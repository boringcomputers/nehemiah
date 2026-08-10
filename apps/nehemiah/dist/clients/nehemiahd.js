import { isIP } from 'node:net';
import { EgressPolicy } from '../domain/network-policy.js';
import { injectTraceHeaders } from '../telemetry.js';
export class HostRequestError extends Error {
    status;
    ambiguous;
    code;
    constructor(status, message, ambiguous, code) {
        super(message);
        this.status = status;
        this.ambiguous = ambiguous;
        this.code = code;
    }
}
export class HostForkContractError extends HostRequestError {
    observed;
    constructor(message, observed) {
        super(undefined, message, true);
        this.observed = observed;
    }
}
export class NehemiahdClient {
    credentials;
    fetcher;
    requestTimeoutMs;
    hostPort;
    constructor(credentials, fetcher = fetch, requestTimeoutMs = 30_000, hostPort = 8080) {
        this.credentials = credentials;
        this.fetcher = fetcher;
        this.requestTimeoutMs = requestTimeoutMs;
        this.hostPort = hostPort;
        if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
            throw new Error('host port must be between 1 and 65535');
        }
    }
    async create(address, request) {
        if (!request.runtimeCohortId || !request.sourceSha256) {
            throw new HostRequestError(undefined, 'managed host create requires an immutable runtime cohort and source digest', false, 'invalid_runtime_binding');
        }
        const machine = await this.request(address, '/internal/v1/machines', {
            method: 'POST',
            headers: { 'idempotency-key': request.idempotencyKey },
            body: JSON.stringify({
                lease_id: request.leaseId,
                lease_generation: request.leaseGeneration ?? 1,
                template: request.template,
                oci_reference: request.ociReference,
                ttl_seconds: request.ttlSeconds,
                // Managed guests always receive a NIC so the host can reach preview
                // ports. nehemiahd installs a per-tap deny rule, so this does not grant
                // outbound internet access without a future explicit egress policy.
                net: true,
                vcpus: request.resources.vcpus,
                memory_mb: request.resources.memoryMb,
                disk_mb: request.resources.diskMb,
                network_policy: request.networkPolicy,
                metadata: request.metadata,
                runtime_cohort_id: request.runtimeCohortId,
                source_sha256: request.sourceSha256
            })
        });
        let observedPolicy;
        try {
            if (machine.network_policy) {
                observedPolicy = new EgressPolicy(machine.network_policy).declaration;
            }
        }
        catch {
            // The contract check below converts malformed host policy JSON into an
            // ambiguous response, preserving reconciliation and cleanup semantics.
        }
        if (machine.lease_id !== request.leaseId ||
            machine.lease_generation !== (request.leaseGeneration ?? 1) ||
            machine.metadata?.public_machine_id !== request.metadata.public_machine_id ||
            machine.resources?.vcpus !== request.resources.vcpus ||
            machine.resources?.memory_mb !== request.resources.memoryMb ||
            machine.resources?.disk_mb !== request.resources.diskMb ||
            machine.runtime_cohort_id !== request.runtimeCohortId ||
            machine.source_sha256 !== request.sourceSha256 ||
            JSON.stringify(observedPolicy) !== JSON.stringify(request.networkPolicy)) {
            throw new HostRequestError(undefined, 'host create response did not match the requested lease and resources', true);
        }
        return machine;
    }
    async get(address, hostMachineId) {
        try {
            return await this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}`);
        }
        catch (error) {
            if (error instanceof HostRequestError && error.status === 404)
                return undefined;
            throw error;
        }
    }
    async destroy(address, hostMachineId, leaseId) {
        await this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}`, {
            method: 'DELETE',
            headers: { 'x-nehemiah-lease-id': leaseId }
        });
    }
    async extend(address, hostMachineId, leaseId, idempotencyKey, targetExpiresAt) {
        const machine = await this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}/extend`, {
            method: 'POST',
            headers: {
                'x-nehemiah-lease-id': leaseId,
                'idempotency-key': idempotencyKey
            },
            body: JSON.stringify({ expires_at: targetExpiresAt.toISOString() })
        });
        const expiresAt = machine.expires_at ? new Date(machine.expires_at) : undefined;
        if (machine.lease_id !== leaseId ||
            !expiresAt ||
            !Number.isFinite(expiresAt.getTime()) ||
            expiresAt < targetExpiresAt) {
            throw new HostRequestError(undefined, 'host extend response did not match the requested lease and expiry', true);
        }
        return machine;
    }
    async fork(address, sourceHostMachineId, sourceLeaseId, idempotencyKey, children) {
        if (children.some((child) => !child.runtimeCohortId || !child.sourceSha256)) {
            throw new HostRequestError(undefined, 'managed host fork requires immutable runtime cohort and source digests', false, 'invalid_runtime_binding');
        }
        let response;
        try {
            response = await this.request(address, `/internal/v1/machines/${encodeURIComponent(sourceHostMachineId)}/fork`, {
                method: 'POST',
                headers: {
                    'x-nehemiah-lease-id': sourceLeaseId,
                    'idempotency-key': idempotencyKey
                },
                body: JSON.stringify({
                    children: children.map((child) => ({
                        lease_id: child.leaseId,
                        lease_generation: child.leaseGeneration ?? 1,
                        expires_at: child.expiresAt.toISOString(),
                        vcpus: child.resources.vcpus,
                        memory_mb: child.resources.memoryMb,
                        disk_mb: child.resources.diskMb,
                        metadata: child.metadata,
                        runtime_cohort_id: child.runtimeCohortId,
                        source_sha256: child.sourceSha256
                    }))
                })
            });
        }
        catch (error) {
            // Capacity rejection happens before the host starts a managed fork and
            // therefore has a definite, replayable result rather than an ambiguous one.
            if (error instanceof HostRequestError && error.status === 429) {
                throw new HostRequestError(error.status, error.message, false, error.code);
            }
            throw error;
        }
        const candidate = response;
        const rawMachines = typeof candidate === 'object' && candidate !== null && 'machines' in candidate
            ? Reflect.get(candidate, 'machines')
            : undefined;
        const inspectable = Array.isArray(rawMachines)
            ? rawMachines.filter((value) => typeof value === 'object' && value !== null)
            : [];
        if (!Array.isArray(rawMachines) ||
            rawMachines.length !== children.length ||
            inspectable.length !== rawMachines.length) {
            throw new HostForkContractError('host fork response did not contain the full batch', inspectable);
        }
        const machines = inspectable;
        const requested = new Map(children.map((child) => [child.metadata.public_machine_id, child]));
        const observed = new Set();
        const hostIds = new Set();
        for (const machine of machines) {
            const publicMachineId = machine.metadata?.public_machine_id;
            const child = publicMachineId ? requested.get(publicMachineId) : undefined;
            const expiresAt = machine.expires_at ? new Date(machine.expires_at) : undefined;
            const startedAt = machine.started_at ? new Date(machine.started_at) : undefined;
            const readyAt = machine.ready_at ? new Date(machine.ready_at) : undefined;
            let observedPolicy;
            try {
                if (machine.network_policy) {
                    observedPolicy = new EgressPolicy(machine.network_policy).declaration;
                }
            }
            catch {
                // The descriptor check below treats malformed policy data as ambiguous.
            }
            if (!machine.id ||
                hostIds.has(machine.id) ||
                !publicMachineId ||
                observed.has(publicMachineId) ||
                !child ||
                machine.lease_id !== child.leaseId ||
                machine.lease_generation !== (child.leaseGeneration ?? 1) ||
                machine.metadata?.parent_machine_id !== child.metadata.parent_machine_id ||
                machine.metadata?.fork_operation_id !== child.metadata.fork_operation_id ||
                machine.resources?.vcpus !== child.resources.vcpus ||
                machine.resources?.memory_mb !== child.resources.memoryMb ||
                machine.resources?.disk_mb !== child.resources.diskMb ||
                machine.runtime_cohort_id !== child.runtimeCohortId ||
                machine.source_sha256 !== child.sourceSha256 ||
                JSON.stringify(observedPolicy) !== JSON.stringify(child.networkPolicy) ||
                !expiresAt ||
                !Number.isFinite(expiresAt.getTime()) ||
                expiresAt.getTime() !== child.expiresAt.getTime() ||
                (startedAt !== undefined && !Number.isFinite(startedAt.getTime())) ||
                (readyAt !== undefined && !Number.isFinite(readyAt.getTime()))) {
                throw new HostForkContractError('host fork child did not match its reserved descriptor', machines);
            }
            observed.add(publicMachineId);
            hostIds.add(machine.id);
        }
        return machines;
    }
    async exec(address, hostMachineId, leaseId, command, timeoutSeconds) {
        try {
            return await this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}/exec`, {
                method: 'POST',
                headers: { 'x-nehemiah-lease-id': leaseId },
                body: JSON.stringify({ command, timeout_seconds: timeoutSeconds })
            }, (timeoutSeconds + 5) * 1_000);
        }
        catch (error) {
            // Guest-operation capacity is rejected before the host dials vsock or
            // performs a side effect. A managed guest-agent-unavailable response is
            // likewise emitted only after the vsock dial failed and serial fallback
            // was forbidden, so neither response is ambiguous.
            if (error instanceof HostRequestError &&
                ((error.status === 429 && error.code === 'guest_operation_capacity_reached') ||
                    (error.status === 503 && error.code === 'guest_agent_unavailable'))) {
                throw new HostRequestError(error.status, error.message, false, error.code);
            }
            throw error;
        }
    }
    async request(address, path, init = {}, timeoutMs = this.requestTimeoutMs) {
        const version = isIP(address);
        if (version === 0) {
            throw new HostRequestError(undefined, 'invalid host address', false);
        }
        const base = `http://${version === 6 ? `[${address}]` : address}:${this.hostPort}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const internalToken = typeof this.credentials === 'string'
                ? this.credentials
                : await this.credentials.resolve(address);
            const headers = new Headers(init.headers);
            headers.set('accept', 'application/json');
            headers.set('content-type', 'application/json');
            headers.set('authorization', `Bearer ${internalToken}`);
            injectTraceHeaders(headers);
            const response = await this.fetcher(`${base}${path}`, {
                ...init,
                signal: controller.signal,
                redirect: 'error',
                headers: Object.fromEntries(headers.entries())
            });
            const bytes = await readBoundedResponse(response, 1 << 20);
            if (!response.ok) {
                const body = new TextDecoder().decode(bytes);
                let code;
                try {
                    const decoded = JSON.parse(body);
                    if (typeof decoded === 'object' && decoded !== null) {
                        const candidate = Reflect.get(decoded, 'error');
                        if (typeof candidate === 'string')
                            code = candidate;
                    }
                }
                catch {
                    // The bounded response body is retained as the diagnostic message below.
                }
                throw new HostRequestError(response.status, body, (response.status >= 500 || response.status === 429 || response.status === 408) &&
                    (init.method === 'POST' || init.method === 'DELETE'), code);
            }
            if (response.status === 204)
                return undefined;
            return JSON.parse(new TextDecoder().decode(bytes));
        }
        catch (error) {
            if (error instanceof HostRequestError)
                throw error;
            throw new HostRequestError(undefined, error instanceof Error ? error.message : String(error), init.method === 'POST' || init.method === 'DELETE');
        }
        finally {
            clearTimeout(timer);
        }
    }
}
const readBoundedResponse = async (response, maximum) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum)
        throw new Error('host response is too large');
    if (!response.body)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maximum) {
            await reader.cancel();
            throw new Error('host response is too large');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
};
//# sourceMappingURL=nehemiahd.js.map
export class HostRequestError extends Error {
    status;
    ambiguous;
    constructor(status, message, ambiguous) {
        super(message);
        this.status = status;
        this.ambiguous = ambiguous;
    }
}
export class NehemiahdClient {
    internalToken;
    fetcher;
    requestTimeoutMs;
    constructor(internalToken, fetcher = fetch, requestTimeoutMs = 30_000) {
        this.internalToken = internalToken;
        this.fetcher = fetcher;
        this.requestTimeoutMs = requestTimeoutMs;
    }
    create(address, request) {
        return this.request(address, '/internal/v1/machines', {
            method: 'POST',
            headers: { 'idempotency-key': request.idempotencyKey },
            body: JSON.stringify({
                lease_id: request.leaseId,
                template: request.template,
                oci_reference: request.ociReference,
                ttl_seconds: request.ttlSeconds,
                vcpus: request.resources.vcpus,
                memory_mb: request.resources.memoryMb,
                disk_mb: request.resources.diskMb,
                metadata: request.metadata
            })
        });
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
    extend(address, hostMachineId, ttlSeconds) {
        return this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}/extend`, {
            method: 'POST',
            body: JSON.stringify({ ttl_seconds: ttlSeconds })
        });
    }
    exec(address, hostMachineId, command, timeoutSeconds) {
        return this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}/exec`, {
            method: 'POST',
            body: JSON.stringify({ command, timeout_seconds: timeoutSeconds })
        });
    }
    async request(address, path, init = {}) {
        if (!/^[a-zA-Z0-9.:[\]-]+(?::\d+)?$/.test(address)) {
            throw new HostRequestError(undefined, 'invalid host address', false);
        }
        const base = address.includes('://') ? address : `http://${address}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            const response = await this.fetcher(`${base}${path}`, {
                ...init,
                signal: controller.signal,
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.internalToken}`,
                    ...init.headers
                }
            });
            if (!response.ok) {
                throw new HostRequestError(response.status, await response.text(), false);
            }
            if (response.status === 204)
                return undefined;
            return (await response.json());
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
//# sourceMappingURL=nehemiahd.js.map
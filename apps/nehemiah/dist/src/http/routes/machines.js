import { gatewayCapabilities, issueCapabilityToken } from '../../auth/capability.js';
import { machineJson } from '../../domain/machines.js';
import { CapacityUnavailable, QuotaExceeded } from '../../scheduler/scheduler.js';
import { authenticate, permits, projectFor } from '../auth.js';
import { json, problem, readJson } from '../router.js';
const owned = async (services, request, id, scope) => {
    const principal = await authenticate(request, services);
    if (!principal || !permits(principal, scope))
        return undefined;
    const machine = await services.machines.get(id, principal.organizationId, projectFor(principal));
    return machine ? { principal, machine } : undefined;
};
export const registerMachineRoutes = (router) => {
    router.post('/v1/machines', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal)
            return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
        if (!permits(principal, 'machines:write')) {
            return problem(403, 'insufficient_scope', 'machines:write is required.', requestId);
        }
        try {
            const body = await readJson(request);
            const projectId = projectFor(principal, body.project_id);
            if (!projectId)
                return problem(400, 'project_required', 'project_id is required.', requestId);
            if (principal.kind === 'api_key' && principal.projectId && body.project_id !== undefined && body.project_id !== principal.projectId) {
                return problem(403, 'cross_project_denied', 'The API key is scoped to another project.', requestId);
            }
            const result = await services.machines.create({
                organizationId: principal.organizationId,
                projectId,
                region: body.region ?? 'ca-tor-1',
                architecture: body.architecture ?? 'x86_64',
                resources: {
                    vcpus: body.vcpus ?? 1,
                    memoryMb: body.memory_mb ?? 512,
                    diskMb: body.disk_mb ?? 5_120
                },
                templateId: body.template_id,
                ociReference: body.oci_reference,
                ttlSeconds: body.ttl_seconds ?? 900,
                idempotencyKey: request.headers.get('idempotency-key') ?? ''
            });
            return json(machineJson(result.machine), result.replayed ? 200 : result.machine.ready ? 201 : 202, result.replayed ? { 'idempotency-replayed': 'true' } : undefined);
        }
        catch (error) {
            if (error instanceof QuotaExceeded)
                return problem(429, error.code, error.message, requestId);
            if (error instanceof CapacityUnavailable)
                return problem(503, error.code, error.message, requestId);
            return problem(400, 'invalid_request', error instanceof Error ? error.message : String(error), requestId);
        }
    });
    router.get('/v1/machines', async ({ request, url, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal)
            return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
        if (!permits(principal, 'machines:read')) {
            return problem(403, 'insufficient_scope', 'machines:read is required.', requestId);
        }
        const project = projectFor(principal, url.searchParams.get('project_id') ?? undefined);
        const machines = await services.machines.list(principal.organizationId, project, url.searchParams.get('cursor') ?? undefined, Number(url.searchParams.get('limit') ?? 50));
        return json({
            machines: machines.map(machineJson),
            next_cursor: machines.length ? machines.at(-1).id : undefined
        });
    });
    router.get('/v1/machines/:id', async ({ request, params, services, requestId }) => {
        const result = await owned(services, request, params.id, 'machines:read');
        if (!result)
            return problem(404, 'not_found', 'Machine not found.', requestId);
        return json(machineJson(result.machine));
    });
    router.delete('/v1/machines/:id', async ({ request, params, services, requestId }) => {
        const result = await owned(services, request, params.id, 'machines:write');
        if (!result)
            return problem(404, 'not_found', 'Machine not found.', requestId);
        await services.machines.destroy(result.machine.id, result.principal.organizationId, projectFor(result.principal));
        return new Response(null, { status: 204 });
    });
    router.post('/v1/machines/:id/extend', async ({ request, params, services, requestId }) => {
        const result = await owned(services, request, params.id, 'machines:write');
        if (!result)
            return problem(404, 'not_found', 'Machine not found.', requestId);
        const body = await readJson(request);
        const machine = await services.machines.extend(result.machine.id, result.principal.organizationId, projectFor(result.principal), body.ttl_seconds ?? 900);
        return json(machine ? machineJson(machine) : machineJson(result.machine));
    });
    router.post('/v1/machines/:id/exec', async ({ request, params, services, requestId }) => {
        const result = await owned(services, request, params.id, 'machines:write');
        if (!result)
            return problem(404, 'not_found', 'Machine not found.', requestId);
        const body = await readJson(request);
        if (!body.command || body.command.length > 65_536) {
            return problem(400, 'invalid_command', 'command is required and must be at most 64 KiB.', requestId);
        }
        const timeout = Math.min(Math.max(body.timeout_seconds ?? 30, 1), 120);
        const execution = await services.machines.exec(result.machine.id, result.principal.organizationId, projectFor(result.principal), body.command, timeout);
        return execution
            ? json(execution)
            : problem(409, 'machine_not_ready', 'The guest agent is not ready.', requestId);
    });
    router.post('/v1/machines/:id/sessions', async ({ request, params, services, requestId }) => {
        const result = await owned(services, request, params.id, 'machines:read');
        if (!result)
            return problem(404, 'not_found', 'Machine not found.', requestId);
        if (!result.machine.ready)
            return problem(409, 'machine_not_ready', 'The guest agent is not ready.', requestId);
        const body = await readJson(request);
        const capabilities = body.capabilities ?? ['tty'];
        if (capabilities.some((value) => !gatewayCapabilities.includes(value))) {
            return problem(400, 'invalid_capability', 'An unknown capability was requested.', requestId);
        }
        if (capabilities.includes('preview') && (!body.port || body.port < 1 || body.port > 65_535)) {
            return problem(400, 'invalid_port', 'Preview sessions require a valid port.', requestId);
        }
        const token = await issueCapabilityToken({
            machineId: result.machine.id,
            organizationId: result.machine.organizationId,
            projectId: result.machine.projectId,
            capabilities,
            port: body.port
        }, services.gatewaySecret, Math.min(body.ttl_seconds ?? 300, 900));
        return json({
            token,
            expires_in: Math.min(body.ttl_seconds ?? 300, 900),
            gateway_url: services.gatewayPublicUrl,
            preview_url: capabilities.includes('preview')
                ? `${services.gatewayPublicUrl}/preview/${result.machine.id}/${body.port}/?token=${encodeURIComponent(token)}`
                : undefined
        });
    });
};
//# sourceMappingURL=machines.js.map
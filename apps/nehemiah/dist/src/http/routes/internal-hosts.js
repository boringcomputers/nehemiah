import { timingSafeEqual } from 'node:crypto';
import { json, problem, readJson } from '../router.js';
const equal = (left, right) => {
    if (!left)
        return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
};
const bearer = (request) => {
    const value = request.headers.get('authorization');
    return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
};
export const registerInternalHostRoutes = (router) => {
    router.post('/internal/v1/hosts/register', async ({ request, services, requestId }) => {
        if (!equal(bearer(request), services.internalToken)) {
            return problem(401, 'unauthorized', 'The fleet bootstrap token is invalid.', requestId);
        }
        const input = await readJson(request);
        const host = await services.hosts.register({
            providerId: input.provider_id,
            regionId: input.region_id,
            address: input.address,
            architecture: input.architecture,
            totalVcpus: input.total_vcpus,
            totalMemoryMb: input.total_memory_mb,
            totalDiskMb: input.total_disk_mb
        });
        return json({ id: host.id, credential: host.credential, secret_displayed_once: true }, 201, {
            'cache-control': 'no-store'
        });
    });
    router.post('/internal/v1/hosts/:id/heartbeat', async ({ request, params, services, requestId }) => {
        const credential = bearer(request);
        if (!credential || !(await services.hosts.authenticate(params.id, credential))) {
            return problem(401, 'unauthorized', 'The host credential is invalid.', requestId);
        }
        const body = await readJson(request);
        await services.hosts.heartbeat(params.id, {
            state: body.state,
            availableVcpus: body.available_vcpus,
            availableMemoryMb: body.available_memory_mb,
            availableDiskMb: body.available_disk_mb,
            machineCount: body.machine_count,
            kvmAvailable: body.kvm_available,
            daemonVersion: body.daemon_version
        });
        return new Response(null, { status: 204 });
    });
    router.get('/internal/v1/routing/machines/:id', async ({ request, params, services, requestId }) => {
        if (!equal(bearer(request), services.gatewayToken)) {
            return problem(401, 'unauthorized', 'The gateway credential is invalid.', requestId);
        }
        const result = await services.database.query(`SELECT host(h.address) AS host_address, m.host_machine_id, m.lease_id, m.expires_at
			 FROM machines m JOIN hosts h ON h.id = m.host_id
			 WHERE m.id = $1 AND m.state = 'running' AND m.ready = true
			   AND m.expires_at > now() AND h.state IN ('ready', 'draining')`, [params.id]);
        const route = result.rows[0];
        if (!route)
            return problem(404, 'route_not_found', 'No live route exists for this machine.', requestId);
        return json({
            host_address: route.host_address,
            host_machine_id: route.host_machine_id,
            lease_id: route.lease_id,
            expires_at: route.expires_at.toISOString()
        });
    });
};
//# sourceMappingURL=internal-hosts.js.map
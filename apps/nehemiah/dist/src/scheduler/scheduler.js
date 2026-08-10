import { validateResources } from './capacity.js';
export class CapacityUnavailable extends Error {
    code = 'capacity_unavailable';
}
export class QuotaExceeded extends Error {
    code = 'quota_exceeded';
}
export class Scheduler {
    database;
    constructor(database) {
        this.database = database;
    }
    async reserve(request) {
        validateResources(request.resources);
        return this.database.transaction(async (client) => {
            await this.enforceQuota(client, request);
            const selected = await client.query(`SELECT h.id, host(h.address) AS address,
				        COALESCE(tr.state = 'ready', false) AS cached_template
				 FROM hosts h
				 LEFT JOIN template_replicas tr ON tr.host_id = h.id AND tr.template_id = $6
				 WHERE h.region_id = $1 AND h.architecture = $2 AND h.state = 'ready'
				   AND h.last_heartbeat_at > now() - interval '30 seconds'
				   AND h.total_vcpus - h.reserved_vcpus >= $3
				   AND h.total_memory_mb - h.reserved_memory_mb >= $4
				   AND h.total_disk_mb - h.reserved_disk_mb >= $5
				 ORDER BY cached_template DESC,
				          (h.total_memory_mb - h.reserved_memory_mb - $4) ASC,
				          (h.total_vcpus - h.reserved_vcpus - $3) ASC,
				          h.id ASC
				 FOR UPDATE OF h SKIP LOCKED LIMIT 1`, [
                request.region,
                request.architecture,
                request.resources.vcpus,
                request.resources.memoryMb,
                request.resources.diskMb,
                request.templateId ?? null
            ]);
            const host = selected.rows[0];
            if (!host)
                throw new CapacityUnavailable('No healthy host has enough reserved capacity.');
            await client.query(`UPDATE hosts SET
				 reserved_vcpus = reserved_vcpus + $2,
				 reserved_memory_mb = reserved_memory_mb + $3,
				 reserved_disk_mb = reserved_disk_mb + $4,
				 updated_at = now()
				 WHERE id = $1`, [
                host.id,
                request.resources.vcpus,
                request.resources.memoryMb,
                request.resources.diskMb
            ]);
            return {
                hostId: host.id,
                address: host.address,
                cachedTemplate: host.cached_template
            };
        });
    }
    async release(hostId, resources) {
        await this.database.query(`UPDATE hosts SET
			 reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
			 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
			 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4),
			 updated_at = now()
			 WHERE id = $1`, [hostId, resources.vcpus, resources.memoryMb, resources.diskMb]);
    }
    async enforceQuota(client, request) {
        const limitsResult = await client.query(`SELECT max_machines, max_vcpus, max_memory_mb FROM projects
			 WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [request.projectId, request.organizationId]);
        const limits = limitsResult.rows[0];
        if (!limits)
            throw new QuotaExceeded('Project does not belong to this organization.');
        const usageResult = await client.query(`SELECT count(*) AS machines, COALESCE(sum(vcpus), 0) AS vcpus,
			        COALESCE(sum(memory_mb), 0) AS memory_mb
			 FROM machines WHERE project_id = $1
			 AND state NOT IN ('stopped', 'failed', 'lost')`, [request.projectId]);
        const usage = usageResult.rows[0];
        if (Number(usage.machines) + 1 > limits.max_machines ||
            Number(usage.vcpus) + request.resources.vcpus > limits.max_vcpus ||
            Number(usage.memory_mb) + request.resources.memoryMb > limits.max_memory_mb) {
            throw new QuotaExceeded('Project machine quota would be exceeded.');
        }
    }
}
//# sourceMappingURL=scheduler.js.map
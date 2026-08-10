import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
const positive = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be positive`);
};
export class HostService {
    database;
    constructor(database) {
        this.database = database;
    }
    async register(input) {
        positive(input.totalVcpus, 'totalVcpus');
        positive(input.totalMemoryMb, 'totalMemoryMb');
        positive(input.totalDiskMb, 'totalDiskMb');
        const id = randomUUID();
        const credential = `nh_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
        const credentialHash = await hash(credential, {
            algorithm: 2 /* Algorithm.Argon2id */,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1
        });
        await this.database.query(`INSERT INTO hosts
			 (id, provider_id, region_id, address, architecture, state, credential_hash,
			  total_vcpus, total_memory_mb, total_disk_mb)
			 VALUES ($1, $2, $3, $4, $5, 'unhealthy', $6, $7, $8, $9)`, [
            id,
            input.providerId ?? null,
            input.regionId,
            input.address,
            input.architecture,
            credentialHash,
            input.totalVcpus,
            input.totalMemoryMb,
            input.totalDiskMb
        ]);
        return { id, credential };
    }
    async authenticate(hostId, credential) {
        const result = await this.database.query('SELECT credential_hash FROM hosts WHERE id = $1', [hostId]);
        const encoded = result.rows[0]?.credential_hash;
        return encoded ? verify(encoded, credential) : false;
    }
    async heartbeat(hostId, heartbeat) {
        for (const [name, value] of Object.entries({
            availableVcpus: heartbeat.availableVcpus,
            availableMemoryMb: heartbeat.availableMemoryMb,
            availableDiskMb: heartbeat.availableDiskMb,
            machineCount: heartbeat.machineCount
        })) {
            if (!Number.isSafeInteger(value) || value < 0)
                throw new Error(`${name} must not be negative`);
        }
        const state = heartbeat.kvmAvailable ? heartbeat.state : 'unhealthy';
        await this.database.query(`WITH updated AS (
			 UPDATE hosts
			 SET state = $2, last_heartbeat_at = now(), daemon_version = $3, updated_at = now()
			 WHERE id = $1 RETURNING id
			)
			INSERT INTO host_heartbeats
			 (host_id, state, available_vcpus, available_memory_mb, available_disk_mb,
			  machine_count, kvm_available, daemon_version)
			SELECT id, $2, $4, $5, $6, $7, $8, $3 FROM updated`, [
            hostId,
            state,
            heartbeat.daemonVersion,
            heartbeat.availableVcpus,
            heartbeat.availableMemoryMb,
            heartbeat.availableDiskMb,
            heartbeat.machineCount,
            heartbeat.kvmAvailable
        ]);
    }
    async markStale(staleAfterMs) {
        const result = await this.database.query(`UPDATE hosts SET state = 'stale', updated_at = now()
			 WHERE state IN ('ready', 'unhealthy')
			   AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 * interval '1 millisecond'))
			 RETURNING id`, [staleAfterMs]);
        return result.rows.map((row) => row.id);
    }
    async setDraining(hostId, draining) {
        const result = await this.database.query(`UPDATE hosts SET state = $2, updated_at = now()
			 WHERE id = $1 AND state <> 'stale'`, [hostId, draining ? 'draining' : 'unhealthy']);
        return Boolean(result.rowCount);
    }
}
//# sourceMappingURL=hosts.js.map
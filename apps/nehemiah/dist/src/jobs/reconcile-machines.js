export class MachineReconciler {
    database;
    host;
    constructor(database, host) {
        this.database = database;
        this.host = host;
    }
    async run() {
        await this.markLostOnStaleHosts();
        const result = await this.database.query(`SELECT m.id, m.organization_id, m.host_id, host(h.address) AS host_address,
			 m.host_machine_id, m.lease_id, m.state, m.vcpus, m.memory_mb, m.disk_mb
			 FROM machines m JOIN hosts h ON h.id = m.host_id
			 WHERE m.state IN ('starting', 'stopping') AND m.placed_at < now() - interval '15 seconds'
			 ORDER BY m.created_at LIMIT 100`);
        for (const machine of result.rows)
            await this.reconcile(machine);
    }
    async reconcile(machine) {
        if (!machine.host_machine_id)
            return;
        const observed = await this.host.get(machine.host_address, machine.host_machine_id);
        if (machine.state === 'starting' && observed) {
            await this.database.query(`UPDATE machines SET state = $2, ready = $3,
				 started_at = COALESCE(started_at, now()), ready_at = CASE WHEN $3 THEN COALESCE(ready_at, now()) ELSE NULL END
				 WHERE id = $1 AND state = 'starting'`, [machine.id, observed.ready ? 'running' : 'starting', observed.ready === true]);
        }
        else if (machine.state === 'stopping' && !observed) {
            await this.finishAndRelease(machine, 'stopped', 'reconciled host not-found');
        }
    }
    async markLostOnStaleHosts() {
        const lost = await this.database.query(`UPDATE machines m SET state = 'lost', state_reason = 'host heartbeat expired',
			 stopped_at = now(), ready = false, ready_at = NULL
			 FROM hosts h WHERE m.host_id = h.id AND h.state = 'stale'
			 AND m.state NOT IN ('stopped', 'failed', 'lost')
			 RETURNING m.id, m.organization_id, m.host_id, host(h.address) AS host_address,
			 m.host_machine_id, m.lease_id, 'running'::text AS state,
			 m.vcpus, m.memory_mb, m.disk_mb`);
        for (const machine of lost.rows)
            await this.release(machine.host_id, machine);
    }
    async finishAndRelease(machine, state, reason) {
        const changed = await this.database.query(`UPDATE machines SET state = $2, state_reason = $3, stopped_at = now(), ready = false, ready_at = NULL
			 WHERE id = $1 AND state NOT IN ('stopped', 'failed', 'lost')`, [machine.id, state, reason]);
        if (changed.rowCount)
            await this.release(machine.host_id, machine);
    }
    async release(hostId, machine) {
        await this.database.query(`UPDATE hosts SET reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
			 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
			 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4), updated_at = now()
			 WHERE id = $1`, [hostId, machine.vcpus, machine.memory_mb, machine.disk_mb]);
    }
}
//# sourceMappingURL=reconcile-machines.js.map
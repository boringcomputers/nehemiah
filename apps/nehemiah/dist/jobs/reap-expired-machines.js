export const reapExpiredMachines = async (database, machines) => {
    const expired = await database.query(`SELECT m.id, m.organization_id, m.project_id FROM machines m
		 WHERE GREATEST(
		   m.expires_at,
		   COALESCE((
		     SELECT MAX(operation.target_expires_at)
		     FROM machine_extend_operations operation
		     WHERE operation.machine_id = m.id
		       AND operation.organization_id = m.organization_id
		   ), '-infinity'::timestamptz)
		 ) <= now()
		 AND m.state NOT IN ('stopped', 'failed', 'lost')
		 AND NOT EXISTS (
		   SELECT 1 FROM machine_fork_operations fork
		   WHERE fork.id = m.fork_operation_id AND fork.state = 'pending'
		 )
		 ORDER BY m.expires_at LIMIT 100`);
    for (const machine of expired.rows) {
        await machines
            .destroy(machine.id, machine.organization_id, machine.project_id)
            .catch(() => undefined);
    }
};
//# sourceMappingURL=reap-expired-machines.js.map
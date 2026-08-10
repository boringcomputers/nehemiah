export const reapExpiredMachines = async (database, machines) => {
    const expired = await database.query(`SELECT id, organization_id, project_id FROM machines
		 WHERE expires_at <= now() AND state NOT IN ('stopped', 'failed', 'lost')
		 ORDER BY expires_at LIMIT 100`);
    for (const machine of expired.rows) {
        await machines.destroy(machine.id, machine.organization_id, machine.project_id).catch(() => undefined);
    }
};
//# sourceMappingURL=reap-expired-machines.js.map
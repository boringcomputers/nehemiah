export class UsageLedger {
    database;
    constructor(database) {
        this.database = database;
    }
    async append(event) {
        if (!Number.isFinite(event.quantity) || event.quantity < 0) {
            throw new Error('usage quantity must be a non-negative finite number');
        }
        if (event.periodEnd < event.periodStart)
            throw new Error('usage period is inverted');
        const result = await this.database.query(`INSERT INTO usage_events
			 (event_key, organization_id, project_id, machine_id, dimension, quantity,
			  period_start, period_end, source)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (event_key) DO NOTHING`, [
            event.eventKey,
            event.organizationId,
            event.projectId,
            event.machineId ?? null,
            event.dimension,
            event.quantity,
            event.periodStart,
            event.periodEnd,
            event.source
        ]);
        return Boolean(result.rowCount);
    }
    async recordMachineRuntime(input) {
        if (input.end < input.start)
            throw new Error('usage period is inverted');
        let start = input.start;
        let segment = 0;
        while (start < input.end) {
            const nextMidnight = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
            const end = nextMidnight < input.end ? nextMidnight : input.end;
            const seconds = (end.getTime() - start.getTime()) / 1_000;
            const prefix = `${input.eventPrefix}:${segment}:${start.toISOString()}`;
            await Promise.all([
                this.append({
                    eventKey: `${prefix}:vcpu`,
                    organizationId: input.organizationId,
                    projectId: input.projectId,
                    machineId: input.machineId,
                    dimension: 'vcpu_seconds',
                    quantity: seconds * input.vcpus,
                    periodStart: start,
                    periodEnd: end,
                    source: input.source
                }),
                this.append({
                    eventKey: `${prefix}:memory`,
                    organizationId: input.organizationId,
                    projectId: input.projectId,
                    machineId: input.machineId,
                    dimension: 'gib_seconds',
                    quantity: seconds * (input.memoryMb / 1_024),
                    periodStart: start,
                    periodEnd: end,
                    source: input.source
                })
            ]);
            start = end;
            segment += 1;
        }
    }
}
//# sourceMappingURL=usage.js.map
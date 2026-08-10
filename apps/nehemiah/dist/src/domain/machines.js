import { randomBytes, randomUUID } from 'node:crypto';
import { HostRequestError } from '../clients/nehemiahd.js';
const selectMachine = `SELECT m.*, host(h.address) AS host_address
 FROM machines m LEFT JOIN hosts h ON h.id = m.host_id`;
const fromRow = (row) => ({
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    hostId: row.host_id ?? undefined,
    hostAddress: row.host_address ?? undefined,
    hostMachineId: row.host_machine_id ?? undefined,
    leaseId: row.lease_id,
    state: row.state,
    stateReason: row.state_reason ?? undefined,
    region: row.region_id,
    architecture: row.architecture,
    resources: { vcpus: row.vcpus, memoryMb: row.memory_mb, diskMb: Number(row.disk_mb) },
    templateId: row.template_id ?? undefined,
    ociReference: row.source_oci_ref ?? undefined,
    ready: row.ready,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    readyAt: row.ready_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
    expiresAt: row.expires_at
});
export class PostgresMachineRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    async find(id, organizationId, projectId) {
        const result = await this.database.query(`${selectMachine} WHERE m.id = $1 AND m.organization_id = $2
			 AND ($3::uuid IS NULL OR m.project_id = $3)`, [id, organizationId, projectId ?? null]);
        return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    }
    async findByIdempotency(organizationId, key) {
        const result = await this.database.query(`${selectMachine} WHERE m.organization_id = $1 AND m.idempotency_key = $2`, [organizationId, key]);
        return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    }
    async list(organizationId, projectId, cursor, limit = 50) {
        const result = await this.database.query(`${selectMachine} WHERE m.organization_id = $1
			 AND ($2::uuid IS NULL OR m.project_id = $2)
			 AND ($3::text IS NULL OR m.id < $3)
			 ORDER BY m.id DESC LIMIT $4`, [organizationId, projectId ?? null, cursor ?? null, Math.min(Math.max(limit, 1), 100)]);
        return result.rows.map(fromRow);
    }
    async insertRequested(machine, idempotencyKey) {
        await this.database.query(`INSERT INTO machines
			 (id, organization_id, project_id, lease_id, idempotency_key, state, region_id,
			  architecture, template_id, source_oci_ref, vcpus, memory_mb, disk_mb, expires_at)
			 VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8, $9, $10, $11, $12, $13)`, [
            machine.id,
            machine.organizationId,
            machine.projectId,
            machine.leaseId,
            idempotencyKey,
            machine.region,
            machine.architecture,
            machine.templateId ?? null,
            machine.ociReference ?? null,
            machine.resources.vcpus,
            machine.resources.memoryMb,
            machine.resources.diskMb,
            machine.expiresAt
        ]);
        await this.event(machine.id, machine.organizationId, undefined, 'requested');
    }
    async assign(machineId, reservation) {
        const result = await this.database.query(`UPDATE machines SET host_id = $2, state = 'starting', placed_at = now()
			 WHERE id = $1 AND state IN ('requested', 'placing')
			 RETURNING organization_id, state`, [machineId, reservation.hostId]);
        const row = result.rows[0];
        if (!row)
            throw new Error('machine could not be assigned');
        await this.event(machineId, row.organization_id, 'placing', 'starting');
    }
    async observeHost(machineId, hostMachine) {
        const ready = hostMachine.ready === true;
        const result = await this.database.query(`UPDATE machines SET host_machine_id = $2, state = $3, ready = $4,
			 started_at = COALESCE($5, started_at, now()), ready_at = $6, state_reason = NULL
			 WHERE id = $1 RETURNING organization_id`, [
            machineId,
            hostMachine.id,
            ready ? 'running' : 'starting',
            ready,
            hostMachine.started_at ? new Date(hostMachine.started_at) : null,
            ready ? (hostMachine.ready_at ? new Date(hostMachine.ready_at) : new Date()) : null
        ]);
        if (ready && result.rows[0]) {
            await this.event(machineId, result.rows[0].organization_id, 'starting', 'running');
        }
    }
    async transition(machineId, from, to, reason) {
        const result = await this.database.query(`WITH prior AS (SELECT id, organization_id, state AS old_state FROM machines
			 WHERE id = $1 AND state = ANY($2::machine_state[]) FOR UPDATE), updated AS (
			 UPDATE machines m SET state = $3, state_reason = $4,
			 stopping_at = CASE WHEN $3 = 'stopping' THEN now() ELSE stopping_at END,
			 stopped_at = CASE WHEN $3 IN ('stopped', 'failed', 'lost') THEN now() ELSE stopped_at END,
			 ready = CASE WHEN $3 = 'running' THEN ready ELSE false END,
			 ready_at = CASE WHEN $3 = 'running' THEN ready_at ELSE NULL END
			 FROM prior WHERE m.id = prior.id
			 RETURNING prior.organization_id, prior.old_state
			) SELECT * FROM updated`, [machineId, from, to, reason ?? null]);
        const row = result.rows[0];
        if (!row)
            return false;
        await this.event(machineId, row.organization_id, row.old_state, to, reason);
        return true;
    }
    async event(machineId, organizationId, from, to, reason) {
        await this.database.query(`INSERT INTO machine_events
			 (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
			 VALUES ($1, $2, $3, $4, $5, $6, 'control-plane') ON CONFLICT DO NOTHING`, [`${machineId}:${to}:${randomUUID()}`, machineId, organizationId, from ?? null, to, reason ?? null]);
    }
}
export class MachineService {
    repository;
    scheduler;
    host;
    constructor(repository, scheduler, host) {
        this.repository = repository;
        this.scheduler = scheduler;
        this.host = host;
    }
    async create(input) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
            throw new Error('A valid Idempotency-Key header is required.');
        }
        if ((!input.templateId && !input.ociReference) || (input.templateId && input.ociReference)) {
            throw new Error('exactly one of templateId or ociReference is required');
        }
        if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 15 || input.ttlSeconds > 86_400) {
            throw new Error('ttlSeconds must be between 15 and 86400');
        }
        const existing = await this.repository.findByIdempotency(input.organizationId, input.idempotencyKey);
        if (existing)
            return { machine: existing, replayed: true };
        const machine = {
            id: `m_${randomBytes(18).toString('base64url')}`,
            organizationId: input.organizationId,
            projectId: input.projectId,
            leaseId: randomUUID(),
            state: 'requested',
            region: input.region,
            architecture: input.architecture,
            resources: input.resources,
            templateId: input.templateId,
            ociReference: input.ociReference,
            ready: false,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000)
        };
        try {
            await this.repository.insertRequested(machine, input.idempotencyKey);
        }
        catch (error) {
            const raced = await this.repository.findByIdempotency(input.organizationId, input.idempotencyKey);
            if (raced)
                return { machine: raced, replayed: true };
            throw error;
        }
        await this.repository.transition(machine.id, ['requested'], 'placing');
        let reservation;
        try {
            reservation = await this.scheduler.reserve({
                organizationId: input.organizationId,
                projectId: input.projectId,
                region: input.region,
                architecture: input.architecture,
                resources: input.resources,
                templateId: input.templateId
            });
            await this.repository.assign(machine.id, reservation);
            const hostMachine = await this.host.create(reservation.address, {
                leaseId: machine.leaseId,
                idempotencyKey: machine.id,
                template: input.templateId,
                ociReference: input.ociReference,
                ttlSeconds: input.ttlSeconds,
                resources: input.resources,
                metadata: { public_machine_id: machine.id }
            });
            await this.repository.observeHost(machine.id, hostMachine);
        }
        catch (error) {
            if (error instanceof HostRequestError && error.ambiguous) {
                const pending = await this.repository.find(machine.id, machine.organizationId);
                return { machine: pending ?? machine, replayed: false };
            }
            await this.repository.transition(machine.id, ['placing', 'starting'], 'failed', String(error));
            if (reservation)
                await this.scheduler.release(reservation.hostId, input.resources);
            throw error;
        }
        return {
            machine: (await this.repository.find(machine.id, machine.organizationId)) ?? machine,
            replayed: false
        };
    }
    list(organizationId, projectId, cursor, limit) {
        return this.repository.list(organizationId, projectId, cursor, limit);
    }
    get(id, organizationId, projectId) {
        return this.repository.find(id, organizationId, projectId);
    }
    async destroy(id, organizationId, projectId) {
        const machine = await this.repository.find(id, organizationId, projectId);
        if (!machine)
            return false;
        if (['stopped', 'failed', 'lost'].includes(machine.state))
            return true;
        if (!(await this.repository.transition(id, ['requested', 'placing', 'starting', 'running'], 'stopping'))) {
            return true;
        }
        if (machine.hostAddress && machine.hostMachineId) {
            try {
                await this.host.destroy(machine.hostAddress, machine.hostMachineId, machine.leaseId);
            }
            catch (error) {
                if (!(error instanceof HostRequestError && error.status === 404))
                    throw error;
            }
        }
        await this.repository.transition(id, ['stopping'], 'stopped');
        if (machine.hostId)
            await this.scheduler.release(machine.hostId, machine.resources);
        return true;
    }
    async extend(id, organizationId, projectId, ttlSeconds) {
        const machine = await this.repository.find(id, organizationId, projectId);
        if (!machine?.hostAddress || !machine.hostMachineId)
            return machine;
        await this.host.extend(machine.hostAddress, machine.hostMachineId, ttlSeconds);
        return this.repository.find(id, organizationId, projectId);
    }
    async exec(id, organizationId, projectId, command, timeoutSeconds) {
        const machine = await this.repository.find(id, organizationId, projectId);
        if (!machine?.ready || !machine.hostAddress || !machine.hostMachineId)
            return undefined;
        return this.host.exec(machine.hostAddress, machine.hostMachineId, command, timeoutSeconds);
    }
}
export const machineJson = (machine) => ({
    id: machine.id,
    project_id: machine.projectId,
    state: machine.state,
    status: machine.state,
    ready: machine.ready,
    region: machine.region,
    architecture: machine.architecture,
    resources: {
        vcpus: machine.resources.vcpus,
        memory_mb: machine.resources.memoryMb,
        disk_mb: machine.resources.diskMb
    },
    template_id: machine.templateId,
    oci_reference: machine.ociReference,
    created_at: machine.createdAt.toISOString(),
    started_at: machine.startedAt?.toISOString(),
    ready_at: machine.readyAt?.toISOString(),
    stopped_at: machine.stoppedAt?.toISOString(),
    expires_at: machine.expiresAt.toISOString(),
    failure_reason: machine.state === 'failed' || machine.state === 'lost' ? machine.stateReason : undefined
});
//# sourceMappingURL=machines.js.map
import { randomUUID } from 'node:crypto';
import { HostForkContractError, HostRequestError } from '../clients/nehemiahd.js';
import { PostgresMachineRepository } from '../domain/machines.js';
import { EgressPolicy } from '../domain/network-policy.js';
import { log } from '../telemetry.js';
const reconcileAdvisoryLock = 0x4e45484d;
const reconcileBatchSize = 100;
const reconcileConcurrency = 8;
const reconcileClaimSeconds = 5 * 60;
const usageClaimSeconds = 5 * 60;
const hostTerminalStates = new Set(['stopped', 'failed', 'lost']);
const forEachConcurrent = async (values, concurrency, operation) => {
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        for (;;) {
            const current = index++;
            const value = values[current];
            if (value === undefined)
                return;
            await operation(value);
        }
    });
    await Promise.all(workers);
};
export class MachineReconciler {
    database;
    host;
    usage;
    metering;
    machines;
    constructor(database, host, usage, metering) {
        this.database = database;
        this.host = host;
        this.usage = usage;
        this.metering = metering;
        this.machines = new PostgresMachineRepository(database);
    }
    async run() {
        await this.database.withAdvisoryLock(reconcileAdvisoryLock, async () => this.runLocked());
    }
    async runLocked() {
        await this.markLostOnStaleHosts();
        await this.closeUnfinalizedAuthoritativeTerminals();
        await this.releaseLeakedReservations();
        // During a rolling host upgrade, only leases with an accepted authoritative
        // start leave the legacy producer. Flushing always remains enabled so rows
        // committed before that exact cutover cannot be stranded.
        await this.enqueueUsageIntervals(Boolean(this.metering));
        await this.flushUsageOutbox();
        const forkOperations = await this.machines.claimPendingForks(20);
        await forEachConcurrent(forkOperations, reconcileConcurrency, async (operation) => {
            let failed = false;
            try {
                await this.reconcileFork(operation);
            }
            catch (error) {
                failed = true;
                log('warn', 'machine fork reconciliation attempt failed', {
                    forkOperationId: operation.id,
                    sourceMachineId: operation.sourceMachineId,
                    error: String(error)
                });
            }
            finally {
                if (operation.reconcileClaimToken) {
                    await this.machines
                        .releaseForkClaim(operation.id, operation.reconcileClaimToken, failed)
                        .catch((error) => log('warn', 'machine fork reconciliation claim release failed', {
                        forkOperationId: operation.id,
                        error: String(error)
                    }));
                }
            }
        });
        const machines = await this.claimReconcileBatch();
        await forEachConcurrent(machines, reconcileConcurrency, async (machine) => {
            let failed = false;
            try {
                await this.reconcile(machine);
            }
            catch (error) {
                failed = true;
                log('warn', 'machine reconciliation attempt failed', {
                    machineId: machine.id,
                    hostId: machine.host_id,
                    error: String(error)
                });
            }
            finally {
                await this.releaseReconcileClaim(machine, failed).catch((error) => log('warn', 'machine reconciliation claim release failed', {
                    machineId: machine.id,
                    error: String(error)
                }));
            }
        });
    }
    async closeUnfinalizedAuthoritativeTerminals() {
        if (!this.metering)
            return;
        const result = await this.database.query(`SELECT machine.id, machine.lease_id
			 FROM machines machine
			 JOIN machine_meter_state meter ON meter.machine_id = machine.id
			 JOIN hosts host ON host.id = machine.host_id
			 WHERE machine.state IN ('stopped', 'failed', 'lost')
			   AND machine.usage_finalized_at IS NULL AND meter.start_seen
			   AND (
			     machine.state = 'lost'
			     OR host.state = 'stale'
			     OR host.desired_state IN ('quarantined', 'revoked')
			     OR host.credential_status = 'revoked'
			   )
			 ORDER BY machine.stopped_at NULLS LAST, machine.id LIMIT 100`);
        for (const machine of result.rows) {
            await this.metering.closeHostLoss(machine.id, machine.lease_id);
        }
    }
    async reconcileFork(operation) {
        let active = operation;
        if (active.cleanupRequested) {
            active = await this.machines.requestForkCleanup(active.id, active.cleanupFailureStatus ?? 502, active.cleanupFailureCode ?? 'fork_batch_failed', active.cleanupFailureMessage ?? 'The fork batch is awaiting confirmed host cleanup.');
            if (active.state !== 'pending' || !active.cleanupClaimToken)
                return;
        }
        let observed;
        try {
            observed = await this.host.fork(active.sourceHostAddress, active.sourceHostMachineId, active.sourceLeaseId, active.idempotencyKey, active.children.map((child) => ({
                leaseId: child.leaseId,
                leaseGeneration: child.leaseGeneration ?? 1,
                expiresAt: child.expiresAt,
                metadata: {
                    public_machine_id: child.id,
                    parent_machine_id: active.sourceMachineId,
                    fork_operation_id: active.id
                },
                resources: child.resources,
                networkPolicy: child.networkPolicy ?? { mode: 'off', hostnames: [], cidrs: [] },
                runtimeCohortId: child.runtimeCohortId,
                sourceSha256: child.sourceSha256
            })));
        }
        catch (error) {
            if (error instanceof HostRequestError && error.code === 'fork_batch_cleaned') {
                await this.finishForkCleanup(active, 502, 'fork_batch_failed', 'The host removed every reserved child after the fork could not complete.', [], true);
                return;
            }
            if (error instanceof HostForkContractError) {
                await this.finishForkCleanup(active, 502, 'fork_batch_failed', 'The host never returned a valid, complete fork batch.', error.observed);
                return;
            }
            if (error instanceof HostRequestError && error.ambiguous) {
                if (active.cleanupClaimToken) {
                    await this.machines.releaseForkCleanupClaim(active.id, active.cleanupClaimToken);
                }
                await this.finishForkCleanup({ ...active, cleanupClaimToken: undefined }, 502, 'fork_batch_failed', 'The host result is ambiguous; the fork remains hidden until cleanup is confirmed.', []);
                return;
            }
            if (active.cleanupRequested) {
                if (active.cleanupClaimToken) {
                    await this.machines.releaseForkCleanupClaim(active.id, active.cleanupClaimToken);
                }
                return;
            }
            if (error instanceof HostRequestError && !error.ambiguous) {
                const sourceRejected = [404, 409, 422, 501].includes(error.status ?? 0);
                await this.machines.failFork(active.id, sourceRejected ? 422 : 502, sourceRejected ? 'machine_not_forkable' : 'host_request_failed', sourceRejected
                    ? 'The source host can no longer create this live snapshot.'
                    : 'The source host rejected the fork request.');
                return;
            }
            throw error;
        }
        if (active.cleanupRequested) {
            await this.finishForkCleanup(active, active.cleanupFailureStatus ?? 502, active.cleanupFailureCode ?? 'fork_batch_failed', active.cleanupFailureMessage ?? 'The fork batch is awaiting confirmed host cleanup.', observed);
            return;
        }
        const terminal = observed.some((machine) => ['stopped', 'failed', 'lost'].includes(machine.status));
        const allReady = observed.every((machine) => machine.ready === true && machine.status === 'running');
        if (terminal || (!allReady && active.deadlineReached)) {
            await this.finishForkCleanup(active, 502, 'fork_batch_failed', terminal
                ? 'A fork child became terminal before the entire batch was ready.'
                : 'The fork batch did not become ready before its shared startup deadline.', observed);
            return;
        }
        try {
            await this.machines.completeFork(active.id, observed);
        }
        catch (error) {
            if (!(error instanceof HostRequestError && error.ambiguous))
                throw error;
            await this.finishForkCleanup(active, 502, 'fork_batch_failed', 'The host fork batch did not match the durable child reservation.', observed);
        }
    }
    async finishForkCleanup(operation, status, code, message, observed, hostConfirmed = false) {
        const cleanup = operation.cleanupRequested && operation.cleanupClaimToken
            ? operation
            : await this.machines.requestForkCleanup(operation.id, status, code, message);
        if (cleanup.state !== 'pending' || !cleanup.cleanupClaimToken)
            return;
        const cleaned = hostConfirmed || (await this.cleanupForkObservations(cleanup, observed));
        if (!cleaned) {
            await this.machines.releaseForkCleanupClaim(cleanup.id, cleanup.cleanupClaimToken);
            return;
        }
        await this.machines.completeForkCleanup(cleanup.id, cleanup.cleanupClaimToken);
    }
    async cleanupForkObservations(operation, observed) {
        const expected = new Map(operation.children.map((child) => [child.id, child]));
        let complete = observed.length === operation.children.length;
        const destroyed = new Set();
        const cleanedChildren = new Set();
        for (const machine of observed) {
            const publicMachineId = machine.metadata?.public_machine_id;
            const child = publicMachineId ? expected.get(publicMachineId) : undefined;
            if (!machine.id ||
                !child ||
                machine.lease_id !== child.leaseId ||
                destroyed.has(machine.id) ||
                cleanedChildren.has(child.id)) {
                complete = false;
                continue;
            }
            destroyed.add(machine.id);
            cleanedChildren.add(child.id);
            try {
                await this.host.destroy(operation.sourceHostAddress, machine.id, child.leaseId);
            }
            catch (error) {
                if (!(error instanceof HostRequestError && error.status === 404))
                    complete = false;
            }
        }
        return (complete &&
            destroyed.size === operation.children.length &&
            cleanedChildren.size === operation.children.length);
    }
    async claimReconcileBatch() {
        const claimToken = randomUUID();
        return this.database.transaction(async (client) => {
            const result = await client.query(`WITH candidates AS (
				   SELECT m.id FROM machines m JOIN hosts h ON h.id = m.host_id
				   WHERE m.state IN ('starting', 'stopping', 'running')
				     AND NOT EXISTS (
				       SELECT 1 FROM machine_fork_operations fork
				       WHERE fork.id = m.fork_operation_id AND fork.state = 'pending'
				     )
				     AND (m.state = 'running' OR m.placed_at < now() - interval '15 seconds')
				     AND m.reconcile_after <= now()
				     AND (m.reconcile_claimed_until IS NULL OR m.reconcile_claimed_until < now())
				   ORDER BY m.reconcile_after,
				     CASE m.state WHEN 'stopping' THEN 0 WHEN 'starting' THEN 1 ELSE 2 END,
				     m.created_at, m.id
				   FOR UPDATE OF m SKIP LOCKED LIMIT $1
				 ), claimed AS (
				   UPDATE machines m SET reconcile_claim_token = $2,
				     reconcile_claimed_until = now() + ($3 * interval '1 second'),
				     reconcile_after = now() + interval '10 seconds'
				   FROM candidates c WHERE m.id = c.id RETURNING m.*
				 )
				 SELECT m.id, m.organization_id, m.project_id, m.host_id,
				   host(h.address) AS host_address, m.host_machine_id, m.runtime_cohort_id,
				   m.source_sha256, m.lease_id,
				   m.lease_generation::text, m.state,
				   m.template_name, m.template_id,
				   (SELECT host_template_name FROM templates t WHERE t.id = m.template_id) AS host_template_name,
				   m.source_oci_ref, m.network_policy, m.requested_ttl_seconds, m.vcpus, m.memory_mb,
				   m.disk_mb::float8 AS disk_mb,
				   m.created_at, m.placed_at, m.started_at, m.startup_deadline_at,
				   COALESCE(m.startup_deadline_at,
				     m.placed_at + interval '2 minutes', m.created_at + interval '2 minutes') <= now()
				     AS startup_deadline_reached,
				   m.reconcile_claim_token
				 FROM claimed m JOIN hosts h ON h.id = m.host_id
				 ORDER BY m.reconcile_after, m.created_at, m.id`, [reconcileBatchSize, claimToken, reconcileClaimSeconds]);
            return result.rows;
        });
    }
    async releaseReconcileClaim(machine, failed) {
        await this.database.query(`UPDATE machines SET reconcile_claim_token = NULL, reconcile_claimed_until = NULL,
			 reconcile_after = CASE WHEN $4 THEN
			   GREATEST(reconcile_after, now() + interval '30 seconds') ELSE reconcile_after END
			 WHERE id = $1 AND lease_id = $2 AND reconcile_claim_token = $3`, [machine.id, machine.lease_id, machine.reconcile_claim_token, failed]);
    }
    async reconcile(machine) {
        let current = machine;
        let hostMachineId = machine.host_machine_id;
        let recovered;
        if (!hostMachineId) {
            recovered = await this.host.create(machine.host_address, {
                leaseId: machine.lease_id,
                leaseGeneration: Number(machine.lease_generation),
                idempotencyKey: machine.id,
                template: machine.template_name ?? machine.host_template_name ?? undefined,
                ociReference: machine.source_oci_ref ?? undefined,
                ttlSeconds: machine.requested_ttl_seconds,
                resources: {
                    vcpus: machine.vcpus,
                    memoryMb: machine.memory_mb,
                    diskMb: machine.disk_mb
                },
                networkPolicy: machine.network_policy,
                metadata: { public_machine_id: machine.id },
                runtimeCohortId: machine.runtime_cohort_id,
                sourceSha256: machine.source_sha256
            });
            hostMachineId = recovered.id;
            const persisted = await this.database.query(`UPDATE machines SET host_machine_id = $2,
				 started_at = COALESCE(started_at, $3, now())
				 WHERE id = $1 AND lease_id = $4
				   AND state IN ('starting', 'stopping', 'running')
				   AND (host_machine_id IS NULL OR host_machine_id = $2)
				 RETURNING state`, [
                machine.id,
                recovered.id,
                recovered.started_at ? new Date(recovered.started_at) : null,
                machine.lease_id
            ]);
            if (!persisted.rows[0]) {
                try {
                    await this.host.destroy(machine.host_address, recovered.id, machine.lease_id);
                }
                catch (error) {
                    if (!(error instanceof HostRequestError && error.status === 404))
                        throw error;
                }
                return;
            }
            current = {
                ...machine,
                state: persisted.rows[0].state,
                host_machine_id: recovered.id,
                started_at: recovered.started_at ? new Date(recovered.started_at) : machine.started_at
            };
        }
        if (current.state === 'stopping') {
            try {
                await this.host.destroy(current.host_address, hostMachineId, current.lease_id);
            }
            catch (error) {
                if (!(error instanceof HostRequestError && error.status === 404))
                    throw error;
            }
            await this.finishAndRelease(current, 'stopped', 'reconciled delete');
            return;
        }
        const observed = recovered ?? (await this.host.get(current.host_address, hostMachineId));
        let observedPolicyMatches = false;
        try {
            observedPolicyMatches =
                observed?.network_policy !== undefined &&
                    JSON.stringify(new EgressPolicy(observed.network_policy).declaration) ===
                        JSON.stringify(new EgressPolicy(current.network_policy).declaration);
        }
        catch {
            // A malformed policy observation is a contract mismatch below.
        }
        if (observed &&
            (observed.id !== hostMachineId ||
                observed.lease_id !== current.lease_id ||
                observed.lease_generation !== Number(current.lease_generation) ||
                observed.metadata?.public_machine_id !== current.id ||
                observed.resources?.vcpus !== current.vcpus ||
                observed.resources?.memory_mb !== current.memory_mb ||
                observed.resources?.disk_mb !== current.disk_mb ||
                !observedPolicyMatches)) {
            throw new Error('host observation does not match the current machine lease, resources, and network policy');
        }
        if (observed && hostTerminalStates.has(observed.status)) {
            await this.finishAndRelease(current, observed.status === 'stopped' ? 'stopped' : 'failed', `host reported ${observed.status}`);
            return;
        }
        if (observed && current.state === 'running') {
            await this.database.query(`UPDATE machines SET ready = $2,
				 ready_at = CASE WHEN $2 THEN COALESCE(ready_at, $3, now()) ELSE NULL END
				 WHERE id = $1 AND lease_id = $4 AND state = 'running'`, [
                current.id,
                observed.ready === true,
                observed.ready_at ? new Date(observed.ready_at) : null,
                current.lease_id
            ]);
            return;
        }
        if (observed && current.state === 'starting') {
            const ready = observed.ready === true;
            if (!ready && current.startup_deadline_reached) {
                try {
                    await this.host.destroy(current.host_address, hostMachineId, current.lease_id);
                }
                catch (error) {
                    if (!(error instanceof HostRequestError && error.status === 404))
                        throw error;
                }
                await this.finishAndRelease(current, 'failed', 'guest agent readiness deadline exceeded');
                return;
            }
            await this.database.transaction(async (client) => {
                const result = await client.query(`UPDATE machines SET state = $2, ready = $3,
					 started_at = COALESCE(started_at, $4, now()),
					 ready_at = CASE WHEN $3 THEN COALESCE(ready_at, $5, now()) ELSE NULL END
					 WHERE id = $1 AND lease_id = $6 AND state = 'starting'`, [
                    current.id,
                    ready ? 'running' : 'starting',
                    ready,
                    observed.started_at ? new Date(observed.started_at) : null,
                    observed.ready_at ? new Date(observed.ready_at) : null,
                    current.lease_id
                ]);
                if (ready && result.rowCount) {
                    await this.event(current, 'starting', 'running', 'guest agent ready', client);
                }
                return result;
            });
            return;
        }
        if (current.state === 'running') {
            await this.finishAndRelease(current, 'lost', 'host no longer has the running machine');
            return;
        }
        if (current.state === 'starting' && current.startup_deadline_reached) {
            await this.finishAndRelease(current, 'failed', 'host no longer has the assigned machine');
        }
    }
    async markLostOnStaleHosts() {
        const lost = await this.database.transaction(async (client) => {
            await client.query(`INSERT INTO machine_events
				 (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
				 SELECT m.id || ':stale-host:lost', m.id, m.organization_id, m.state,
				        'lost', 'host heartbeat expired', 'reconciler'
				 FROM machines m JOIN hosts h ON h.id = m.host_id
				 WHERE h.state = 'stale' AND m.state NOT IN ('stopped', 'failed', 'lost')
				   AND NOT EXISTS (
				     SELECT 1 FROM machine_fork_operations fork
				     WHERE fork.id = m.fork_operation_id AND fork.state = 'pending'
				   )
				 ON CONFLICT (event_key) DO NOTHING`);
            return client.query(`UPDATE machines m SET state = 'lost', state_reason = 'host heartbeat expired',
			 stopped_at = COALESCE(
			   (SELECT state.last_period_end FROM machine_meter_state state
			    WHERE state.machine_id = m.id), m.started_at, m.placed_at, m.created_at
			 ), ready = false, ready_at = NULL
			 FROM hosts h WHERE m.host_id = h.id AND h.state = 'stale'
			 AND m.state NOT IN ('stopped', 'failed', 'lost')
			 AND NOT EXISTS (
			   SELECT 1 FROM machine_fork_operations fork
			   WHERE fork.id = m.fork_operation_id AND fork.state = 'pending'
			 )
			 RETURNING m.id, m.organization_id, m.project_id, m.host_id,
			 host(h.address) AS host_address, m.host_machine_id, m.lease_id,
			 m.lease_generation::text,
			 'running'::text AS state, m.template_name, m.template_id,
			 (SELECT host_template_name FROM templates t WHERE t.id = m.template_id) AS host_template_name,
			 m.source_oci_ref,
			 m.requested_ttl_seconds, m.vcpus, m.memory_mb,
			 m.disk_mb::float8 AS disk_mb,
			 m.created_at, m.placed_at, m.started_at`);
        });
        for (const machine of lost.rows) {
            await this.metering?.closeHostLoss(machine.id, machine.lease_id);
            await this.release(machine);
        }
    }
    async finishAndRelease(machine, state, reason) {
        const lossCutoff = state === 'lost' && this.metering
            ? await this.metering.closeHostLoss(machine.id, machine.lease_id)
            : undefined;
        const changed = await this.database.transaction(async (client) => {
            const result = await client.query(`WITH prior AS (
				   SELECT id, state AS old_state FROM machines
				   WHERE id = $1 AND lease_id = $4
				     AND state NOT IN ('stopped', 'failed', 'lost') FOR UPDATE
				 ), updated AS (
				   UPDATE machines m SET state = $2::machine_state, state_reason = $3,
				     stopped_at = CASE WHEN $2::machine_state = 'lost'
				       THEN COALESCE($5::timestamptz, m.started_at, m.placed_at, m.created_at)
				       ELSE now() END,
				     ready = false, ready_at = NULL
				   FROM prior WHERE m.id = prior.id RETURNING prior.old_state
				 ) SELECT old_state FROM updated`, [machine.id, state, reason, machine.lease_id, lossCutoff ?? null]);
            const prior = result.rows[0];
            if (prior) {
                await client.query(`INSERT INTO machine_events
					 (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
					 VALUES ($1, $2, $3, $4, $5, $6, 'reconciler') ON CONFLICT DO NOTHING`, [
                    `${machine.id}:reconciled:${state}`,
                    machine.id,
                    machine.organization_id,
                    prior.old_state,
                    state,
                    reason
                ]);
            }
            return Boolean(prior);
        });
        if (!changed)
            return;
        await this.release(machine);
    }
    async releaseLeakedReservations() {
        const result = await this.database.query(`SELECT m.id, m.organization_id, m.project_id, m.host_id,
			 host(h.address) AS host_address, m.host_machine_id, m.lease_id,
			 m.lease_generation::text,
			 'running'::text AS state, m.template_name, m.template_id,
			 (SELECT host_template_name FROM templates t WHERE t.id = m.template_id) AS host_template_name,
			 m.source_oci_ref,
			 m.requested_ttl_seconds, m.vcpus, m.memory_mb,
			 m.disk_mb::float8 AS disk_mb,
			 m.created_at, m.placed_at, m.started_at
			 FROM machines m JOIN hosts h ON h.id = m.host_id
			 WHERE m.state IN ('stopped', 'failed', 'lost')
			   AND m.reservation_released_at IS NULL LIMIT 100`);
        for (const machine of result.rows)
            await this.release(machine);
    }
    async release(machine) {
        await this.database.transaction(async (client) => {
            const claimed = await client.query(`UPDATE machines SET reservation_released_at = now()
				 WHERE id = $1 AND reservation_released_at IS NULL`, [machine.id]);
            if (!claimed.rowCount)
                return;
            await client.query(`UPDATE hosts SET reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
				 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
				 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4), updated_at = now()
				 WHERE id = $1`, [machine.host_id, machine.vcpus, machine.memory_mb, machine.disk_mb]);
        });
    }
    async event(machine, from, to, reason, database = this.database) {
        await database.query(`INSERT INTO machine_events
			 (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
			 VALUES ($1, $2, $3, $4, $5, $6, 'reconciler') ON CONFLICT DO NOTHING`, [`${machine.id}:reconciled:${to}`, machine.id, machine.organization_id, from, to, reason]);
    }
    async enqueueUsageIntervals(excludeAuthoritativeLeases = false) {
        await this.database.transaction(async (client) => {
            const clock = await client.query('SELECT now() AS now');
            const checkpointEnd = clock.rows[0].now;
            const terminal = await client.query(`SELECT id, organization_id, project_id, vcpus, memory_mb,
				        COALESCE(usage_checkpoint_at, started_at) AS period_start,
				        stopped_at AS period_end
					 FROM machines
					 WHERE state IN ('stopped', 'failed', 'lost') AND started_at IS NOT NULL
					   AND stopped_at IS NOT NULL AND usage_finalized_at IS NULL
					   AND usage_quarantined_at IS NULL
					   AND (NOT $1::boolean OR NOT EXISTS (
					     SELECT 1 FROM machine_meter_state meter
					     WHERE meter.machine_id = machines.id AND meter.start_seen
					   ))
					   AND NOT EXISTS (
					     SELECT 1 FROM usage_outbox o WHERE o.machine_id = machines.id AND o.final
					   )
					 ORDER BY stopped_at, id FOR UPDATE SKIP LOCKED LIMIT 100`, [excludeAuthoritativeLeases]);
            for (const row of terminal.rows) {
                if (row.period_start > row.period_end ||
                    row.period_end.getTime() > checkpointEnd.getTime() + 30_000) {
                    await client.query(`UPDATE machines SET usage_quarantined_at = now(),
						 usage_quarantine_reason = $2
						 WHERE id = $1 AND usage_quarantined_at IS NULL`, [
                        row.id,
                        row.period_start > row.period_end
                            ? 'usage interval starts after it ends'
                            : 'usage interval ends in the future'
                    ]);
                    continue;
                }
                const key = `machine:${row.id}:final:${row.period_end.toISOString()}`;
                await client.query(`INSERT INTO usage_outbox
					 (event_key, organization_id, project_id, machine_id, vcpus, memory_mb,
					  period_start, period_end, final, source)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'reconciler')
					 ON CONFLICT (event_key) DO NOTHING`, [
                    key,
                    row.organization_id,
                    row.project_id,
                    row.id,
                    row.vcpus,
                    row.memory_mb,
                    row.period_start,
                    row.period_end
                ]);
                await client.query('UPDATE machines SET usage_checkpoint_at = $2 WHERE id = $1', [
                    row.id,
                    row.period_end
                ]);
            }
            const active = await client.query(`SELECT id, organization_id, project_id, vcpus, memory_mb,
				        COALESCE(usage_checkpoint_at, started_at) AS period_start
					 FROM machines WHERE state = 'running' AND started_at IS NOT NULL
					   AND usage_quarantined_at IS NULL
					   AND (NOT $1::boolean OR NOT EXISTS (
					     SELECT 1 FROM machine_meter_state meter
					     WHERE meter.machine_id = machines.id AND meter.start_seen
					   ))
					   AND COALESCE(usage_checkpoint_at, started_at) < now() - interval '5 minutes'
					 ORDER BY COALESCE(usage_checkpoint_at, started_at), id
					 FOR UPDATE SKIP LOCKED LIMIT 100`, [excludeAuthoritativeLeases]);
            for (const row of active.rows) {
                const key = `machine:${row.id}:checkpoint:${checkpointEnd.toISOString()}`;
                await client.query(`INSERT INTO usage_outbox
					 (event_key, organization_id, project_id, machine_id, vcpus, memory_mb,
					  period_start, period_end, final, source)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 'reconciler')`, [
                    key,
                    row.organization_id,
                    row.project_id,
                    row.id,
                    row.vcpus,
                    row.memory_mb,
                    row.period_start,
                    checkpointEnd
                ]);
                await client.query('UPDATE machines SET usage_checkpoint_at = $2 WHERE id = $1', [
                    row.id,
                    checkpointEnd
                ]);
            }
        });
    }
    async flushUsageOutbox() {
        const usage = this.usage;
        if (!usage)
            return;
        const claimToken = randomUUID();
        const pending = await this.database.transaction(async (client) => {
            return client.query(`WITH candidates AS (
				   SELECT o.event_key FROM usage_outbox o
				   WHERE o.processed_at IS NULL AND o.next_attempt_at <= now()
				     AND (o.claimed_until IS NULL OR o.claimed_until < now())
				     AND (NOT o.final OR NOT EXISTS (
				       SELECT 1 FROM usage_outbox prior
				       WHERE prior.machine_id = o.machine_id AND prior.processed_at IS NULL
				         AND NOT prior.final
				     ))
				   ORDER BY o.next_attempt_at, o.created_at, o.event_key
				   FOR UPDATE OF o SKIP LOCKED LIMIT $1
				 ), claimed AS (
				   UPDATE usage_outbox o SET claim_token = $2,
				     claimed_until = now() + ($3 * interval '1 second')
				   FROM candidates c WHERE o.event_key = c.event_key
				   RETURNING o.*
				 )
				 SELECT event_key, organization_id, project_id, machine_id, vcpus,
				   memory_mb, period_start, period_end, final, source, attempts, claim_token
				 FROM claimed ORDER BY next_attempt_at, created_at, event_key`, [reconcileBatchSize, claimToken, usageClaimSeconds]);
        });
        await forEachConcurrent(pending.rows, reconcileConcurrency, async (event) => {
            try {
                await usage.recordMachineRuntime({
                    eventPrefix: event.event_key,
                    organizationId: event.organization_id,
                    projectId: event.project_id,
                    machineId: event.machine_id,
                    vcpus: event.vcpus,
                    memoryMb: event.memory_mb,
                    start: event.period_start,
                    end: event.period_end,
                    source: event.source
                });
                await this.database.transaction(async (client) => {
                    const processed = await client.query(`UPDATE usage_outbox SET processed_at = now(), attempts = attempts + 1,
						 last_error = NULL, claim_token = NULL, claimed_until = NULL
						 WHERE event_key = $1 AND claim_token = $2 AND processed_at IS NULL
						 RETURNING machine_id`, [event.event_key, event.claim_token]);
                    if (processed.rowCount) {
                        await client.query(`UPDATE machines m SET usage_finalized_at = now()
							 WHERE m.id = $1 AND m.usage_finalized_at IS NULL
							   AND EXISTS (
							     SELECT 1 FROM usage_outbox done
							     WHERE done.machine_id = m.id AND done.final AND done.processed_at IS NOT NULL
							   )
							   AND NOT EXISTS (
							     SELECT 1 FROM usage_outbox pending
							     WHERE pending.machine_id = m.id AND pending.processed_at IS NULL
							   )`, [event.machine_id]);
                    }
                });
            }
            catch (error) {
                const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
                await this.database.query(`UPDATE usage_outbox SET attempts = attempts + 1, last_error = $3,
					 next_attempt_at = now() + ($4 * interval '1 second'),
					 claim_token = NULL, claimed_until = NULL
					 WHERE event_key = $1 AND claim_token = $2 AND processed_at IS NULL`, [event.event_key, event.claim_token, String(error).slice(0, 1_024), delaySeconds]);
            }
        });
    }
}
//# sourceMappingURL=reconcile-machines.js.map
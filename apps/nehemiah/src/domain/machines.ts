import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HostClient, HostExecResult, HostMachine } from '../clients/nehemiahd.js';
import { HostForkContractError, HostRequestError } from '../clients/nehemiahd.js';
import { BillingAdmissionPolicy, BillingAdmissionRejected } from '../billing/admission.js';
import type { UsageLedger } from '../billing/usage.js';
import { Database, type Queryable } from '../db/client.js';
import type { MachineState } from '../db/schema.js';
import { EgressPolicy, type NetworkPolicyDeclaration } from './network-policy.js';
import { validateResources, type Resources } from '../scheduler/capacity.js';
import {
	CapacityUnavailable,
	QuotaExceeded,
	type Reservation,
	type ScheduleRequest
} from '../scheduler/scheduler.js';

export interface Machine {
	readonly id: string;
	readonly organizationId: string;
	readonly projectId: string;
	readonly hostId?: string;
	readonly hostAddress?: string;
	readonly hostMachineId?: string;
	readonly runtimeCohortId?: string;
	readonly sourceSha256?: string;
	readonly leaseId: string;
	readonly leaseGeneration?: number;
	readonly state: MachineState;
	readonly stateReason?: string;
	readonly region: string;
	readonly architecture: 'x86_64' | 'aarch64';
	readonly resources: Resources;
	readonly networkPolicy?: NetworkPolicyDeclaration;
	readonly template?: string;
	readonly templateId?: string;
	readonly hostTemplateName?: string;
	readonly ociReference?: string;
	readonly requestedTtlSeconds?: number;
	readonly ready: boolean;
	readonly createdAt: Date;
	readonly startedAt?: Date;
	readonly readyAt?: Date;
	readonly stoppedAt?: Date;
	readonly expiresAt: Date;
	readonly idempotencyRequestHash?: string;
	readonly createFailureStatus?: number;
	readonly createFailureCode?: string;
	readonly createFailureMessage?: string;
	readonly parentId?: string;
	readonly forkOperationId?: string;
}

export interface CreateMachine {
	readonly organizationId: string;
	readonly projectId: string;
	readonly region: string;
	readonly architecture: 'x86_64' | 'aarch64';
	readonly resources: Resources;
	readonly template?: string;
	readonly templateId?: string;
	readonly ociReference?: string;
	readonly networkPolicy?: NetworkPolicyDeclaration;
	readonly ttlSeconds: number;
	readonly idempotencyKey: string;
}

export interface ExtendOperation {
	readonly id: string;
	readonly requestHash: string;
	readonly targetExpiresAt: Date;
	readonly resultExpiresAt?: Date;
	readonly replayed: boolean;
}

export interface ExtendMachineResult {
	readonly machine?: Machine;
	readonly replayed: boolean;
	readonly applied: boolean;
}

export type ForkOperationState = 'pending' | 'succeeded' | 'failed';

export interface ForkOperation {
	readonly id: string;
	readonly auditOperationId: string;
	readonly idempotencyKey: string;
	readonly requestHash: string;
	readonly state: ForkOperationState;
	readonly replayed: boolean;
	readonly sourceMachineId: string;
	readonly sourceHostId: string;
	readonly sourceHostAddress: string;
	readonly sourceHostMachineId: string;
	readonly sourceLeaseId: string;
	readonly children: ReadonlyArray<Machine>;
	readonly failureStatus?: number;
	readonly failureCode?: string;
	readonly failureMessage?: string;
	readonly reconcileClaimToken?: string;
	readonly cleanupRequested: boolean;
	readonly cleanupClaimToken?: string;
	readonly cleanupFailureStatus?: number;
	readonly cleanupFailureCode?: string;
	readonly cleanupFailureMessage?: string;
	readonly expired: boolean;
	readonly deadlineReached: boolean;
}

export interface ForkMachineResult {
	readonly operationId: string;
	readonly auditOperationId: string;
	readonly idempotencyKey: string;
	readonly machines: ReadonlyArray<Machine>;
	readonly replayed: boolean;
	readonly pending: boolean;
	readonly cleanupPending: boolean;
}

export interface MachineRepository {
	find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
	findByIdempotency(
		organizationId: string,
		projectId: string,
		key: string
	): Promise<Machine | undefined>;
	list(
		organizationId: string,
		projectId?: string,
		cursor?: string,
		limit?: number
	): Promise<Machine[]>;
	insertRequested(machine: Machine, idempotencyKey: string): Promise<void>;
	claimCreate(machineId: string): Promise<string | undefined>;
	releaseCreateClaim(machineId: string, claimToken: string): Promise<void>;
	failCreate(
		machineId: string,
		claimToken: string,
		status: number,
		code: string,
		message: string
	): Promise<boolean>;
	assign(machineId: string, reservation: Reservation): Promise<void>;
	observeHost(
		machineId: string,
		hostMachine: { id: string; ready?: boolean; started_at?: string; ready_at?: string }
	): Promise<void>;
	transition(
		machineId: string,
		from: ReadonlyArray<MachineState>,
		to: MachineState,
		reason?: string
	): Promise<boolean>;
	beginExtend(
		machineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		ttlSeconds: number
	): Promise<ExtendOperation | undefined>;
	completeExtend(
		operationId: string,
		machineId: string,
		organizationId: string,
		resultExpiresAt: Date
	): Promise<Date>;
	beginFork(
		sourceMachineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		count: number,
		auditOperationId: string
	): Promise<ForkOperation | undefined>;
	completeFork(operationId: string, observed: ReadonlyArray<HostMachine>): Promise<ForkOperation>;
	failFork(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation>;
	requestForkCleanup(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation>;
	completeForkCleanup(operationId: string, cleanupClaimToken: string): Promise<ForkOperation>;
	releaseForkCleanupClaim(operationId: string, cleanupClaimToken: string): Promise<void>;
	claimPendingForks(limit?: number): Promise<ReadonlyArray<ForkOperation>>;
	releaseForkClaim(operationId: string, claimToken: string, failed: boolean): Promise<void>;
}

type MachineRow = {
	id: string;
	organization_id: string;
	project_id: string;
	host_id: string | null;
	host_address: string | null;
	host_machine_id: string | null;
	runtime_cohort_id: string | null;
	source_sha256: string | null;
	lease_id: string;
	lease_generation: string;
	state: MachineState;
	state_reason: string | null;
	region_id: string;
	architecture: 'x86_64' | 'aarch64';
	vcpus: number;
	memory_mb: number;
	disk_mb: number;
	template_id: string | null;
	template_name: string | null;
	host_template_name: string | null;
	source_oci_ref: string | null;
	network_policy: NetworkPolicyDeclaration;
	requested_ttl_seconds: number;
	ready: boolean;
	created_at: Date;
	started_at: Date | null;
	ready_at: Date | null;
	stopped_at: Date | null;
	expires_at: Date;
	idempotency_request_hash: string;
	create_failure_status: number | null;
	create_failure_code: string | null;
	create_failure_message: string | null;
	parent_machine_id: string | null;
	fork_operation_id: string | null;
};

type ExtendOperationRow = {
	id: string;
	request_hash: string;
	target_expires_at: Date;
	result_expires_at: Date | null;
};

type ForkOperationRow = {
	id: string;
	audit_operation_id: string;
	idempotency_key: string;
	request_hash: string;
	state: ForkOperationState;
	source_machine_id: string;
	source_host_id: string;
	source_host_address: string;
	source_host_machine_id: string;
	source_lease_id: string;
	failure_status: number | null;
	failure_code: string | null;
	failure_message: string | null;
	reconcile_claim_token: string | null;
	cleanup_requested: boolean;
	cleanup_claim_token: string | null;
	cleanup_failure_status: number | null;
	cleanup_failure_code: string | null;
	cleanup_failure_message: string | null;
	expired: boolean;
	deadline_reached: boolean;
};

const fromExtendOperationRow = (row: ExtendOperationRow, replayed: boolean): ExtendOperation => ({
	id: row.id,
	requestHash: row.request_hash,
	targetExpiresAt: row.target_expires_at,
	resultExpiresAt: row.result_expires_at ?? undefined,
	replayed
});

const selectMachine = `SELECT m.*, host(h.address) AS host_address, t.host_template_name
 FROM machines m LEFT JOIN hosts h ON h.id = m.host_id
 LEFT JOIN templates t ON t.id = m.template_id`;

const fromRow = (row: MachineRow): Machine => ({
	id: row.id,
	organizationId: row.organization_id,
	projectId: row.project_id,
	hostId: row.host_id ?? undefined,
	hostAddress: row.host_address ?? undefined,
	hostMachineId: row.host_machine_id ?? undefined,
	runtimeCohortId: row.runtime_cohort_id ?? undefined,
	sourceSha256: row.source_sha256 ?? undefined,
	leaseId: row.lease_id,
	leaseGeneration: Number(row.lease_generation),
	state: row.state,
	stateReason: row.state_reason ?? undefined,
	region: row.region_id,
	architecture: row.architecture,
	resources: { vcpus: row.vcpus, memoryMb: row.memory_mb, diskMb: Number(row.disk_mb) },
	template: row.template_name ?? undefined,
	templateId: row.template_id ?? undefined,
	hostTemplateName: row.host_template_name ?? undefined,
	ociReference: row.source_oci_ref ?? undefined,
	networkPolicy: new EgressPolicy(row.network_policy).declaration,
	requestedTtlSeconds: row.requested_ttl_seconds,
	ready: row.ready,
	createdAt: row.created_at,
	startedAt: row.started_at ?? undefined,
	readyAt: row.ready_at ?? undefined,
	stoppedAt: row.stopped_at ?? undefined,
	expiresAt: row.expires_at,
	idempotencyRequestHash: row.idempotency_request_hash,
	createFailureStatus: row.create_failure_status ?? undefined,
	createFailureCode: row.create_failure_code ?? undefined,
	createFailureMessage: row.create_failure_message ?? undefined,
	parentId: row.parent_machine_id ?? undefined,
	forkOperationId: row.fork_operation_id ?? undefined
});

export class PostgresMachineRepository implements MachineRepository {
	constructor(
		private readonly database: Database,
		private readonly billingAdmission = new BillingAdmissionPolicy()
	) {}

	async find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined> {
		const result = await this.database.query<MachineRow>(
			`${selectMachine} WHERE m.id = $1 AND m.organization_id = $2
			 AND ($3::uuid IS NULL OR m.project_id = $3)
			 AND (m.fork_operation_id IS NULL OR EXISTS (
			   SELECT 1 FROM machine_fork_operations fork
			   WHERE fork.id = m.fork_operation_id AND fork.state = 'succeeded'
			 ))`,
			[id, organizationId, projectId ?? null]
		);
		return result.rows[0] ? fromRow(result.rows[0]) : undefined;
	}

	async findByIdempotency(
		organizationId: string,
		projectId: string,
		key: string
	): Promise<Machine | undefined> {
		const result = await this.database.query<MachineRow>(
			`${selectMachine} WHERE m.organization_id = $1 AND m.project_id = $2
			 AND m.idempotency_key = $3`,
			[organizationId, projectId, key]
		);
		return result.rows[0] ? fromRow(result.rows[0]) : undefined;
	}

	async list(
		organizationId: string,
		projectId?: string,
		cursor?: string,
		limit = 50
	): Promise<Machine[]> {
		const result = await this.database.query<MachineRow>(
			`${selectMachine} WHERE m.organization_id = $1
			 AND ($2::uuid IS NULL OR m.project_id = $2)
			 AND ($3::text IS NULL OR m.id < $3)
			 AND (m.fork_operation_id IS NULL OR EXISTS (
			   SELECT 1 FROM machine_fork_operations fork
			   WHERE fork.id = m.fork_operation_id AND fork.state = 'succeeded'
			 ))
			 ORDER BY m.id DESC LIMIT $4`,
			[organizationId, projectId ?? null, cursor ?? null, Math.min(Math.max(limit, 1), 100)]
		);
		return result.rows.map(fromRow);
	}

	async insertRequested(machine: Machine, idempotencyKey: string): Promise<void> {
		await this.database.transaction(async (client) => {
			if (machine.templateId) {
				// Serialize the durable machine row with template deletion. FOR SHARE
				// allows concurrent creates but conflicts with delete's FOR UPDATE and
				// with a direct soft-delete UPDATE.
				const template = await client.query(
					`SELECT t.id FROM templates t
					 WHERE t.id = $1 AND t.organization_id = $2 AND t.project_id = $3
					   AND t.deleted_at IS NULL
					 FOR SHARE OF t`,
					[machine.templateId, machine.organizationId, machine.projectId]
				);
				if (!template.rowCount) throw new Error('template is not available to this project');
			}
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, lease_id, idempotency_key,
				  idempotency_request_hash, state, region_id,
				  architecture, template_name, template_id, source_oci_ref, requested_ttl_seconds,
				  vcpus, memory_mb, disk_mb, network_policy, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $10, $11, $12,
				         $13, $14, $15, $16, $17)`,
				[
					machine.id,
					machine.organizationId,
					machine.projectId,
					machine.leaseId,
					idempotencyKey,
					machine.idempotencyRequestHash,
					machine.region,
					machine.architecture,
					machine.template ?? null,
					machine.templateId ?? null,
					machine.ociReference ?? null,
					machine.requestedTtlSeconds,
					machine.resources.vcpus,
					machine.resources.memoryMb,
					machine.resources.diskMb,
					JSON.stringify(machine.networkPolicy ?? { mode: 'off', hostnames: [], cidrs: [] }),
					machine.expiresAt
				]
			);
			await this.event(
				machine.id,
				machine.organizationId,
				undefined,
				'requested',
				undefined,
				client
			);
		});
	}

	async claimCreate(machineId: string): Promise<string | undefined> {
		const claimToken = randomUUID();
		const result = await this.database.query<{ create_claim_token: string }>(
			`UPDATE machines
			 SET create_claim_token = $2, create_claimed_until = now() + interval '5 minutes'
			 WHERE id = $1 AND state = 'requested' AND create_failure_status IS NULL
			   AND (create_claim_token IS NULL OR create_claimed_until <= now())
			 RETURNING create_claim_token`,
			[machineId, claimToken]
		);
		return result.rows[0]?.create_claim_token;
	}

	async releaseCreateClaim(machineId: string, claimToken: string): Promise<void> {
		await this.database.query(
			`UPDATE machines SET create_claim_token = NULL, create_claimed_until = NULL
			 WHERE id = $1 AND create_claim_token = $2`,
			[machineId, claimToken]
		);
	}

	async failCreate(
		machineId: string,
		claimToken: string,
		status: number,
		code: string,
		message: string
	): Promise<boolean> {
		return this.database.transaction(async (client) => {
			const result = await client.query<{ organization_id: string; old_state: MachineState }>(
				`WITH prior AS (
				 SELECT id, organization_id, state AS old_state FROM machines
				 WHERE id = $1 AND create_claim_token = $2
				   AND state IN ('requested', 'placing', 'starting')
				 FOR UPDATE
				), updated AS (
				 UPDATE machines m SET state = 'failed', state_reason = $5, stopped_at = now(),
				   ready = false, ready_at = NULL,
				   create_failure_status = $3, create_failure_code = $4,
				   create_failure_message = $5,
				   create_claim_token = NULL, create_claimed_until = NULL
				 FROM prior WHERE m.id = prior.id
				 RETURNING prior.organization_id, prior.old_state
				) SELECT * FROM updated`,
				[machineId, claimToken, status, code, message]
			);
			const row = result.rows[0];
			if (!row) return false;
			await this.event(machineId, row.organization_id, row.old_state, 'failed', message, client);
			return true;
		});
	}

	async assign(machineId: string, reservation: Reservation): Promise<void> {
		await this.database.transaction(async (client) => {
			const result = await client.query<{ organization_id: string; state: MachineState }>(
				`UPDATE machines SET host_id = $2, runtime_cohort_id = $3,
				     source_sha256 = $4, state = 'starting', placed_at = now(),
					 startup_deadline_at = now() + interval '2 minutes'
					 WHERE id = $1 AND state IN ('requested', 'placing')
				 RETURNING organization_id, state`,
				[
					machineId,
					reservation.hostId,
					reservation.runtimeCohortId ?? null,
					reservation.sourceSha256 ?? null
				]
			);
			const row = result.rows[0];
			if (!row) throw new Error('machine could not be assigned');
			await this.event(machineId, row.organization_id, 'requested', 'starting', undefined, client);
		});
	}

	async observeHost(
		machineId: string,
		hostMachine: { id: string; ready?: boolean; started_at?: string; ready_at?: string }
	): Promise<void> {
		const ready = hostMachine.ready === true;
		await this.database.transaction(async (client) => {
			const result = await client.query<{ organization_id: string }>(
				`UPDATE machines SET host_machine_id = $2, state = $3, ready = $4,
			 started_at = COALESCE($5, started_at, now()), ready_at = $6, state_reason = NULL,
			 create_claim_token = NULL, create_claimed_until = NULL
			 WHERE id = $1 AND state = 'starting' RETURNING organization_id`,
				[
					machineId,
					hostMachine.id,
					ready ? 'running' : 'starting',
					ready,
					hostMachine.started_at ? new Date(hostMachine.started_at) : null,
					ready ? (hostMachine.ready_at ? new Date(hostMachine.ready_at) : new Date()) : null
				]
			);
			if (ready && result.rows[0]) {
				await this.event(
					machineId,
					result.rows[0].organization_id,
					'starting',
					'running',
					undefined,
					client
				);
			}
		});
	}

	async transition(
		machineId: string,
		from: ReadonlyArray<MachineState>,
		to: MachineState,
		reason?: string
	): Promise<boolean> {
		return this.database.transaction(async (client) => {
			const result = await client.query<{ organization_id: string; old_state: MachineState }>(
				`WITH prior AS (SELECT id, organization_id, state AS old_state FROM machines
			 WHERE id = $1 AND state = ANY($2::machine_state[]) FOR UPDATE), updated AS (
				 UPDATE machines m SET state = $3::machine_state, state_reason = $4,
				 stopping_at = CASE
				   WHEN $3::machine_state = 'stopping' THEN now() ELSE stopping_at END,
				 stopped_at = CASE
				   WHEN $3::machine_state IN ('stopped', 'failed', 'lost') THEN now() ELSE stopped_at END,
				 ready = CASE WHEN $3::machine_state = 'running' THEN ready ELSE false END,
				 ready_at = CASE WHEN $3::machine_state = 'running' THEN ready_at ELSE NULL END,
				 create_claim_token = CASE
				   WHEN $3::machine_state IN ('stopped', 'failed', 'lost')
				   THEN NULL ELSE create_claim_token END,
				 create_claimed_until = CASE
				   WHEN $3::machine_state IN ('stopped', 'failed', 'lost')
				   THEN NULL ELSE create_claimed_until END
			 FROM prior WHERE m.id = prior.id
			 RETURNING prior.organization_id, prior.old_state
			) SELECT * FROM updated`,
				[machineId, from, to, reason ?? null]
			);
			const row = result.rows[0];
			if (!row) return false;
			await this.event(machineId, row.organization_id, row.old_state, to, reason, client);
			return true;
		});
	}

	async beginExtend(
		machineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		ttlSeconds: number
	): Promise<ExtendOperation | undefined> {
		return this.database.transaction(async (client) => {
			const organization = await client.query(
				'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
				[organizationId]
			);
			if (!organization.rows[0]) return undefined;
			const locked = await client.query<{
				expires_at: Date;
				state: MachineState;
				host_id: string | null;
				host_machine_id: string | null;
				vcpus: number;
				memory_mb: number;
			}>(
				`SELECT expires_at, state, host_id, host_machine_id, vcpus, memory_mb
				 FROM machines
				 WHERE id = $1 AND organization_id = $2 AND project_id = $3
				 FOR UPDATE`,
				[machineId, organizationId, projectId]
			);
			if (!locked.rows[0]) return undefined;

			const prior = await client.query<ExtendOperationRow>(
				`SELECT id::text, request_hash, target_expires_at, result_expires_at
				 FROM machine_extend_operations
				 WHERE organization_id = $1 AND machine_id = $2 AND idempotency_key = $3`,
				[organizationId, machineId, idempotencyKey]
			);
			if (prior.rows[0]) return fromExtendOperationRow(prior.rows[0], true);
			if (
				!['starting', 'running'].includes(locked.rows[0].state) ||
				!locked.rows[0].host_id ||
				!locked.rows[0].host_machine_id
			) {
				return undefined;
			}

			const target = await client.query<{
				target_expires_at: Date;
				additional_seconds: string;
			}>(
				`WITH admission_clock AS MATERIALIZED (
				   SELECT clock_timestamp() AS admitted_at
				 ), committed AS (
				   SELECT GREATEST(
				     $1::timestamptz,
				     COALESCE(MAX(target_expires_at), '-infinity'::timestamptz)
				   ) AS committed_until
				   FROM machine_extend_operations
				   WHERE organization_id = $2 AND machine_id = $3
				 ), target AS (
				   SELECT admitted_at, committed_until,
				          GREATEST(committed_until,
				            admitted_at + $4::integer * interval '1 second') AS target_expires_at
				   FROM admission_clock CROSS JOIN committed
				 )
				 SELECT target_expires_at,
				        CEIL(GREATEST(EXTRACT(EPOCH FROM (
				          target_expires_at - GREATEST(committed_until, admitted_at)
				        )), 0))::numeric::text AS additional_seconds
				 FROM target`,
				[locked.rows[0].expires_at, organizationId, machineId, ttlSeconds]
			);
			const targetExpiresAt = target.rows[0]?.target_expires_at;
			if (!targetExpiresAt) throw new Error('could not allocate an extend target');
			const additionalSeconds = BigInt(target.rows[0]!.additional_seconds);
			await this.billingAdmission.enforce(client, organizationId, {
				vcpuSeconds: additionalSeconds * BigInt(locked.rows[0].vcpus),
				memoryMebibyteSeconds: additionalSeconds * BigInt(locked.rows[0].memory_mb)
			});
			const inserted = await client.query<ExtendOperationRow>(
				`INSERT INTO machine_extend_operations
				 (organization_id, project_id, machine_id, idempotency_key, request_hash,
				  target_expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING id::text, request_hash, target_expires_at, result_expires_at`,
				[organizationId, projectId, machineId, idempotencyKey, requestHash, targetExpiresAt]
			);
			return fromExtendOperationRow(inserted.rows[0]!, false);
		});
	}

	async completeExtend(
		operationId: string,
		machineId: string,
		organizationId: string,
		resultExpiresAt: Date
	): Promise<Date> {
		return this.database.transaction(async (client) => {
			const locked = await client.query(
				`SELECT id FROM machines WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
				[machineId, organizationId]
			);
			if (!locked.rows[0]) throw new Error('machine disappeared while completing extend');
			const completed = await client.query<{ result_expires_at: Date }>(
				`UPDATE machine_extend_operations
				 SET result_expires_at = $4, completed_at = now()
				 WHERE id = $1::bigint AND machine_id = $2 AND organization_id = $3
				   AND completed_at IS NULL
				 RETURNING result_expires_at`,
				[operationId, machineId, organizationId, resultExpiresAt]
			);
			const recorded =
				completed.rows[0] ??
				(
					await client.query<{ result_expires_at: Date }>(
						`SELECT result_expires_at FROM machine_extend_operations
						 WHERE id = $1::bigint AND machine_id = $2 AND organization_id = $3
						   AND completed_at IS NOT NULL`,
						[operationId, machineId, organizationId]
					)
				).rows[0];
			if (!recorded) throw new Error('extend operation disappeared while completing');
			await client.query(
				`UPDATE machines SET expires_at = GREATEST(expires_at, $3)
				 WHERE id = $1 AND organization_id = $2
				   AND state NOT IN ('stopped', 'failed', 'lost')`,
				[machineId, organizationId, recorded.result_expires_at]
			);
			return recorded.result_expires_at;
		});
	}

	async beginFork(
		sourceMachineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		count: number,
		auditOperationId: string
	): Promise<ForkOperation | undefined> {
		return this.database.transaction(async (client) => {
			// Match ordinary placement's lock order and admission boundary. Sibling
			// projects share the organization allowance, so the organization row must
			// be locked before the project row for the entire batch.
			const organizationResult = await client.query<{
				max_machines: number;
				max_vcpus: number;
				max_memory_mb: number;
				max_disk_mb: string;
			}>(
				`SELECT organization.max_machines, organization.max_vcpus,
				        organization.max_memory_mb, organization.max_disk_mb
				 FROM organizations organization
				 WHERE organization.id = $1 FOR UPDATE OF organization`,
				[organizationId]
			);
			const organization = organizationResult.rows[0];
			if (!organization) return undefined;
			const limits = await client.query<{
				max_machines: number;
				max_vcpus: number;
				max_memory_mb: number;
				max_disk_mb: string;
			}>(
				`SELECT max_machines, max_vcpus, max_memory_mb, max_disk_mb
				 FROM projects WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
				[projectId, organizationId]
			);
			if (!limits.rows[0]) return undefined;

			const sourceResult = await client.query<
				MachineRow & {
					host_state: string;
					host_desired_state: string;
					host_credential_status: string;
					host_fresh: boolean;
					total_vcpus: number;
					total_memory_mb: number;
					total_disk_mb: string;
					reserved_vcpus: number;
					reserved_memory_mb: number;
					reserved_disk_mb: string;
					reported_available_vcpus: number | null;
					reported_available_memory_mb: number | null;
					reported_available_disk_mb: string | null;
					remaining_seconds: number;
				}
			>(
				`SELECT m.*, host(h.address) AS host_address, t.host_template_name,
				        h.state::text AS host_state,
				        h.desired_state::text AS host_desired_state,
				        h.credential_status::text AS host_credential_status,
				        h.last_heartbeat_at > now() - interval '30 seconds' AS host_fresh,
				        h.total_vcpus, h.total_memory_mb, h.total_disk_mb,
				        h.reserved_vcpus, h.reserved_memory_mb, h.reserved_disk_mb,
				        h.reported_available_vcpus, h.reported_available_memory_mb,
				        h.reported_available_disk_mb,
				        CEIL(EXTRACT(EPOCH FROM (m.expires_at - clock_timestamp())))::integer
				          AS remaining_seconds
				 FROM machines m JOIN hosts h ON h.id = m.host_id
				 LEFT JOIN templates t ON t.id = m.template_id
				 WHERE m.id = $1 AND m.organization_id = $2 AND m.project_id = $3
				 FOR UPDATE OF m, h`,
				[sourceMachineId, organizationId, projectId]
			);
			const source = sourceResult.rows[0];
			if (!source) return undefined;

			const prior = await client.query<{ id: string }>(
				`SELECT id FROM machine_fork_operations
				 WHERE organization_id = $1 AND project_id = $2 AND source_machine_id = $3
				   AND idempotency_key = $4`,
				[organizationId, projectId, sourceMachineId, idempotencyKey]
			);
			if (prior.rows[0]) return this.loadForkOperation(client, prior.rows[0].id, true);

			if (
				source.state !== 'running' ||
				!source.ready ||
				!source.host_id ||
				!source.host_address ||
				!source.host_machine_id ||
				!source.runtime_cohort_id ||
				!source.source_sha256 ||
				source.remaining_seconds < 15
			) {
				throw new MachineNotForkable('The source machine must be current, ready, and live.');
			}
			if (
				source.host_state !== 'ready' ||
				source.host_desired_state !== 'active' ||
				source.host_credential_status !== 'active' ||
				!source.host_fresh
			) {
				throw new CapacityUnavailable('The source host is not accepting new fork children.');
			}

			const usage = await client.query<{
				machines: string;
				vcpus: string;
				memory_mb: string;
				disk_mb: string;
			}>(
				`SELECT count(*) AS machines, COALESCE(sum(vcpus), 0) AS vcpus,
				        COALESCE(sum(memory_mb), 0) AS memory_mb,
				        COALESCE(sum(disk_mb), 0) AS disk_mb
				 FROM machines WHERE project_id = $1
				   AND state NOT IN ('requested', 'placing', 'stopped', 'failed', 'lost')`,
				[projectId]
			);
			const organizationUsage = await client.query<{
				machines: string;
				vcpus: string;
				memory_mb: string;
				disk_mb: string;
			}>(
				`SELECT count(*) AS machines, COALESCE(sum(vcpus), 0) AS vcpus,
				        COALESCE(sum(memory_mb), 0) AS memory_mb,
				        COALESCE(sum(disk_mb), 0) AS disk_mb
				 FROM machines WHERE organization_id = $1
				   AND state NOT IN ('requested', 'placing', 'stopped', 'failed', 'lost')`,
				[organizationId]
			);
			const project = limits.rows[0];
			const active = usage.rows[0]!;
			const organizationActive = organizationUsage.rows[0]!;
			if (
				Number(organizationActive.machines) + count > organization.max_machines ||
				Number(organizationActive.vcpus) + source.vcpus * count > organization.max_vcpus ||
				Number(organizationActive.memory_mb) + source.memory_mb * count >
					organization.max_memory_mb ||
				Number(organizationActive.disk_mb) + Number(source.disk_mb) * count >
					Number(organization.max_disk_mb)
			) {
				throw new QuotaExceeded('Organization machine quota would be exceeded.');
			}
			if (
				Number(active.machines) + count > project.max_machines ||
				Number(active.vcpus) + source.vcpus * count > project.max_vcpus ||
				Number(active.memory_mb) + source.memory_mb * count > project.max_memory_mb ||
				Number(active.disk_mb) + Number(source.disk_mb) * count > Number(project.max_disk_mb)
			) {
				throw new QuotaExceeded('Project machine quota would be exceeded.');
			}
			const committedSeconds = BigInt(Math.max(source.remaining_seconds, 0)) * BigInt(count);
			await this.billingAdmission.enforce(client, organizationId, {
				vcpuSeconds: committedSeconds * BigInt(source.vcpus),
				memoryMebibyteSeconds: committedSeconds * BigInt(source.memory_mb)
			});

			const neededVcpus = source.vcpus * count;
			const neededMemoryMb = source.memory_mb * count;
			const neededDiskMb = Number(source.disk_mb) * count;
			const availableVcpus = Math.min(
				source.total_vcpus - source.reserved_vcpus,
				source.reported_available_vcpus ?? source.total_vcpus - source.reserved_vcpus
			);
			const availableMemoryMb = Math.min(
				source.total_memory_mb - source.reserved_memory_mb,
				source.reported_available_memory_mb ?? source.total_memory_mb - source.reserved_memory_mb
			);
			const availableDiskMb = Math.min(
				Number(source.total_disk_mb) - Number(source.reserved_disk_mb),
				source.reported_available_disk_mb === null
					? Number(source.total_disk_mb) - Number(source.reserved_disk_mb)
					: Number(source.reported_available_disk_mb)
			);
			if (
				availableVcpus < neededVcpus ||
				availableMemoryMb < neededMemoryMb ||
				availableDiskMb < neededDiskMb
			) {
				throw new CapacityUnavailable('The source host cannot fit the entire fork batch.');
			}

			const operationId = randomUUID();
			await client.query(
				`INSERT INTO machine_fork_operations
					 (id, organization_id, project_id, source_machine_id, source_host_id,
					  source_host_machine_id, source_lease_id, idempotency_key, request_hash,
					  child_count, audit_operation_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
				[
					operationId,
					organizationId,
					projectId,
					sourceMachineId,
					source.host_id,
					source.host_machine_id,
					source.lease_id,
					idempotencyKey,
					requestHash,
					count,
					auditOperationId
				]
			);
			for (let ordinal = 0; ordinal < count; ordinal += 1) {
				const machineId = `m_${randomBytes(18).toString('base64url')}`;
				const leaseId = randomUUID();
				const childHash = createHash('sha256')
					.update(`${requestHash}:${ordinal}:${machineId}:${leaseId}`)
					.digest('hex');
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, lease_id, idempotency_key,
					  idempotency_request_hash, state, region_id, architecture, template_name,
					  template_id, source_oci_ref, requested_ttl_seconds, vcpus, memory_mb,
					  disk_mb, network_policy, expires_at, placed_at, startup_deadline_at, parent_machine_id,
					  fork_operation_id, runtime_cohort_id, source_sha256)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, 'starting', $8, $9, $10, $11,
					         $12, $13, $14, $15, $16, $17, $18, now(), now() + interval '2 minutes',
					         $19, $20, $21, $22)`,
					[
						machineId,
						organizationId,
						projectId,
						source.host_id,
						leaseId,
						`fork:${operationId}:${ordinal}`,
						childHash,
						source.region_id,
						source.architecture,
						source.template_name,
						source.template_id,
						source.source_oci_ref,
						Math.min(source.remaining_seconds, 86_400),
						source.vcpus,
						source.memory_mb,
						source.disk_mb,
						JSON.stringify(source.network_policy),
						source.expires_at,
						sourceMachineId,
						operationId,
						source.runtime_cohort_id,
						source.source_sha256
					]
				);
				await client.query(
					`INSERT INTO machine_fork_children (operation_id, ordinal, machine_id, lease_id)
					 VALUES ($1, $2, $3, $4)`,
					[operationId, ordinal, machineId, leaseId]
				);
				await client.query(
					`INSERT INTO machine_events
					 (event_key, machine_id, organization_id, from_state, to_state, observed_by,
					  metadata)
					 VALUES ($1, $2, $3, NULL, 'starting', 'control-plane', $4)`,
					[
						`${machineId}:fork-allocated`,
						machineId,
						organizationId,
						JSON.stringify({ fork_operation_id: operationId, parent_machine_id: sourceMachineId })
					]
				);
			}
			await client.query(
				`UPDATE hosts SET reserved_vcpus = reserved_vcpus + $2,
				 reserved_memory_mb = reserved_memory_mb + $3,
				 reserved_disk_mb = reserved_disk_mb + $4, updated_at = now()
				 WHERE id = $1`,
				[source.host_id, neededVcpus, neededMemoryMb, neededDiskMb]
			);
			return this.loadForkOperation(client, operationId, false);
		});
	}

	async completeFork(
		operationId: string,
		observed: ReadonlyArray<HostMachine>
	): Promise<ForkOperation> {
		await this.database.transaction(async (client) => {
			const operation = await client.query<{
				state: ForkOperationState;
				organization_id: string;
				source_machine_id: string;
				cleanup_requested: boolean;
			}>(
				`SELECT state, organization_id, source_machine_id,
				        cleanup_requested_at IS NOT NULL AS cleanup_requested
				 FROM machine_fork_operations
				 WHERE id = $1 FOR UPDATE`,
				[operationId]
			);
			const current = operation.rows[0];
			if (!current) throw new Error('fork operation disappeared while completing');
			if (current.state !== 'pending' || current.cleanup_requested) return;

			const expected = await client.query<{
				machine_id: string;
				lease_id: string;
				vcpus: number;
				memory_mb: number;
				disk_mb: number;
				expires_at: Date;
				host_machine_id: string | null;
				network_policy: NetworkPolicyDeclaration;
			}>(
				`SELECT child.machine_id, child.lease_id, machine.vcpus, machine.memory_mb,
				        machine.disk_mb::float8 AS disk_mb, machine.expires_at,
				        machine.host_machine_id, machine.network_policy
				 FROM machine_fork_children child
				 JOIN machines machine ON machine.id = child.machine_id
				 WHERE child.operation_id = $1 ORDER BY child.ordinal`,
				[operationId]
			);
			const byPublicId = new Map(
				observed.map((machine) => [machine.metadata?.public_machine_id, machine] as const)
			);
			const hostIds = new Set(observed.map(({ id }) => id));
			if (
				byPublicId.size !== expected.rows.length ||
				observed.length !== expected.rows.length ||
				hostIds.size !== expected.rows.length ||
				observed.some(({ id }) => id.length === 0)
			) {
				throw new HostRequestError(
					undefined,
					'host fork response did not contain the full batch',
					true
				);
			}
			for (const child of expected.rows) {
				const hostMachine = byPublicId.get(child.machine_id);
				const expiresAt = hostMachine?.expires_at ? new Date(hostMachine.expires_at) : undefined;
				let observedPolicy: NetworkPolicyDeclaration | undefined;
				try {
					if (hostMachine?.network_policy) {
						observedPolicy = new EgressPolicy(hostMachine.network_policy).declaration;
					}
				} catch {
					// The descriptor comparison below fails closed.
				}
				if (
					!hostMachine ||
					hostMachine.lease_id !== child.lease_id ||
					hostMachine.metadata?.parent_machine_id !== current.source_machine_id ||
					hostMachine.metadata?.fork_operation_id !== operationId ||
					(child.host_machine_id !== null && child.host_machine_id !== hostMachine.id) ||
					hostMachine.resources?.vcpus !== child.vcpus ||
					hostMachine.resources?.memory_mb !== child.memory_mb ||
					hostMachine.resources?.disk_mb !== child.disk_mb ||
					JSON.stringify(observedPolicy) !==
						JSON.stringify(new EgressPolicy(child.network_policy).declaration) ||
					!expiresAt ||
					!Number.isFinite(expiresAt.getTime()) ||
					expiresAt.getTime() !== child.expires_at.getTime()
				) {
					throw new HostRequestError(
						undefined,
						'host fork child identity or descriptor did not match',
						true
					);
				}
			}

			const allReady = observed.every(
				(machine) => machine.ready === true && machine.status === 'running'
			);
			for (const child of expected.rows) {
				const hostMachine = byPublicId.get(child.machine_id)!;
				const updated = await client.query(
					`UPDATE machines SET host_machine_id = $2,
					 state = CASE WHEN $3 THEN 'running'::machine_state ELSE state END,
					 ready = $3,
					 started_at = COALESCE(started_at, $5, now()),
					 ready_at = CASE WHEN $3 THEN COALESCE(ready_at, $6, now()) ELSE NULL END,
					 state_reason = NULL
					 WHERE id = $1 AND lease_id = $4 AND fork_operation_id = $7
					   AND state = 'starting'`,
					[
						child.machine_id,
						hostMachine.id,
						allReady,
						child.lease_id,
						hostMachine.started_at ? new Date(hostMachine.started_at) : null,
						hostMachine.ready_at ? new Date(hostMachine.ready_at) : null,
						operationId
					]
				);
				if (!updated.rowCount) throw new Error('fork child could not be completed');
				if (allReady) {
					await client.query(
						`INSERT INTO machine_events
						 (event_key, machine_id, organization_id, from_state, to_state, observed_by)
						 VALUES ($1, $2, $3, 'starting', 'running', 'control-plane')
						 ON CONFLICT DO NOTHING`,
						[`${child.machine_id}:fork-ready`, child.machine_id, current.organization_id]
					);
				}
			}
			if (!allReady) return;
			await client.query(
				`UPDATE machine_fork_operations SET state = 'succeeded', completed_at = now(),
				 reconcile_claim_token = NULL, reconcile_claimed_until = NULL
				 WHERE id = $1 AND state = 'pending'`,
				[operationId]
			);
			await this.recordForkTerminalAudit(client, operationId, 'succeeded');
		});
		return (await this.loadForkOperation(this.database, operationId, true))!;
	}

	async failFork(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation> {
		await this.database.transaction(async (client) => {
			const operation = await client.query<{
				state: ForkOperationState;
				organization_id: string;
				source_host_id: string;
				cleanup_requested: boolean;
			}>(
				`SELECT state, organization_id, source_host_id,
				        cleanup_requested_at IS NOT NULL AS cleanup_requested
				 FROM machine_fork_operations
				 WHERE id = $1 FOR UPDATE`,
				[operationId]
			);
			const current = operation.rows[0];
			if (!current) throw new Error('fork operation disappeared while failing');
			if (current.state !== 'pending' || current.cleanup_requested) return;
			const resources = await client.query<{
				vcpus: string;
				memory_mb: string;
				disk_mb: string;
			}>(
				`SELECT COALESCE(sum(vcpus), 0) AS vcpus,
				        COALESCE(sum(memory_mb), 0) AS memory_mb,
				        COALESCE(sum(disk_mb), 0) AS disk_mb
				 FROM machines WHERE fork_operation_id = $1`,
				[operationId]
			);
			await client.query(
				`WITH prior AS (
				   SELECT id, state AS old_state FROM machines
				   WHERE fork_operation_id = $1 AND state IN ('starting', 'running') FOR UPDATE
				 ), failed AS (
				   UPDATE machines machine SET state = 'failed', state_reason = $2, ready = false,
				     ready_at = NULL, stopped_at = now(), reservation_released_at = now()
				   FROM prior WHERE machine.id = prior.id RETURNING machine.id, prior.old_state
				 )
				 INSERT INTO machine_events
				  (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
				 SELECT failed.id || ':fork-failed', failed.id, $3, failed.old_state,
				        'failed', $2, 'control-plane'
				 FROM failed ON CONFLICT DO NOTHING`,
				[operationId, message, current.organization_id]
			);
			const totals = resources.rows[0]!;
			await client.query(
				`UPDATE hosts SET reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
				 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
				 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4), updated_at = now()
				 WHERE id = $1`,
				[
					current.source_host_id,
					Number(totals.vcpus),
					Number(totals.memory_mb),
					Number(totals.disk_mb)
				]
			);
			await client.query(
				`UPDATE machine_fork_operations SET state = 'failed', failure_status = $2,
				 failure_code = $3, failure_message = $4, completed_at = now(),
				 reconcile_claim_token = NULL, reconcile_claimed_until = NULL,
				 cleanup_claim_token = NULL, cleanup_claimed_until = NULL
				 WHERE id = $1 AND state = 'pending'`,
				[operationId, status, code, message]
			);
			await this.recordForkTerminalAudit(client, operationId, 'failed', code);
		});
		return (await this.loadForkOperation(this.database, operationId, true))!;
	}

	async requestForkCleanup(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation> {
		let claimedToken: string | undefined;
		await this.database.transaction(async (client) => {
			const operation = await client.query<{
				state: ForkOperationState;
				cleanup_requested_at: Date | null;
				cleanup_claim_token: string | null;
				cleanup_claimed_until: Date | null;
			}>(
				`SELECT state, cleanup_requested_at, cleanup_claim_token, cleanup_claimed_until
				 FROM machine_fork_operations WHERE id = $1 FOR UPDATE`,
				[operationId]
			);
			const current = operation.rows[0];
			if (!current) throw new Error('fork operation disappeared while requesting cleanup');
			if (current.state !== 'pending') return;

			if (current.cleanup_requested_at === null) {
				await client.query(
					`UPDATE machine_fork_operations
					 SET cleanup_requested_at = now(), cleanup_failure_status = $2,
					     cleanup_failure_code = $3, cleanup_failure_message = $4,
					     reconcile_after = now()
					 WHERE id = $1 AND state = 'pending' AND cleanup_requested_at IS NULL`,
					[operationId, status, code, message]
				);
			}

			const candidateToken = randomUUID();
			const claimed = await client.query<{ cleanup_claim_token: string }>(
				`UPDATE machine_fork_operations
				 SET cleanup_claim_token = $2,
				     cleanup_claimed_until = now() + interval '5 minutes'
				 WHERE id = $1 AND state = 'pending'
				   AND (cleanup_claim_token IS NULL OR cleanup_claimed_until <= now())
				 RETURNING cleanup_claim_token`,
				[operationId, candidateToken]
			);
			claimedToken = claimed.rows[0]?.cleanup_claim_token;
		});
		const operation = (await this.loadForkOperation(this.database, operationId, true))!;
		return claimedToken
			? { ...operation, cleanupClaimToken: claimedToken }
			: { ...operation, cleanupClaimToken: undefined };
	}

	async releaseForkCleanupClaim(operationId: string, cleanupClaimToken: string): Promise<void> {
		await this.database.query(
			`UPDATE machine_fork_operations
			 SET cleanup_claim_token = NULL, cleanup_claimed_until = NULL,
			     reconcile_after = now() + interval '15 seconds'
			 WHERE id = $1 AND state = 'pending' AND cleanup_claim_token = $2`,
			[operationId, cleanupClaimToken]
		);
	}

	async completeForkCleanup(
		operationId: string,
		cleanupClaimToken: string
	): Promise<ForkOperation> {
		await this.database.transaction(async (client) => {
			const operation = await client.query<{
				state: ForkOperationState;
				organization_id: string;
				source_host_id: string;
				cleanup_claim_token: string | null;
				cleanup_failure_status: number | null;
				cleanup_failure_code: string | null;
				cleanup_failure_message: string | null;
			}>(
				`SELECT state, organization_id, source_host_id, cleanup_claim_token,
				        cleanup_failure_status, cleanup_failure_code, cleanup_failure_message
				 FROM machine_fork_operations WHERE id = $1 FOR UPDATE`,
				[operationId]
			);
			const current = operation.rows[0];
			if (!current) throw new Error('fork operation disappeared while completing cleanup');
			if (current.state !== 'pending') return;
			if (
				current.cleanup_claim_token !== cleanupClaimToken ||
				current.cleanup_failure_status === null ||
				current.cleanup_failure_code === null ||
				current.cleanup_failure_message === null
			) {
				return;
			}

			const resources = await client.query<{
				vcpus: string;
				memory_mb: string;
				disk_mb: string;
			}>(
				`SELECT COALESCE(sum(vcpus), 0) AS vcpus,
				        COALESCE(sum(memory_mb), 0) AS memory_mb,
				        COALESCE(sum(disk_mb), 0) AS disk_mb
				 FROM machines WHERE fork_operation_id = $1`,
				[operationId]
			);
			await client.query(
				`WITH prior AS (
				   SELECT id, state AS old_state FROM machines
				   WHERE fork_operation_id = $1 AND state IN ('starting', 'running') FOR UPDATE
				 ), failed AS (
				   UPDATE machines machine SET state = 'failed', state_reason = $2, ready = false,
				     ready_at = NULL, stopped_at = now(), reservation_released_at = now()
				   FROM prior WHERE machine.id = prior.id RETURNING machine.id, prior.old_state
				 )
				 INSERT INTO machine_events
				  (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
				 SELECT failed.id || ':fork-failed', failed.id, $3, failed.old_state,
				        'failed', $2, 'control-plane'
				 FROM failed ON CONFLICT DO NOTHING`,
				[operationId, current.cleanup_failure_message, current.organization_id]
			);
			const totals = resources.rows[0]!;
			await client.query(
				`UPDATE hosts SET reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
				 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
				 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4), updated_at = now()
				 WHERE id = $1`,
				[
					current.source_host_id,
					Number(totals.vcpus),
					Number(totals.memory_mb),
					Number(totals.disk_mb)
				]
			);
			await client.query(
				`UPDATE machine_fork_operations SET state = 'failed', failure_status = $2,
				 failure_code = $3, failure_message = $4, completed_at = now(),
				 reconcile_claim_token = NULL, reconcile_claimed_until = NULL,
				 cleanup_claim_token = NULL, cleanup_claimed_until = NULL
				 WHERE id = $1 AND state = 'pending' AND cleanup_claim_token = $5`,
				[
					operationId,
					current.cleanup_failure_status,
					current.cleanup_failure_code,
					current.cleanup_failure_message,
					cleanupClaimToken
				]
			);
			await this.recordForkTerminalAudit(
				client,
				operationId,
				'failed',
				current.cleanup_failure_code
			);
		});
		return (await this.loadForkOperation(this.database, operationId, true))!;
	}

	async claimPendingForks(limit = 20): Promise<ReadonlyArray<ForkOperation>> {
		const claimToken = randomUUID();
		const ids = await this.database.transaction(async (client) => {
			const claimed = await client.query<{ id: string }>(
				`WITH candidates AS (
				   SELECT id FROM machine_fork_operations
				   WHERE state = 'pending' AND reconcile_after <= now()
				     AND (reconcile_claimed_until IS NULL OR reconcile_claimed_until <= now())
				   ORDER BY reconcile_after, created_at
				   FOR UPDATE SKIP LOCKED LIMIT $1
				 )
				 UPDATE machine_fork_operations operation
				 SET reconcile_claim_token = $2,
				     reconcile_claimed_until = now() + interval '5 minutes',
				     reconcile_after = now() + interval '30 seconds'
				 FROM candidates WHERE operation.id = candidates.id
				 RETURNING operation.id`,
				[Math.min(Math.max(limit, 1), 100), claimToken]
			);
			return claimed.rows.map(({ id }) => id);
		});
		const operations = await Promise.all(
			ids.map((id) => this.loadForkOperation(this.database, id, true))
		);
		return operations.filter((operation): operation is ForkOperation => operation !== undefined);
	}

	async releaseForkClaim(operationId: string, claimToken: string, failed: boolean): Promise<void> {
		await this.database.query(
			`UPDATE machine_fork_operations SET reconcile_claim_token = NULL,
			 reconcile_claimed_until = NULL,
			 reconcile_after = CASE WHEN $3 THEN now() + interval '30 seconds'
			                        ELSE reconcile_after END
			 WHERE id = $1 AND reconcile_claim_token = $2`,
			[operationId, claimToken, failed]
		);
	}

	private async recordForkTerminalAudit(
		database: Queryable,
		operationId: string,
		outcome: 'succeeded' | 'failed',
		reasonCode?: string
	): Promise<void> {
		await database.query(
			`INSERT INTO audit_events
			 (event_key, operation_id, organization_id, project_id, actor_type, actor_id,
			  action, outcome, reason_code, resource_type, resource_id, request_id,
			  user_agent, metadata)
			 SELECT 'audit:fork:' || operation.id || ':terminal', operation.audit_operation_id,
			        operation.organization_id, operation.project_id,
			        COALESCE(requested.actor_type, 'system'), requested.actor_id,
				        'machine.fork', $2::text, $3::text, 'machine', operation.source_machine_id,
			        requested.request_id, requested.user_agent,
			        COALESCE(requested.metadata, '{}'::jsonb) || jsonb_build_object(
			          'fork_operation_id', operation.id,
			          'child_ids', COALESCE((
			            SELECT jsonb_agg(child.machine_id ORDER BY child.ordinal)
			            FROM machine_fork_children child
			            WHERE child.operation_id = operation.id
			          ), '[]'::jsonb),
				          'state', $2::text
			        )
			 FROM machine_fork_operations operation
			 LEFT JOIN LATERAL (
			   SELECT actor_type, actor_id, request_id, user_agent, metadata
			   FROM audit_events
			   WHERE operation_id = operation.audit_operation_id
			     AND action = 'machine.fork' AND outcome = 'requested'
			   ORDER BY id LIMIT 1
			 ) requested ON true
			 WHERE operation.id = $1
			 ON CONFLICT (event_key) DO NOTHING`,
			[operationId, outcome, reasonCode ?? null]
		);
	}

	private async loadForkOperation(
		database: Queryable,
		operationId: string,
		replayed: boolean
	): Promise<ForkOperation | undefined> {
		const operationResult = await database.query<ForkOperationRow>(
			`SELECT operation.id, operation.audit_operation_id, operation.idempotency_key,
			        operation.request_hash, operation.state,
			        operation.source_machine_id, operation.source_host_id,
			        host(host.address) AS source_host_address,
			        operation.source_host_machine_id,
			        operation.source_lease_id,
			        operation.failure_status, operation.failure_code,
			        operation.failure_message, operation.reconcile_claim_token,
			        operation.cleanup_requested_at IS NOT NULL AS cleanup_requested,
			        operation.cleanup_claim_token,
			        operation.cleanup_failure_status, operation.cleanup_failure_code,
			        operation.cleanup_failure_message,
			        NOT EXISTS (
			          SELECT 1 FROM machine_fork_children expiry_child
			          JOIN machines expiry_machine ON expiry_machine.id = expiry_child.machine_id
			          WHERE expiry_child.operation_id = operation.id
			            AND expiry_machine.expires_at > now()
			        ) AS expired,
			        NOT EXISTS (
			          SELECT 1 FROM machine_fork_children deadline_child
			          JOIN machines deadline_machine ON deadline_machine.id = deadline_child.machine_id
			          WHERE deadline_child.operation_id = operation.id
			            AND COALESCE(deadline_machine.startup_deadline_at,
			                         deadline_machine.created_at + interval '2 minutes') > now()
			        ) AS deadline_reached
			 FROM machine_fork_operations operation
			 JOIN hosts host ON host.id = operation.source_host_id
			 WHERE operation.id = $1`,
			[operationId]
		);
		const operation = operationResult.rows[0];
		if (!operation) return undefined;
		const children = await database.query<MachineRow>(
			`${selectMachine}
			 JOIN machine_fork_children child ON child.machine_id = m.id
			 WHERE child.operation_id = $1 ORDER BY child.ordinal`,
			[operationId]
		);
		return {
			id: operation.id,
			auditOperationId: operation.audit_operation_id,
			idempotencyKey: operation.idempotency_key,
			requestHash: operation.request_hash,
			state: operation.state,
			replayed,
			sourceMachineId: operation.source_machine_id,
			sourceHostId: operation.source_host_id,
			sourceHostAddress: operation.source_host_address,
			sourceHostMachineId: operation.source_host_machine_id,
			sourceLeaseId: operation.source_lease_id,
			children: children.rows.map(fromRow),
			failureStatus: operation.failure_status ?? undefined,
			failureCode: operation.failure_code ?? undefined,
			failureMessage: operation.failure_message ?? undefined,
			reconcileClaimToken: operation.reconcile_claim_token ?? undefined,
			cleanupRequested: operation.cleanup_requested,
			cleanupClaimToken: operation.cleanup_claim_token ?? undefined,
			cleanupFailureStatus: operation.cleanup_failure_status ?? undefined,
			cleanupFailureCode: operation.cleanup_failure_code ?? undefined,
			cleanupFailureMessage: operation.cleanup_failure_message ?? undefined,
			expired: operation.expired,
			deadlineReached: operation.deadline_reached
		};
	}

	private async event(
		machineId: string,
		organizationId: string,
		from: MachineState | undefined,
		to: MachineState,
		reason?: string,
		database: Queryable = this.database
	): Promise<void> {
		await database.query(
			`INSERT INTO machine_events
			 (event_key, machine_id, organization_id, from_state, to_state, reason, observed_by)
			 VALUES ($1, $2, $3, $4, $5, $6, 'control-plane') ON CONFLICT DO NOTHING`,
			[
				`${machineId}:${to}:${randomUUID()}`,
				machineId,
				organizationId,
				from ?? null,
				to,
				reason ?? null
			]
		);
	}
}

export interface MachineScheduler {
	reserve(request: ScheduleRequest): Promise<Reservation>;
	release(hostId: string, resources: Resources, machineId?: string): Promise<void>;
}

export class IdempotencyConflict extends Error {
	readonly code = 'idempotency_conflict';
}

export class InvalidMachineRequest extends Error {
	readonly code = 'invalid_request';
}

export class ManagedNetworkEgressUnavailable extends Error {
	readonly code = 'not_supported';
}

export class MachineNotForkable extends Error {
	readonly code = 'machine_not_forkable';
}

export class ReplayedCreateFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

export class ReplayedForkFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly auditOperationId?: string
	) {
		super(message);
	}
}

type CreateFailure = {
	readonly status: number;
	readonly code: string;
	readonly message: string;
};

const failureForCreateError = (error: unknown): CreateFailure => {
	if (error instanceof QuotaExceeded || error instanceof BillingAdmissionRejected) {
		return { status: 429, code: error.code, message: error.message };
	}
	if (error instanceof CapacityUnavailable) {
		return { status: 503, code: error.code, message: error.message };
	}
	if (error instanceof HostRequestError) {
		return {
			status: error.ambiguous ? 503 : 502,
			code: error.ambiguous ? 'host_result_pending' : 'host_request_failed',
			message: error.ambiguous
				? 'The host result is not yet known; retry with the same Idempotency-Key.'
				: 'The selected host rejected the machine request.'
		};
	}
	return {
		status: 500,
		code: 'internal_error',
		message: 'The machine request could not be completed.'
	};
};

const throwPersistedCreateFailure = (machine: Machine): void => {
	if (
		machine.createFailureStatus !== undefined &&
		machine.createFailureCode !== undefined &&
		machine.createFailureMessage !== undefined
	) {
		throw new ReplayedCreateFailure(
			machine.createFailureStatus,
			machine.createFailureCode,
			machine.createFailureMessage
		);
	}
};

const throwPersistedForkFailure = (operation: ForkOperation): void => {
	if (
		operation.state === 'failed' &&
		operation.failureStatus !== undefined &&
		operation.failureCode !== undefined &&
		operation.failureMessage !== undefined
	) {
		throw new ReplayedForkFailure(
			operation.failureStatus,
			operation.failureCode,
			operation.failureMessage,
			operation.auditOperationId
		);
	}
};

const forkResult = (operation: ForkOperation, replayed = operation.replayed): ForkMachineResult => {
	throwPersistedForkFailure(operation);
	return {
		operationId: operation.id,
		auditOperationId: operation.auditOperationId,
		idempotencyKey: operation.idempotencyKey,
		machines: operation.children,
		replayed,
		pending: operation.state === 'pending',
		cleanupPending: operation.state === 'pending' && operation.cleanupRequested
	};
};

export class MachineService {
	constructor(
		private readonly repository: MachineRepository,
		private readonly scheduler: MachineScheduler,
		private readonly host: HostClient,
		private readonly usage?: UsageLedger
	) {}

	async create(input: CreateMachine): Promise<{ machine: Machine; replayed: boolean }> {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
			throw new InvalidMachineRequest('A valid Idempotency-Key header is required.');
		}
		const imageSources = [input.template, input.templateId, input.ociReference].filter(Boolean);
		if (imageSources.length !== 1) {
			throw new InvalidMachineRequest(
				'exactly one of template, templateId or ociReference is required'
			);
		}
		if (input.ociReference) {
			throw new InvalidMachineRequest(
				'OCI images are not available until digest-pinned registry imports are enabled'
			);
		}
		if (input.template && !['python', 'desktop'].includes(input.template)) {
			throw new InvalidMachineRequest(
				'template must be a platform built-in; use template_id for published templates'
			);
		}
		if (
			!Number.isSafeInteger(input.ttlSeconds) ||
			input.ttlSeconds < 15 ||
			input.ttlSeconds > 86_400
		) {
			throw new InvalidMachineRequest('ttlSeconds must be between 15 and 86400');
		}
		try {
			validateResources(input.resources);
		} catch (error) {
			throw new InvalidMachineRequest(error instanceof Error ? error.message : String(error));
		}
		let networkPolicy: NetworkPolicyDeclaration;
		try {
			networkPolicy = new EgressPolicy(
				input.networkPolicy ?? { mode: 'off', hostnames: [], cidrs: [] }
			).declaration;
		} catch (error) {
			throw new InvalidMachineRequest(error instanceof Error ? error.message : String(error));
		}
		if (networkPolicy.mode !== 'off') {
			throw new ManagedNetworkEgressUnavailable(
				'Managed guest egress is disabled until hard organization, project, and host-network traffic quotas are enforced.'
			);
		}
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					projectId: input.projectId,
					region: input.region,
					architecture: input.architecture,
					resources: input.resources,
					template: input.template,
					templateId: input.templateId,
					ociReference: input.ociReference,
					networkPolicy,
					ttlSeconds: input.ttlSeconds
				})
			)
			.digest('hex');
		const existing = await this.repository.findByIdempotency(
			input.organizationId,
			input.projectId,
			input.idempotencyKey
		);
		if (existing?.idempotencyRequestHash && existing.idempotencyRequestHash !== requestHash) {
			throw new IdempotencyConflict('Idempotency-Key was already used with a different request.');
		}
		if (existing) {
			throwPersistedCreateFailure(existing);
			if (existing.state !== 'requested') return { machine: existing, replayed: true };
		}

		let replayed = Boolean(existing);
		let machine: Machine = existing ?? {
			id: `m_${randomBytes(18).toString('base64url')}`,
			organizationId: input.organizationId,
			projectId: input.projectId,
			leaseId: randomUUID(),
			state: 'requested',
			region: input.region,
			architecture: input.architecture,
			resources: input.resources,
			template: input.template,
			templateId: input.templateId,
			ociReference: input.ociReference,
			networkPolicy,
			requestedTtlSeconds: input.ttlSeconds,
			ready: false,
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000),
			idempotencyRequestHash: requestHash
		};
		try {
			if (!existing) await this.repository.insertRequested(machine, input.idempotencyKey);
		} catch (error) {
			const raced = await this.repository.findByIdempotency(
				input.organizationId,
				input.projectId,
				input.idempotencyKey
			);
			if (raced) {
				if (raced.idempotencyRequestHash && raced.idempotencyRequestHash !== requestHash) {
					throw new IdempotencyConflict(
						'Idempotency-Key was already used with a different request.'
					);
				}
				throwPersistedCreateFailure(raced);
				if (raced.state !== 'requested') return { machine: raced, replayed: true };
				machine = raced;
				replayed = true;
			} else {
				throw error;
			}
		}
		const claimToken = await this.repository.claimCreate(machine.id);
		if (!claimToken) {
			const pending =
				(await this.repository.find(machine.id, machine.organizationId, machine.projectId)) ??
				machine;
			if (pending.idempotencyRequestHash && pending.idempotencyRequestHash !== requestHash) {
				throw new IdempotencyConflict('Idempotency-Key was already used with a different request.');
			}
			throwPersistedCreateFailure(pending);
			return { machine: pending, replayed: true };
		}

		let reservation: Reservation | undefined;
		let createdHostMachine: HostMachine | undefined;
		const persistedSource =
			(await this.repository.find(machine.id, machine.organizationId, machine.projectId)) ??
			machine;
		try {
			reservation = await this.scheduler.reserve({
				organizationId: input.organizationId,
				projectId: input.projectId,
				region: input.region,
				architecture: input.architecture,
				resources: input.resources,
				templateId: input.templateId,
				machineId: machine.id
			});
			if (!reservation.assignmentCommitted) await this.repository.assign(machine.id, reservation);
			createdHostMachine = await this.host.create(reservation.address, {
				leaseId: machine.leaseId,
				leaseGeneration: machine.leaseGeneration ?? 1,
				idempotencyKey: machine.id,
				template: input.template ?? persistedSource.hostTemplateName,
				ociReference: input.ociReference,
				ttlSeconds: input.ttlSeconds,
				resources: input.resources,
				networkPolicy,
				metadata: { public_machine_id: machine.id },
				runtimeCohortId: reservation.runtimeCohortId,
				sourceSha256: reservation.sourceSha256
			});
			await this.repository.observeHost(machine.id, createdHostMachine);
		} catch (error) {
			if (error instanceof HostRequestError && error.ambiguous && !createdHostMachine) {
				const pending = await this.repository.find(machine.id, machine.organizationId);
				return { machine: pending ?? machine, replayed };
			}
			if (reservation && createdHostMachine) {
				try {
					await this.host.destroy(reservation.address, createdHostMachine.id, machine.leaseId);
				} catch {
					// Retain the reservation and move to stopping. Reconciliation replays
					// the create key to recover the host ID, then deletes the lease.
					await this.repository.transition(
						machine.id,
						['starting', 'running'],
						'stopping',
						'create persistence failed; compensation pending'
					);
					await this.repository.releaseCreateClaim(machine.id, claimToken);
					throw error;
				}
			}
			const failure = failureForCreateError(error);
			const failed = await this.repository.failCreate(
				machine.id,
				claimToken,
				failure.status,
				failure.code,
				failure.message
			);
			if (reservation && failed) {
				await this.scheduler.release(reservation.hostId, input.resources, machine.id);
			}
			if (!failed) await this.repository.releaseCreateClaim(machine.id, claimToken);
			throw error;
		}
		return {
			machine: (await this.repository.find(machine.id, machine.organizationId)) ?? machine,
			replayed
		};
	}

	list(
		organizationId: string,
		projectId?: string,
		cursor?: string,
		limit?: number
	): Promise<Machine[]> {
		return this.repository.list(organizationId, projectId, cursor, limit);
	}

	get(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined> {
		return this.repository.find(id, organizationId, projectId);
	}

	async destroy(id: string, organizationId: string, projectId?: string): Promise<boolean> {
		const machine = await this.repository.find(id, organizationId, projectId);
		if (!machine) return false;
		if (['stopped', 'failed', 'lost'].includes(machine.state)) return true;
		if (
			!(await this.repository.transition(
				id,
				['requested', 'placing', 'starting', 'running'],
				'stopping'
			))
		) {
			return true;
		}
		// A timed-out create may have succeeded on the host before its local ID was
		// observed. Leave the lease in stopping so reconciliation can replay the
		// idempotent create, recover that ID, and issue the matching delete.
		if (machine.hostId && machine.hostAddress && !machine.hostMachineId) return true;
		if (machine.hostAddress && machine.hostMachineId) {
			try {
				await this.host.destroy(machine.hostAddress, machine.hostMachineId, machine.leaseId);
			} catch (error) {
				if (!(error instanceof HostRequestError && error.status === 404)) throw error;
			}
		}
		await this.repository.transition(id, ['stopping'], 'stopped');
		if (machine.hostId) await this.scheduler.release(machine.hostId, machine.resources, machine.id);
		return true;
	}

	async extend(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		ttlSeconds: number,
		idempotencyKey: string
	): Promise<ExtendMachineResult> {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
			throw new InvalidMachineRequest('A valid Idempotency-Key header is required.');
		}
		if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 86_400) {
			throw new InvalidMachineRequest('ttlSeconds must be between 15 and 86400');
		}
		const machine = await this.repository.find(id, organizationId, projectId);
		if (!machine) return { machine: undefined, replayed: false, applied: false };
		if (new EgressPolicy(machine.networkPolicy ?? { mode: 'off' }).declaration.mode !== 'off') {
			throw new ManagedNetworkEgressUnavailable(
				'Machines with a legacy managed egress policy cannot be extended.'
			);
		}
		const requestHash = createHash('sha256')
			.update(JSON.stringify({ machineId: machine.id, ttlSeconds }))
			.digest('hex');
		const operation = await this.repository.beginExtend(
			id,
			organizationId,
			machine.projectId,
			idempotencyKey,
			requestHash,
			ttlSeconds
		);
		if (!operation) return { machine: undefined, replayed: false, applied: false };
		if (operation.requestHash !== requestHash) {
			throw new IdempotencyConflict('Idempotency-Key was already used with a different request.');
		}
		if (operation.resultExpiresAt) {
			const current = (await this.repository.find(id, organizationId, projectId)) ?? machine;
			return {
				machine: { ...current, expiresAt: operation.resultExpiresAt },
				replayed: true,
				applied: true
			};
		}
		const current = (await this.repository.find(id, organizationId, projectId)) ?? machine;
		if (
			!['starting', 'running'].includes(current.state) ||
			!current.hostAddress ||
			!current.hostMachineId
		) {
			return { machine: current, replayed: operation.replayed, applied: false };
		}
		const hostMachine = await this.host.extend(
			current.hostAddress,
			current.hostMachineId,
			current.leaseId,
			idempotencyKey,
			operation.targetExpiresAt
		);
		const hostExpiry = hostMachine.expires_at ? new Date(hostMachine.expires_at) : undefined;
		if (
			!hostExpiry ||
			!Number.isFinite(hostExpiry.getTime()) ||
			hostExpiry < operation.targetExpiresAt
		) {
			throw new HostRequestError(
				undefined,
				'host extend response did not honor the absolute expiry target',
				true
			);
		}
		const recordedExpiry = await this.repository.completeExtend(
			operation.id,
			id,
			organizationId,
			hostExpiry
		);
		const completed = (await this.repository.find(id, organizationId, projectId)) ?? current;
		return {
			machine: { ...completed, expiresAt: recordedExpiry },
			replayed: operation.replayed,
			applied: true
		};
	}

	async fork(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		count: number,
		idempotencyKey: string,
		auditOperationId = randomUUID()
	): Promise<ForkMachineResult> {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
			throw new InvalidMachineRequest('A valid Idempotency-Key header is required.');
		}
		if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
			throw new InvalidMachineRequest('count must be an integer from 1 to 8');
		}
		const source = await this.repository.find(id, organizationId, projectId);
		if (!source) throw new MachineNotForkable('The source machine was not found.');
		if (new EgressPolicy(source.networkPolicy ?? { mode: 'off' }).declaration.mode !== 'off') {
			throw new ManagedNetworkEgressUnavailable(
				'Machines with a legacy managed egress policy cannot be forked.'
			);
		}
		const requestHash = createHash('sha256')
			.update(JSON.stringify({ sourceMachineId: source.id, count }))
			.digest('hex');
		const operation = await this.repository.beginFork(
			source.id,
			organizationId,
			source.projectId,
			idempotencyKey,
			requestHash,
			count,
			auditOperationId
		);
		if (!operation) throw new MachineNotForkable('The source machine is not forkable.');
		if (operation.requestHash !== requestHash) {
			throw new IdempotencyConflict('Idempotency-Key was already used with a different request.');
		}
		if (operation.state !== 'pending') return forkResult(operation, true);
		const replayed = operation.replayed;
		try {
			let active = operation;
			if (active.cleanupRequested) {
				active = await this.repository.requestForkCleanup(
					active.id,
					active.cleanupFailureStatus ?? 502,
					active.cleanupFailureCode ?? 'fork_batch_failed',
					active.cleanupFailureMessage ?? 'The fork batch is awaiting confirmed host cleanup.'
				);
				if (active.state !== 'pending') return forkResult(active, replayed);
			}

			let observed: ReadonlyArray<HostMachine>;
			try {
				observed = await this.host.fork(
					active.sourceHostAddress,
					active.sourceHostMachineId,
					active.sourceLeaseId,
					idempotencyKey,
					active.children.map((child) => ({
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
					}))
				);
			} catch (error) {
				if (error instanceof HostRequestError && error.code === 'fork_batch_cleaned') {
					return this.finishForkCleanup(
						active,
						{
							status: 502,
							code: 'fork_batch_failed',
							message:
								'The host returned an incomplete fork batch and removed all reserved children.'
						},
						[],
						replayed,
						true
					);
				}
				if (error instanceof HostForkContractError) {
					return this.finishForkCleanup(
						active,
						{
							status: 502,
							code: 'fork_batch_failed',
							message: 'The host returned an incomplete or invalid fork batch.'
						},
						error.observed,
						replayed
					);
				}
				if (error instanceof HostRequestError && error.ambiguous) {
					if (active.cleanupClaimToken) {
						await this.repository.releaseForkCleanupClaim(active.id, active.cleanupClaimToken);
					}
					return this.finishForkCleanup(
						{ ...active, cleanupClaimToken: undefined },
						{
							status: 502,
							code: 'fork_batch_failed',
							message:
								'The host result was ambiguous; the fork remains hidden until cleanup is confirmed.'
						},
						[],
						replayed
					);
				}
				if (active.cleanupRequested) {
					if (active.cleanupClaimToken) {
						await this.repository.releaseForkCleanupClaim(active.id, active.cleanupClaimToken);
					}
					return forkResult(active, replayed);
				}
				const sourceRejected =
					error instanceof HostRequestError && [404, 409, 422, 501].includes(error.status ?? 0);
				const failure =
					error instanceof HostRequestError
						? {
								status: sourceRejected ? 422 : 502,
								code: sourceRejected ? 'machine_not_forkable' : 'host_request_failed',
								message: sourceRejected
									? 'The source host cannot create a live snapshot of this machine.'
									: 'The source host rejected the fork request.'
							}
						: {
								status: 500,
								code: 'internal_error',
								message: 'The fork request could not be completed.'
							};
				const failed = await this.repository.failFork(
					active.id,
					failure.status,
					failure.code,
					failure.message
				);
				return forkResult(failed, replayed);
			}

			if (active.cleanupRequested) {
				return this.finishForkCleanup(
					active,
					{
						status: active.cleanupFailureStatus ?? 502,
						code: active.cleanupFailureCode ?? 'fork_batch_failed',
						message:
							active.cleanupFailureMessage ?? 'The fork batch is awaiting confirmed host cleanup.'
					},
					observed,
					replayed
				);
			}

			const terminal = observed.some((machine) =>
				['stopped', 'failed', 'lost'].includes(machine.status)
			);
			const allReady = observed.every(
				(machine) => machine.ready === true && machine.status === 'running'
			);
			if (terminal || (!allReady && operation.deadlineReached)) {
				const message = terminal
					? 'A fork child became terminal before the entire batch was ready.'
					: 'The fork batch did not become ready before its shared startup deadline.';
				return this.finishForkCleanup(
					active,
					{ status: 502, code: 'fork_batch_failed', message },
					observed,
					replayed
				);
			}

			let completed: ForkOperation;
			try {
				completed = await this.repository.completeFork(active.id, observed);
			} catch (error) {
				if (error instanceof HostRequestError && error.ambiguous) {
					return this.finishForkCleanup(
						active,
						{
							status: 502,
							code: 'fork_batch_failed',
							message: 'The host fork batch did not match the durable child reservation.'
						},
						observed,
						replayed
					);
				}
				throw error;
			}
			return forkResult(completed, replayed);
		} catch (error) {
			if (error instanceof ReplayedForkFailure) throw error;
			// Allocation is already durable. If a persistence response is lost, exposing
			// a terminal result here could conflict with the committed database state.
			// Return the stable operation and key so the caller can recover by replay.
			return forkResult(operation, replayed);
		}
	}

	private async finishForkCleanup(
		operation: ForkOperation,
		failure: { readonly status: number; readonly code: string; readonly message: string },
		observed: ReadonlyArray<HostMachine>,
		replayed: boolean,
		hostConfirmed = false
	): Promise<ForkMachineResult> {
		const cleanup =
			operation.cleanupRequested && operation.cleanupClaimToken
				? operation
				: await this.repository.requestForkCleanup(
						operation.id,
						failure.status,
						failure.code,
						failure.message
					);
		if (cleanup.state !== 'pending') return forkResult(cleanup, replayed);
		if (!cleanup.cleanupClaimToken) return forkResult(cleanup, replayed);

		const cleaned = hostConfirmed || (await this.cleanupForkObservations(cleanup, observed));
		if (!cleaned) {
			await this.repository.releaseForkCleanupClaim(cleanup.id, cleanup.cleanupClaimToken);
			return forkResult(cleanup, replayed);
		}
		const terminal = await this.repository.completeForkCleanup(
			cleanup.id,
			cleanup.cleanupClaimToken
		);
		return forkResult(terminal, replayed);
	}

	private async cleanupForkObservations(
		operation: ForkOperation,
		observed: ReadonlyArray<HostMachine>
	): Promise<boolean> {
		const expected = new Map(operation.children.map((child) => [child.id, child] as const));
		let complete = observed.length === operation.children.length;
		const destroyed = new Set<string>();
		const cleanedChildren = new Set<string>();
		for (const machine of observed) {
			const publicMachineId = machine.metadata?.public_machine_id;
			const child = publicMachineId ? expected.get(publicMachineId) : undefined;
			if (
				!machine.id ||
				!child ||
				machine.lease_id !== child.leaseId ||
				destroyed.has(machine.id) ||
				cleanedChildren.has(child.id)
			) {
				complete = false;
				continue;
			}
			destroyed.add(machine.id);
			cleanedChildren.add(child.id);
			try {
				await this.host.destroy(operation.sourceHostAddress, machine.id, child.leaseId);
			} catch (error) {
				if (!(error instanceof HostRequestError && error.status === 404)) complete = false;
			}
		}
		return (
			complete &&
			destroyed.size === operation.children.length &&
			cleanedChildren.size === operation.children.length
		);
	}

	async exec(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		command: string,
		timeoutSeconds: number
	): Promise<HostExecResult | undefined> {
		const machine = await this.repository.find(id, organizationId, projectId);
		if (!machine?.ready || !machine.hostAddress || !machine.hostMachineId) return undefined;
		return this.host.exec(
			machine.hostAddress,
			machine.hostMachineId,
			machine.leaseId,
			command,
			timeoutSeconds
		);
	}
}

export const machineJson = (machine: Machine) => ({
	id: machine.id,
	project_id: machine.projectId,
	state: machine.state,
	status: machine.state,
	ready: machine.ready,
	region: machine.region,
	architecture: machine.architecture,
	runtime_cohort_id: machine.runtimeCohortId,
	source_sha256: machine.sourceSha256,
	resources: {
		vcpus: machine.resources.vcpus,
		memory_mb: machine.resources.memoryMb,
		disk_mb: machine.resources.diskMb
	},
	template: machine.template,
	template_id: machine.templateId,
	oci_reference: machine.ociReference,
	network_policy: machine.networkPolicy ?? { mode: 'off', hostnames: [], cidrs: [] },
	parent_id: machine.parentId,
	created_at: machine.createdAt.toISOString(),
	started_at: machine.startedAt?.toISOString(),
	ready_at: machine.readyAt?.toISOString(),
	stopped_at: machine.stoppedAt?.toISOString(),
	expires_at: machine.expiresAt.toISOString(),
	failure_reason:
		machine.state === 'failed' || machine.state === 'lost' ? machine.stateReason : undefined
});

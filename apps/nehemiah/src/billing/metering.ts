import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database, Queryable } from '../db/client.js';

const unsignedInteger = /^(?:0|[1-9][0-9]{0,29})$/;
const positiveInteger = /^[1-9][0-9]{0,18}$/;
const maxSignedBigint = 9_223_372_036_854_775_807n;
const maxUnsignedBigint = 18_446_744_073_709_551_615n;
const maximumClockLeadMs = 5 * 60 * 1_000;
const maximumWallDivergenceMs = 5 * 60 * 1_000;
const nanosecondsPerMillisecond = 1_000_000n;
const nanosecondsPerSecond = 1_000_000_000n;
const bytesPerGibibyte = 1_073_741_824n;
const maximumForwardSequenceWindow = 64n;
const maximumPendingObservationsPerHost = 2_048;
const minimumMeteringBatchIntervalMs = 1_000;
const minimumCheckpointRuntimeDeltaNs = 4n * nanosecondsPerSecond;
const managedEgressBytesPerSecond = 8_000_000n;
const managedEgressBurstBytes = 1_048_576n;
const maximumExactFinalLeadMs = 30_000;

export class MeteringInputError extends Error {}

export class MeteringHostLifecycleError extends Error {}

export class MeteringRateLimitError extends Error {
	readonly retryAfterSeconds = 1;
}

export type HostUsageObservationKind = 'start' | 'checkpoint' | 'final';
export type HostUsageObservationQuality = 'exact' | 'last_defensible';
export type HostUsageObservationQualityReason =
	| 'none'
	| 'terminal_monotonic_unavailable'
	| 'terminal_monotonic_regressed'
	| 'terminal_egress_unavailable'
	| 'invalid_or_expired_state'
	| 'runtime_unavailable'
	| 'host_boot_changed'
	| 'network_isolation_unavailable';

export interface HostUsageObservation {
	readonly machineId: string;
	readonly hostMachineId: string;
	readonly leaseId: string;
	readonly leaseGeneration: string;
	readonly hostBootId: string;
	readonly sequence: string;
	readonly kind: HostUsageObservationKind;
	readonly quality: HostUsageObservationQuality;
	readonly qualityReason: HostUsageObservationQualityReason;
	readonly runtimeNs: string;
	readonly egressBytes: string;
	readonly egressCounterEpoch: string;
	readonly observedMonotonicNs: string;
	readonly observedAt: string;
	readonly vcpus: number;
	readonly memoryBytes: string;
	readonly processId: number;
}

export type HostUsageObservationOutcome =
	'accepted' | 'duplicate' | 'pending_gap' | 'quarantined' | 'rejected_payload_conflict';

export interface HostUsageObservationReceipt {
	readonly leaseId: string;
	readonly leaseGeneration: string;
	readonly hostBootId: string;
	readonly sequence: string;
	readonly outcome: HostUsageObservationOutcome;
	readonly acknowledged: boolean;
}

const receiptFor = (
	observation: HostUsageObservation,
	outcome: HostUsageObservationOutcome
): HostUsageObservationReceipt => ({
	leaseId: observation.leaseId,
	leaseGeneration: observation.leaseGeneration,
	hostBootId: observation.hostBootId,
	sequence: observation.sequence,
	outcome,
	acknowledged: true
});

type MachineIdentityRow = {
	id: string;
	organization_id: string;
	project_id: string;
	host_id: string;
	host_machine_id: string;
	lease_id: string;
	lease_generation: string;
	vcpus: number;
	memory_bytes: string;
	created_at: Date;
	started_at: Date | null;
	usage_checkpoint_at: Date | null;
	state: string;
	expires_at: Date;
	admission_received_at: Date;
};

type StoredObservationRow = {
	id: string;
	payload_hash: Buffer;
	host_boot_id: string;
	sequence: string;
	kind: HostUsageObservationKind;
	quality: HostUsageObservationQuality;
	quality_reason: HostUsageObservationQualityReason;
	runtime_ns: string;
	egress_bytes: string;
	egress_counter_epoch: string;
	observed_monotonic_ns: string;
	observed_at: Date;
	received_at: Date;
	vcpus: number;
	memory_bytes: string;
};

type MeterStateRow = {
	machine_id: string;
	host_id: string;
	host_machine_id: string;
	lease_id: string;
	lease_generation: string;
	host_boot_id: string;
	last_sequence: string;
	last_runtime_ns: string;
	projected_runtime_ns: string;
	start_monotonic_ns: string | null;
	last_observed_monotonic_ns: string | null;
	last_egress_bytes: string;
	egress_counter_epoch: string;
	start_seen: boolean;
	final_seen: boolean;
	last_observed_at: Date | null;
	last_period_end: Date | null;
	last_received_at: Date | null;
	loss_closed_at: Date | null;
	quarantined_at: Date | null;
	quarantine_reason: string | null;
};

interface UsageSegment {
	readonly index: number;
	readonly start: Date;
	readonly end: Date;
	readonly runtimeNs: bigint;
}

type IntegrityReason =
	'observation_rate_exceeded' | 'egress_plausibility_exceeded' | 'premature_final';

const observationIntegrityReason = (
	identity: MachineIdentityRow,
	state: MeterStateRow,
	observation: Pick<
		StoredObservationRow,
		'kind' | 'quality' | 'runtime_ns' | 'egress_bytes' | 'egress_counter_epoch'
	>,
	receivedAt: Date
): IntegrityReason | undefined => {
	const runtime = BigInt(observation.runtime_ns);
	const egress = BigInt(observation.egress_bytes);
	const leaseStart = identity.started_at ?? identity.created_at;
	const defensibleElapsedNs =
		BigInt(Math.max(0, receivedAt.getTime() - leaseStart.getTime()) + maximumWallDivergenceMs) *
		nanosecondsPerMillisecond;
	if (runtime > defensibleElapsedNs) return 'observation_rate_exceeded';
	const maximumCumulativeEgress =
		managedEgressBurstBytes +
		(defensibleElapsedNs * managedEgressBytesPerSecond + nanosecondsPerSecond - 1n) /
			nanosecondsPerSecond;
	if (egress > maximumCumulativeEgress) return 'egress_plausibility_exceeded';
	if (!state.start_seen) return undefined;
	const priorRuntime = BigInt(state.last_runtime_ns);
	const priorEgress = BigInt(state.last_egress_bytes);
	if (runtime < priorRuntime || egress < priorEgress) return undefined;
	const runtimeDelta = runtime - priorRuntime;
	if (observation.kind === 'checkpoint' && runtimeDelta < minimumCheckpointRuntimeDeltaNs) {
		return 'observation_rate_exceeded';
	}
	if (observation.egress_counter_epoch === state.egress_counter_epoch) {
		const egressDelta = egress - priorEgress;
		const maximumEgressDelta =
			runtimeDelta === 0n
				? 0n
				: managedEgressBurstBytes +
					(runtimeDelta * managedEgressBytesPerSecond + nanosecondsPerSecond - 1n) /
						nanosecondsPerSecond;
		if (egressDelta > maximumEgressDelta) return 'egress_plausibility_exceeded';
	}
	if (
		observation.kind === 'final' &&
		observation.quality === 'exact' &&
		!['stopping', 'stopped', 'failed', 'lost'].includes(identity.state) &&
		receivedAt.getTime() < identity.expires_at.getTime() - maximumExactFinalLeadMs
	) {
		return 'premature_final';
	}
	return undefined;
};

const parseUnsigned = (value: string, name: string): bigint => {
	if (!unsignedInteger.test(value))
		throw new MeteringInputError(`${name} must be an unsigned decimal integer`);
	const parsed = BigInt(value);
	if (parsed > maxUnsignedBigint) throw new MeteringInputError(`${name} exceeds host uint64`);
	return parsed;
};

const parsePositiveBigint = (value: string, name: string): bigint => {
	if (!positiveInteger.test(value))
		throw new MeteringInputError(`${name} must be a positive decimal integer`);
	const parsed = BigInt(value);
	if (parsed > maxSignedBigint) throw new MeteringInputError(`${name} exceeds PostgreSQL bigint`);
	return parsed;
};

const canonicalPayload = (observation: HostUsageObservation): string =>
	JSON.stringify({
		machine_id: observation.machineId,
		host_machine_id: observation.hostMachineId,
		lease_id: observation.leaseId,
		lease_generation: observation.leaseGeneration,
		host_boot_id: observation.hostBootId,
		sequence: observation.sequence,
		kind: observation.kind,
		quality: observation.quality,
		quality_reason: observation.qualityReason,
		runtime_ns: observation.runtimeNs,
		egress_bytes: observation.egressBytes,
		egress_counter_epoch: observation.egressCounterEpoch,
		observed_monotonic_ns: observation.observedMonotonicNs,
		observed_at: observation.observedAt,
		vcpus: observation.vcpus,
		memory_bytes: observation.memoryBytes,
		process_id: observation.processId
	});

const payloadHash = (observation: HostUsageObservation): Buffer =>
	createHash('sha256').update(canonicalPayload(observation)).digest();

const validateObservation = (observation: HostUsageObservation): void => {
	if (observation.machineId.length > 128 || !/^m_[A-Za-z0-9_-]{12,}$/.test(observation.machineId)) {
		throw new MeteringInputError('machine_id is invalid');
	}
	if (!/^m-[0-9a-f]{8}$/.test(observation.hostMachineId)) {
		throw new MeteringInputError('host_machine_id is invalid');
	}
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			observation.leaseId
		)
	) {
		throw new MeteringInputError('lease_id is invalid');
	}
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			observation.hostBootId
		)
	) {
		throw new MeteringInputError('host_boot_id is invalid');
	}
	parsePositiveBigint(observation.leaseGeneration, 'lease_generation');
	parsePositiveBigint(observation.sequence, 'sequence');
	parseUnsigned(observation.runtimeNs, 'runtime_ns');
	parseUnsigned(observation.egressBytes, 'egress_bytes');
	parsePositiveBigint(observation.egressCounterEpoch, 'egress_counter_epoch');
	parseUnsigned(observation.observedMonotonicNs, 'observed_monotonic_ns');
	parsePositiveBigint(observation.memoryBytes, 'memory_bytes');
	if (!['start', 'checkpoint', 'final'].includes(observation.kind)) {
		throw new MeteringInputError('kind is invalid');
	}
	if (!['exact', 'last_defensible'].includes(observation.quality)) {
		throw new MeteringInputError('quality is invalid');
	}
	const qualityReasons: ReadonlyArray<HostUsageObservationQualityReason> = [
		'none',
		'terminal_monotonic_unavailable',
		'terminal_monotonic_regressed',
		'terminal_egress_unavailable',
		'invalid_or_expired_state',
		'runtime_unavailable',
		'host_boot_changed',
		'network_isolation_unavailable'
	];
	if (!qualityReasons.includes(observation.qualityReason)) {
		throw new MeteringInputError('quality_reason is invalid');
	}
	if (
		(observation.quality === 'exact' && observation.qualityReason !== 'none') ||
		(observation.quality === 'last_defensible' &&
			(observation.kind !== 'final' || observation.qualityReason === 'none'))
	) {
		throw new MeteringInputError('quality and quality_reason are inconsistent');
	}
	if (!Number.isSafeInteger(observation.vcpus) || observation.vcpus < 1) {
		throw new MeteringInputError('vcpus is invalid');
	}
	if (!Number.isSafeInteger(observation.processId) || observation.processId <= 1) {
		throw new MeteringInputError('process_id is invalid');
	}
	const observedAt = new Date(observation.observedAt);
	if (
		!Number.isFinite(observedAt.getTime()) ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(
			observation.observedAt
		)
	) {
		throw new MeteringInputError('observed_at must be a canonical UTC timestamp');
	}
};

const timestampFromNanoseconds = (value: bigint): Date =>
	new Date(Number(value / nanosecondsPerMillisecond));

/** Split a monotonic interval at UTC midnights without losing a nanosecond. */
export const splitRuntimeAtUtcMidnight = (
	start: Date,
	durationNs: bigint
): ReadonlyArray<UsageSegment> => {
	if (durationNs < 0n) throw new Error('runtime delta cannot be negative');
	if (durationNs === 0n) return [];
	let cursor = BigInt(start.getTime()) * nanosecondsPerMillisecond;
	const terminal = cursor + durationNs;
	const segments: UsageSegment[] = [];
	let index = 0;
	while (cursor < terminal) {
		const cursorDate = timestampFromNanoseconds(cursor);
		const nextMidnight =
			BigInt(
				Date.UTC(cursorDate.getUTCFullYear(), cursorDate.getUTCMonth(), cursorDate.getUTCDate() + 1)
			) * nanosecondsPerMillisecond;
		const end = nextMidnight < terminal ? nextMidnight : terminal;
		segments.push({
			index,
			start: timestampFromNanoseconds(cursor),
			end: timestampFromNanoseconds(end),
			runtimeNs: end - cursor
		});
		cursor = end;
		index += 1;
	}
	return segments;
};

const exception = async (
	client: Queryable,
	input: {
		key: string;
		hostId: string;
		machineId: string;
		leaseId: string;
		leaseGeneration: string;
		hostBootId?: string;
		sequence?: string;
		reason: string;
	}
): Promise<void> => {
	await client.query(
		`INSERT INTO metering_exceptions
		 (exception_key, host_id, machine_id, lease_id, lease_generation,
		  host_boot_id, sequence, reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (exception_key) DO NOTHING`,
		[
			input.key,
			input.hostId,
			input.machineId,
			input.leaseId,
			input.leaseGeneration,
			input.hostBootId ?? null,
			input.sequence ?? null,
			input.reason
		]
	);
};

const stateForUpdate = async (
	client: Queryable,
	machineId: string
): Promise<MeterStateRow | undefined> =>
	(
		await client.query<MeterStateRow>(
			`SELECT * FROM machine_meter_state WHERE machine_id = $1 FOR UPDATE`,
			[machineId]
		)
	).rows[0];

const setQuarantined = async (
	client: Queryable,
	machineId: string,
	reason: string
): Promise<void> => {
	await client.query(
		`UPDATE machine_meter_state
		 SET quarantined_at = COALESCE(quarantined_at, now()),
		     quarantine_reason = COALESCE(quarantine_reason, $2), updated_at = now()
		 WHERE machine_id = $1`,
		[machineId, reason]
	);
};

const quarantineHost = async (client: Queryable, hostId: string, reason: string): Promise<void> => {
	await client.query(
		`UPDATE hosts
		 SET desired_state = 'quarantined', state = 'stale',
		     credential_generation = credential_generation + 1,
		     credential_status = 'revoked', credential_hash = NULL,
		     control_credential_ciphertext = NULL, gateway_credential_ciphertext = NULL,
		     credential_revoked_at = COALESCE(credential_revoked_at, statement_timestamp()),
		     reported_available_vcpus = 0, reported_available_memory_mb = 0,
		     reported_available_disk_mb = 0, reported_machine_count = 0,
		     lifecycle_reason = $2, lifecycle_updated_at = now(),
		     metering_quarantined_at = COALESCE(metering_quarantined_at, now()),
		     updated_at = now()
		 WHERE id = $1 AND desired_state NOT IN ('quarantined', 'revoked')`,
		[hostId, reason]
	);
	await client.query(
		`INSERT INTO audit_events
		 (event_key, actor_type, actor_id, action, outcome, reason_code,
		  resource_type, resource_id, metadata)
		 VALUES ($1, 'system', 'authoritative-metering', 'host.quarantined', 'succeeded',
		         'metering_integrity_violation', 'host', $2, jsonb_build_object('reason', $3::text))
		 ON CONFLICT (event_key) DO NOTHING`,
		[`host:${hostId}:metering-integrity-quarantine`, hostId, reason]
	);
};

const appendProjection = async (
	client: Queryable,
	input: {
		eventKey: string;
		observationId: string;
		identity: MachineIdentityRow;
		dimension: 'compute' | 'memory' | 'egress';
		unit: 'vcpu_nanosecond' | 'byte_nanosecond' | 'byte';
		quantity: bigint;
		periodStart: Date;
		periodEnd: Date;
	}
): Promise<void> => {
	if (input.quantity === 0n) return;
	await client.query(
		`INSERT INTO meter_raw_usage_events
		 (event_key, observation_id, organization_id, project_id, machine_id,
		  lease_id, lease_generation, dimension, unit, quantity, period_start, period_end)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12)
		 ON CONFLICT (event_key) DO NOTHING`,
		[
			input.eventKey,
			input.observationId,
			input.identity.organization_id,
			input.identity.project_id,
			input.identity.id,
			input.identity.lease_id,
			input.identity.lease_generation,
			input.dimension,
			input.unit,
			input.quantity.toString(),
			input.periodStart,
			input.periodEnd
		]
	);

	const projection =
		input.unit === 'vcpu_nanosecond'
			? { dimension: 'vcpu_seconds', divisor: nanosecondsPerSecond }
			: input.unit === 'byte_nanosecond'
				? {
						dimension: 'gib_seconds',
						divisor: bytesPerGibibyte * nanosecondsPerSecond
					}
				: { dimension: 'egress_bytes', divisor: 1n };
	await client.query(
		`INSERT INTO usage_events
		 (event_key, organization_id, project_id, machine_id, dimension, quantity,
		  period_start, period_end, source)
		 VALUES ($1, $2, $3, $4, $5, $6::numeric / $7::numeric, $8, $9, 'host')
		 ON CONFLICT (event_key) DO NOTHING`,
		[
			`raw:${input.eventKey}`,
			input.identity.organization_id,
			input.identity.project_id,
			input.identity.id,
			projection.dimension,
			input.quantity.toString(),
			projection.divisor.toString(),
			input.periodStart,
			input.periodEnd
		]
	);
};

const closeLegacyPrefix = async (
	client: Queryable,
	identity: MachineIdentityRow,
	hostStart: Date
): Promise<Date> => {
	const legacyStart = identity.usage_checkpoint_at ?? identity.started_at;
	const boundary =
		legacyStart && legacyStart.getTime() > hostStart.getTime() ? legacyStart : hostStart;
	if (legacyStart && legacyStart.getTime() < boundary.getTime()) {
		await client.query(
			`INSERT INTO usage_outbox
			 (event_key, organization_id, project_id, machine_id, vcpus, memory_mb,
			  period_start, period_end, final, source)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 'reconciler')
			 ON CONFLICT (event_key) DO NOTHING`,
			[
				`machine:${identity.id}:meter-cutover:${identity.lease_generation}:${boundary.toISOString()}`,
				identity.organization_id,
				identity.project_id,
				identity.id,
				identity.vcpus,
				Number(BigInt(identity.memory_bytes) / 1_048_576n),
				legacyStart,
				boundary
			]
		);
	}
	await client.query(
		`UPDATE machines SET usage_checkpoint_at = GREATEST(COALESCE(usage_checkpoint_at, $2), $2)
		 WHERE id = $1 AND lease_id = $3 AND lease_generation = $4::bigint`,
		[identity.id, boundary, identity.lease_id, identity.lease_generation]
	);
	return boundary;
};

const processObservation = async (
	client: PoolClient,
	identity: MachineIdentityRow,
	state: MeterStateRow,
	observation: StoredObservationRow
): Promise<'accepted' | 'quarantined'> => {
	const sequence = BigInt(observation.sequence);
	const runtime = BigInt(observation.runtime_ns);
	const egress = BigInt(observation.egress_bytes);
	const priorRuntime = BigInt(state.last_runtime_ns);
	const priorProjectedRuntime = BigInt(state.projected_runtime_ns);
	const priorEgress = BigInt(state.last_egress_bytes);
	const priorSequence = BigInt(state.last_sequence);
	const monotonic = BigInt(observation.observed_monotonic_ns);
	let anomaly: MeterStateRow['quarantine_reason'] = null;

	if (state.quarantined_at) anomaly = state.quarantine_reason;
	else if (state.host_boot_id !== observation.host_boot_id) anomaly = 'boot_id_changed';
	else if (state.loss_closed_at) anomaly = 'observation_after_final';
	else if (
		!state.start_seen &&
		(sequence !== 1n || observation.kind !== 'start' || runtime !== 0n)
	) {
		anomaly = 'start_missing';
	} else if (state.start_seen && observation.kind === 'start') anomaly = 'start_repeated';
	else if (state.final_seen) anomaly = 'observation_after_final';
	else if (
		runtime < priorRuntime ||
		egress < priorEgress ||
		observation.egress_counter_epoch !== state.egress_counter_epoch ||
		(state.start_seen &&
			(state.start_monotonic_ns === null ||
				state.last_observed_monotonic_ns === null ||
				monotonic < BigInt(state.last_observed_monotonic_ns) ||
				monotonic - BigInt(state.start_monotonic_ns) !== runtime))
	) {
		anomaly = 'counter_reset';
	} else {
		anomaly =
			observationIntegrityReason(identity, state, observation, observation.received_at) ?? null;
	}
	if (
		!anomaly &&
		(observation.observed_at.getTime() > observation.received_at.getTime() + maximumClockLeadMs ||
			(observation.kind === 'start' &&
				observation.observed_at.getTime() < identity.created_at.getTime() - maximumClockLeadMs))
	) {
		anomaly = 'clock_skew';
	} else if (!anomaly && state.last_observed_at) {
		const runtimeDeltaMs = Number((runtime - priorRuntime) / nanosecondsPerMillisecond);
		const wallDeltaMs = observation.observed_at.getTime() - state.last_observed_at.getTime();
		if (Math.abs(wallDeltaMs - runtimeDeltaMs) > maximumWallDivergenceMs) anomaly = 'clock_skew';
	}

	if (anomaly) {
		await exception(client, {
			key: `meter:${identity.id}:${identity.lease_generation}:${observation.host_boot_id}:${observation.sequence}:${anomaly}`,
			hostId: identity.host_id,
			machineId: identity.id,
			leaseId: identity.lease_id,
			leaseGeneration: identity.lease_generation,
			hostBootId: observation.host_boot_id,
			sequence: observation.sequence,
			reason: anomaly
		});
		await setQuarantined(client, identity.id, anomaly);
		await client.query(
			`UPDATE machine_meter_state
			 SET last_sequence = $2, last_received_at = $3, updated_at = now()
			 WHERE machine_id = $1 AND last_sequence = $4`,
			[identity.id, observation.sequence, observation.received_at, priorSequence.toString()]
		);
		return 'quarantined';
	}

	if (observation.kind === 'start') {
		const cutoverBoundary = await closeLegacyPrefix(client, identity, observation.observed_at);
		const legacyCoveredRuntime =
			BigInt(Math.max(0, cutoverBoundary.getTime() - observation.observed_at.getTime())) *
			nanosecondsPerMillisecond;
		await client.query(
			`UPDATE machine_meter_state
			 SET last_sequence = $2, start_seen = true, last_runtime_ns = $3,
			     projected_runtime_ns = $4, last_egress_bytes = $5, egress_counter_epoch = $6,
			     start_monotonic_ns = $7, last_observed_monotonic_ns = $7,
			     last_observed_at = $8, last_period_end = $9, last_received_at = $10,
			     final_seen = false, updated_at = now()
			 WHERE machine_id = $1 AND last_sequence = $11`,
			[
				identity.id,
				observation.sequence,
				observation.runtime_ns,
				legacyCoveredRuntime.toString(),
				observation.egress_bytes,
				observation.egress_counter_epoch,
				observation.observed_monotonic_ns,
				observation.observed_at,
				cutoverBoundary,
				observation.received_at,
				priorSequence.toString()
			]
		);
		return 'accepted';
	}

	const runtimeDelta = runtime > priorProjectedRuntime ? runtime - priorProjectedRuntime : 0n;
	const projectedRuntime = runtime > priorProjectedRuntime ? runtime : priorProjectedRuntime;
	const egressDelta = egress - priorEgress;
	const periodStart = state.last_period_end ?? state.last_observed_at;
	if (!periodStart) throw new Error('accepted meter state is missing its period boundary');
	const segments = splitRuntimeAtUtcMidnight(periodStart, runtimeDelta);
	for (const segment of segments) {
		const prefix = `meter:${observation.id}:${segment.index}`;
		await appendProjection(client, {
			eventKey: `${prefix}:compute`,
			observationId: observation.id,
			identity,
			dimension: 'compute',
			unit: 'vcpu_nanosecond',
			quantity: segment.runtimeNs * BigInt(identity.vcpus),
			periodStart: segment.start,
			periodEnd: segment.end
		});
		await appendProjection(client, {
			eventKey: `${prefix}:memory`,
			observationId: observation.id,
			identity,
			dimension: 'memory',
			unit: 'byte_nanosecond',
			quantity: segment.runtimeNs * BigInt(identity.memory_bytes),
			periodStart: segment.start,
			periodEnd: segment.end
		});
	}
	if (egressDelta > 0n) {
		const finalSegment = segments.at(-1);
		const periodEnd = finalSegment?.end ?? periodStart;
		await appendProjection(client, {
			eventKey: `meter:${observation.id}:egress`,
			observationId: observation.id,
			identity,
			dimension: 'egress',
			unit: 'byte',
			quantity: egressDelta,
			periodStart,
			periodEnd
		});
	}
	const periodEnd = timestampFromNanoseconds(
		BigInt(periodStart.getTime()) * nanosecondsPerMillisecond + runtimeDelta
	);
	await client.query(
		`UPDATE machine_meter_state
		 SET last_sequence = $2, last_runtime_ns = $3, projected_runtime_ns = $4,
		     last_egress_bytes = $5, last_observed_monotonic_ns = $6,
		     last_observed_at = $7, last_period_end = $8,
		     last_received_at = $9, final_seen = $10, updated_at = now()
		 WHERE machine_id = $1 AND last_sequence = $11`,
		[
			identity.id,
			observation.sequence,
			observation.runtime_ns,
			projectedRuntime.toString(),
			observation.egress_bytes,
			observation.observed_monotonic_ns,
			observation.observed_at,
			periodEnd,
			observation.received_at,
			observation.kind === 'final',
			priorSequence.toString()
		]
	);
	if (observation.kind === 'final') {
		await client.query(
			`UPDATE machines
			 SET usage_checkpoint_at = $2, usage_finalized_at = COALESCE(usage_finalized_at, now())
			 WHERE id = $1 AND lease_id = $3 AND lease_generation = $4`,
			[identity.id, periodEnd, identity.lease_id, identity.lease_generation]
		);
		if (observation.quality === 'last_defensible') {
			await exception(client, {
				key: `meter:${identity.id}:${identity.lease_generation}:${observation.host_boot_id}:${observation.sequence}:degraded_terminal:${observation.quality_reason}`,
				hostId: identity.host_id,
				machineId: identity.id,
				leaseId: identity.lease_id,
				leaseGeneration: identity.lease_generation,
				hostBootId: observation.host_boot_id,
				sequence: observation.sequence,
				reason: 'degraded_terminal'
			});
			await setQuarantined(client, identity.id, 'degraded_terminal');
			return 'quarantined';
		}
	}
	return 'accepted';
};

export class AuthoritativeMetering {
	constructor(
		private readonly database: Database,
		private readonly minimumBatchIntervalMs = minimumMeteringBatchIntervalMs
	) {
		if (
			!Number.isSafeInteger(minimumBatchIntervalMs) ||
			minimumBatchIntervalMs < 0 ||
			minimumBatchIntervalMs > 60_000
		) {
			throw new Error('metering batch interval must be between 0 and 60000 milliseconds');
		}
	}

	async ingest(
		hostId: string,
		observations: ReadonlyArray<HostUsageObservation>,
		credentialGeneration?: number
	): Promise<ReadonlyArray<HostUsageObservationReceipt>> {
		if (observations.length < 1 || observations.length > 256) {
			throw new MeteringInputError('observation batch must contain between 1 and 256 entries');
		}
		for (const observation of observations) validateObservation(observation);
		return this.database.transaction(async (client) => {
			const host = await client.query<{
				desired_state: string;
				credential_status: string;
				credential_generation: number;
				metering_cadence_valid: boolean;
			}>(
				`SELECT desired_state::text, credential_status::text, credential_generation,
				        last_metering_batch_at IS NULL OR
				          last_metering_batch_at <= statement_timestamp() -
				            ($2 * interval '1 millisecond') AS metering_cadence_valid
				 FROM hosts
				 WHERE id = $1 FOR UPDATE`,
				[hostId, this.minimumBatchIntervalMs]
			);
			if (
				!host.rows[0] ||
				!['active', 'draining'].includes(host.rows[0].desired_state) ||
				host.rows[0].credential_status !== 'active' ||
				(credentialGeneration !== undefined &&
					host.rows[0].credential_generation !== credentialGeneration)
			) {
				throw new MeteringHostLifecycleError('host lifecycle does not allow metering observations');
			}
			if (!host.rows[0].metering_cadence_valid) {
				throw new MeteringRateLimitError('host metering batch cadence exceeded');
			}
			await client.query(
				'UPDATE hosts SET last_metering_batch_at = statement_timestamp() WHERE id = $1',
				[hostId]
			);

			const receipts: HostUsageObservationReceipt[] = [];
			let hostQuarantined = false;
			for (const input of observations) {
				if (hostQuarantined) {
					receipts.push(receiptFor(input, 'quarantined'));
					continue;
				}
				const identity = (
					await client.query<MachineIdentityRow>(
						`SELECT id, organization_id, project_id, host_id, host_machine_id,
						        lease_id, lease_generation::text, vcpus,
						        (memory_mb::bigint * 1048576)::text AS memory_bytes,
						        created_at, started_at, usage_checkpoint_at,
						        state::text, expires_at, statement_timestamp() AS admission_received_at
						 FROM machines
						 WHERE id = $1 AND host_id = $2 AND host_machine_id = $3
						   AND lease_id = $4 AND lease_generation = $5::bigint
						 FOR UPDATE`,
						[input.machineId, hostId, input.hostMachineId, input.leaseId, input.leaseGeneration]
					)
				).rows[0];
				if (
					!identity ||
					identity.vcpus !== input.vcpus ||
					identity.memory_bytes !== input.memoryBytes
				) {
					throw new MeteringInputError(
						'observation does not match the authoritative machine lease and resources'
					);
				}

				let state = await stateForUpdate(client, input.machineId);
				if (!state) {
					await client.query(
						`INSERT INTO machine_meter_state
						 (machine_id, host_id, host_machine_id, lease_id, lease_generation,
						  host_boot_id, egress_counter_epoch)
						 VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::bigint)`,
						[
							identity.id,
							identity.host_id,
							identity.host_machine_id,
							identity.lease_id,
							identity.lease_generation,
							input.hostBootId,
							input.egressCounterEpoch
						]
					);
					state = (await stateForUpdate(client, input.machineId))!;
				}
				const sequence = BigInt(input.sequence);
				const lastSequence = BigInt(state.last_sequence);
				let sequenceViolation =
					state.host_boot_id !== input.hostBootId ||
					sequence > lastSequence + maximumForwardSequenceWindow;
				if (!sequenceViolation && sequence > lastSequence + 1n) {
					const pending = await client.query<{ count: string }>(
						`SELECT count(*)::text AS count
						 FROM host_usage_observations observation
						 JOIN machine_meter_state meter ON meter.machine_id = observation.machine_id
						  AND meter.lease_generation = observation.lease_generation
						 WHERE observation.host_id = $1
						   AND observation.sequence > meter.last_sequence`,
						[hostId]
					);
					sequenceViolation =
						Number(pending.rows[0]?.count ?? '0') >= maximumPendingObservationsPerHost;
				}
				if (sequenceViolation) {
					await exception(client, {
						key: `meter:${identity.id}:${identity.lease_generation}:sequence_window_exceeded`,
						hostId,
						machineId: identity.id,
						leaseId: identity.lease_id,
						leaseGeneration: identity.lease_generation,
						hostBootId: input.hostBootId,
						sequence: input.sequence,
						reason: 'sequence_window_exceeded'
					});
					await setQuarantined(client, input.machineId, 'sequence_window_exceeded');
					await quarantineHost(client, hostId, 'metering sequence admission violated');
					hostQuarantined = true;
					receipts.push(receiptFor(input, 'quarantined'));
					continue;
				}
				const integrityViolation =
					sequence === lastSequence + 1n
						? observationIntegrityReason(
								identity,
								state,
								{
									kind: input.kind,
									quality: input.quality,
									runtime_ns: input.runtimeNs,
									egress_bytes: input.egressBytes,
									egress_counter_epoch: input.egressCounterEpoch
								},
								identity.admission_received_at
							)
						: undefined;
				if (integrityViolation) {
					await exception(client, {
						key: `meter:${identity.id}:${identity.lease_generation}:${integrityViolation}`,
						hostId,
						machineId: identity.id,
						leaseId: identity.lease_id,
						leaseGeneration: identity.lease_generation,
						hostBootId: input.hostBootId,
						sequence: input.sequence,
						reason: integrityViolation
					});
					await setQuarantined(client, input.machineId, integrityViolation);
					await quarantineHost(client, hostId, `metering ${integrityViolation}`);
					hostQuarantined = true;
					receipts.push(receiptFor(input, 'quarantined'));
					continue;
				}

				const hash = payloadHash(input);
				const inserted = await client.query<StoredObservationRow>(
					`INSERT INTO host_usage_observations
						 (host_id, machine_id, host_machine_id, lease_id, lease_generation,
						  host_boot_id, sequence, kind, quality, quality_reason, runtime_ns, egress_bytes,
						  egress_counter_epoch, observed_monotonic_ns, observed_at,
						  vcpus, memory_bytes, process_id, payload_hash)
						 VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::bigint, $8, $9, $10,
						         $11::numeric, $12::numeric, $13::bigint, $14::numeric,
						         $15, $16, $17::bigint, $18, $19)
					 ON CONFLICT (host_id, host_boot_id, lease_id, lease_generation, sequence)
					 DO NOTHING
							 RETURNING id::text, payload_hash, host_boot_id::text, sequence::text, kind,
							  quality, quality_reason,
						  runtime_ns::text, egress_bytes::text, egress_counter_epoch::text,
						  observed_monotonic_ns::text,
					  observed_at, received_at, vcpus, memory_bytes::text`,
					[
						hostId,
						input.machineId,
						input.hostMachineId,
						input.leaseId,
						input.leaseGeneration,
						input.hostBootId,
						input.sequence,
						input.kind,
						input.quality,
						input.qualityReason,
						input.runtimeNs,
						input.egressBytes,
						input.egressCounterEpoch,
						input.observedMonotonicNs,
						new Date(input.observedAt),
						input.vcpus,
						input.memoryBytes,
						input.processId,
						hash
					]
				);
				let stored = inserted.rows[0];
				let duplicate = false;
				if (!stored) {
					duplicate = true;
					stored = (
						await client.query<StoredObservationRow>(
							`SELECT id::text, payload_hash, host_boot_id::text, sequence::text, kind,
								 quality, quality_reason,
								 runtime_ns::text, egress_bytes::text, egress_counter_epoch::text,
								 observed_monotonic_ns::text,
							 observed_at, received_at, vcpus, memory_bytes::text
							 FROM host_usage_observations
							 WHERE host_id = $1 AND host_boot_id = $2 AND lease_id = $3
							   AND lease_generation = $4::bigint AND sequence = $5::bigint`,
							[hostId, input.hostBootId, input.leaseId, input.leaseGeneration, input.sequence]
						)
					).rows[0];
					if (!stored || !stored.payload_hash.equals(hash)) {
						await exception(client, {
							key: `meter:${input.machineId}:${input.leaseGeneration}:${input.hostBootId}:${input.sequence}:payload_conflict`,
							hostId,
							machineId: input.machineId,
							leaseId: input.leaseId,
							leaseGeneration: input.leaseGeneration,
							hostBootId: input.hostBootId,
							sequence: input.sequence,
							reason: 'payload_conflict'
						});
						await setQuarantined(client, input.machineId, 'payload_conflict');
						await quarantineHost(client, hostId, 'metering payload conflict');
						hostQuarantined = true;
						receipts.push(receiptFor(input, 'rejected_payload_conflict'));
						continue;
					}
				}

				let processedInput = false;
				let inputQuarantined = false;
				for (;;) {
					state = (await stateForUpdate(client, input.machineId))!;
					const next = (BigInt(state.last_sequence) + 1n).toString();
					const pending = (
						await client.query<StoredObservationRow>(
							`SELECT id::text, payload_hash, host_boot_id::text, sequence::text, kind,
								 quality, quality_reason,
								 runtime_ns::text, egress_bytes::text, egress_counter_epoch::text,
								 observed_monotonic_ns::text,
							 observed_at, received_at, vcpus, memory_bytes::text
							 FROM host_usage_observations
							 WHERE machine_id = $1 AND lease_generation = $2::bigint
							   AND host_boot_id = $3 AND sequence = $4::bigint`,
							[identity.id, identity.lease_generation, state.host_boot_id, next]
						)
					).rows[0];
					if (!pending) break;
					const outcome = await processObservation(client, identity, state, pending);
					if (pending.id === stored.id) {
						processedInput = true;
						inputQuarantined = outcome === 'quarantined';
					}
				}
				if (inputQuarantined) {
					await quarantineHost(client, hostId, 'metering observation integrity violated');
					hostQuarantined = true;
				}

				state = (await stateForUpdate(client, input.machineId))!;
				if (BigInt(input.sequence) > BigInt(state.last_sequence)) {
					await exception(client, {
						key: `meter:${input.machineId}:${input.leaseGeneration}:${input.hostBootId}:${input.sequence}:sequence_gap`,
						hostId,
						machineId: input.machineId,
						leaseId: input.leaseId,
						leaseGeneration: input.leaseGeneration,
						hostBootId: input.hostBootId,
						sequence: input.sequence,
						reason: 'sequence_gap'
					});
				}
				await client.query(
					`INSERT INTO metering_exception_resolutions (exception_id, resolution)
					 SELECT exception.id, 'missing observation arrived'
					 FROM metering_exceptions exception
					 WHERE exception.machine_id = $1 AND exception.lease_generation = $2::bigint
					   AND exception.reason = 'sequence_gap' AND exception.sequence <= $3::bigint
					 ON CONFLICT (exception_id) DO NOTHING`,
					[identity.id, identity.lease_generation, state.last_sequence]
				);
				receipts.push(
					receiptFor(
						input,
						inputQuarantined
							? 'quarantined'
							: processedInput
								? duplicate
									? 'duplicate'
									: 'accepted'
								: BigInt(input.sequence) <= BigInt(state.last_sequence)
									? 'duplicate'
									: 'pending_gap'
					)
				);
			}
			return receipts;
		});
	}

	async closeHostLoss(machineId: string, leaseId: string): Promise<Date | undefined> {
		return this.database.transaction(async (client) => {
			const machine = (
				await client.query<{
					host_id: string;
					lease_generation: string;
					meter_state: boolean;
					start_seen: boolean | null;
					last_period_end: Date | null;
					final_seen: boolean | null;
				}>(
					`SELECT m.host_id, m.lease_generation::text,
					        state.machine_id IS NOT NULL AS meter_state, state.start_seen,
					        state.last_period_end, state.final_seen
					 FROM machines m
					 LEFT JOIN machine_meter_state state ON state.machine_id = m.id
					 WHERE m.id = $1 AND m.lease_id = $2 FOR UPDATE OF m`,
					[machineId, leaseId]
				)
			).rows[0];
			if (!machine) return undefined;
			if (!machine.meter_state) return undefined;
			const reason = machine.last_period_end
				? 'host_lost_without_final'
				: 'host_lost_without_observation';
			if (!machine.start_seen) {
				await exception(client, {
					key: `meter:${machineId}:${machine.lease_generation}:host_loss:${reason}`,
					hostId: machine.host_id,
					machineId,
					leaseId,
					leaseGeneration: machine.lease_generation,
					reason
				});
				return undefined;
			}
			if (!machine.final_seen) {
				await exception(client, {
					key: `meter:${machineId}:${machine.lease_generation}:host_loss:${reason}`,
					hostId: machine.host_id,
					machineId,
					leaseId,
					leaseGeneration: machine.lease_generation,
					reason
				});
				await client.query(
					`UPDATE machine_meter_state
					 SET loss_closed_at = COALESCE(loss_closed_at, now()), updated_at = now()
					 WHERE machine_id = $1 AND lease_id = $2`,
					[machineId, leaseId]
				);
			}
			await client.query(
				`UPDATE machines
				 SET usage_checkpoint_at = COALESCE($3, usage_checkpoint_at),
				     usage_finalized_at = COALESCE(usage_finalized_at, now())
				 WHERE id = $1 AND lease_id = $2`,
				[machineId, leaseId, machine.last_period_end]
			);
			return machine.last_period_end ?? undefined;
		});
	}

	async health(): Promise<{ readonly backlog: number; readonly openExceptions: number }> {
		const result = await this.database.query<{ backlog: string; exceptions: string }>(
			`SELECT
			 (SELECT count(*) FROM host_usage_observations observation
			  LEFT JOIN machine_meter_state state ON state.machine_id = observation.machine_id
			  WHERE state.machine_id IS NULL OR observation.sequence > state.last_sequence) AS backlog,
			 (SELECT count(*) FROM metering_exceptions exception
			  WHERE NOT EXISTS (
			    SELECT 1 FROM metering_exception_resolutions resolution
			    WHERE resolution.exception_id = exception.id
			  )) AS exceptions`
		);
		return {
			backlog: Number(result.rows[0]?.backlog ?? 0),
			openExceptions: Number(result.rows[0]?.exceptions ?? 0)
		};
	}
}

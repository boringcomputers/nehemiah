import type { Queryable } from '../db/client.js';
import { privateBetaRates, type MeterDimension, type Rate } from './rates.js';

const microsPerCent = 10_000n;
const mebibytesPerGibibyte = 1_024n;
const bytesPerGibibyteHour = 1_073_741_824n * 3_600n;
const meterDimensions: ReadonlyArray<MeterDimension> = [
	'vcpu_seconds',
	'gib_seconds',
	'storage_gib_hours',
	'egress_bytes',
	'inference_units'
];

export interface BillingCommitmentDelta {
	/** Whole vCPU-seconds reserved by the new operation. */
	readonly vcpuSeconds?: bigint;
	/** Whole MiB-seconds reserved by the new operation. */
	readonly memoryMebibyteSeconds?: bigint;
	/** Whole byte-seconds reserved by the new operation. */
	readonly storageByteSeconds?: bigint;
}

export class BillingAdmissionRejected extends Error {
	constructor(
		readonly code: 'billing_delinquent' | 'billing_plan_unavailable' | 'spend_cap_exceeded',
		message: string
	) {
		super(message);
	}
}

type BillingAccountRow = {
	plan: string;
	spend_cap_cents: string | null;
	delinquent_at: Date | null;
};

type UsageRow = {
	dimension: MeterDimension;
	quantity: string;
};

type DurableCommitmentsRow = {
	vcpu_seconds: string;
	memory_mebibyte_seconds: string;
	storage_byte_seconds: string;
};

const decimal = (value: string): { numerator: bigint; denominator: bigint } => {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
	if (!match) throw new Error('billing quantity is not a non-negative decimal');
	const fractional = match[2] ?? '';
	return {
		numerator: BigInt(`${match[1]}${fractional}`),
		denominator: 10n ** BigInt(fractional.length)
	};
};

const ceilingPrice = (quantity: string | bigint, rate: bigint, divisor = 1n): bigint => {
	if (rate < 0n || divisor < 1n) throw new Error('billing rate configuration is invalid');
	const parsed =
		typeof quantity === 'bigint' ? { numerator: quantity, denominator: 1n } : decimal(quantity);
	if (parsed.numerator < 0n) throw new Error('billing commitment cannot be negative');
	const numerator = parsed.numerator * rate;
	const denominator = parsed.denominator * divisor;
	return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
};

/**
 * Admission-time cost projection over immutable usage plus durable, unexpired
 * allocations. This is deliberately more conservative than invoice pricing:
 * every dimension is rounded up to a micro-dollar before comparing the cap.
 *
 * Callers must hold the organization row lock before invoking this method. The
 * Stripe transition path uses the same organization -> billing-account order,
 * making delinquency and commitment admission one serial decision per tenant.
 */
export class BillingAdmissionPolicy {
	readonly #rates: ReadonlyMap<MeterDimension, bigint>;

	constructor(
		rates: ReadonlyArray<Rate> = privateBetaRates,
		private readonly plan = 'private_beta'
	) {
		const configured = new Map<MeterDimension, bigint>();
		for (const rate of rates) {
			if (configured.has(rate.dimension) || rate.unitPriceMicros < 0n) {
				throw new Error('billing rate configuration is invalid');
			}
			configured.set(rate.dimension, rate.unitPriceMicros);
		}
		for (const dimension of meterDimensions) {
			if (!configured.has(dimension)) throw new Error(`billing rate is missing for ${dimension}`);
		}
		this.#rates = configured;
	}

	async enforce(
		client: Queryable,
		organizationId: string,
		additional: BillingCommitmentDelta = {}
	): Promise<void> {
		const accountResult = await client.query<BillingAccountRow>(
			`SELECT plan, spend_cap_cents::text, delinquent_at
			 FROM billing_accounts WHERE organization_id = $1 FOR UPDATE`,
			[organizationId]
		);
		const account = accountResult.rows[0];
		if (!account) return;
		if (account.delinquent_at) {
			throw new BillingAdmissionRejected(
				'billing_delinquent',
				'Organization billing is delinquent; new resource commitments are suspended.'
			);
		}
		if (account.plan !== this.plan) {
			throw new BillingAdmissionRejected(
				'billing_plan_unavailable',
				'Organization billing plan has no active admission rate card.'
			);
		}
		if (account.spend_cap_cents === null) return;

		const usage = await client.query<UsageRow>(
			`WITH durable_usage AS (
			   SELECT dimension::text AS dimension, quantity
			   FROM usage_events WHERE organization_id = $1
			   UNION ALL
			   SELECT 'vcpu_seconds',
			          GREATEST(EXTRACT(EPOCH FROM (period_end - period_start)), 0) * vcpus
			   FROM usage_outbox
			   WHERE organization_id = $1 AND processed_at IS NULL
			   UNION ALL
			   SELECT 'gib_seconds',
			          GREATEST(EXTRACT(EPOCH FROM (period_end - period_start)), 0)
			            * memory_mb / 1024
			   FROM usage_outbox
			   WHERE organization_id = $1 AND processed_at IS NULL
			 )
			 SELECT dimension, COALESCE(sum(quantity), 0)::text AS quantity
			 FROM durable_usage GROUP BY dimension`,
			[organizationId]
		);
		const commitments = await client.query<DurableCommitmentsRow>(
			`WITH machine_commitments AS (
			   SELECT machine.vcpus, machine.memory_mb, machine.state,
			          GREATEST(machine.expires_at,
			            COALESCE(extension.target_expires_at, '-infinity'::timestamptz))
			            AS committed_until,
			          COALESCE(machine.stopped_at, statement_timestamp()) AS accounting_end,
			          COALESCE(usage.vcpu_through, machine.started_at,
			            machine.placed_at, machine.created_at) AS vcpu_through,
			          COALESCE(usage.memory_through, machine.started_at,
			            machine.placed_at, machine.created_at) AS memory_through
			   FROM machines machine
			   LEFT JOIN LATERAL (
			     SELECT max(target_expires_at) AS target_expires_at
			     FROM machine_extend_operations operation
			     WHERE operation.machine_id = machine.id
			       AND operation.organization_id = machine.organization_id
			   ) extension ON true
			   LEFT JOIN LATERAL (
			     SELECT
			       max(period_end) FILTER (WHERE dimension = 'vcpu_seconds') AS vcpu_through,
			       max(period_end) FILTER (WHERE dimension = 'gib_seconds') AS memory_through
			     FROM (
			       SELECT event.dimension::text AS dimension, event.period_end
			       FROM usage_events event
			       WHERE event.machine_id = machine.id
			         AND event.organization_id = machine.organization_id
			       UNION ALL
			       SELECT dimension, outbox.period_end
			       FROM usage_outbox outbox
			       CROSS JOIN (VALUES ('vcpu_seconds'), ('gib_seconds')) dimensions(dimension)
			       WHERE outbox.machine_id = machine.id
			         AND outbox.organization_id = machine.organization_id
			         AND outbox.processed_at IS NULL
			     ) durable_usage
			   ) usage ON true
			   WHERE machine.organization_id = $1
			     AND (
			       machine.state NOT IN ('requested', 'placing', 'stopped', 'failed', 'lost')
			       OR (machine.state IN ('stopped', 'failed', 'lost')
			           AND machine.usage_finalized_at IS NULL)
			     )
			 )
			 SELECT
			   COALESCE((SELECT sum(
			     (CASE WHEN state IN ('stopped', 'failed', 'lost') THEN 0
			       ELSE GREATEST(EXTRACT(EPOCH FROM (committed_until - statement_timestamp())), 0)
			      END + GREATEST(EXTRACT(EPOCH FROM (accounting_end - vcpu_through)), 0))
			       * vcpus
			   ) FROM machine_commitments), 0)::text AS vcpu_seconds,
			   COALESCE((SELECT sum(
			     (CASE WHEN state IN ('stopped', 'failed', 'lost') THEN 0
			       ELSE GREATEST(EXTRACT(EPOCH FROM (committed_until - statement_timestamp())), 0)
			      END + GREATEST(EXTRACT(EPOCH FROM (accounting_end - memory_through)), 0))
			       * memory_mb
			   ) FROM machine_commitments), 0)::text AS memory_mebibyte_seconds,
			   COALESCE((SELECT sum(
			     size_limit_bytes::numeric
			       * GREATEST(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())), 0)
			   ) FROM volumes
			   WHERE organization_id = $1 AND deleted_at IS NULL
			     AND expires_at > statement_timestamp()), 0)::text AS storage_byte_seconds`,
			[organizationId]
		);
		const durable = commitments.rows[0]!;

		let projectedMicros = 0n;
		for (const row of usage.rows) {
			projectedMicros += ceilingPrice(row.quantity, this.#rate(row.dimension));
		}
		projectedMicros += ceilingPrice(durable.vcpu_seconds, this.#rate('vcpu_seconds'));
		projectedMicros += ceilingPrice(
			durable.memory_mebibyte_seconds,
			this.#rate('gib_seconds'),
			mebibytesPerGibibyte
		);
		projectedMicros += ceilingPrice(
			durable.storage_byte_seconds,
			this.#rate('storage_gib_hours'),
			bytesPerGibibyteHour
		);
		projectedMicros += ceilingPrice(additional.vcpuSeconds ?? 0n, this.#rate('vcpu_seconds'));
		projectedMicros += ceilingPrice(
			additional.memoryMebibyteSeconds ?? 0n,
			this.#rate('gib_seconds'),
			mebibytesPerGibibyte
		);
		projectedMicros += ceilingPrice(
			additional.storageByteSeconds ?? 0n,
			this.#rate('storage_gib_hours'),
			bytesPerGibibyteHour
		);

		if (projectedMicros > BigInt(account.spend_cap_cents) * microsPerCent) {
			throw new BillingAdmissionRejected(
				'spend_cap_exceeded',
				'Organization spend cap would be exceeded by this resource commitment.'
			);
		}
	}

	#rate(dimension: MeterDimension): bigint {
		return this.#rates.get(dimension)!;
	}
}

export type MeterDimension =
	'vcpu_seconds' | 'gib_seconds' | 'storage_gib_hours' | 'egress_bytes' | 'inference_units';

export interface Rate {
	readonly dimension: MeterDimension;
	readonly unitPriceMicros: bigint;
	readonly unit: string;
}

/** Version rates rather than editing historical values in place. */
export const privateBetaRates: ReadonlyArray<Rate> = [
	{ dimension: 'vcpu_seconds', unitPriceMicros: 0n, unit: 'vCPU-second' },
	{ dimension: 'gib_seconds', unitPriceMicros: 0n, unit: 'GiB-second' },
	{ dimension: 'storage_gib_hours', unitPriceMicros: 0n, unit: 'GiB-hour' },
	{ dimension: 'egress_bytes', unitPriceMicros: 0n, unit: 'byte' },
	{ dimension: 'inference_units', unitPriceMicros: 0n, unit: 'provider unit' }
];

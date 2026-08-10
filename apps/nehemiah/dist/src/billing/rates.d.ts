export type MeterDimension = 'vcpu_seconds' | 'gib_seconds' | 'storage_gib_hours' | 'egress_bytes' | 'inference_units';
export interface Rate {
    readonly dimension: MeterDimension;
    readonly unitPriceMicros: bigint;
    readonly unit: string;
}
/** Version rates rather than editing historical values in place. */
export declare const privateBetaRates: ReadonlyArray<Rate>;

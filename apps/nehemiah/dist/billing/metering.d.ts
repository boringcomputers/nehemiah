import type { Database } from '../db/client.js';
export declare class MeteringInputError extends Error {
}
export declare class MeteringHostLifecycleError extends Error {
}
export declare class MeteringRateLimitError extends Error {
    readonly retryAfterSeconds = 1;
}
export type HostUsageObservationKind = 'start' | 'checkpoint' | 'final';
export type HostUsageObservationQuality = 'exact' | 'last_defensible';
export type HostUsageObservationQualityReason = 'none' | 'terminal_monotonic_unavailable' | 'terminal_monotonic_regressed' | 'terminal_egress_unavailable' | 'invalid_or_expired_state' | 'runtime_unavailable' | 'host_boot_changed' | 'network_isolation_unavailable';
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
export type HostUsageObservationOutcome = 'accepted' | 'duplicate' | 'pending_gap' | 'quarantined' | 'rejected_payload_conflict';
export interface HostUsageObservationReceipt {
    readonly leaseId: string;
    readonly leaseGeneration: string;
    readonly hostBootId: string;
    readonly sequence: string;
    readonly outcome: HostUsageObservationOutcome;
    readonly acknowledged: boolean;
}
interface UsageSegment {
    readonly index: number;
    readonly start: Date;
    readonly end: Date;
    readonly runtimeNs: bigint;
}
/** Split a monotonic interval at UTC midnights without losing a nanosecond. */
export declare const splitRuntimeAtUtcMidnight: (start: Date, durationNs: bigint) => ReadonlyArray<UsageSegment>;
export declare class AuthoritativeMetering {
    private readonly database;
    private readonly minimumBatchIntervalMs;
    constructor(database: Database, minimumBatchIntervalMs?: number);
    ingest(hostId: string, observations: ReadonlyArray<HostUsageObservation>, credentialGeneration?: number): Promise<ReadonlyArray<HostUsageObservationReceipt>>;
    closeHostLoss(machineId: string, leaseId: string): Promise<Date | undefined>;
    health(): Promise<{
        readonly backlog: number;
        readonly openExceptions: number;
    }>;
}
export {};

import { type Attributes } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { Environment, TelemetryConfig } from './config.js';
export interface LogContext {
    readonly requestId?: string;
    readonly machineId?: string;
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly hostId?: string;
    readonly leaseId?: string;
    readonly forkOperationId?: string;
    readonly sourceMachineId?: string;
    readonly method?: string;
    readonly path?: string;
    readonly status?: number;
    readonly duration_ms?: number;
    readonly port?: number;
    readonly environment?: string;
    readonly reason?: string;
    readonly result?: string;
    readonly error?: unknown;
}
export interface DatabasePoolSnapshot {
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
}
export interface MeteringHealthSnapshot {
    readonly backlog: number;
    readonly openExceptions: number;
}
export type ControlPlaneJob = 'device_authorization_retention' | 'gateway_grant_expiry' | 'gateway_stream_expiry' | 'host_stale_marker' | 'machine_expiry' | 'machine_reconciliation' | 'template_replication' | 'usage_aggregation' | 'volume_deletion';
interface RuntimeConfig {
    readonly telemetry?: TelemetryConfig;
    readonly environment: Environment;
    readonly region: string;
}
/** Build the only structured-log fields that may leave the process. Arbitrary
 * context keys and error text are intentionally discarded. */
export declare const safeLogRecord: (level: "debug" | "info" | "warn" | "error", message: string, input?: LogContext, now?: Date) => Record<string, unknown>;
/** Structured logger with a strict allowlist. Headers, URLs, bodies, commands,
 * terminal bytes, raw IPs, signed URLs, and error messages never enter it. */
export declare const log: (level: "debug" | "info" | "warn" | "error", message: string, contextValue?: LogContext) => void;
export declare const requestId: (request: Request) => string;
declare class ControlPlaneTelemetry {
    #private;
    constructor(sdk?: NodeSDK);
    request(input: {
        readonly request: Request;
        readonly requestId: string;
        readonly route: string;
    }, operation: () => Promise<Response>): Promise<Response>;
    job<A>(name: ControlPlaneJob, operation: () => Promise<A>): Promise<A>;
    registerDatabasePool(read: () => DatabasePoolSnapshot): void;
    registerMeteringHealth(read: () => Promise<MeteringHealthSnapshot>): void;
    inject(headers: Headers): void;
    shutdown(): Promise<void>;
}
/** Keep resource identity deployment-controlled and exclude credentials or
 * arbitrary environment/configuration values by construction. */
export declare const telemetryResourceAttributes: (telemetry: Pick<TelemetryConfig, "serviceVersion" | "instanceId" | "deploymentEnvironment">, region: string) => Attributes;
export declare const initializeTelemetry: (config: RuntimeConfig) => ControlPlaneTelemetry;
export declare const withControlPlaneRequestTelemetry: (input: {
    readonly request: Request;
    readonly requestId: string;
    readonly route: string;
}, operation: () => Promise<Response>) => Promise<Response>;
export declare const withJobTelemetry: <A>(name: ControlPlaneJob, operation: () => Promise<A>) => Promise<A>;
export declare const registerDatabasePoolMetrics: (read: () => DatabasePoolSnapshot) => void;
/** Global fleet gauges deliberately carry no tenant, machine, lease, or host labels. */
export declare const registerMeteringMetrics: (read: () => Promise<MeteringHealthSnapshot>) => void;
export declare const injectTraceHeaders: (headers: Headers) => void;
export {};

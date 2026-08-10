import { Effect, Redacted } from 'effect';
import type { ApiRateLimitConfig } from './auth/api-admission.js';
export type Environment = 'development' | 'test' | 'production';
export interface S3ObjectStorageConfig {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: Redacted.Redacted<string>;
    readonly secretAccessKey: Redacted.Redacted<string>;
    readonly sessionToken?: Redacted.Redacted<string>;
    readonly forcePathStyle: boolean;
}
export interface TemplateTransferConfig {
    readonly replicationIntervalMs: number;
    readonly hostTimeoutMs: number;
}
export interface VolumeBrokerConfig {
    readonly publicUrl: string;
    readonly secret: Redacted.Redacted<string>;
}
export interface TelemetryConfig {
    readonly endpoint: string;
    readonly authorization: Redacted.Redacted<string>;
    readonly serviceVersion: string;
    readonly instanceId: string;
    readonly deploymentEnvironment: 'development' | 'test' | 'staging' | 'production';
    readonly exportIntervalMs: number;
    readonly exportTimeoutMs: number;
    readonly traceSampleRatio: number;
}
export interface ServiceConfig {
    readonly environment: Environment;
    readonly host: string;
    readonly port: number;
    readonly databaseUrl: Redacted.Redacted<string>;
    readonly hostCredentialKey: Redacted.Redacted<string>;
    readonly gatewayToken: Redacted.Redacted<string>;
    readonly gatewaySecret: Redacted.Redacted<string>;
    readonly deviceCodePepper: Redacted.Redacted<string>;
    readonly gatewayPublicUrl: string;
    readonly deviceVerificationUrl: string;
    readonly previewBaseDomain?: string;
    readonly trustedSiteDomain?: string;
    readonly hostCidrs: ReadonlyArray<string>;
    readonly hostPort: number;
    readonly clerkIssuer?: string;
    readonly clerkAudience?: string;
    readonly hostStaleAfterMs: number;
    readonly defaultRegion: string;
    readonly objectStorage?: S3ObjectStorageConfig;
    readonly templateTransfers?: TemplateTransferConfig;
    readonly volumeBroker?: VolumeBrokerConfig;
    readonly telemetry?: TelemetryConfig;
    readonly apiRateLimit: ApiRateLimitConfig;
}
declare const ConfigError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ConfigError";
} & Readonly<A>;
export declare class ConfigError extends ConfigError_base<{
    readonly variable: string;
    readonly message: string;
}> {
}
/** Load and validate configuration inside Effect so startup failures are typed. */
export declare const loadConfig: (env?: NodeJS.ProcessEnv) => Effect.Effect<ServiceConfig, ConfigError>;
export {};

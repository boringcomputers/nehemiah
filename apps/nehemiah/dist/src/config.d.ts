import { Effect, Redacted } from 'effect';
export type Environment = 'development' | 'test' | 'production';
export interface ServiceConfig {
    readonly environment: Environment;
    readonly host: string;
    readonly port: number;
    readonly databaseUrl: Redacted.Redacted<string>;
    readonly internalToken: Redacted.Redacted<string>;
    readonly gatewayToken: Redacted.Redacted<string>;
    readonly clerkIssuer?: string;
    readonly clerkAudience?: string;
    readonly hostStaleAfterMs: number;
    readonly defaultRegion: string;
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

import type { TargetMode } from 'nehemiah-sdk';
export interface CliConfig {
    readonly apiKey?: string;
    readonly authMode?: 'api_key' | 'device';
    readonly credentialAccount?: string;
    readonly credentialOrigin?: string;
    readonly project?: string;
    readonly region?: string;
    readonly baseUrl?: string;
    readonly target?: TargetMode;
}
/** Canonical origin accepted for persisted credentials; paths are deliberately not retained. */
export declare function canonicalCredentialOrigin(baseUrl: string): string | undefined;
export interface ConfigPathOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly userHome?: string;
}
/** Always resolves to the operating system's per-user config directory. */
export declare function configPath(options?: ConfigPathOptions): string;
export declare function readConfig(path?: string): Promise<CliConfig>;
/** Atomic user-only write. The final file is explicitly chmodded to 0600. */
export declare function writeConfig(config: CliConfig, path?: string): Promise<void>;

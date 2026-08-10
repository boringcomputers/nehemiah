#!/usr/bin/env node
import { type NehemiahClient, type NehemiahClientOptions } from 'nehemiah-sdk';
import { type CliConfig } from './config.js';
import { type DeviceCodeResponse } from './device-auth.js';
import { type CredentialStore } from './credential-store.js';
export interface CliIo {
    readonly out: (text: string) => void;
    readonly error: (text: string) => void;
}
export interface CliDependencies {
    readonly env?: NodeJS.ProcessEnv;
    readonly io?: CliIo;
    readonly client?: NehemiahClient;
    readonly fetch?: typeof globalThis.fetch;
    readonly configFile?: string;
    readonly credentialStore?: CredentialStore;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
    readonly openBrowser?: (url: string) => Promise<void>;
    /** Test seam for proving that credential publication rolls back under the account lock. */
    readonly writeConfig?: (config: CliConfig, path: string) => Promise<void>;
}
export declare class DeviceLoginUnavailable extends Error {
    readonly code = "device_login_unavailable";
    readonly status?: number;
    constructor(status?: number);
}
export declare class CredentialOriginError extends Error {
    readonly code: 'credential_origin_required' | 'credential_origin_mismatch' | 'unsafe_credential_origin';
    constructor(code: 'credential_origin_required' | 'credential_origin_mismatch' | 'unsafe_credential_origin', message: string);
}
export declare function runCli(argv: ReadonlyArray<string>, dependencies?: CliDependencies): Promise<number>;
export declare function clientOptions(env: NodeJS.ProcessEnv, config: CliConfig, flags?: Readonly<Record<string, string | boolean>>): NehemiahClientOptions;
export declare function beginDeviceLogin(baseUrl: string, fetchImplementation: typeof globalThis.fetch): Promise<DeviceCodeResponse>;

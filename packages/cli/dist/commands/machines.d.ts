import type { NehemiahClient } from 'nehemiah-sdk';
export interface ParsedArgs {
    readonly positionals: ReadonlyArray<string>;
    readonly flags: Readonly<Record<string, string | boolean>>;
}
export interface CommandOutput {
    readonly value?: unknown;
    readonly human?: string;
}
export declare function parseArgs(args: ReadonlyArray<string>): ParsedArgs;
export declare function runMachineCommand(client: NehemiahClient, command: string, args: ParsedArgs): Promise<CommandOutput>;
export declare class UsageError extends Error {
    readonly code = "usage_error";
}

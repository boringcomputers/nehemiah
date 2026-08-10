import type { NehemiahClient } from 'nehemiah-sdk';
import { type CommandOutput, type ParsedArgs } from './machines.js';
export declare function runTemplateCommand(client: NehemiahClient, command: string | undefined, args: ParsedArgs): Promise<CommandOutput>;

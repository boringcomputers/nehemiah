import type { HostService } from '../domain/hosts.js';
export declare const markStaleHosts: (hosts: HostService, staleAfterMs: number) => Promise<ReadonlyArray<string>>;

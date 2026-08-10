import type { HostService } from '../domain/hosts.js';

export const markStaleHosts = (
	hosts: HostService,
	staleAfterMs: number
): Promise<ReadonlyArray<string>> => hosts.markStale(staleAfterMs);

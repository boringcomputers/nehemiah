import { describe, expect, it } from 'vitest';
import type { HostCapacity } from '../../src/scheduler/capacity.js';
import { chooseHost } from '../../src/scheduler/placement.js';

const host = (overrides: Partial<HostCapacity>): HostCapacity => ({
	id: 'host-a',
	region: 'ca-tor-1',
	architecture: 'x86_64',
	state: 'ready',
	vcpus: 16,
	memoryMb: 32_768,
	diskMb: 1_000_000,
	reservedVcpus: 0,
	reservedMemoryMb: 0,
	reservedDiskMb: 0,
	cachedTemplates: new Set(),
	...overrides
});

describe('deterministic placement', () => {
	it('excludes stale, draining and insufficient hosts', () => {
		const selected = chooseHost(
			[
				host({ id: 'draining', state: 'draining' }),
				host({ id: 'small', memoryMb: 512 }),
				host({ id: 'good', memoryMb: 4096 })
			],
			{
				region: 'ca-tor-1',
				architecture: 'x86_64',
				resources: { vcpus: 2, memoryMb: 1024, diskMb: 100 }
			}
		);
		expect(selected?.id).toBe('good');
	});

	it('prefers a cached template before best fit and breaks ties by host ID', () => {
		const selected = chooseHost(
			[
				host({ id: 'host-c', memoryMb: 4096 }),
				host({ id: 'host-b', memoryMb: 16_384, cachedTemplates: new Set(['tpl']) }),
				host({ id: 'host-a', memoryMb: 16_384, cachedTemplates: new Set(['tpl']) })
			],
			{
				region: 'ca-tor-1',
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 100 },
				templateId: 'tpl'
			}
		);
		expect(selected?.id).toBe('host-a');
	});
});

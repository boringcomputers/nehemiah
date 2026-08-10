import { describe, expect, it, vi } from 'vitest';
import {
	HostForkContractError,
	NehemiahdClient,
	type ForkOnHostChild,
	type HostMachine
} from '../../src/clients/nehemiahd.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const expiry = new Date('2030-01-01T00:00:00.000Z');
const children: ReadonlyArray<ForkOnHostChild> = [
	{
		leaseId: 'lease-1',
		leaseGeneration: 1,
		expiresAt: expiry,
		resources: { vcpus: 2, memoryMb: 2_048, diskMb: 10_240 },
		networkPolicy: { mode: 'allowlist', hostnames: ['api.example.com'], cidrs: [] },
		runtimeCohortId: testRuntimeCohort.id,
		sourceSha256: testRuntimeCohort.pythonRootfsSha256,
		metadata: {
			public_machine_id: 'm_child_1',
			parent_machine_id: 'm_parent',
			fork_operation_id: 'fork-operation'
		}
	},
	{
		leaseId: 'lease-2',
		leaseGeneration: 1,
		expiresAt: expiry,
		resources: { vcpus: 2, memoryMb: 2_048, diskMb: 10_240 },
		networkPolicy: { mode: 'allowlist', hostnames: ['api.example.com'], cidrs: [] },
		runtimeCohortId: testRuntimeCohort.id,
		sourceSha256: testRuntimeCohort.pythonRootfsSha256,
		metadata: {
			public_machine_id: 'm_child_2',
			parent_machine_id: 'm_parent',
			fork_operation_id: 'fork-operation'
		}
	}
];

const observed = (child: ForkOnHostChild, index: number): HostMachine => ({
	id: `host-child-${index}`,
	status: 'running',
	ready: true,
	lease_id: child.leaseId,
	lease_generation: child.leaseGeneration,
	metadata: child.metadata,
	expires_at: child.expiresAt.toISOString(),
	resources: {
		vcpus: child.resources.vcpus,
		memory_mb: child.resources.memoryMb,
		disk_mb: child.resources.diskMb
	},
	network_policy: child.networkPolicy,
	runtime_cohort_id: child.runtimeCohortId,
	source_sha256: child.sourceSha256
});

describe('managed host fork client', () => {
	it('sends the source lease and exact child descriptors', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ machines: children.map(observed) }), {
				status: 201,
				headers: { 'content-type': 'application/json' }
			})
		);
		const client = new NehemiahdClient('host-token', fetcher, 1_000, 8_080);

		await expect(
			client.fork('127.0.0.1', 'source/host', 'source-lease', 'fork-key', children)
		).resolves.toHaveLength(2);
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe('http://127.0.0.1:8080/internal/v1/machines/source%2Fhost/fork');
		expect(init?.headers).toMatchObject({
			authorization: 'Bearer host-token',
			'x-nehemiah-lease-id': 'source-lease',
			'idempotency-key': 'fork-key'
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			children: children.map((child) => ({
				lease_id: child.leaseId,
				lease_generation: child.leaseGeneration,
				expires_at: child.expiresAt.toISOString(),
				vcpus: child.resources.vcpus,
				memory_mb: child.resources.memoryMb,
				disk_mb: child.resources.diskMb,
				metadata: child.metadata,
				runtime_cohort_id: child.runtimeCohortId,
				source_sha256: child.sourceSha256
			}))
		});
	});

	it.each([
		[
			'duplicate host id',
			(machines: HostMachine[]) => [
				{ ...machines[0]!, id: 'same' },
				{ ...machines[1]!, id: 'same' }
			]
		],
		[
			'wrong resources',
			(machines: HostMachine[]) => [
				{ ...machines[0]!, resources: { ...machines[0]!.resources!, memory_mb: 1 } },
				machines[1]!
			]
		],
		[
			'wrong network policy',
			(machines: HostMachine[]) => [
				{ ...machines[0]!, network_policy: { mode: 'off' as const } },
				machines[1]!
			]
		],
		[
			'wrong metadata',
			(machines: HostMachine[]) => [
				{ ...machines[0]!, metadata: { ...machines[0]!.metadata!, parent_machine_id: 'other' } },
				machines[1]!
			]
		],
		[
			'earlier expiry',
			(machines: HostMachine[]) => [
				{ ...machines[0]!, expires_at: '2029-12-31T23:59:59.000Z' },
				machines[1]!
			]
		]
	])('treats %s as an ambiguous contract violation', async (_name, mutate) => {
		const machines = mutate(children.map(observed));
		const client = new NehemiahdClient(
			'host-token',
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ machines }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			),
			1_000,
			8_080
		);

		await expect(
			client.fork('127.0.0.1', 'source', 'source-lease', 'fork-key', children)
		).rejects.toMatchObject({
			ambiguous: true,
			observed: machines
		} satisfies Partial<HostForkContractError>);
	});

	it('treats a null child as an ambiguous contract violation', async () => {
		const first = observed(children[0]!, 0);
		const client = new NehemiahdClient(
			'host-token',
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ machines: [first, null] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			),
			1_000,
			8_080
		);

		await expect(
			client.fork('127.0.0.1', 'source', 'source-lease', 'fork-key', children)
		).rejects.toMatchObject({
			ambiguous: true,
			observed: [first]
		} satisfies Partial<HostForkContractError>);
	});

	it('preserves the definitive cleaned-batch error code', async () => {
		const client = new NehemiahdClient(
			'host-token',
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ error: 'fork_batch_cleaned' }), {
					status: 422,
					headers: { 'content-type': 'application/json' }
				})
			),
			1_000,
			8_080
		);

		await expect(
			client.fork('127.0.0.1', 'source', 'source-lease', 'fork-key', children)
		).rejects.toMatchObject({
			status: 422,
			code: 'fork_batch_cleaned',
			ambiguous: false
		});
	});
});

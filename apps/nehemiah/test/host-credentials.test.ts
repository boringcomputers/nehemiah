import { describe, expect, it, vi } from 'vitest';
import { HostRequestError, NehemiahdClient } from '../src/clients/nehemiahd.js';
import type { Queryable } from '../src/db/client.js';
import { HostCredentialCipher } from '../src/domain/host-credentials.js';
import { HostHeartbeatError, HostService } from '../src/domain/hosts.js';
import { testRuntimeCohort } from './runtime-cohort-fixture.js';

const encodedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const controlToken = 'control-token-with-more-than-thirty-two-random-characters';
const gatewayToken = 'gateway-token-with-more-than-thirty-two-random-characters';
const enrollmentToken = `nhe_${'a'.repeat(43)}`;

describe('managed host credentials', () => {
	it('encrypts authenticated per-host tokens and rejects tampering', () => {
		const cipher = new HostCredentialCipher(encodedKey);
		const envelope = cipher.encrypt(controlToken);
		expect(envelope).not.toContain(controlToken);
		expect(cipher.decrypt(envelope)).toBe(controlToken);
		const parts = envelope.split('.');
		parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`;
		expect(() => cipher.decrypt(parts.join('.'))).toThrow();
	});

	it('accepts only configured overlay literals and never stores plaintext control tokens', async () => {
		const calls: ReadonlyArray<unknown>[] = [];
		const database: Queryable = {
			query: async (_text, values = []) => {
				calls.push(values);
				return {
					rows: [{ id: 'host-test', grant_id: 'grant-test', credential_generation: 1 }],
					rowCount: 1
				} as never;
			}
		};
		const hosts = new HostService(database, new HostCredentialCipher(encodedKey), ['10.64.0.0/16']);
		const input = {
			providerId: 'latitude-host-test',
			regionId: 'ca-tor-1',
			address: '10.64.0.9',
			architecture: 'x86_64' as const,
			totalVcpus: 8,
			totalMemoryMb: 32_768,
			totalDiskMb: 100_000,
			controlToken,
			gatewayToken,
			runtimeCohort: testRuntimeCohort
		};
		await hosts.register(enrollmentToken, input);
		expect(JSON.stringify(calls)).not.toContain(controlToken);
		expect(JSON.stringify(calls)).not.toContain(gatewayToken);
		await expect(
			hosts.register(enrollmentToken, { ...input, address: '169.254.169.254' })
		).rejects.toThrow('overlay network');
	});

	it('rejects an unapproved daemon build before mutating host readiness', async () => {
		const query = vi.fn(async () => ({ rows: [], rowCount: 0 }) as never);
		const hosts = new HostService(
			{ query },
			new HostCredentialCipher(encodedKey),
			['10.64.0.0/16'],
			'v0.2.0-beta.1'
		);
		await expect(
			hosts.heartbeat(
				'0cb5c3a6-9d58-4fdb-bfa7-b1397267c07c',
				{
					state: 'ready',
					availableVcpus: 8,
					availableMemoryMb: 16_384,
					availableDiskMb: 100_000,
					machineCount: 0,
					kvmAvailable: true,
					daemonVersion: 'v0.1.0-old',
					runtimeCohort: testRuntimeCohort
				},
				1
			)
		).rejects.toBeInstanceOf(HostHeartbeatError);
		expect(query).not.toHaveBeenCalled();
	});

	it('resolves a per-host credential and pins the fixed daemon port', async () => {
		let requestUrl = '';
		let requestInit: RequestInit | undefined;
		const client = new NehemiahdClient(
			{ resolve: async () => controlToken },
			async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return Response.json({
					id: 'local-1',
					status: 'running',
					ready: true,
					lease_id: controlToken,
					metadata: { public_machine_id: 'unused' }
				});
			},
			1_000,
			8080
		);
		await client.get('10.64.0.9', 'local-1');
		expect(requestUrl).toBe('http://10.64.0.9:8080/internal/v1/machines/local-1');
		expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Bearer ${controlToken}`);
		expect(requestInit?.redirect).toBe('error');
	});

	it('gives managed guests a preview NIC without granting egress in the API contract', async () => {
		let body: Record<string, unknown> | undefined;
		const client = new NehemiahdClient(
			{ resolve: async () => controlToken },
			async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json({
					id: 'local-1',
					status: 'starting',
					lease_id: 'lease-1',
					lease_generation: 1,
					metadata: { public_machine_id: 'm_public-123456789' },
					resources: { vcpus: 2, memory_mb: 1024, disk_mb: 5120 },
					network_policy: { mode: 'off' },
					runtime_cohort_id: testRuntimeCohort.id,
					source_sha256: testRuntimeCohort.pythonRootfsSha256
				});
			},
			1_000,
			8080
		);
		await client.create('10.64.0.9', {
			leaseId: 'lease-1',
			idempotencyKey: 'm_public-123456789',
			template: 'python',
			ttlSeconds: 900,
			resources: { vcpus: 2, memoryMb: 1024, diskMb: 5120 },
			networkPolicy: { mode: 'off', hostnames: [], cidrs: [] },
			metadata: { public_machine_id: 'm_public-123456789' },
			runtimeCohortId: testRuntimeCohort.id,
			sourceSha256: testRuntimeCohort.pythonRootfsSha256
		});
		expect(body).toMatchObject({
			net: true,
			lease_id: 'lease-1',
			lease_generation: 1,
			network_policy: { mode: 'off', hostnames: [], cidrs: [] }
		});
	});

	it('treats a host-reported egress policy mismatch as an ambiguous create result', async () => {
		const client = new NehemiahdClient(
			controlToken,
			async () =>
				Response.json({
					id: 'local-1',
					status: 'starting',
					lease_id: 'lease-1',
					lease_generation: 1,
					metadata: { public_machine_id: 'm_public-123456789' },
					resources: { vcpus: 2, memory_mb: 1024, disk_mb: 5120 },
					network_policy: { mode: 'off' },
					runtime_cohort_id: testRuntimeCohort.id,
					source_sha256: testRuntimeCohort.pythonRootfsSha256
				}),
			1_000,
			8080
		);

		await expect(
			client.create('10.64.0.9', {
				leaseId: 'lease-1',
				idempotencyKey: 'm_public-123456789',
				template: 'python',
				ttlSeconds: 900,
				resources: { vcpus: 2, memoryMb: 1024, diskMb: 5120 },
				networkPolicy: {
					mode: 'allowlist',
					hostnames: ['api.example.com'],
					cidrs: []
				},
				metadata: { public_machine_id: 'm_public-123456789' },
				runtimeCohortId: testRuntimeCohort.id,
				sourceSha256: testRuntimeCohort.pythonRootfsSha256
			})
		).rejects.toMatchObject({ ambiguous: true } satisfies Partial<HostRequestError>);
	});

	it('sends a lease-bound idempotency key and one absolute extend target', async () => {
		let requestInit: RequestInit | undefined;
		const target = new Date('2026-08-09T15:30:00.000Z');
		const client = new NehemiahdClient(
			{ resolve: async () => controlToken },
			async (_input, init) => {
				requestInit = init;
				return Response.json({
					id: 'local-1',
					status: 'running',
					lease_id: 'lease-1',
					expires_at: target.toISOString()
				});
			},
			1_000,
			8080
		);

		await client.extend('10.64.0.9', 'local-1', 'lease-1', 'extend-1', target);

		const headers = new Headers(requestInit?.headers);
		expect(headers.get('x-nehemiah-lease-id')).toBe('lease-1');
		expect(headers.get('idempotency-key')).toBe('extend-1');
		expect(JSON.parse(String(requestInit?.body))).toEqual({ expires_at: target.toISOString() });
	});

	it('marks pre-exec host capacity rejection as safely retryable', async () => {
		const client = new NehemiahdClient(
			controlToken,
			async () =>
				Response.json(
					{ error: 'guest_operation_capacity_reached', retry_after_seconds: 1 },
					{ status: 429, headers: { 'retry-after': '1' } }
				),
			1_000,
			8080
		);

		await expect(client.exec('10.64.0.9', 'local-1', 'lease-1', 'true', 5)).rejects.toMatchObject({
			status: 429,
			code: 'guest_operation_capacity_reached',
			ambiguous: false
		} satisfies Partial<HostRequestError>);
	});

	it('marks managed guest-agent absence as a definite typed rejection', async () => {
		const client = new NehemiahdClient(
			controlToken,
			async () =>
				Response.json(
					{ error: 'guest_agent_unavailable' },
					{ status: 503, headers: { 'retry-after': '1' } }
				),
			1_000,
			8080
		);

		await expect(client.exec('10.64.0.9', 'local-1', 'lease-1', 'true', 5)).rejects.toMatchObject({
			status: 503,
			code: 'guest_agent_unavailable',
			ambiguous: false
		} satisfies Partial<HostRequestError>);
	});
});

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	ApiAdmissionUnavailable,
	ApiRateLimitExceeded,
	coarseClientIdentity,
	PostgresApiAdmission,
	type ApiRateLimitConfig
} from '../../src/auth/api-admission.js';
import type { Queryable } from '../../src/db/client.js';
import { authenticateIdentity, type AuthServices } from '../../src/http/auth.js';
import {
	clientAddressHeader,
	clientSignatureHeader,
	clientTimestampHeader,
	verifiedClientAddress
} from '../../src/http/client-identity.js';
import { Router } from '../../src/http/router.js';

const config: ApiRateLimitConfig = {
	enabled: true,
	windowSeconds: 60,
	preAuthIpRequests: 10,
	preAuthApiKeyRequests: 5,
	principalRequests: 20,
	organizationRequests: 100,
	projectRequests: 50,
	failClosed: true
};

class RecordingDatabase implements Queryable {
	readonly calls: Array<{ text: string; values: ReadonlyArray<unknown> }> = [];

	constructor(
		private readonly response: { allowed: boolean; retry_after_seconds: number } | Error = {
			allowed: true,
			retry_after_seconds: 1
		}
	) {}

	async query(text: string, values: ReadonlyArray<unknown> = []) {
		this.calls.push({ text, values });
		if (this.response instanceof Error) throw this.response;
		return { rows: [this.response], rowCount: 1 } as never;
	}
}

describe('distributed API admission', () => {
	it('stores only bounded slots and limits, never credentials or client addresses', async () => {
		const database = new RecordingDatabase();
		const admission = new PostgresApiAdmission(database, config);
		const secret = 'S'.repeat(43);
		const key = `bc_live_deadbeefcafe_${secret}`;
		await admission.preAuthenticate(
			new Request('https://api.example.test/v1/machines', {
				headers: { [clientAddressHeader]: '203.0.113.91' }
			}),
			key
		);
		const serialized = JSON.stringify(database.calls[0]?.values);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain('203.0.113.91');
		expect(serialized).not.toContain('bc_live_deadbeefcafe');
		expect(database.calls[0]?.values[0]).toEqual([
			'preauth_api_key',
			'preauth_credential',
			'preauth_ip'
		]);
		for (const slot of database.calls[0]?.values[1] as number[]) {
			expect(slot).toBeGreaterThanOrEqual(0);
			expect(slot).toBeLessThan(1_048_576);
		}
	});

	it('uses one source-independent full-credential slot before expensive verification', async () => {
		const database = new RecordingDatabase();
		const admission = new PostgresApiAdmission(database, config);
		const key = `bc_live_deadbeefcafe_${'S'.repeat(43)}`;
		for (const address of ['203.0.113.91', '198.51.100.22']) {
			await admission.preAuthenticate(
				new Request('https://api.example.test/v1/machines', {
					headers: { [clientAddressHeader]: address }
				}),
				key
			);
		}
		const slots = database.calls.map((call) => {
			const scopes = call.values[0] as string[];
			const values = call.values[1] as number[];
			return {
				credential: values[scopes.indexOf('preauth_credential')],
				source: values[scopes.indexOf('preauth_ip')]
			};
		});
		expect(slots[0]?.credential).toBe(slots[1]?.credential);
		expect(slots[0]?.source).not.toBe(slots[1]?.source);
		expect(JSON.stringify(database.calls)).not.toContain(key);
	});

	it('always consumes the trusted-source bucket when no bearer credential is present', async () => {
		const database = new RecordingDatabase();
		const admission = new PostgresApiAdmission(database, config);
		await admission.preAuthenticate(
			new Request('https://api.example.test/v1/machines', {
				headers: { [clientAddressHeader]: '203.0.113.91' }
			})
		);
		expect(database.calls).toHaveLength(1);
		expect(database.calls[0]?.values[0]).toEqual(['preauth_ip']);
		expect(JSON.stringify(database.calls[0]?.values)).not.toContain('203.0.113.91');
	});

	it('applies principal, organization, and project buckets in one atomic statement', async () => {
		const database = new RecordingDatabase();
		await new PostgresApiAdmission(database, config).authenticate({
			principalId: 'api_key:private-id',
			organizationId: 'org-private-id',
			projectId: 'project-private-id'
		});
		expect(database.calls).toHaveLength(1);
		expect(database.calls[0]?.values[0]).toEqual(['organization', 'principal', 'project']);
		expect(JSON.stringify(database.calls[0]?.values)).not.toContain('private-id');
	});

	it('returns a bounded retry delay and fails closed when PostgreSQL is unavailable', async () => {
		const limited = new PostgresApiAdmission(
			new RecordingDatabase({ allowed: false, retry_after_seconds: 47 }),
			config
		);
		await expect(limited.authenticate({ principalId: 'user:1' })).rejects.toMatchObject({
			code: 'rate_limit_exceeded',
			retryAfterSeconds: 47
		});
		await expect(
			new PostgresApiAdmission(
				new RecordingDatabase(new Error('database secret')),
				config
			).authenticate({
				principalId: 'user:1'
			})
		).rejects.toBeInstanceOf(ApiAdmissionUnavailable);

		const failOpen = new PostgresApiAdmission(new RecordingDatabase(new Error('offline')), {
			...config,
			failClosed: false
		});
		await expect(failOpen.authenticate({ principalId: 'user:1' })).resolves.toBeUndefined();
	});

	it('coarsens IPv4 and IPv6 sources before hashing', () => {
		expect(coarseClientIdentity('203.0.113.91')).toBe('ipv4:203.0.113.0/24');
		expect(coarseClientIdentity('::ffff:203.0.113.91')).toBe('ipv4:203.0.113.0/24');
		expect(coarseClientIdentity('2001:db8:abcd:12ff::1')).toBe('ipv6:20010db8abcd12/56');
		expect(coarseClientIdentity('not-an-address')).toBe('unknown');
	});

	it('rejects before expensive credential verification when the coarse bucket is full', async () => {
		const authenticate = vi.fn(async () => undefined);
		const services = {
			apiAdmission: {
				preAuthenticate: async () => {
					throw new ApiRateLimitExceeded(12);
				},
				authenticate: async () => undefined
			},
			apiKeys: { authenticate },
			audit: {},
			organizations: {}
		} as unknown as AuthServices;
		await expect(
			authenticateIdentity(
				new Request('https://api.example.test/v1/machines', {
					headers: { authorization: `Bearer bc_live_deadbeefcafe_${'A'.repeat(43)}` }
				}),
				services
			)
		).rejects.toBeInstanceOf(ApiRateLimitExceeded);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('runs source admission before auditing missing or malformed authorization', async () => {
		const order: string[] = [];
		const services = {
			apiAdmission: {
				preAuthenticate: async (_request: Request, token?: string) => {
					order.push(`admit:${token ?? 'missing'}`);
				},
				authenticate: async () => undefined
			},
			apiKeys: { authenticate: vi.fn() },
			audit: {
				authentication: async () => {
					order.push('audit');
				}
			},
			organizations: {}
		} as unknown as AuthServices;
		for (const authorization of [undefined, 'Basic dXNlcjpwYXNz', 'Bearer   ']) {
			order.length = 0;
			const headers = authorization ? { authorization } : undefined;
			await expect(
				authenticateIdentity(
					new Request('https://api.example.test/v1/machines', { headers }),
					services
				)
			).resolves.toBeUndefined();
			expect(order).toEqual(['admit:missing', 'audit']);
		}
	});

	it('renders admission failures as explicit retryable problem responses', async () => {
		const router = new Router<object>();
		router.get('/limited', () => {
			throw new ApiRateLimitExceeded(9);
		});
		const response = await router.handle(new Request('https://api.example.test/limited'), {});
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('9');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			title: 'rate_limit_exceeded',
			retry_after_seconds: 9
		});

		const unavailable = new Router<object>();
		unavailable.get('/limited', () => {
			throw new ApiAdmissionUnavailable();
		});
		const outage = await unavailable.handle(new Request('https://api.example.test/limited'), {});
		expect(outage.status).toBe(503);
		expect(outage.headers.get('retry-after')).toBe('1');
		expect(await outage.json()).toMatchObject({ title: 'api_admission_unavailable' });
	});
});

describe('gateway client identity verification', () => {
	const gatewayToken = 'private-gateway-service-token';
	const timestamp = '1786291200';
	const address = '203.0.113.19';
	const signature = createHmac('sha256', gatewayToken)
		.update(`nehemiah-client-address-v1\n${timestamp}\n${address}`)
		.digest('hex');

	it('accepts a fresh HMAC-authenticated gateway address', () => {
		const headers = new Headers({
			[clientAddressHeader]: address,
			[clientTimestampHeader]: timestamp,
			[clientSignatureHeader]: signature
		});
		expect(
			verifiedClientAddress(headers, '10.64.0.9', gatewayToken, new Date('2026-08-09T16:00:00Z'))
		).toBe(address);
	});

	it('ignores forged, stale, duplicated, and malformed forwarding values', () => {
		for (const headers of [
			new Headers({
				[clientAddressHeader]: address,
				[clientTimestampHeader]: timestamp,
				[clientSignatureHeader]: '0'.repeat(64)
			}),
			new Headers({
				[clientAddressHeader]: address,
				[clientTimestampHeader]: '1',
				[clientSignatureHeader]: signature
			}),
			new Headers({
				[clientAddressHeader]: `${address}, 198.51.100.2`,
				[clientTimestampHeader]: timestamp,
				[clientSignatureHeader]: signature
			})
		]) {
			expect(
				verifiedClientAddress(headers, '10.64.0.9', gatewayToken, new Date('2026-08-09T16:00:00Z'))
			).toBe('10.64.0.9');
		}
	});
});

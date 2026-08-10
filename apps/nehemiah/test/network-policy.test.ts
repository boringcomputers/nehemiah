import { describe, expect, it } from 'vitest';
import { EgressPolicy, isHardBlockedAddress } from '../src/domain/network-policy.js';

describe('strict egress policy', () => {
	it('has a non-overridable metadata/private/peer hard floor', () => {
		for (const ip of [
			'127.0.0.1',
			'10.0.0.1',
			'100.64.0.1',
			'169.254.169.254',
			'172.16.0.1',
			'192.168.1.1',
			'224.0.0.1',
			'::1',
			'fd00::1',
			'fe80::1',
			'::ffff:172.16.0.1',
			'::ffff:ac10:1',
			'::ffff:169.254.169.254',
			'::ffff:a9fe:a9fe',
			'::ffff:100.64.0.1',
			'::ffff:6440:1'
		]) {
			expect(isHardBlockedAddress(ip)).toBe(true);
		}
		expect(isHardBlockedAddress('1.1.1.1')).toBe(false);
	});

	it('rejects unsupported IPv6 allowlists and invalid deployment deny rules', () => {
		expect(() => new EgressPolicy({ mode: 'allowlist', cidrs: ['2001:db8::/32'] })).toThrow(
			'managed IPv6 is disabled'
		);
		expect(() => new EgressPolicy({ mode: 'off' }, ['not-a-cidr'])).toThrow('invalid IP CIDR');
	});

	it('learns only allowed public DNS answers and clamps TTL', () => {
		const policy = new EgressPolicy({ mode: 'allowlist', hostnames: ['api.example.com'] });
		policy.learnDns('api.example.com', ['1.1.1.1'], 10_000, 1_000);
		expect(policy.allowsAddress('1.1.1.1', 300_000)).toBe(true);
		expect(policy.allowsAddress('1.1.1.1', 302_000)).toBe(false);
		expect(() => policy.learnDns('api.example.com', ['169.254.169.254'], 60)).toThrow('hard-deny');
	});

	it('defaults to no network', () => {
		const policy = new EgressPolicy({ mode: 'off' });
		expect(policy.declaration).toEqual({ mode: 'off', hostnames: [], cidrs: [] });
		expect(policy.allowsAddress('1.1.1.1')).toBe(false);
		expect(() => new EgressPolicy({ mode: 'off', cidrs: ['1.1.1.0/24'] })).toThrow(
			'require mode=allowlist'
		);
		expect(() => new EgressPolicy({ mode: 'allowlist' })).toThrow('requires at least one');
	});

	it('canonicalizes policy identity and rejects malformed or unknown fields', () => {
		expect(
			new EgressPolicy({
				mode: 'allowlist',
				hostnames: ['API.EXAMPLE.COM.', 'api.example.com'],
				cidrs: ['8.8.8.0/24', '1.1.1.0/24', '8.8.8.0/24']
			}).declaration
		).toEqual({
			mode: 'allowlist',
			hostnames: ['api.example.com'],
			cidrs: ['1.1.1.0/24', '8.8.8.0/24']
		});
		expect(() => new EgressPolicy({ mode: 'off', surprise: true } as never)).toThrow(
			'unknown field'
		);
		expect(() => new EgressPolicy({ mode: 'allowlist', cidrs: '1.1.1.0/24' } as never)).toThrow(
			'string arrays'
		);
	});
});

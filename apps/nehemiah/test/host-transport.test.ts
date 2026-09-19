import { Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	hostBaseUrl,
	hostTransportHeaders,
	hostTunnelLabel,
	overlayTransport,
	validateHostTransport,
	type HostTransport
} from '../src/clients/host-transport.js';
import { NehemiahdClient } from '../src/clients/nehemiahd.js';

const tunnel: HostTransport = {
	kind: 'cloudflare-tunnel',
	domain: 'hosts.example.test',
	accessClientId: 'a1b2c3d4e5f6.access',
	accessClientSecret: Redacted.make(
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
	)
};

describe('host transport', () => {
	it('maps overlay addresses to stable tunnel labels', () => {
		expect(hostTunnelLabel('10.64.0.7')).toBe('10-64-0-7');
		expect(hostTunnelLabel('::ffff:10.64.0.7')).toBe('10-64-0-7');
		expect(hostTunnelLabel('fd00:6e65:6865::7')).toBe('fd00-6e65-6865-0000-0000-0000-0000-0007');
		expect(hostTunnelLabel('FD00:6E65:6865:0:0:0:0:7')).toBe(
			'fd00-6e65-6865-0000-0000-0000-0000-0007'
		);
		expect(hostTunnelLabel('::1')).toBe('0000-0000-0000-0000-0000-0000-0000-0001');
		expect(() => hostTunnelLabel('hosts.example.test')).toThrow('invalid host address');
	});

	it('keeps the overlay transport byte-for-byte compatible', () => {
		expect(hostBaseUrl('10.64.0.7', overlayTransport(8080))).toBe('http://10.64.0.7:8080');
		expect(hostBaseUrl('fd00::7', overlayTransport(8080))).toBe('http://[fd00::7]:8080');
		expect(hostTransportHeaders(overlayTransport(8080))).toEqual([]);
	});

	it('addresses hosts through their tunnel hostname with the Access service token', () => {
		expect(hostBaseUrl('10.64.0.7', tunnel)).toBe('https://10-64-0-7.hosts.example.test');
		expect(hostTransportHeaders(tunnel)).toEqual([
			['cf-access-client-id', 'a1b2c3d4e5f6.access'],
			['cf-access-client-secret', Redacted.value(tunnel.accessClientSecret)]
		]);
	});

	it('rejects malformed transports before any request is sent', () => {
		expect(() => validateHostTransport(overlayTransport(0))).toThrow('host port');
		expect(() => validateHostTransport({ ...tunnel, domain: 'hosts' })).toThrow('DNS suffix');
		expect(() => validateHostTransport({ ...tunnel, domain: '.hosts.example.test' })).toThrow(
			'DNS suffix'
		);
		expect(() => validateHostTransport({ ...tunnel, accessClientId: 'short' })).toThrow(
			'Access service token'
		);
		expect(validateHostTransport(tunnel)).toBe(tunnel);
	});

	it('routes host client requests through the tunnel without changing host identity', async () => {
		let requestUrl = '';
		let requestInit: RequestInit | undefined;
		const client = new NehemiahdClient(
			{ resolve: async () => 'host-control-token-that-is-long-enough-000000' },
			async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return Response.json({
					id: 'local-1',
					status: 'running',
					ready: true,
					lease_id: 'lease-1',
					metadata: { public_machine_id: 'unused' }
				});
			},
			1_000,
			tunnel
		);
		await client.get('10.64.0.9', 'local-1');
		expect(requestUrl).toBe('https://10-64-0-9.hosts.example.test/internal/v1/machines/local-1');
		const headers = new Headers(requestInit?.headers);
		expect(headers.get('cf-access-client-id')).toBe('a1b2c3d4e5f6.access');
		expect(headers.get('cf-access-client-secret')).toBe(Redacted.value(tunnel.accessClientSecret));
		expect(headers.get('authorization')).toBe(
			'Bearer host-control-token-that-is-long-enough-000000'
		);
	});
});

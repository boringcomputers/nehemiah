import { describe, expect, it, vi } from 'vitest';
import {
	collectPublicStatus,
	PUBLIC_STATUS_CACHE_CONTROL,
	safeProbeOrigin,
	STATUS_PROBE_TIMEOUT_MS,
	STATUS_RESPONSE_LIMIT_BYTES
} from './public-status';

const response = (status: number, body = '{}'): Response =>
	new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('public status probes', () => {
	it('uses a short public cache window with stale-while-revalidate', () => {
		expect(PUBLIC_STATUS_CACHE_CONTROL).toContain('max-age=15');
		expect(PUBLIC_STATUS_CACHE_CONTROL).toContain('s-maxage=15');
		expect(PUBLIC_STATUS_CACHE_CONTROL).toContain('stale-while-revalidate=30');
		expect(PUBLIC_STATUS_CACHE_CONTROL).not.toMatch(/max-age=(?:3[1-9]|[4-9]\d|\d{3,})/);
	});

	it('rejects unsafe or non-origin probe URLs without making a request', async () => {
		for (const value of [
			'http://api.example.com',
			'https://user:secret@api.example.com',
			'https://api.example.com/private',
			'https://api.example.com/?token=secret',
			'https://api.example.com/#internal',
			'https://localhost:8081'
		]) {
			expect(safeProbeOrigin(value, true)).toBeUndefined();
		}
		expect(safeProbeOrigin('http://api.example.com', false)).toBeUndefined();
		expect(safeProbeOrigin('http://127.0.0.1:8081', false)).toBe('http://127.0.0.1:8081');

		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await collectPublicStatus(
			{
				controlPlaneUrl: 'https://api.example.com/private',
				gatewayUrl: 'file:///tmp/gateway',
				production: true
			},
			{ fetch, now: () => new Date('2026-08-09T12:00:00.000Z') }
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: 'unknown',
			components: { control_plane: 'unknown', gateway: 'unknown' },
			checked_at: '2026-08-09T12:00:00.000Z'
		});
	});

	it('runs the three credential-free probes and reduces mixed health to coarse statuses', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname === 'control.example.com' && url.pathname === '/healthz') {
				return response(200);
			}
			if (url.hostname === 'control.example.com' && url.pathname === '/readyz') {
				return response(503);
			}
			if (url.hostname === 'gateway.example.com' && url.pathname === '/healthz') {
				return response(200);
			}
			throw new Error('unexpected probe target');
		});

		const result = await collectPublicStatus(
			{
				controlPlaneUrl: 'https://control.example.com',
				gatewayUrl: 'https://gateway.example.com',
				production: true
			},
			{ fetch, now: () => new Date('2026-08-09T12:00:00.000Z') }
		);

		expect(fetch).toHaveBeenCalledTimes(3);
		for (const [input, init] of fetch.mock.calls) {
			const url = new URL(input instanceof Request ? input.url : String(input));
			expect(url.search).toBe('');
			expect(init).toMatchObject({
				method: 'GET',
				redirect: 'error',
				credentials: 'omit',
				cache: 'no-store',
				referrerPolicy: 'no-referrer'
			});
			const headers = new Headers(init?.headers);
			expect(headers.get('authorization')).toBeNull();
			expect(headers.get('cookie')).toBeNull();
		}
		expect(result).toEqual({
			status: 'degraded',
			components: { control_plane: 'degraded', gateway: 'operational' },
			checked_at: '2026-08-09T12:00:00.000Z'
		});
	});

	it('aborts a hung request at the bounded timeout', async () => {
		expect(STATUS_PROBE_TIMEOUT_MS).toBe(2_000);
		const signals: AbortSignal[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return reject(new Error('missing signal'));
					signals.push(signal);
					signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				})
		);
		const result = await collectPublicStatus(
			{ gatewayUrl: 'https://gateway.example.com', production: true },
			{ fetch, timeoutMs: 5, now: () => new Date('2026-08-09T12:00:00.000Z') }
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(result.status).toBe('unknown');
	});

	it('cancels and discards a streamed body as soon as it exceeds 16 KiB', async () => {
		expect(STATUS_RESPONSE_LIMIT_BYTES).toBe(16_384);
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8_192));
				controller.enqueue(new Uint8Array(8_193));
			},
			cancel() {
				cancelled = true;
			}
		});
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
		const result = await collectPublicStatus(
			{ gatewayUrl: 'https://gateway.example.com', production: true },
			{ fetch }
		);
		expect(cancelled).toBe(true);
		expect(result.components.gateway).toBe('unknown');
	});

	it('refuses redirects instead of following a server-provided location', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } })
			);
		const result = await collectPublicStatus(
			{ gatewayUrl: 'https://gateway.example.com', production: true },
			{ fetch }
		);
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
		expect(result.components.gateway).toBe('unknown');
	});

	it('never reflects upstream bodies, errors, URLs, credentials, or private identifiers', async () => {
		const upstream = {
			detail: 'database at db.private.internal failed',
			api_key: 'bc_live_do-not-leak',
			host_id: 'host-private-123',
			customer_id: 'customer-private-456'
		};
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(response(500, JSON.stringify(upstream)));
		const result = await collectPublicStatus(
			{ gatewayUrl: 'https://gateway.example.com', production: true },
			{ fetch, now: () => new Date('2026-08-09T12:00:00.000Z') }
		);
		const serialized = JSON.stringify(result);
		for (const forbidden of Object.values(upstream)) expect(serialized).not.toContain(forbidden);
		expect(serialized).not.toContain('gateway.example.com');
		expect(result).toEqual({
			status: 'outage',
			components: { control_plane: 'unknown', gateway: 'outage' },
			checked_at: '2026-08-09T12:00:00.000Z'
		});
	});
});

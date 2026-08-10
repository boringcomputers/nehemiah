import { describe, expect, it } from 'vitest';
import { healthz, readyz, type HealthServices } from '../src/http/health.js';
import { readJson, Router } from '../src/http/router.js';

describe('health routes', () => {
	it('keeps liveness independent from database readiness', async () => {
		const router = new Router<HealthServices>().get('/healthz', healthz).get('/readyz', readyz);
		const services: HealthServices = {
			startedAt: new Date('2026-01-01T00:00:00Z'),
			readiness: { ping: async () => Promise.reject(new Error('down')) }
		};
		const live = await router.handle(new Request('http://test/healthz'), services);
		const ready = await router.handle(new Request('http://test/readyz'), services);

		expect(live.status).toBe(200);
		expect(await live.json()).toMatchObject({ ok: true, service: 'nehemiah-control-plane' });
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({ title: 'not_ready' });
		expect(live.headers.get('x-request-id')).toBeTruthy();
	});

	it('treats malformed encoded route parameters as an unmatched request', async () => {
		const router = new Router<undefined>().get('/v1/machines/:id', ({ params }) =>
			Response.json({ id: params.id })
		);
		const response = await router.handle(new Request('http://test/v1/machines/%ZZ'), undefined);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ title: 'not_found' });
	});

	it('returns typed client errors for malformed and oversized JSON', async () => {
		const router = new Router<undefined>().post('/v1/input', async ({ request }) => {
			return Response.json(await readJson(request, 8));
		});
		let canceled = false;
		const streamedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"value":1}'));
			},
			cancel() {
				canceled = true;
			}
		});
		const malformed = await router.handle(
			new Request('http://test/v1/input', { method: 'POST', body: '{' }),
			undefined
		);
		const oversized = await router.handle(
			new Request('http://test/v1/input', { method: 'POST', body: '{"value":1}' }),
			undefined
		);
		const streamedOversized = await router.handle(
			new Request('http://test/v1/input', {
				method: 'POST',
				body: streamedBody,
				duplex: 'half'
			} as RequestInit & { duplex: 'half' }),
			undefined
		);

		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ title: 'invalid_json' });
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ title: 'request_too_large' });
		expect(streamedOversized.status).toBe(413);
		expect(await streamedOversized.json()).toMatchObject({ title: 'request_too_large' });
		expect(canceled).toBe(true);
	});
});

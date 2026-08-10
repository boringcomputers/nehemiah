import { describe, expect, it } from 'vitest';
import { healthz, readyz } from '../src/http/health.js';
import { Router } from '../src/http/router.js';
describe('health routes', () => {
    it('keeps liveness independent from database readiness', async () => {
        const router = new Router()
            .get('/healthz', healthz)
            .get('/readyz', readyz);
        const services = {
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
});
//# sourceMappingURL=health.test.js.map
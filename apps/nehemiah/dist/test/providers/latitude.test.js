import { describe, expect, it, vi } from 'vitest';
import { FakeComputeProvider } from '../../src/providers/compute/fake.js';
import { LatitudeProvider } from '../../src/providers/compute/latitude.js';
const request = {
    project: 'proj_1',
    plan: 'c2-small-x86',
    site: 'TOR',
    operatingSystem: 'ubuntu_22_04_x64_lts',
    hostname: 'nehemiah-host-1',
    idempotencyKey: 'capacity-1'
};
describe('compute providers', () => {
    it('makes fake provisioning idempotent', async () => {
        const provider = new FakeComputeProvider();
        expect((await provider.provisionHost(request)).id).toBe((await provider.provisionHost(request)).id);
        expect(provider.hosts.size).toBe(1);
    });
    it('uses Latitude JSON:API fields and auth headers', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: {
                id: 'sv_1',
                attributes: {
                    hostname: request.hostname,
                    status: 'off',
                    region: { site: { slug: 'TOR' } },
                    plan: { slug: request.plan }
                }
            }
        }), { status: 201, headers: { 'content-type': 'application/json' } }));
        const provider = new LatitudeProvider('secret', fetcher);
        const result = await provider.provisionHost(request);
        const [, init] = fetcher.mock.calls[0];
        expect(result).toMatchObject({ id: 'sv_1', region: 'TOR' });
        expect(init.headers.authorization).toBe('Bearer secret');
        expect(init.headers['idempotency-key']).toBe(request.idempotencyKey);
        expect(JSON.parse(init.body).data.attributes).toMatchObject({
            project: request.project,
            operating_system: request.operatingSystem
        });
    });
});
//# sourceMappingURL=latitude.test.js.map
import { describe, expect, it } from 'vitest';
import { ApiKeyService } from '../../src/auth/api-key.js';
class MemoryStore {
    records = new Map();
    async insert(record) {
        this.records.set(record.prefix, record);
    }
    async findByPrefix(prefix) {
        return this.records.get(prefix);
    }
    async revoke(id, organizationId) {
        for (const [prefix, record] of this.records) {
            if (record.id === id && record.organizationId === organizationId && !record.revokedAt) {
                this.records.set(prefix, { ...record, revokedAt: new Date() });
                return true;
            }
        }
        return false;
    }
    async touch() { }
}
describe('API keys', () => {
    it('returns a bc_ secret once and persists only an Argon2id hash', async () => {
        const store = new MemoryStore();
        const service = new ApiKeyService(store, 'test');
        const created = await service.create({
            organizationId: 'org-1',
            projectId: 'project-1',
            name: 'CI',
            scopes: ['machines:read', 'machines:write']
        });
        const stored = store.records.get(created.prefix);
        expect(created.key).toMatch(/^bc_test_[a-f0-9]{12}_/);
        expect(stored.keyHash).toMatch(/^\$argon2id\$/);
        expect(JSON.stringify(stored)).not.toContain(created.key);
        expect(await service.authenticate(created.key)).toMatchObject({
            organizationId: 'org-1',
            projectId: 'project-1'
        });
        expect(await service.authenticate(`${created.key}bad`)).toBeUndefined();
    });
    it('denies revoked keys', async () => {
        const store = new MemoryStore();
        const service = new ApiKeyService(store, 'test');
        const created = await service.create({
            organizationId: 'org-1',
            name: 'old',
            scopes: ['machines:read']
        });
        await service.revoke(created.id, 'org-1');
        expect(await service.authenticate(created.key)).toBeUndefined();
    });
});
//# sourceMappingURL=api-key.test.js.map
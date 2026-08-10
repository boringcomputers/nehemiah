import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
describe('initial PostgreSQL schema', () => {
    it('contains every control-plane aggregate and immutable ledgers', async () => {
        const sql = await readFile(new URL('../../src/db/migrations/0001_initial.sql', import.meta.url), 'utf8');
        for (const table of [
            'users',
            'organizations',
            'organization_members',
            'projects',
            'api_keys',
            'regions',
            'hosts',
            'host_heartbeats',
            'machines',
            'machine_events',
            'idempotency_keys',
            'templates',
            'template_replicas',
            'volumes',
            'usage_events',
            'billing_accounts',
            'audit_events'
        ]) {
            expect(sql).toContain(`CREATE TABLE ${table}`);
        }
        expect(sql.match(/reject_append_only_mutation/g)?.length).toBeGreaterThanOrEqual(4);
        expect(sql).toContain("key_hash text NOT NULL CHECK (key_hash LIKE '$argon2id$%')");
    });
});
//# sourceMappingURL=schema.test.js.map
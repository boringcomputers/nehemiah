import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('authentication audit evidence migration', () => {
	it('bounds counters and fingerprints every future audit user agent', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0031_authentication_audit_evidence.sql', import.meta.url),
			'utf8'
		);
		expect(sql).toContain('CREATE TABLE authentication_attempt_windows');
		expect(sql).toContain('bucket_slot < 65536');
		expect(sql).toContain('PRIMARY KEY (credential_kind, bucket_slot)');
		expect(sql).toContain('CREATE TRIGGER audit_events_user_agent_fingerprint');
		expect(sql).toContain("'^sha256:[0-9a-f]{64}$'");
		expect(sql).not.toMatch(/credential_(?:hash|digest)|raw_token|raw_key/i);
	});
});

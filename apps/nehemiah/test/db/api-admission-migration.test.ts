import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('API admission migration', () => {
	it('uses a fixed, credential-free slot space with one row per scope and slot', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0015_api_admission_windows.sql', import.meta.url),
			'utf8'
		);
		expect(sql).toContain('CREATE TABLE api_admission_windows');
		expect(sql).toContain('PRIMARY KEY (scope, bucket_slot)');
		expect(sql).toContain('bucket_slot < 1048576');
		expect(sql).not.toMatch(/address_hash|key_hash|identifier\s+text|key_digest/i);
	});

	it('adds a source-independent credential scope without storing a digest', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0030_api_key_verification_admission.sql', import.meta.url),
			'utf8'
		);
		expect(sql).toContain("'preauth_credential'");
		expect(sql).not.toMatch(/credential_(?:hash|digest)|raw_key|token/i);
	});
});

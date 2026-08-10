import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('identity-provider sync migration', () => {
	it('pins immutable subject mappings and append-only bounded digest receipts', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0033_identity_provider_sync.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('CREATE TRIGGER users_clerk_subject_immutable');
		expect(migration).toContain('NEW.clerk_user_id IS DISTINCT FROM OLD.clerk_user_id');
		expect(migration).toContain('CREATE TABLE identity_provider_sync_receipts');
		expect(migration).toContain('octet_length(event_id) BETWEEN 1 AND 128');
		expect(migration).toContain("payload_sha256 ~ '^[0-9a-f]{64}$'");
		expect(migration).toContain('source_version BETWEEN 1 AND 9007199254740991');
		expect(migration).toContain('UNIQUE (provider, stream_sha256, source_version)');
		expect(migration).toContain('CREATE TRIGGER identity_provider_sync_receipts_append_only');
		expect(migration).not.toMatch(/payload\s+jsonb/i);
	});
});

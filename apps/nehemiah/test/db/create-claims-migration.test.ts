import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('create operation claim migration', () => {
	it('persists an exclusive owner and replayable terminal failure', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0004_create_operation_claims.sql', import.meta.url),
			'utf8'
		);

		expect(sql).toContain('create_claim_token uuid');
		expect(sql).toContain('create_claimed_until timestamptz');
		expect(sql).toContain('create_failure_status integer');
		expect(sql).toContain('machines_create_claim_complete_check');
		expect(sql).toContain('machines_create_failure_complete_check');
		expect(sql).toContain('machines_create_claim_expiry_idx');
	});
});

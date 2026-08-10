import { describe, expect, it } from 'vitest';
import { productionDatabaseUrlIssue } from '../../src/db/url.js';

describe('production PostgreSQL transport', () => {
	it('requires hostname-verified TLS and a complete credentialed database URL', () => {
		expect(
			productionDatabaseUrlIssue(
				'postgres://runtime:secret@database.internal/nehemiah?sslmode=verify-full'
			)
		).toBeUndefined();

		for (const value of [
			'not-a-url',
			'postgres://database.internal/nehemiah?sslmode=verify-full',
			'postgres://runtime:secret@database.internal/?sslmode=verify-full',
			'postgres://runtime:secret@database.internal/nehemiah',
			'postgres://runtime:secret@database.internal/nehemiah?sslmode=require',
			'postgres://runtime:secret@database.internal/nehemiah?sslmode=verify-full&sslmode=require',
			'postgres://runtime:secret@database.internal/nehemiah?sslmode=verify-full&ssl=false',
			'postgres://runtime:secret@database.internal/nehemiah?sslmode=verify-full#unsafe'
		]) {
			expect(productionDatabaseUrlIssue(value), value).toBeTruthy();
		}
	});
});

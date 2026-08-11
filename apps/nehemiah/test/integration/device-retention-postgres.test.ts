import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DeviceAuthorizationService } from '../../src/auth/device.js';
import { Database } from '../../src/db/client.js';
import { reapExpiredDeviceAuthorizations } from '../../src/jobs/reap-expired-device-authorizations.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const pepper = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=';

databaseDescribe('device authorization retained-row boundary', () => {
	it('serializes capacity, rolls cleanup back on failure, and removes only whole terminal chains', async () => {
		const database = new Database(databaseUrl!);
		const suffix = randomUUID().replaceAll('-', '');
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const userId = randomUUID();
		const standaloneAuthorizationId = randomUUID();
		const terminalAuthorizationId = randomUUID();
		const terminalFamilyId = randomUUID();
		const terminalRefresh0 = randomUUID();
		const terminalRefresh1 = randomUUID();
		const terminalAccessId = randomUUID();
		const terminalRefreshToken0 = `bc_refresh_${terminalRefresh0}_${'R'.repeat(43)}`;
		const terminalRefreshToken1 = `bc_refresh_${terminalRefresh1}_${'S'.repeat(43)}`;
		const terminalAccessToken = `bc_access_${terminalAccessId}_${'T'.repeat(43)}`;
		const activeAuthorizationId = randomUUID();
		const activeFamilyId = randomUUID();
		const activeRefreshId = randomUUID();
		const activeAccessId = randomUUID();
		const activeAccessToken = `bc_access_${activeAccessId}_${'A'.repeat(43)}`;
		const failFunction = `device_retention_fail_${suffix}`;
		const failTrigger = `device_retention_fail_${suffix}`;
		const service = new DeviceAuthorizationService(
			database,
			'https://boringcomputers.com/dashboard/device',
			pepper
		);

		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO organizations (id, slug, name)
					 VALUES ($1, $2, 'Device retention test')`,
					[organizationId, `device-retention-${suffix}`]
				);
				await client.query(
					`INSERT INTO projects (id, organization_id, slug, name)
					 VALUES ($1, $2, $3, 'Device retention project')`,
					[projectId, organizationId, `device-retention-${suffix}`]
				);
				await client.query('INSERT INTO users (id, clerk_user_id) VALUES ($1, $2)', [
					userId,
					`device-retention-${suffix}`
				]);
				await client.query(
					`INSERT INTO organization_members (organization_id, user_id, role)
					 VALUES ($1, $2, 'owner')`,
					[organizationId, userId]
				);

				await client.query(
					`INSERT INTO device_authorizations
					 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
					  next_poll_at, created_at, expires_at)
					 VALUES ($1, $2, $3, 'nehemiah-cli', ARRAY['machines:read']::text[],
					         statement_timestamp() - interval '3 hours',
					         statement_timestamp() - interval '4 hours',
					         statement_timestamp() - interval '3 hours')`,
					[
						standaloneAuthorizationId,
						createHash('sha256').update(`${standaloneAuthorizationId}:device`).digest(),
						createHash('sha256').update(`${standaloneAuthorizationId}:user`).digest()
					]
				);

				for (const [authorizationId, createdOffset, expiresOffset] of [
					[terminalAuthorizationId, '40 days', '39 days'],
					[activeAuthorizationId, '1 day', '23 hours']
				] as const) {
					await client.query(
						`INSERT INTO device_authorizations
						 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
						  approved_scopes, status, organization_id, project_id, approved_by,
						  next_poll_at, created_at, expires_at, authorized_at, consumed_at)
						 VALUES ($1, $2, $3, 'nehemiah-cli', ARRAY['machines:read']::text[],
						         ARRAY['machines:read']::text[], 'consumed', $4, $5, $6,
						         statement_timestamp() - $8::interval,
						         statement_timestamp() - $7::interval,
						         statement_timestamp() - $8::interval,
						         statement_timestamp() - $7::interval,
						         statement_timestamp() - $7::interval)`,
						[
							authorizationId,
							createHash('sha256').update(`${authorizationId}:device`).digest(),
							createHash('sha256').update(`${authorizationId}:user`).digest(),
							organizationId,
							projectId,
							userId,
							createdOffset,
							expiresOffset
						]
					);
				}

				await client.query(
					`INSERT INTO device_refresh_families
					 (id, device_authorization_id, organization_id, project_id, scopes,
					  created_at, expires_at)
					 VALUES
					 ($1, $2, $3, $4, ARRAY['machines:read']::text[],
					  statement_timestamp() - interval '40 days', statement_timestamp() - interval '2 days'),
					 ($5, $6, $3, $4, ARRAY['machines:read']::text[],
					  statement_timestamp() - interval '1 day', statement_timestamp() + interval '29 days')`,
					[
						terminalFamilyId,
						terminalAuthorizationId,
						organizationId,
						projectId,
						activeFamilyId,
						activeAuthorizationId
					]
				);
				await client.query(
					`INSERT INTO device_refresh_tokens
					 (id, family_id, generation, token_hash, created_at, expires_at, used_at)
					 VALUES
					 ($1, $2, 0, $3, statement_timestamp() - interval '40 days',
					  statement_timestamp() - interval '2 days', statement_timestamp() - interval '39 days'),
					 ($4, $2, 1, $5, statement_timestamp() - interval '39 days',
					  statement_timestamp() - interval '2 days', NULL),
					 ($6, $7, 0, $8, statement_timestamp() - interval '1 day',
					  statement_timestamp() + interval '29 days', NULL)`,
					[
						terminalRefresh0,
						terminalFamilyId,
						createHash('sha256').update(terminalRefreshToken0).digest(),
						terminalRefresh1,
						createHash('sha256').update(terminalRefreshToken1).digest(),
						activeRefreshId,
						activeFamilyId,
						Buffer.alloc(32, 9)
					]
				);
				await client.query('UPDATE device_refresh_tokens SET replaced_by = $2 WHERE id = $1', [
					terminalRefresh0,
					terminalRefresh1
				]);
				await client.query(
					`INSERT INTO device_access_tokens
					 (id, family_id, organization_id, project_id, scopes, token_hash,
					  created_at, expires_at)
					 VALUES
					 ($1, $2, $3, $4, ARRAY['machines:read']::text[], $5,
					  statement_timestamp() - interval '40 days', statement_timestamp() - interval '2 days'),
					 ($6, $7, $3, $4, ARRAY['machines:read']::text[], $8,
					  statement_timestamp() - interval '1 minute', statement_timestamp() + interval '14 minutes')`,
					[
						terminalAccessId,
						terminalFamilyId,
						organizationId,
						projectId,
						createHash('sha256').update(terminalAccessToken).digest(),
						activeAccessId,
						activeFamilyId,
						createHash('sha256').update(activeAccessToken).digest()
					]
				);
				await client.query(
					`INSERT INTO audit_events
					 (event_key, organization_id, project_id, actor_type, action, outcome,
					  resource_type, resource_id)
					 VALUES ($1, $2, $3, 'system', 'device_authorization.test_evidence',
					         'succeeded', 'device_authorization', $4)`,
					[`device-retention:${suffix}`, organizationId, projectId, terminalAuthorizationId]
				);
			});

			expect(await service.authenticateAccess(activeAccessToken)).toMatchObject({
				organizationId,
				projectId
			});

			// The singleton row is the cross-replica serialization point. Put it one
			// slot below capacity without creating 50,000 fixtures; exactly one of
			// two independent service calls may reserve that final slot.
			await database.query(
				'UPDATE device_retention_capacity SET authorization_rows = 49999 WHERE singleton'
			);
			const attempts = await Promise.allSettled([
				service.issue({
					clientId: 'nehemiah-cli',
					scopes: ['machines:read'],
					source: `${suffix}-a`
				}),
				service.issue({
					clientId: 'nehemiah-cli',
					scopes: ['machines:read'],
					source: `${suffix}-b`
				})
			]);
			expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
			const denied = attempts.find(({ status }) => status === 'rejected');
			expect(denied).toMatchObject({
				status: 'rejected',
				reason: expect.objectContaining({ code: 'rate_limited', status: 429 })
			});
			const accepted = attempts.find(
				(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.issue>>> =>
					result.status === 'fulfilled'
			)!;
			const acceptedId = accepted.value.device_code.split('_')[2]!;
			await database.query('DELETE FROM device_authorizations WHERE id = $1', [acceptedId]);

			await database.query(
				'UPDATE device_retention_capacity SET authorization_rows = 50000 WHERE singleton'
			);
			const auditBeforeCap = await database.query<{ count: number }>(
				`SELECT count(*)::integer AS count FROM audit_events
				 WHERE action = 'device_authorization.requested'`
			);
			await expect(
				service.issue({
					clientId: 'nehemiah-cli',
					scopes: ['machines:read'],
					source: `${suffix}-cap`
				})
			).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
			const auditAfterCap = await database.query<{ count: number }>(
				`SELECT count(*)::integer AS count FROM audit_events
				 WHERE action = 'device_authorization.requested'`
			);
			expect(auditAfterCap.rows[0]?.count).toBe(auditBeforeCap.rows[0]?.count);

			await database.query(`
				CREATE FUNCTION ${failFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
				  RAISE EXCEPTION 'injected device retention cleanup failure';
				END;
				$$;
				CREATE TRIGGER ${failTrigger}
				BEFORE DELETE ON device_refresh_tokens
				FOR EACH ROW EXECUTE FUNCTION ${failFunction}();
			`);
			const beforeFailure = await database.query<{
				authorization_rows: string;
				family_rows: string;
				refresh_token_rows: string;
				access_token_rows: string;
			}>(
				`SELECT authorization_rows::text, family_rows::text,
				        refresh_token_rows::text, access_token_rows::text
				 FROM device_retention_capacity WHERE singleton`
			);
			await expect(reapExpiredDeviceAuthorizations(database)).rejects.toThrow(
				'injected device retention cleanup failure'
			);
			const afterFailure = await database.query(
				`SELECT authorization_rows::text, family_rows::text,
				        refresh_token_rows::text, access_token_rows::text
				 FROM device_retention_capacity WHERE singleton`
			);
			expect(afterFailure.rows).toEqual(beforeFailure.rows);
			expect(
				(
					await database.query(
						'SELECT count(*)::integer AS count FROM device_refresh_tokens WHERE family_id = $1',
						[terminalFamilyId]
					)
				).rows[0]?.count
			).toBe(2);
			await database.query(`DROP TRIGGER ${failTrigger} ON device_refresh_tokens`);
			await database.query(`DROP FUNCTION ${failFunction}()`);

			// Hold the family row exactly where the reaper serializes cleanup. An
			// expired access/refresh/revoke request must be rejected by its unlocked
			// active-authority lookup instead of taking a child lock and waiting for
			// this family (the former child->family order deadlocked family cleanup).
			const lockPool = new Pool({ connectionString: databaseUrl! });
			const familyLocker = await lockPool.connect();
			const barrierDatabase = new Database({
				connectionString: databaseUrl!,
				max: 4,
				options: '-c lock_timeout=250ms'
			});
			const barrierService = new DeviceAuthorizationService(
				barrierDatabase,
				'https://boringcomputers.com/dashboard/device',
				pepper
			);
			let expiredResults: PromiseSettledResult<unknown>[] = [];
			try {
				await familyLocker.query('BEGIN');
				await familyLocker.query(
					'SELECT id FROM device_refresh_families WHERE id = $1 FOR UPDATE',
					[terminalFamilyId]
				);
				expiredResults = await Promise.allSettled([
					barrierService.refresh(terminalRefreshToken1),
					barrierService.revoke(terminalRefreshToken1),
					barrierService.authenticateAccess(terminalAccessToken)
				]);
			} finally {
				await familyLocker.query('ROLLBACK');
				familyLocker.release();
				await Promise.all([lockPool.end(), barrierDatabase.close()]);
			}
			expect(expiredResults[0]).toMatchObject({
				status: 'rejected',
				reason: expect.objectContaining({ code: 'invalid_grant' })
			});
			expect(expiredResults[1]).toEqual({ status: 'fulfilled', value: false });
			expect(expiredResults[2]).toEqual({ status: 'fulfilled', value: undefined });

			// The reaper drains oldest-first in bounded batches, and other suites'
			// expired fixtures legitimately share this database and can sort ahead
			// of this chain, so run the job to completion the way its schedule
			// would instead of assuming one batch covers this family.
			const totals = { accessTokens: 0, refreshTokens: 0, families: 0, authorizations: 0 };
			for (let pass = 0; pass < 20; pass += 1) {
				const report = await reapExpiredDeviceAuthorizations(database);
				expect(report).toMatchObject({ skipped: false });
				totals.accessTokens += report.accessTokens;
				totals.refreshTokens += report.refreshTokens;
				totals.families += report.families;
				totals.authorizations += report.authorizations;
				if (
					report.accessTokens + report.refreshTokens + report.families + report.authorizations ===
					0
				) {
					break;
				}
			}
			expect(totals.refreshTokens).toBeGreaterThanOrEqual(2);
			expect(totals.families).toBeGreaterThanOrEqual(1);
			expect(totals.authorizations).toBeGreaterThanOrEqual(2);
			const terminalRows = await database.query<{ count: number }>(
				`SELECT
				   (SELECT count(*) FROM device_authorizations
				     WHERE id IN ($1, $2))::integer
				 + (SELECT count(*) FROM device_refresh_families WHERE id = $3)::integer
				 + (SELECT count(*) FROM device_refresh_tokens WHERE family_id = $3)::integer
				 + (SELECT count(*) FROM device_access_tokens WHERE family_id = $3)::integer
				 AS count`,
				[standaloneAuthorizationId, terminalAuthorizationId, terminalFamilyId]
			);
			expect(terminalRows.rows[0]?.count).toBe(0);
			expect(
				(
					await database.query<{ count: number }>(
						'SELECT count(*)::integer AS count FROM audit_events WHERE resource_id = $1',
						[terminalAuthorizationId]
					)
				).rows[0]?.count
			).toBe(1);
			expect(await service.authenticateAccess(activeAccessToken)).toMatchObject({
				organizationId,
				projectId
			});

			// Reaping a terminal code releases a durable slot. The next issuance is
			// admitted, while its audit is written only for the successful request.
			const afterReap = await service.issue({
				clientId: 'nehemiah-cli',
				scopes: ['machines:read'],
				source: `${suffix}-after-reap`
			});
			await database.query('DELETE FROM device_authorizations WHERE id = $1', [
				afterReap.device_code.split('_')[2]!
			]);

			// Restore exact accounting after the deliberate near-cap test mutation,
			// then prove every counter matches its underlying bounded table.
			await database.query(
				`UPDATE device_retention_capacity SET
				 authorization_rows = (SELECT count(*) FROM device_authorizations),
				 family_rows = (SELECT count(*) FROM device_refresh_families),
				 refresh_token_rows = (SELECT count(*) FROM device_refresh_tokens),
				 access_token_rows = (SELECT count(*) FROM device_access_tokens)
				 WHERE singleton`
			);
			const exact = await database.query<{ exact: boolean }>(
				`SELECT authorization_rows = (SELECT count(*) FROM device_authorizations)
				    AND family_rows = (SELECT count(*) FROM device_refresh_families)
				    AND refresh_token_rows = (SELECT count(*) FROM device_refresh_tokens)
				    AND access_token_rows = (SELECT count(*) FROM device_access_tokens) AS exact
				 FROM device_retention_capacity WHERE singleton`
			);
			expect(exact.rows[0]?.exact).toBe(true);
		} finally {
			await database.query(`DROP TRIGGER IF EXISTS ${failTrigger} ON device_refresh_tokens`);
			await database.query(`DROP FUNCTION IF EXISTS ${failFunction}()`);
			await database.query(
				`UPDATE device_retention_capacity SET
				 authorization_rows = (SELECT count(*) FROM device_authorizations),
				 family_rows = (SELECT count(*) FROM device_refresh_families),
				 refresh_token_rows = (SELECT count(*) FROM device_refresh_tokens),
				 access_token_rows = (SELECT count(*) FROM device_access_tokens)
				 WHERE singleton`
			);
			await database.close();
		}
	});
});

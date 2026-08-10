import type { PoolClient } from 'pg';
import { Database } from '../db/client.js';

const deviceRetentionAdvisoryLock = 1_314_141_516;

export interface DeviceRetentionReport {
	readonly skipped: boolean;
	readonly accessTokens: number;
	readonly refreshTokens: number;
	readonly families: number;
	readonly authorizations: number;
}

const emptyReport = (skipped: boolean): DeviceRetentionReport => ({
	skipped,
	accessTokens: 0,
	refreshTokens: 0,
	families: 0,
	authorizations: 0
});

const positiveBatch = (value: number, maximum: number, label: string): void => {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} must be from 1 to ${maximum}`);
	}
};

const reapTransaction = async (
	client: PoolClient,
	options: {
		readonly accessBatch: number;
		readonly familyBatch: number;
		readonly authorizationBatch: number;
	}
): Promise<DeviceRetentionReport> => {
	await client.query('BEGIN');
	try {
		// Access credentials are independent generations. Removing only tokens
		// terminal for at least one hour cannot affect a currently authorized
		// access token or its refresh family.
		const access = await client.query<{ id: string }>(
			`WITH terminal AS (
			   SELECT id FROM device_access_tokens
			   WHERE COALESCE(revoked_at, expires_at)
			         <= statement_timestamp() - interval '1 hour'
			   ORDER BY COALESCE(revoked_at, expires_at), id
			   LIMIT $1 FOR UPDATE SKIP LOCKED
			 )
			 DELETE FROM device_access_tokens token
			 USING terminal
			 WHERE token.id = terminal.id
			 RETURNING token.id`,
			[options.accessBatch]
		);

		// A refresh chain has a self-referential replaced_by FK. Select whole
		// terminal families under lock, then delete every generation in one SQL
		// statement so no dangling reference or partial authority can survive.
		const familyRows = await client.query<{ id: string; device_authorization_id: string }>(
			`SELECT id, device_authorization_id
			 FROM device_refresh_families
			 WHERE COALESCE(revoked_at, expires_at)
			       <= statement_timestamp() - interval '24 hours'
			 ORDER BY COALESCE(revoked_at, expires_at), id
			 LIMIT $1 FOR UPDATE SKIP LOCKED`,
			[options.familyBatch]
		);
		const familyIds = familyRows.rows.map(({ id }) => id);
		const familyAuthorizationIds = familyRows.rows.map(({ device_authorization_id: id }) => id);
		let familyAccessCount = 0;
		let refreshCount = 0;
		let familyCount = 0;
		let familyAuthorizationCount = 0;
		if (familyIds.length > 0) {
			const familyAccess = await client.query(
				'DELETE FROM device_access_tokens WHERE family_id = ANY($1::uuid[])',
				[familyIds]
			);
			familyAccessCount = familyAccess.rowCount ?? 0;
			const refresh = await client.query(
				'DELETE FROM device_refresh_tokens WHERE family_id = ANY($1::uuid[])',
				[familyIds]
			);
			refreshCount = refresh.rowCount ?? 0;
			const families = await client.query(
				'DELETE FROM device_refresh_families WHERE id = ANY($1::uuid[])',
				[familyIds]
			);
			familyCount = families.rowCount ?? 0;
			const authorizations = await client.query(
				`DELETE FROM device_authorizations AS device_auth
				 WHERE device_auth.id = ANY($1::uuid[])
				   AND NOT EXISTS (
				     SELECT 1 FROM device_refresh_families family
				     WHERE family.device_authorization_id = device_auth.id
				   )`,
				[familyAuthorizationIds]
			);
			familyAuthorizationCount = authorizations.rowCount ?? 0;
		}

		// Unapproved, denied, and otherwise family-free codes carry no live
		// authority once their ten-minute lifetime plus one-hour evidence window
		// has elapsed. The immutable audit event is deliberately not deleted.
		const authorizations = await client.query<{ id: string }>(
			`WITH terminal AS (
			   SELECT device_auth.id
			   FROM device_authorizations AS device_auth
			   WHERE device_auth.expires_at
			         <= statement_timestamp() - interval '1 hour'
			     AND NOT EXISTS (
			       SELECT 1 FROM device_refresh_families family
			       WHERE family.device_authorization_id = device_auth.id
			     )
			   ORDER BY device_auth.expires_at, device_auth.id
			   LIMIT $1 FOR UPDATE OF device_auth SKIP LOCKED
			 )
			 DELETE FROM device_authorizations AS device_auth
			 USING terminal
			 WHERE device_auth.id = terminal.id
			 RETURNING device_auth.id`,
			[options.authorizationBatch]
		);

		await client.query('COMMIT');
		return {
			skipped: false,
			accessTokens: (access.rowCount ?? access.rows.length) + familyAccessCount,
			refreshTokens: refreshCount,
			families: familyCount,
			authorizations:
				familyAuthorizationCount + (authorizations.rowCount ?? authorizations.rows.length)
		};
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], 'device retention cleanup rollback failed');
		}
		throw error;
	}
};

/**
 * Reap a bounded terminal batch. The session advisory lock makes the job a
 * singleton across replicas; SKIP LOCKED remains defense-in-depth against an
 * operator transaction inspecting one of the same credential rows.
 */
export const reapExpiredDeviceAuthorizations = async (
	database: Database,
	options: {
		readonly accessBatch?: number;
		readonly familyBatch?: number;
		readonly authorizationBatch?: number;
	} = {}
): Promise<DeviceRetentionReport> => {
	const accessBatch = options.accessBatch ?? 1_000;
	const familyBatch = options.familyBatch ?? 4;
	const authorizationBatch = options.authorizationBatch ?? 1_000;
	positiveBatch(accessBatch, 10_000, 'device access cleanup batch');
	positiveBatch(familyBatch, 32, 'device family cleanup batch');
	positiveBatch(authorizationBatch, 10_000, 'device authorization cleanup batch');

	return (
		(await database.withAdvisoryLock(deviceRetentionAdvisoryLock, (client) =>
			reapTransaction(client, { accessBatch, familyBatch, authorizationBatch })
		)) ?? emptyReport(true)
	);
};

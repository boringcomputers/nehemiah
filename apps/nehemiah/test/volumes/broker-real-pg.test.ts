import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import { VolumeQuotaExceeded, VolumeService } from '../../src/domain/volumes.js';
import { S3VolumeObjectStore } from '../../src/providers/storage/s3-volumes.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const now = new Date('2026-08-09T13:00:00.000Z');

databaseDescribe('bounded volume broker with PostgreSQL reservations', () => {
	let database: Database;
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const slugSuffix = randomUUID().replaceAll('-', '').slice(0, 20);

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO organizations (id, slug, name, max_storage_mb)
				 VALUES ($1, $2, 'Volume broker PostgreSQL', 10)`,
				[organizationId, `volume-broker-${slugSuffix}`]
			);
			await client.query(
				`INSERT INTO projects
				 (id, organization_id, slug, name, max_storage_mb)
				 VALUES ($1, $2, $3, 'Volume broker PostgreSQL', 10)`,
				[projectId, organizationId, `volume-broker-${slugSuffix}`]
			);
		});
	});

	afterAll(async () => {
		await database?.query('DELETE FROM volumes WHERE organization_id = $1', [organizationId]);
		await database?.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
		await database?.close();
	});

	it('replays one durable reservation under create concurrency and defers deletion to retention', async () => {
		let currentNow = now;
		const commands: unknown[] = [];
		const storage = new S3VolumeObjectStore(
			{
				endpoint: 'https://objects.example.test',
				region: 'ca-central-1',
				bucket: 'nehemiah-volume-artifacts',
				accessKeyId: 'scoped-volume-broker-key',
				secretAccessKey: 'scoped-volume-broker-secret',
				brokerPublicUrl: 'https://volumes.example.test',
				brokerSecret: Buffer.alloc(32, 11).toString('base64')
			},
			{
				now: () => currentNow,
				send: async (command) => {
					commands.push(command);
					if (command instanceof ListObjectsV2Command) {
						return { IsTruncated: false, Contents: [] };
					}
					throw new Error('unexpected storage command');
				}
			}
		);
		const volumes = new VolumeService(database, storage, () => currentNow);
		const idempotencyKey = `broker-pg-${randomUUID()}`;
		const create = () =>
			volumes.create({
				organizationId,
				projectId,
				sizeLimitMb: 1,
				ttlSeconds: 3_600,
				grantTtlSeconds: 60,
				idempotencyKey
			});
		const results = await Promise.all([create(), create()]);

		expect(new Set(results.map(({ volume }) => volume.id)).size).toBe(1);
		expect(new Set(results.map(({ grant }) => grant.url)).size).toBe(1);
		expect(
			new Set(results.map(({ grant }) => grant.headers?.['x-nehemiah-volume-capability'])).size
		).toBe(1);
		expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
		expect(commands).toHaveLength(2);

		const volumeId = results[0]!.volume.id;
		const durable = await database.query<{
			volume_count: string;
			reservation_count: string;
			issued_count: string;
			maximum_bytes: string;
			reservation_expires_at: Date;
		}>(
			`SELECT count(DISTINCT v.id)::text AS volume_count,
			        count(DISTINCT r.id)::text AS reservation_count,
			        count(DISTINCT r.id) FILTER (WHERE r.issued_at IS NOT NULL)::text AS issued_count,
			        max(r.maximum_bytes)::text AS maximum_bytes,
			        max(r.expires_at) AS reservation_expires_at
			 FROM volumes v
			 LEFT JOIN volume_write_grant_reservations r ON r.volume_id = v.id
			 WHERE v.id = $1
			 GROUP BY v.id`,
			[volumeId]
		);
		expect(durable.rows[0]).toMatchObject({
			volume_count: '1',
			reservation_count: '1',
			issued_count: '1',
			maximum_bytes: String(1_048_576)
		});
		const firstGrantExpiresAt = results[0]!.grant.expiresAt;
		expect(durable.rows[0]!.reservation_expires_at.getTime() - firstGrantExpiresAt.getTime()).toBe(
			60_000
		);

		// A transfer is aborted at its public deadline, but the reservation stays
		// charged through the bounded provider settlement window. A late S3 commit
		// therefore cannot race an immediately reissued full-allocation grant.
		currentNow = new Date(firstGrantExpiresAt.getTime() + 1);
		await expect(
			volumes.grant(volumeId, organizationId, projectId, 'PUT', 60)
		).rejects.toBeInstanceOf(VolumeQuotaExceeded);
		currentNow = new Date(durable.rows[0]!.reservation_expires_at.getTime() + 1);
		const nextGrant = await volumes.grant(volumeId, organizationId, projectId, 'PUT', 60);
		expect(nextGrant?.grant.maximumBytes).toBe(1_048_576);

		const removed = await volumes.remove(volumeId, organizationId, projectId);
		expect(removed).toBeDefined();
		const deletion = await database.query<{
			delete_after: Date;
			next_attempt_at: Date;
			scheduled_at: Date | null;
			last_error_code: string | null;
		}>(
			`SELECT delete_after, next_attempt_at, scheduled_at, last_error_code
			 FROM volume_deletion_jobs WHERE volume_id = $1`,
			[volumeId]
		);
		expect(deletion.rows[0]?.next_attempt_at).toEqual(deletion.rows[0]?.delete_after);
		expect(deletion.rows[0]).toMatchObject({
			scheduled_at: null,
			last_error_code: 'volume_retention_pending'
		});
	});
});

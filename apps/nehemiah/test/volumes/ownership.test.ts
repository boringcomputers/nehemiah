import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyService, PostgresApiKeyStore } from '../../src/auth/api-key.js';
import { AuditService } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import {
	defaultVolumeGrantTtlSeconds,
	volumeDeletionRetentionSeconds,
	VolumeService,
	type VolumeGrantMethod,
	type VolumeObjectGrant,
	type VolumeObjectStore
} from '../../src/domain/volumes.js';
import { Router } from '../../src/http/router.js';
import { registerVolumeRoutes, type VolumeRouteServices } from '../../src/http/routes/volumes.js';
import {
	VolumeDeletionWorker,
	volumeDeletionRetryDelayMs
} from '../../src/jobs/schedule-volume-deletions.js';
import { listenRouter, type TestHttpServer } from '../helpers/http-server.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const fixedNow = new Date('2026-08-09T01:00:00.000Z');
let currentNow = fixedNow;

interface Fixture {
	readonly organizations: { readonly a: string; readonly b: string; readonly quota: string };
	readonly projects: {
		readonly a1: string;
		readonly a2: string;
		readonly aQuota: string;
		readonly b1: string;
		readonly quota1: string;
		readonly quota2: string;
	};
}

interface Keys {
	readonly organizationA: string;
	readonly projectA1: string;
	readonly projectA2: string;
	readonly projectAQuota: string;
	readonly organizationB: string;
	readonly readOnlyA: string;
	readonly organizationQuota1: string;
	readonly organizationQuota2: string;
}

class RecordingVolumeStore implements VolumeObjectStore {
	readonly observed = new Map<string, number>();
	readonly grants: Array<{
		organizationId: string;
		projectId: string;
		objectPrefix: string;
		method: VolumeGrantMethod;
		expiresAt: Date;
		maximumBytes?: number;
		requireEncryptionAtRest: true;
		reservationId?: string;
	}> = [];
	readonly deletions: Array<{
		organizationId: string;
		projectId: string;
		objectPrefix: string;
		deleteAfter: Date;
	}> = [];
	grantProtocol: 'https:' | 'http:' = 'https:';
	grantExpiryAdjustmentMs = 0;
	issueFailures = 0;
	deletionFailures = 0;
	beforeIssue?: (input: {
		organizationId: string;
		projectId: string;
		objectPrefix: string;
		method: VolumeGrantMethod;
	}) => Promise<void>;

	async inspect(input: {
		organizationId: string;
		projectId: string;
		objectPrefix: string;
	}): Promise<{ observedSizeBytes: number }> {
		return { observedSizeBytes: this.observed.get(input.objectPrefix) ?? 0 };
	}

	async issueGrant(input: {
		organizationId: string;
		projectId: string;
		objectPrefix: string;
		method: VolumeGrantMethod;
		expiresAt: Date;
		maximumBytes?: number;
		requireEncryptionAtRest: true;
		reservationId?: string;
	}): Promise<VolumeObjectGrant> {
		this.grants.push(input);
		await this.beforeIssue?.(input);
		if (this.issueFailures > 0) {
			this.issueFailures -= 1;
			throw new Error('simulated ambiguous grant issuance');
		}
		return {
			method: input.method,
			url: `${this.grantProtocol}//objects.integration.invalid/scoped?prefix=${encodeURIComponent(input.objectPrefix)}${input.reservationId ? `&reservation=${input.reservationId}` : ''}`,
			objectPrefix: input.objectPrefix,
			expiresAt: new Date(input.expiresAt.getTime() + this.grantExpiryAdjustmentMs),
			encryptionAtRest: true,
			headers: { 'x-amz-checksum-sha256': 'required-at-upload' },
			maximumBytes: input.maximumBytes
		};
	}

	async scheduleDeletion(input: {
		organizationId: string;
		projectId: string;
		objectPrefix: string;
		deleteAfter: Date;
	}): Promise<void> {
		this.deletions.push(input);
		if (this.deletionFailures > 0) {
			this.deletionFailures -= 1;
			throw new Error('simulated retention scheduling failure');
		}
	}
}

const seed = async (database: Database): Promise<Fixture> => {
	const fixture: Fixture = {
		organizations: { a: randomUUID(), b: randomUUID(), quota: randomUUID() },
		projects: {
			a1: randomUUID(),
			a2: randomUUID(),
			aQuota: randomUUID(),
			b1: randomUUID(),
			quota1: randomUUID(),
			quota2: randomUUID()
		}
	};
	const suffix = randomUUID().replaceAll('-', '');
	await database.transaction(async (client) => {
		await client.query(
			`INSERT INTO organizations (id, slug, name, max_storage_mb)
			 VALUES ($1, $2, 'Volume A', 102400),
			        ($3, $4, 'Volume B', 102400),
			        ($5, $6, 'Volume fixed quota', 4)`,
			[
				fixture.organizations.a,
				`volume-a-${suffix}`,
				fixture.organizations.b,
				`volume-b-${suffix}`,
				fixture.organizations.quota,
				`volume-fixed-quota-${suffix}`
			]
		);
		await client.query(
			`INSERT INTO projects
			 (id, organization_id, slug, name, max_storage_mb)
			 VALUES ($1, $2, $3, 'Volume A1', 20),
			        ($4, $2, $5, 'Volume A2', 20),
			        ($6, $2, $7, 'Volume quota', 4),
				        ($8, $9, $10, 'Volume B1', 20),
				        ($11, $12, $13, 'Volume org quota 1', 20),
				        ($14, $12, $15, 'Volume org quota 2', 20)`,
			[
				fixture.projects.a1,
				fixture.organizations.a,
				`volume-a1-${suffix}`,
				fixture.projects.a2,
				`volume-a2-${suffix}`,
				fixture.projects.aQuota,
				`volume-quota-${suffix}`,
				fixture.projects.b1,
				fixture.organizations.b,
				`volume-b1-${suffix}`,
				fixture.projects.quota1,
				fixture.organizations.quota,
				`volume-org-quota1-${suffix}`,
				fixture.projects.quota2,
				`volume-org-quota2-${suffix}`
			]
		);
	});
	return fixture;
};

const createKeys = async (apiKeys: ApiKeyService, fixture: Fixture): Promise<Keys> => {
	const create = async (
		organizationId: string,
		projectId: string | undefined,
		scopes: Array<'volumes:read' | 'volumes:write'>,
		name: string
	): Promise<string> =>
		(
			await apiKeys.create({
				organizationId,
				projectId,
				scopes,
				name
			})
		).key;
	return {
		organizationA: await create(
			fixture.organizations.a,
			undefined,
			['volumes:read', 'volumes:write'],
			'Volume organization A'
		),
		projectA1: await create(
			fixture.organizations.a,
			fixture.projects.a1,
			['volumes:read', 'volumes:write'],
			'Volume project A1'
		),
		projectA2: await create(
			fixture.organizations.a,
			fixture.projects.a2,
			['volumes:read', 'volumes:write'],
			'Volume project A2'
		),
		projectAQuota: await create(
			fixture.organizations.a,
			fixture.projects.aQuota,
			['volumes:read', 'volumes:write'],
			'Volume quota project'
		),
		organizationB: await create(
			fixture.organizations.b,
			undefined,
			['volumes:read', 'volumes:write'],
			'Volume organization B'
		),
		readOnlyA: await create(
			fixture.organizations.a,
			undefined,
			['volumes:read'],
			'Volume read only'
		),
		organizationQuota1: await create(
			fixture.organizations.quota,
			fixture.projects.quota1,
			['volumes:read', 'volumes:write'],
			'Volume fixed organization quota 1'
		),
		organizationQuota2: await create(
			fixture.organizations.quota,
			fixture.projects.quota2,
			['volumes:read', 'volumes:write'],
			'Volume fixed organization quota 2'
		)
	};
};

const app = async (
	database: Database,
	apiKeys: ApiKeyService,
	volumes: VolumeService
): Promise<TestHttpServer> => {
	const services: VolumeRouteServices = {
		apiKeys,
		audit: new AuditService(database),
		organizations: new OrganizationService(database),
		volumes
	};
	const router = new Router<VolumeRouteServices>();
	registerVolumeRoutes(router);
	return listenRouter(router, services);
};

const auth = (key: string): HeadersInit => ({
	authorization: `Bearer ${key}`,
	'content-type': 'application/json'
});

databaseDescribe('managed volume ownership and object-store boundary', () => {
	let database: Database;
	let fixture: Fixture;
	let keys: Keys;
	let store: RecordingVolumeStore;
	let configured: TestHttpServer;
	let unavailable: TestHttpServer;

	const post = (
		server: TestHttpServer,
		path: string,
		key: string,
		body: unknown,
		idempotencyKey: string = randomUUID()
	): Promise<Response> =>
		fetch(`${server.origin}${path}`, {
			method: 'POST',
			headers: { ...auth(key), 'idempotency-key': idempotencyKey },
			body: JSON.stringify(body)
		});

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.query('SELECT 1');
		fixture = await seed(database);
		const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		keys = await createKeys(apiKeys, fixture);
		store = new RecordingVolumeStore();
		configured = await app(database, apiKeys, new VolumeService(database, store, () => currentNow));
		unavailable = await app(
			database,
			apiKeys,
			new VolumeService(database, undefined, () => currentNow)
		);
	});

	beforeEach(async () => {
		await database.query('DELETE FROM volumes WHERE organization_id = ANY($1::uuid[])', [
			[fixture.organizations.a, fixture.organizations.b, fixture.organizations.quota]
		]);
		currentNow = fixedNow;
		store.observed.clear();
		store.grants.length = 0;
		store.deletions.length = 0;
		store.beforeIssue = undefined;
		store.issueFailures = 0;
		store.deletionFailures = 0;
		store.grantProtocol = 'https:';
		store.grantExpiryAdjustmentMs = 0;
	});

	afterAll(async () => {
		await configured?.close();
		await unavailable?.close();
		await database?.close();
	});

	it('returns a typed 503 and persists no volume when no object-store adapter is configured', async () => {
		const response = await post(unavailable, '/v1/volumes', keys.projectA1, {
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ title: 'volume_infrastructure_unavailable' });
		const rows = await database.query<{ count: string }>(
			'SELECT count(*) FROM volumes WHERE project_id = $1',
			[fixture.projects.a1]
		);
		expect(Number(rows.rows[0]?.count)).toBe(0);
	});

	it('admits one durable volume for concurrent create replays and rejects key reuse with a different payload', async () => {
		const idempotencyKey = `volume-replay-${randomUUID()}`;
		const grantsBefore = store.grants.length;
		const responses = await Promise.all([
			post(
				configured,
				'/v1/volumes',
				keys.projectA1,
				{ size_limit_mb: 1, ttl_seconds: 3_600 },
				idempotencyKey
			),
			post(
				configured,
				'/v1/volumes',
				keys.projectA1,
				{ size_limit_mb: 1, ttl_seconds: 3_600 },
				idempotencyKey
			)
		]);
		expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
		const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
			id: string;
			grant: { url: string };
		}>;
		expect(new Set(bodies.map(({ id }) => id)).size).toBe(1);
		expect(new Set(bodies.map(({ grant }) => grant.url)).size).toBe(1);
		expect(
			responses.some((response) => response.headers.get('idempotency-replayed') === 'true')
		).toBe(true);
		const admitted = await database.query<{ volume_count: string; reservation_count: string }>(
			`SELECT count(DISTINCT v.id)::text AS volume_count,
			        count(DISTINCT r.id)::text AS reservation_count
			 FROM volumes v
			 LEFT JOIN volume_write_grant_reservations r ON r.volume_id = v.id
			 WHERE v.organization_id = $1 AND v.project_id = $2 AND v.idempotency_key = $3`,
			[fixture.organizations.a, fixture.projects.a1, idempotencyKey]
		);
		expect(admitted.rows[0]).toMatchObject({ volume_count: '1', reservation_count: '1' });
		expect(store.grants.slice(grantsBefore).map(({ reservationId }) => reservationId)).toEqual([
			store.grants.at(grantsBefore)!.reservationId,
			store.grants.at(grantsBefore)!.reservationId
		]);

		const conflict = await post(
			configured,
			'/v1/volumes',
			keys.projectA1,
			{ size_limit_mb: 2, ttl_seconds: 3_600 },
			idempotencyKey
		);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ title: 'idempotency_conflict' });
	});

	it('returns typed 429 denials for delinquent volume creation and PUT grants', async () => {
		const admitted = await post(configured, '/v1/volumes', keys.projectA1, {
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(admitted.status).toBe(201);
		const volume = (await admitted.json()) as { id: string };
		await database.query(
			`INSERT INTO billing_accounts (organization_id, delinquent_at)
			 VALUES ($1, now())
			 ON CONFLICT (organization_id) DO UPDATE SET delinquent_at = EXCLUDED.delinquent_at`,
			[fixture.organizations.a]
		);
		try {
			const createDenied = await post(configured, '/v1/volumes', keys.projectA1, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			});
			expect(createDenied.status).toBe(429);
			expect(await createDenied.json()).toMatchObject({ title: 'billing_delinquent' });

			const grantDenied = await post(
				configured,
				`/v1/volumes/${volume.id}/grants`,
				keys.projectA1,
				{ method: 'PUT' }
			);
			expect(grantDenied.status).toBe(429);
			expect(await grantDenied.json()).toMatchObject({ title: 'billing_delinquent' });
		} finally {
			await database.query('DELETE FROM billing_accounts WHERE organization_id = $1', [
				fixture.organizations.a
			]);
		}
	});

	it('replays the admitted volume and reservation after ambiguous initial grant issuance', async () => {
		const idempotencyKey = `volume-ambiguous-${randomUUID()}`;
		const grantsBefore = store.grants.length;
		store.issueFailures = 1;
		const failed = await post(
			configured,
			'/v1/volumes',
			keys.projectA1,
			{ size_limit_mb: 1, ttl_seconds: 3_600 },
			idempotencyKey
		);
		expect(failed.status).toBe(503);

		const replay = await post(
			configured,
			'/v1/volumes',
			keys.projectA1,
			{ size_limit_mb: 1, ttl_seconds: 3_600 },
			idempotencyKey
		);
		expect(replay.status).toBe(200);
		expect(replay.headers.get('idempotency-replayed')).toBe('true');
		const body = (await replay.json()) as { id: string; grant: { maximum_bytes: number } };
		expect(body.grant.maximum_bytes).toBe(1_048_576);
		const persisted = await database.query<{ volumes: string; reservations: string }>(
			`SELECT count(DISTINCT v.id)::text AS volumes,
			        count(DISTINCT r.id)::text AS reservations
			 FROM volumes v
			 LEFT JOIN volume_write_grant_reservations r ON r.volume_id = v.id
			 WHERE v.id = $1 AND v.idempotency_key = $2`,
			[body.id, idempotencyKey]
		);
		expect(persisted.rows[0]).toMatchObject({ volumes: '1', reservations: '1' });
		expect(store.grants.at(grantsBefore)?.reservationId).toBe(
			store.grants.at(grantsBefore + 1)?.reservationId
		);

		const prefix = (
			await database.query<{ object_prefix: string }>(
				'SELECT object_prefix FROM volumes WHERE id = $1',
				[body.id]
			)
		).rows[0]!.object_prefix;
		store.observed.set(prefix, 512);
		currentNow = new Date(fixedNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);
		const afterExpiry = await post(
			configured,
			'/v1/volumes',
			keys.projectA1,
			{ size_limit_mb: 1, ttl_seconds: 3_600 },
			idempotencyKey
		);
		expect(afterExpiry.status).toBe(200);
		expect(await afterExpiry.json()).toMatchObject({
			id: body.id,
			used_bytes: 512,
			grant: { maximum_bytes: 1_048_576 - 512 }
		});
	});

	it('creates only tenant-prefixed metadata and hides it across project and organization boundaries', async () => {
		const response = await post(configured, '/v1/volumes', keys.projectA1, {
			size_limit_mb: 2,
			ttl_seconds: 3_600,
			grant_ttl_seconds: 120
		});
		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const created = (await response.json()) as {
			id: string;
			project_id: string;
			grant: { method: string; url: string; maximum_bytes: number };
		};
		expect(created).toMatchObject({
			project_id: fixture.projects.a1,
			grant: { method: 'PUT', maximum_bytes: 2 * 1_048_576 }
		});
		expect(created.grant.url.startsWith('https://')).toBe(true);
		const persisted = await database.query<{ object_prefix: string }>(
			'SELECT object_prefix FROM volumes WHERE id = $1',
			[created.id]
		);
		expect(persisted.rows[0]?.object_prefix).toBe(
			`organizations/${fixture.organizations.a}/projects/${fixture.projects.a1}/volumes/${created.id}/`
		);

		for (const key of [keys.projectA2, keys.organizationB]) {
			const hidden = await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
				headers: auth(key)
			});
			expect(hidden.status).toBe(404);
		}
		const crossProject = await fetch(
			`${configured.origin}/v1/volumes?project_id=${fixture.projects.a2}`,
			{ headers: auth(keys.projectA1) }
		);
		expect(crossProject.status).toBe(403);
		const crossOrganization = await fetch(
			`${configured.origin}/v1/volumes?project_id=${fixture.projects.b1}`,
			{ headers: auth(keys.organizationA) }
		);
		expect(crossOrganization.status).toBe(200);
		expect(((await crossOrganization.json()) as { volumes: unknown[] }).volumes).toEqual([]);
		const malformedProject = await fetch(`${configured.origin}/v1/volumes?project_id=not-a-uuid`, {
			headers: auth(keys.organizationA)
		});
		expect(malformedProject.status).toBe(400);
	});

	it('validates create project UUIDs before audit and hides a cross-organization project', async () => {
		const malformed = await post(configured, '/v1/volumes', keys.organizationA, {
			project_id: 'not-a-uuid',
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ title: 'invalid_volume_request' });

		const crossOrganization = await post(configured, '/v1/volumes', keys.organizationA, {
			project_id: fixture.projects.b1,
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(crossOrganization.status).toBe(404);
		expect(await crossOrganization.json()).toMatchObject({ title: 'volume_project_not_found' });
		const requestId = crossOrganization.headers.get('x-request-id');
		const audit = await database.query<{ outcome: string; project_id: string | null }>(
			`SELECT outcome, project_id FROM audit_events
			 WHERE request_id = $1 AND action = 'volume.create'
			 ORDER BY occurred_at, id`,
			[requestId]
		);
		expect(audit.rows).toEqual([
			{ outcome: 'requested', project_id: null },
			{ outcome: 'failed', project_id: null }
		]);
		expect(
			Number(
				(
					await database.query<{ count: string }>(
						'SELECT count(*) FROM volumes WHERE project_id = $1',
						[fixture.projects.b1]
					)
				).rows[0]?.count
			)
		).toBe(0);
	});

	it('verifies observed size before issuing bounded read/write grants', async () => {
		const created = (await (
			await post(configured, '/v1/volumes', keys.projectA2, {
				size_limit_mb: 2,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		const row = await database.query<{ object_prefix: string }>(
			'SELECT object_prefix FROM volumes WHERE id = $1',
			[created.id]
		);
		const prefix = row.rows[0]!.object_prefix;
		store.observed.set(prefix, 512);
		// The initial create PUT reservation is intentionally exclusive until
		// its capability expires.
		currentNow = new Date(fixedNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);

		const readGrant = await post(configured, `/v1/volumes/${created.id}/grants`, keys.readOnlyA, {
			method: 'GET',
			ttl_seconds: 60
		});
		expect(readGrant.status).toBe(200);
		const observed = await database.query<{ observed_size_bytes: string }>(
			'SELECT observed_size_bytes FROM volumes WHERE id = $1',
			[created.id]
		);
		expect(Number(observed.rows[0]?.observed_size_bytes)).toBe(512);

		const deniedWrite = await post(configured, `/v1/volumes/${created.id}/grants`, keys.readOnlyA, {
			method: 'PUT'
		});
		expect(deniedWrite.status).toBe(403);
		const writeGrant = await post(configured, `/v1/volumes/${created.id}/grants`, keys.projectA2, {
			method: 'PUT'
		});
		expect(writeGrant.status).toBe(200);
		expect(await writeGrant.json()).toMatchObject({
			grant: { maximum_bytes: 2 * 1_048_576 - 512 }
		});
	});

	it('keeps durable idempotency metadata when post-admission grant validation fails', async () => {
		const beforeUnsafe = await database.query<{ count: string }>(
			'SELECT count(*) FROM volumes WHERE project_id = $1',
			[fixture.projects.a1]
		);
		store.grantProtocol = 'http:';
		const unsafe = await post(configured, '/v1/volumes', keys.projectA1, {
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(unsafe.status).toBe(503);
		store.grantProtocol = 'https:';
		store.grantExpiryAdjustmentMs = -10 * 60 * 1_000;
		const expiredGrant = await post(configured, '/v1/volumes', keys.projectA1, {
			size_limit_mb: 1,
			ttl_seconds: 3_600
		});
		expect(expiredGrant.status).toBe(503);
		store.grantExpiryAdjustmentMs = 0;
		const afterUnsafe = await database.query<{ count: string }>(
			'SELECT count(*) FROM volumes WHERE project_id = $1',
			[fixture.projects.a1]
		);
		expect(Number(afterUnsafe.rows[0]?.count)).toBe(Number(beforeUnsafe.rows[0]?.count) + 2);

		const created = (await (
			await post(configured, '/v1/volumes', keys.projectA1, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		const row = await database.query<{ object_prefix: string }>(
			'SELECT object_prefix FROM volumes WHERE id = $1',
			[created.id]
		);
		store.observed.set(row.rows[0]!.object_prefix, 1_048_577);
		const grant = await post(configured, `/v1/volumes/${created.id}/grants`, keys.projectA1, {
			method: 'GET'
		});
		expect(grant.status).toBe(502);
		const persisted = await database.query<{ observed_size_bytes: string }>(
			'SELECT observed_size_bytes FROM volumes WHERE id = $1',
			[created.id]
		);
		expect(Number(persisted.rows[0]?.observed_size_bytes)).toBe(0);
	});

	it('does not return a PUT grant when a concurrent soft-delete wins reservation finalization', async () => {
		const created = (await (
			await post(configured, '/v1/volumes', keys.projectA1, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		currentNow = new Date(fixedNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);
		store.beforeIssue = async () => {
			store.beforeIssue = undefined;
			await database.query('UPDATE volumes SET deleted_at = $2 WHERE id = $1', [
				created.id,
				currentNow
			]);
		};
		const response = await post(configured, `/v1/volumes/${created.id}/grants`, keys.projectA1, {
			method: 'PUT'
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ title: 'volume_not_found' });
	});

	it('serializes concurrent PUT grants and keeps ambiguous issuance reserved until expiry', async () => {
		const created = (await (
			await post(configured, '/v1/volumes', keys.projectA2, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		currentNow = new Date(fixedNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);
		const contenders = await Promise.all([
			post(configured, `/v1/volumes/${created.id}/grants`, keys.projectA2, { method: 'PUT' }),
			post(configured, `/v1/volumes/${created.id}/grants`, keys.projectA2, { method: 'PUT' })
		]);
		expect(contenders.map(({ status }) => status).sort()).toEqual([200, 409]);
		const active = await database.query<{ total: string; count: string }>(
			`SELECT COALESCE(sum(maximum_bytes), 0)::text AS total, count(*)::text AS count
			 FROM volume_write_grant_reservations
			 WHERE volume_id = $1 AND expires_at > $2`,
			[created.id, currentNow]
		);
		expect(active.rows[0]).toMatchObject({ total: String(1_048_576), count: '1' });

		const ambiguous = (await (
			await post(configured, '/v1/volumes', keys.projectA1, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		currentNow = new Date(currentNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);
		store.issueFailures = 1;
		const failed = await post(configured, `/v1/volumes/${ambiguous.id}/grants`, keys.projectA1, {
			method: 'PUT'
		});
		expect(failed.status).toBe(503);
		const denied = await post(configured, `/v1/volumes/${ambiguous.id}/grants`, keys.projectA1, {
			method: 'PUT'
		});
		expect(denied.status).toBe(409);
		const held = await database.query<{ issued_at: Date | null }>(
			`SELECT issued_at FROM volume_write_grant_reservations
			 WHERE volume_id = $1 AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`,
			[ambiguous.id, currentNow]
		);
		expect(held.rows[0]?.issued_at).toBeNull();
		currentNow = new Date(currentNow.getTime() + (defaultVolumeGrantTtlSeconds + 1) * 1_000);
		expect(
			(
				await post(configured, `/v1/volumes/${ambiguous.id}/grants`, keys.projectA1, {
					method: 'PUT'
				})
			).status
		).toBe(200);
	});

	it('enforces the explicit fixed organization quota across projects', async () => {
		const contenders = await Promise.all([
			post(configured, '/v1/volumes', keys.organizationQuota1, {
				size_limit_mb: 3,
				ttl_seconds: 3_600
			}),
			post(configured, '/v1/volumes', keys.organizationQuota2, {
				size_limit_mb: 3,
				ttl_seconds: 3_600
			})
		]);
		expect(contenders.map(({ status }) => status).sort()).toEqual([201, 409]);
		const organization = await database.query<{ max_storage_mb: string; allocated: string }>(
			`SELECT o.max_storage_mb::text,
			        COALESCE(sum(v.size_limit_bytes), 0)::text AS allocated
			 FROM organizations o
			 LEFT JOIN volumes v ON v.organization_id = o.id
			 WHERE o.id = $1 GROUP BY o.id`,
			[fixture.organizations.quota]
		);
		expect(organization.rows[0]).toMatchObject({
			max_storage_mb: '4',
			allocated: String(3 * 1_048_576)
		});
	});

	it('enforces allocation quota transactionally through expiry retention', async () => {
		const contenders = await Promise.all([
			post(configured, '/v1/volumes', keys.projectAQuota, {
				size_limit_mb: 3,
				ttl_seconds: 3_600
			}),
			post(configured, '/v1/volumes', keys.projectAQuota, {
				size_limit_mb: 3,
				ttl_seconds: 3_600
			})
		]);
		expect(contenders.map(({ status }) => status).sort()).toEqual([201, 409]);
		const first = contenders.find(({ status }) => status === 201)!;
		const overQuota = contenders.find(({ status }) => status === 409)!;
		const firstVolume = (await first.json()) as { id: string; expires_at: string };
		expect(await overQuota.json()).toMatchObject({ title: 'storage_quota_exceeded' });

		currentNow = new Date(fixedNow.getTime() + 3_600_001);
		const duringRetention = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 2,
			ttl_seconds: 3_600
		});
		expect(duringRetention.status).toBe(409);
		currentNow = new Date(
			new Date(firstVolume.expires_at).getTime() + volumeDeletionRetentionSeconds * 1_000 + 1
		);
		const withoutDeletionJob = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 2,
			ttl_seconds: 3_600
		});
		expect(withoutDeletionJob.status).toBe(409);

		store.deletionFailures = 1;
		const worker = new VolumeDeletionWorker(database, store, () => currentNow);
		const failedSchedule = await worker.run();
		expect(failedSchedule).toMatchObject({
			expiredEnqueued: 1,
			claimed: 1,
			scheduled: 0,
			deferred: 1
		});
		const pendingDeletion = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 2,
			ttl_seconds: 3_600
		});
		expect(pendingDeletion.status).toBe(409);
		const retry = await database.query<{ next_attempt_at: Date }>(
			'SELECT next_attempt_at FROM volume_deletion_jobs WHERE volume_id = $1',
			[firstVolume.id]
		);
		currentNow = new Date(retry.rows[0]!.next_attempt_at.getTime() + 1);
		expect(await worker.run()).toMatchObject({ claimed: 1, scheduled: 1, deferred: 0 });

		const afterExpiry = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 2,
			ttl_seconds: 3_600
		});
		expect(afterExpiry.status).toBe(201);
		const retainedId = ((await afterExpiry.json()) as { id: string }).id;
		expect(
			(
				await fetch(`${configured.origin}/v1/volumes/${retainedId}`, {
					method: 'DELETE',
					headers: auth(keys.projectAQuota)
				})
			).status
		).toBe(204);
		const retainedAllocation = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 3,
			ttl_seconds: 3_600
		});
		expect(retainedAllocation.status).toBe(409);
		await database.query('UPDATE volumes SET deleted_at = $2 WHERE id = $1', [
			retainedId,
			new Date(currentNow.getTime() - (volumeDeletionRetentionSeconds * 1_000 + 1))
		]);
		expect(
			(
				await post(configured, '/v1/volumes', keys.projectAQuota, {
					size_limit_mb: 3,
					ttl_seconds: 3_600
				})
			).status
		).toBe(201);
	});

	it('durably schedules natural expiry and holds quota through retention', async () => {
		const created = (await (
			await post(configured, '/v1/volumes', keys.projectAQuota, {
				size_limit_mb: 3,
				ttl_seconds: 3_600
			})
		).json()) as { id: string; expires_at: string };
		currentNow = new Date(new Date(created.expires_at).getTime() + 1);
		const worker = new VolumeDeletionWorker(database, store, () => currentNow);
		const run = await worker.run();
		expect(run).toMatchObject({ expiredEnqueued: 1, claimed: 1, scheduled: 1, deferred: 0 });

		const persisted = await database.query<{
			deleted_at: Date;
			delete_after: Date;
			scheduled_at: Date;
		}>(
			`SELECT volume.deleted_at, job.delete_after, job.scheduled_at
			 FROM volumes volume
			 JOIN volume_deletion_jobs job ON job.volume_id = volume.id
			 WHERE volume.id = $1`,
			[created.id]
		);
		expect(persisted.rows[0]?.deleted_at.toISOString()).toBe(created.expires_at);
		expect(persisted.rows[0]?.delete_after.toISOString()).toBe(
			new Date(
				new Date(created.expires_at).getTime() + volumeDeletionRetentionSeconds * 1_000
			).toISOString()
		);
		expect(persisted.rows[0]?.scheduled_at).toBeInstanceOf(Date);
		expect(store.deletions).toHaveLength(1);

		const retained = await post(configured, '/v1/volumes', keys.projectAQuota, {
			size_limit_mb: 2,
			ttl_seconds: 3_600
		});
		expect(retained.status).toBe(409);
		currentNow = new Date(
			new Date(created.expires_at).getTime() + volumeDeletionRetentionSeconds * 1_000 + 1
		);
		expect(
			(
				await post(configured, '/v1/volumes', keys.projectAQuota, {
					size_limit_mb: 2,
					ttl_seconds: 3_600
				})
			).status
		).toBe(201);
	});

	it('backs off a failed deletion without starving later jobs and retries it', async () => {
		const ids: string[] = [];
		for (const key of [keys.projectA1, keys.projectA2]) {
			const created = (await (
				await post(configured, '/v1/volumes', key, {
					size_limit_mb: 1,
					ttl_seconds: 3_600
				})
			).json()) as { id: string };
			ids.push(created.id);
		}
		store.deletionFailures = 2;
		for (const [index, id] of ids.entries()) {
			const response = await fetch(`${configured.origin}/v1/volumes/${id}`, {
				method: 'DELETE',
				headers: auth(index === 0 ? keys.projectA1 : keys.projectA2)
			});
			expect(response.status).toBe(503);
		}

		currentNow = new Date(fixedNow.getTime() + 1_001);
		store.deletionFailures = 1;
		const worker = new VolumeDeletionWorker(database, store, () => currentNow);
		const first = await worker.run();
		expect(first).toMatchObject({ claimed: 2, scheduled: 1, deferred: 1 });
		const states = await database.query<{
			volume_id: string;
			attempt_count: number;
			scheduled_at: Date | null;
			next_attempt_at: Date;
			claim_token: string | null;
		}>(
			`SELECT volume_id, attempt_count, scheduled_at, next_attempt_at, claim_token
			 FROM volume_deletion_jobs WHERE volume_id = ANY($1::text[])
			 ORDER BY volume_id`,
			[ids]
		);
		expect(states.rows).toHaveLength(2);
		expect(states.rows.filter(({ scheduled_at }) => scheduled_at !== null)).toHaveLength(1);
		const deferred = states.rows.find(({ scheduled_at }) => scheduled_at === null)!;
		expect(deferred.attempt_count).toBe(2);
		expect(deferred.claim_token).toBeNull();
		expect(deferred.next_attempt_at.toISOString()).toBe(
			new Date(currentNow.getTime() + volumeDeletionRetryDelayMs(2)).toISOString()
		);

		currentNow = new Date(deferred.next_attempt_at.getTime() + 1);
		const retried = await worker.run();
		expect(retried).toMatchObject({ claimed: 1, scheduled: 1, deferred: 0 });
		expect(
			Number(
				(
					await database.query<{ count: string }>(
						`SELECT count(*) FROM volume_deletion_jobs
						 WHERE volume_id = ANY($1::text[]) AND scheduled_at IS NOT NULL`,
						[ids]
					)
				).rows[0]?.count
			)
		).toBe(2);
	});

	it('soft-deletes only after durable retention is scheduled and keeps tenant metadata', async () => {
		const created = (await (
			await post(configured, '/v1/volumes', keys.projectA2, {
				size_limit_mb: 1,
				ttl_seconds: 3_600
			})
		).json()) as { id: string };
		const row = await database.query<{ object_prefix: string }>(
			'SELECT object_prefix FROM volumes WHERE id = $1',
			[created.id]
		);
		const prefix = row.rows[0]!.object_prefix;
		store.observed.set(prefix, 123);

		const unavailableDelete = await fetch(`${unavailable.origin}/v1/volumes/${created.id}`, {
			method: 'DELETE',
			headers: auth(keys.projectA2)
		});
		expect(unavailableDelete.status).toBe(503);
		expect(
			(
				await database.query<{ deleted_at: Date | null }>(
					'SELECT deleted_at FROM volumes WHERE id = $1',
					[created.id]
				)
			).rows[0]?.deleted_at
		).toBeNull();
		expect(
			Number(
				(
					await database.query<{ count: string }>(
						'SELECT count(*) FROM volume_deletion_jobs WHERE volume_id = $1',
						[created.id]
					)
				).rows[0]?.count
			)
		).toBe(0);

		const crossTenantDelete = await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
			method: 'DELETE',
			headers: auth(keys.organizationB)
		});
		expect(crossTenantDelete.status).toBe(404);
		store.deletionFailures = 1;
		const schedulingFailed = await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
			method: 'DELETE',
			headers: auth(keys.projectA2)
		});
		expect(schedulingFailed.status).toBe(503);
		const softDeletedBeforeRetry = await database.query<{ deleted_at: Date | null }>(
			'SELECT deleted_at FROM volumes WHERE id = $1',
			[created.id]
		);
		expect(softDeletedBeforeRetry.rows[0]?.deleted_at?.toISOString()).toBe(fixedNow.toISOString());

		const deleted = await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
			method: 'DELETE',
			headers: auth(keys.projectA2)
		});
		expect(deleted.status).toBe(204);
		const deleteAfter = new Date(
			fixedNow.getTime() + volumeDeletionRetentionSeconds * 1_000
		).toISOString();
		expect(deleted.headers.get('x-volume-delete-after')).toBe(deleteAfter);
		expect(store.deletions.at(-1)).toMatchObject({
			organizationId: fixture.organizations.a,
			projectId: fixture.projects.a2,
			objectPrefix: prefix,
			deleteAfter: new Date(deleteAfter)
		});
		expect(store.deletions.at(-2)?.deleteAfter.toISOString()).toBe(deleteAfter);
		const persisted = await database.query<{
			deleted_at: Date | null;
			observed_size_bytes: string;
		}>('SELECT deleted_at, observed_size_bytes FROM volumes WHERE id = $1', [created.id]);
		expect(persisted.rows[0]?.deleted_at?.toISOString()).toBe(fixedNow.toISOString());
		expect(Number(persisted.rows[0]?.observed_size_bytes)).toBe(123);
		expect(
			(
				await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
					headers: auth(keys.projectA2)
				})
			).status
		).toBe(404);
	});

	it('schedules oversized and corrupt objects with a safe persisted observation', async () => {
		for (const observation of [2 * 1_048_576, Number.NaN]) {
			const created = (await (
				await post(configured, '/v1/volumes', keys.projectA1, {
					size_limit_mb: 1,
					ttl_seconds: 3_600
				})
			).json()) as { id: string };
			const row = await database.query<{ object_prefix: string }>(
				'SELECT object_prefix FROM volumes WHERE id = $1',
				[created.id]
			);
			const prefix = row.rows[0]!.object_prefix;
			if (Number.isNaN(observation)) {
				await database.query('UPDATE volumes SET observed_size_bytes = 77 WHERE id = $1', [
					created.id
				]);
			}
			store.observed.set(prefix, observation);
			const response = await fetch(`${configured.origin}/v1/volumes/${created.id}`, {
				method: 'DELETE',
				headers: auth(keys.projectA1)
			});
			expect(response.status).toBe(204);
			const persisted = await database.query<{
				observed_size_bytes: string;
				scheduled_at: Date | null;
			}>(
				`SELECT volume.observed_size_bytes, job.scheduled_at
				 FROM volumes volume
				 JOIN volume_deletion_jobs job ON job.volume_id = volume.id
				 WHERE volume.id = $1`,
				[created.id]
			);
			expect(Number(persisted.rows[0]?.observed_size_bytes)).toBe(
				Number.isNaN(observation) ? 77 : 1_048_576
			);
			expect(persisted.rows[0]?.scheduled_at).toBeInstanceOf(Date);
		}
	});
});

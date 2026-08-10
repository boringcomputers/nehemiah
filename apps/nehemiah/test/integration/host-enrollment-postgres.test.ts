import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import { HostCredentialCipher } from '../../src/domain/host-credentials.js';
import { HostService, type RegisterHost } from '../../src/domain/hosts.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const encodedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

databaseDescribe('one-use managed-host enrollment grants', () => {
	let database: Database;

	beforeAll(() => {
		database = new Database(databaseUrl!);
	});

	afterAll(async () => {
		await database.close();
	});

	const fixture = async (label: string) => {
		const suffix = randomUUID().replaceAll('-', '');
		const organizationId = randomUUID();
		const regionId = `enr-${label}-${suffix.slice(0, 10)}`;
		const providerId = `latitude-${label}-${suffix}`;
		const octets = Buffer.from(suffix.slice(0, 4), 'hex');
		const address = `10.91.${octets[0] ?? 1}.${(octets[1] ?? 1) || 1}`;
		await database.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Enrollment test')`,
			[organizationId, `enr-${suffix.slice(0, 20)}`]
		);
		await database.query(
			`INSERT INTO regions (id, provider, display_name)
			 VALUES ($1, 'integration', 'Enrollment integration')`,
			[regionId]
		);
		const hosts = new HostService(database, new HostCredentialCipher(encodedKey), ['10.91.0.0/16']);
		const input: RegisterHost = {
			providerId,
			regionId,
			address,
			architecture: 'x86_64',
			totalVcpus: 8,
			totalMemoryMb: 16_384,
			totalDiskMb: 100_000,
			controlToken: `control-${suffix}`.padEnd(48, 'c'),
			gatewayToken: `gateway-${suffix}`.padEnd(48, 'g'),
			runtimeCohort: testRuntimeCohort
		};
		const issue = () =>
			hosts.issueEnrollment({
				providerId,
				regionId,
				address,
				architecture: 'x86_64',
				totalVcpus: input.totalVcpus,
				totalMemoryMb: input.totalMemoryMb,
				totalDiskMb: input.totalDiskMb,
				ttlSeconds: 600,
				issuedByOrganizationId: organizationId,
				issuedByUserId: 'enrollment-integration',
				runtimeCohort: testRuntimeCohort
			});
		const cleanup = async () => {
			await database.query('DELETE FROM hosts WHERE provider_id = $1', [providerId]);
			await database.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
			await database.query('DELETE FROM regions WHERE id = $1', [regionId]);
		};
		return { hosts, input, issue, organizationId, regionId, providerId, cleanup };
	};

	it('stores only a bound digest and atomically accepts exactly one concurrent consumer', async () => {
		const test = await fixture('consume');
		try {
			const grant = await test.issue();
			const stored = await database.query<{
				token_hash: string;
				provider_id: string;
				address: string;
				total_vcpus: number;
			}>(
				`SELECT encode(token_hash, 'hex') AS token_hash, provider_id,
				        host(address) AS address, total_vcpus
				 FROM host_enrollment_grants WHERE id = $1`,
				[grant.id]
			);
			expect(stored.rows[0]).toMatchObject({
				provider_id: test.providerId,
				address: test.input.address,
				total_vcpus: 8
			});
			expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(JSON.stringify(stored.rows)).not.toContain(grant.token);

			const attempts = await Promise.allSettled([
				test.hosts.register(grant.token, test.input),
				test.hosts.register(grant.token, test.input)
			]);
			expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
			const rows = await database.query<{ count: string; consumed: boolean }>(
				`SELECT count(host.*)::text AS count,
				        enrollment.consumed_at IS NOT NULL AS consumed
				 FROM host_enrollment_grants enrollment
				 LEFT JOIN hosts host ON host.id = enrollment.host_id
				 WHERE enrollment.id = $1 GROUP BY enrollment.consumed_at`,
				[grant.id]
			);
			expect(rows.rows[0]).toEqual({ count: '1', consumed: true });
			await expect(
				test.hosts.register(grant.token, { ...test.input, providerId: `${test.providerId}-other` })
			).rejects.toMatchObject({ code: 'invalid_enrollment_grant' });
		} finally {
			await test.cleanup();
		}
	});

	it('fails closed on wrong bindings, expiry, and explicit revocation', async () => {
		const test = await fixture('binding');
		try {
			const superseded = await test.issue();
			const bound = await test.issue();
			await expect(test.hosts.register(superseded.token, test.input)).rejects.toMatchObject({
				code: 'invalid_enrollment_grant'
			});
			await expect(
				test.hosts.register(bound.token, { ...test.input, totalVcpus: 9 })
			).rejects.toMatchObject({ code: 'invalid_enrollment_grant' });
			const accepted = await test.hosts.register(bound.token, test.input);
			expect(accepted.id).toBe(bound.hostId);

			const recovery = await test.issue();
			expect(await test.hosts.revokeEnrollment(recovery.id)).toBe(true);
			expect(await test.hosts.revokeEnrollment(recovery.id)).toBe(false);
			await expect(test.hosts.register(recovery.token, test.input)).rejects.toMatchObject({
				code: 'invalid_enrollment_grant'
			});

			const expiredToken = `nhe_${randomBytes(32).toString('base64url')}`;
			const expiredId = randomUUID();
			await database.query(
				`INSERT INTO host_enrollment_grants
				 (id, token_hash, host_id, provider_id, region_id, address, architecture,
				  total_vcpus, total_memory_mb, total_disk_mb, issued_by_organization_id,
				  issued_by_user_id, created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
				         'enrollment-integration', statement_timestamp() - interval '2 minutes',
				         statement_timestamp() - interval '1 minute')`,
				[
					expiredId,
					createHash('sha256').update(expiredToken, 'utf8').digest(),
					accepted.id,
					test.providerId,
					test.regionId,
					test.input.address,
					test.input.architecture,
					test.input.totalVcpus,
					test.input.totalMemoryMb,
					test.input.totalDiskMb,
					test.organizationId
				]
			);
			await expect(test.hosts.register(expiredToken, test.input)).rejects.toMatchObject({
				code: 'invalid_enrollment_grant'
			});
		} finally {
			await test.cleanup();
		}
	});

	it('allows an operator recovery grant only before the first accepted heartbeat', async () => {
		const test = await fixture('recovery');
		try {
			const firstGrant = await test.issue();
			const first = await test.hosts.register(firstGrant.token, test.input);
			const recoveryGrant = await test.issue();
			const recovered = await test.hosts.register(recoveryGrant.token, test.input);
			expect(recovered.id).toBe(first.id);
			expect(recovered.credentialGeneration).toBe(first.credentialGeneration + 1);
			expect(
				await test.hosts.heartbeat(
					recovered.id,
					{
						state: 'ready',
						availableVcpus: 8,
						availableMemoryMb: 16_384,
						availableDiskMb: 100_000,
						machineCount: 0,
						kvmAvailable: true,
						daemonVersion: 'enrollment-integration',
						runtimeCohort: testRuntimeCohort
					},
					recovered.credentialGeneration
				)
			).toBe(true);
			await expect(test.issue()).rejects.toMatchObject({ code: 'host_not_enrollable' });
		} finally {
			await test.cleanup();
		}
	});
});

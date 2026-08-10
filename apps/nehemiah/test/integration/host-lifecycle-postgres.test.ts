import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import { HostCredentialCipher } from '../../src/domain/host-credentials.js';
import { HostService } from '../../src/domain/hosts.js';
import { CapacityUnavailable, Scheduler } from '../../src/scheduler/scheduler.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const encodedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

databaseDescribe('PostgreSQL managed-host lifecycle', () => {
	let database: Database;

	beforeAll(() => {
		database = new Database(databaseUrl!);
	});

	afterAll(async () => {
		await database.close();
	});

	it('requires an operator transition after stale/quarantine and permanently revokes retired hosts', async () => {
		const suffix = randomUUID();
		const regionId = `host-lifecycle-${suffix}`;
		const organizationId = randomUUID();
		const projectId = randomUUID();
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO regions (id, provider, display_name)
				 VALUES ($1, 'integration', 'Host lifecycle integration')`,
				[regionId]
			);
			await client.query(
				`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Fleet operators')`,
				[organizationId, `fleet-operators-${suffix}`]
			);
			await client.query(
				`INSERT INTO projects (id, organization_id, slug, name)
				 VALUES ($1, $2, $3, 'Fleet lifecycle test')`,
				[projectId, organizationId, `host-lifecycle-${suffix}`]
			);
			await client.query('INSERT INTO fleet_operator_organizations (organization_id) VALUES ($1)', [
				organizationId
			]);
		});

		const hosts = new HostService(database, new HostCredentialCipher(encodedKey), ['10.64.0.0/16']);
		const input = {
			providerId: `provider-${suffix}`,
			regionId,
			address: `10.64.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`,
			architecture: 'x86_64' as const,
			totalVcpus: 8,
			totalMemoryMb: 16_384,
			totalDiskMb: 100_000,
			controlToken: 'control-'.padEnd(48, 'c'),
			gatewayToken: 'gateway-'.padEnd(48, 'g'),
			runtimeCohort: testRuntimeCohort
		};
		const issueEnrollment = () =>
			hosts.issueEnrollment({
				providerId: input.providerId,
				regionId: input.regionId,
				address: input.address,
				architecture: input.architecture,
				totalVcpus: input.totalVcpus,
				totalMemoryMb: input.totalMemoryMb,
				totalDiskMb: input.totalDiskMb,
				ttlSeconds: 600,
				issuedByOrganizationId: organizationId,
				issuedByUserId: 'host-lifecycle-integration',
				runtimeCohort: testRuntimeCohort
			});
		const enrollment = await issueEnrollment();
		const registered = await hosts.register(enrollment.token, input);
		expect(registered.credentialGeneration).toBe(1);
		const credentialState = () =>
			database.query<{
				credential_generation: number;
				state: string;
				control_credential_ciphertext: string;
				gateway_credential_ciphertext: string;
			}>(
				`SELECT credential_generation, state, control_credential_ciphertext,
				        gateway_credential_ciphertext
				 FROM hosts WHERE id = $1`,
				[registered.id]
			);
		const beforeCollapsedRotation = (await credentialState()).rows[0];
		const collapsedToken = 'collapsed-authority-'.padEnd(48, 'x');
		await expect(
			hosts.rotateCredentials(registered.id, {
				controlToken: collapsedToken,
				gatewayToken: collapsedToken
			})
		).rejects.toMatchObject({ code: 'invalid_host_enrollment' });
		expect((await credentialState()).rows[0]).toEqual(beforeCollapsedRotation);
		expect(await hosts.isOperatorOrganization(organizationId)).toBe(true);
		expect(await hosts.authenticate(registered.id, registered.credential)).toBe(true);
		const heartbeat = {
			state: 'ready' as const,
			availableVcpus: 8,
			availableMemoryMb: 16_384,
			availableDiskMb: 100_000,
			machineCount: 0,
			kvmAvailable: true,
			daemonVersion: 'integration',
			runtimeCohort: testRuntimeCohort
		};
		const sendHeartbeat = async (credentialGeneration: number) => {
			await database.query(
				`UPDATE hosts SET last_heartbeat_at = now() - interval '6 seconds' WHERE id = $1`,
				[registered.id]
			);
			return hosts.heartbeat(registered.id, heartbeat, credentialGeneration);
		};
		expect(await sendHeartbeat(registered.credentialGeneration)).toBe(true);
		await hosts.activate(registered.id, 'verify enrollment stays closed');
		await expect(issueEnrollment()).rejects.toMatchObject({ code: 'host_not_enrollable' });
		expect(await sendHeartbeat(registered.credentialGeneration)).toBe(true);
		const scheduler = new Scheduler(database);
		const placement = () =>
			scheduler.reserve({
				organizationId,
				projectId,
				region: regionId,
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 5_120 }
			});
		for (const desiredState of ['draining', 'quarantined'] as const) {
			await database.query('UPDATE hosts SET desired_state = $2 WHERE id = $1', [
				registered.id,
				desiredState
			]);
			await expect(placement()).rejects.toBeInstanceOf(CapacityUnavailable);
		}
		await database.query("UPDATE hosts SET desired_state = 'active' WHERE id = $1", [
			registered.id
		]);

		await hosts.drain(registered.id, 'maintenance');
		expect(await sendHeartbeat(registered.credentialGeneration)).toBe(true);
		await expect(placement()).rejects.toBeInstanceOf(CapacityUnavailable);

		await hosts.quarantine(registered.id, 'suspected compromise');
		const erased = await database.query<{
			desired_state: string;
			state: string;
			credential_status: string;
			credential_hash: string | null;
			control_credential_ciphertext: string | null;
			gateway_credential_ciphertext: string | null;
		}>(
			`SELECT desired_state, state, credential_status, credential_hash,
			        control_credential_ciphertext, gateway_credential_ciphertext
			 FROM hosts WHERE id = $1`,
			[registered.id]
		);
		expect(erased.rows[0]).toEqual({
			desired_state: 'quarantined',
			state: 'stale',
			credential_status: 'revoked',
			credential_hash: null,
			control_credential_ciphertext: null,
			gateway_credential_ciphertext: null
		});
		expect(await hosts.authenticate(registered.id, registered.credential)).toBe(false);
		expect(await sendHeartbeat(registered.credentialGeneration)).toBe(false);

		const rotated = await hosts.rotateCredentials(
			registered.id,
			{
				controlToken: 'rotated-control-'.padEnd(48, 'c'),
				gatewayToken: 'rotated-gateway-'.padEnd(48, 'g')
			},
			'incident recovery'
		);
		expect(rotated?.credentialGeneration).toBe(2);
		expect(await hosts.authenticate(registered.id, rotated!.credential)).toBe(false);
		expect(await hosts.activate(registered.id, 'approved recovery')).toBeDefined();
		expect(await sendHeartbeat(registered.credentialGeneration)).toBe(false);
		expect(await hosts.authenticate(registered.id, rotated!.credential)).toBe(true);
		expect(await sendHeartbeat(rotated!.credentialGeneration)).toBe(true);
		const latestHeartbeat = await database.query<{ credential_generation: number }>(
			`SELECT credential_generation FROM host_heartbeats
			 WHERE host_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1`,
			[registered.id]
		);
		expect(latestHeartbeat.rows[0]?.credential_generation).toBe(2);

		await hosts.revoke(registered.id, 'retired after incident');
		await database.query("UPDATE hosts SET state = 'ready' WHERE id = $1", [registered.id]);
		await expect(placement()).rejects.toBeInstanceOf(CapacityUnavailable);
		expect(await hosts.authenticate(registered.id, rotated!.credential)).toBe(false);
		expect(
			await hosts.rotateCredentials(registered.id, {
				controlToken: 'another-control-'.padEnd(48, 'c'),
				gatewayToken: 'another-gateway-'.padEnd(48, 'g')
			})
		).toBeUndefined();
		expect(await hosts.activate(registered.id)).toBeUndefined();
		await expect(issueEnrollment()).rejects.toMatchObject({ code: 'host_not_enrollable' });
	});
});

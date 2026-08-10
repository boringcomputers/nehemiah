import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import {
	TemplateService,
	type ScopedObjectGrant,
	type TemplateMachineResolver,
	type TemplateObjectStore,
	type TemplatePublisher
} from '../../src/domain/templates.js';
import { PostgresTemplateReplicaRepository } from '../../src/jobs/replicate-template.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const checksum = `sha256:${'ab'.repeat(32)}`;
const artifact = { checksum, sizeBytes: 4_194_304 };

class BoundStorage implements TemplateObjectStore {
	granted?: { objectKey: string; artifact: typeof artifact };

	async createUploadGrant(
		objectKey: string,
		requested: typeof artifact,
		expiresAt: Date
	): Promise<ScopedObjectGrant> {
		this.granted = { objectKey, artifact: requested };
		return {
			method: 'PUT',
			url: `https://objects.example.test/exact?X-Amz-Signature=scoped`,
			headers: {
				'content-length': String(requested.sizeBytes),
				'if-none-match': '*',
				'x-amz-server-side-encryption': 'AES256'
			},
			expiresAt
		};
	}

	async createDownloadGrant(_objectKey: string, expiresAt: Date): Promise<ScopedObjectGrant> {
		return {
			method: 'GET',
			url: 'https://objects.example.test/exact?X-Amz-Signature=scoped',
			expiresAt
		};
	}

	async stat() {
		return artifact;
	}

	async delete(): Promise<void> {}
}

class ExportFirstPublisher implements TemplatePublisher {
	exported = false;

	async export(input: Parameters<TemplatePublisher['export']>[0]) {
		this.exported = true;
		return { exportId: input.exportId, ...artifact };
	}

	async upload(input: Parameters<TemplatePublisher['upload']>[0]) {
		if (!this.exported || input.artifact.checksum !== checksum) {
			throw new Error('upload was not bound to the completed export');
		}
		return artifact;
	}

	async discard(): Promise<void> {}
}

databaseDescribe('PostgreSQL durable template publication and replica eligibility', () => {
	let database: Database;

	beforeAll(() => {
		database = new Database(databaseUrl!);
	});

	afterAll(async () => {
		await database.close();
	});

	it('persists one tenant/version, queues architecture-matched hosts, and schedules only a verified replica', async () => {
		const suffix = randomUUID();
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const sourceHostId = randomUUID();
		const replicaHostId = randomUUID();
		const regionId = `template-transfer-${suffix}`;
		const machineId = `m_template_source_${suffix.replaceAll('-', '')}`;
		const leaseId = randomUUID();
		const subnet = (Number.parseInt(suffix.slice(0, 2), 16) % 200) + 20;
		const sourceAddress = `10.71.${subnet}.10`;
		const replicaAddress = `10.71.${subnet}.11`;
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO regions (id, provider, display_name) VALUES ($1, 'integration', $2)`,
					[regionId, `Template transfer ${suffix}`]
				);
				await client.query(
					`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Template transfer')`,
					[organizationId, `template-transfer-${suffix}`]
				);
				await client.query(
					`INSERT INTO projects
					 (id, organization_id, slug, name, max_machines, max_vcpus, max_memory_mb, max_storage_mb)
					 VALUES ($1, $2, $3, 'Template transfer', 10, 20, 20480, 102400)`,
					[projectId, organizationId, `template-transfer-${suffix}`]
				);
				for (const [id, address] of [
					[sourceHostId, sourceAddress],
					[replicaHostId, replicaAddress]
				] as const) {
					await client.query(
						`INSERT INTO hosts
						 (id, provider_id, region_id, address, architecture, state, credential_hash,
						  control_credential_ciphertext, gateway_credential_ciphertext,
						  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
						  reported_available_vcpus, reported_available_memory_mb, reported_available_disk_mb,
						  runtime_cohort_id, runtime_contract_version, runtime_arch,
						  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
						  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
						 VALUES ($1, $2, $3, $4, 'x86_64', 'ready', 'test', 'test', 'test',
						         8, 16384, 100000, now(), 8, 16384, 100000,
						         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
						         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
						[id, `template-${id}`, regionId, address]
					);
				}
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
					  idempotency_key, idempotency_request_hash, state, region_id, architecture,
					  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
					  ready, ready_at, expires_at)
					 VALUES ($1, $2, $3, $4, 'm-01020304', $5, 'template-source', $6,
					         'running', $7, 'x86_64', 'python', 900, 1, 512, 5120,
					         true, now(), now() + interval '15 minutes')`,
					[machineId, organizationId, projectId, sourceHostId, leaseId, 'a'.repeat(64), regionId]
				);
			});

			const machines: TemplateMachineResolver = {
				get: async () => ({
					id: machineId,
					organizationId,
					projectId,
					state: 'running',
					ready: true,
					architecture: 'x86_64',
					hostId: sourceHostId,
					hostAddress: sourceAddress,
					hostMachineId: 'm-01020304',
					leaseId,
					expiresAt: new Date(Date.now() + 10 * 60 * 1_000)
				})
			};
			const storage = new BoundStorage();
			const eligibleHosts = await database.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM hosts
				 WHERE architecture = 'x86_64' AND state IN ('ready', 'draining')`
			);
			const template = await new TemplateService(
				database,
				machines,
				storage,
				new ExportFirstPublisher()
			).publish({
				organizationId,
				projectId,
				machineId,
				name: 'integration-template',
				version: 'v1'
			});
			expect(storage.granted).toEqual({ objectKey: template.objectKey, artifact });

			const persisted = await database.query<{
				organization_id: string;
				project_id: string;
				checksum: string;
				replicas: string;
			}>(
				`SELECT t.organization_id, t.project_id, t.checksum, count(tr.*)::text AS replicas
				 FROM templates t JOIN template_replicas tr ON tr.template_id = t.id
				 WHERE t.id = $1 GROUP BY t.id`,
				[template.id]
			);
			expect(persisted.rows[0]).toEqual({
				organization_id: organizationId,
				project_id: projectId,
				checksum,
				replicas: eligibleHosts.rows[0]!.count
			});
			const requiredReplicas = await database.query<{ host_id: string }>(
				`SELECT host_id::text FROM template_replicas
				 WHERE template_id = $1 AND host_id = ANY($2::uuid[]) ORDER BY host_id`,
				[template.id, [sourceHostId, replicaHostId]]
			);
			expect(requiredReplicas.rows.map(({ host_id }) => host_id).sort()).toEqual(
				[sourceHostId, replicaHostId].sort()
			);

			const replicas = new PostgresTemplateReplicaRepository(database);
			await database.query(
				"UPDATE template_replicas SET state = 'pulling' WHERE template_id = $1 AND host_id = $2",
				[template.id, replicaHostId]
			);
			expect(await replicas.markReady(template.id, replicaHostId, checksum)).toBe(true);
			const reservation = await new Scheduler(database).reserve({
				organizationId,
				projectId,
				region: regionId,
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 5_120 },
				templateId: template.id
			});
			expect(reservation.hostId).toBe(replicaHostId);
		} finally {
			await database.query('DELETE FROM templates WHERE organization_id = $1', [organizationId]);
			await database.query('DELETE FROM machines WHERE organization_id = $1', [organizationId]);
			await database.query('DELETE FROM projects WHERE organization_id = $1', [organizationId]);
			await database.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
			await database.query('DELETE FROM hosts WHERE id = ANY($1::uuid[])', [
				[sourceHostId, replicaHostId]
			]);
			await database.query('DELETE FROM regions WHERE id = $1', [regionId]);
		}
	});
});

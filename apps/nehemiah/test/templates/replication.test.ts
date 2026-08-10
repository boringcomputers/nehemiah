import { describe, expect, it } from 'vitest';
import type {
	ScopedObjectGrant,
	TemplateManifest,
	TemplateObjectStore
} from '../../src/domain/templates.js';
import {
	TemplateInfrastructureUnavailable,
	TemplateIntegrityError
} from '../../src/domain/templates.js';
import {
	TemplateReplicationJob,
	type TemplateActivator,
	type TemplateReplicaRepository,
	type TemplateReplicaWork
} from '../../src/jobs/replicate-template.js';
import { chooseHost } from '../../src/scheduler/placement.js';

const checksum = `sha256:${'c'.repeat(64)}`;
const now = new Date('2026-08-09T12:00:00.000Z');
const objectKey =
	'organizations/org-a/projects/project-a/templates/editor/v1/template-a/snapshot.tar.zst';
const manifest: TemplateManifest = {
	schema_version: 1,
	format: 'firecracker-snapshot-v1',
	architecture: 'x86_64',
	source: { machine_id: 'm_source-machine-123' },
	artifact: { object_key: objectKey, checksum, size_bytes: 4_194_304 }
};

const work: TemplateReplicaWork = {
	templateId: 'template-a',
	organizationId: 'org-a',
	projectId: 'project-a',
	name: 'editor',
	version: 'v1',
	hostId: 'host-a',
	hostAddress: '10.0.0.2',
	hostTemplateName: `t-${'d'.repeat(29)}`,
	objectKey,
	checksum,
	sizeBytes: 4_194_304,
	manifest
};

class MemoryReplicas implements TemplateReplicaRepository {
	enqueued = 0;
	claimed = 0;
	ready?: { templateId: string; hostId: string; checksum: string };
	failed?: { templateId: string; hostId: string; reason: string };
	markReadyResult = true;

	constructor(readonly work?: TemplateReplicaWork) {}

	async enqueueMissing(): Promise<number> {
		this.enqueued += 1;
		return 2;
	}

	async claim(): Promise<TemplateReplicaWork | undefined> {
		this.claimed += 1;
		return this.work;
	}

	async markReady(templateId: string, hostId: string, verifiedChecksum: string) {
		this.ready = { templateId, hostId, checksum: verifiedChecksum };
		return this.markReadyResult;
	}

	async markFailed(templateId: string, hostId: string, reason: string): Promise<void> {
		this.failed = { templateId, hostId, reason };
	}
}

class ReplicaStorage implements TemplateObjectStore {
	artifact = { checksum, sizeBytes: work.sizeBytes };
	downloads = 0;
	grant: ScopedObjectGrant = {
		method: 'GET',
		url: 'https://objects.example.test/template?signature=scoped',
		expiresAt: new Date(now.getTime() + 10 * 60 * 1_000)
	};

	async createUploadGrant(
		_objectKey: string,
		_artifact: { readonly checksum: string; readonly sizeBytes: number },
		_expiresAt: Date
	): Promise<ScopedObjectGrant> {
		throw new Error('not used by replication');
	}

	async createDownloadGrant(): Promise<ScopedObjectGrant> {
		this.downloads += 1;
		return this.grant;
	}

	async stat() {
		return this.artifact;
	}

	async delete(): Promise<void> {}
}

class FakeActivator implements TemplateActivator {
	calls = 0;
	result = { checksum, sizeBytes: work.sizeBytes };
	lastInput?: Parameters<TemplateActivator['activate']>[0];

	async activate(input: Parameters<TemplateActivator['activate']>[0]) {
		this.calls += 1;
		this.lastInput = input;
		return this.result;
	}
}

describe('template replication state machine', () => {
	it('marks ready only after durable and host activation checksums match', async () => {
		const replicas = new MemoryReplicas(work);
		const storage = new ReplicaStorage();
		const activator = new FakeActivator();
		const job = new TemplateReplicationJob(replicas, storage, activator, () => new Date(now));

		expect(await job.runOnce()).toEqual({
			state: 'ready',
			enqueued: 2,
			templateId: 'template-a',
			hostId: 'host-a'
		});
		expect(activator.lastInput).toMatchObject({
			address: '10.0.0.2',
			hostTemplateName: work.hostTemplateName,
			architecture: 'x86_64',
			checksum,
			sizeBytes: work.sizeBytes,
			download: { method: 'GET' }
		});
		expect(replicas.ready).toEqual({
			templateId: 'template-a',
			hostId: 'host-a',
			checksum
		});
		expect(replicas.failed).toBeUndefined();

		// This is the exact cached-template signal consumed by the scheduler.
		const selected = chooseHost(
			[
				{
					id: 'host-a',
					region: 'ca-tor-1',
					architecture: 'x86_64',
					state: 'ready',
					vcpus: 4,
					memoryMb: 4096,
					diskMb: 20_000,
					reservedVcpus: 0,
					reservedMemoryMb: 0,
					reservedDiskMb: 0,
					cachedTemplates: new Set(['template-a'])
				}
			],
			{
				region: 'ca-tor-1',
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
				templateId: 'template-a'
			}
		);
		expect(selected?.id).toBe('host-a');
	});

	it('never activates or marks ready when durable storage does not match', async () => {
		const replicas = new MemoryReplicas(work);
		const storage = new ReplicaStorage();
		storage.artifact = { checksum: `sha256:${'e'.repeat(64)}`, sizeBytes: work.sizeBytes };
		const activator = new FakeActivator();
		const result = await new TemplateReplicationJob(
			replicas,
			storage,
			activator,
			() => new Date(now)
		).runOnce();

		expect(result.state).toBe('failed');
		expect(activator.calls).toBe(0);
		expect(replicas.ready).toBeUndefined();
		expect(replicas.failed?.reason).toBe(new TemplateIntegrityError('').code);
	});

	it('never marks ready when the activated host checksum differs', async () => {
		const replicas = new MemoryReplicas(work);
		const activator = new FakeActivator();
		activator.result = { checksum: `sha256:${'f'.repeat(64)}`, sizeBytes: work.sizeBytes };
		const result = await new TemplateReplicationJob(
			replicas,
			new ReplicaStorage(),
			activator,
			() => new Date(now)
		).runOnce();

		expect(result.state).toBe('failed');
		expect(activator.calls).toBe(1);
		expect(replicas.ready).toBeUndefined();
		expect(replicas.failed?.reason).toBe('template_integrity_failed');
	});

	it('fails typed and does not claim work when storage or activation is unconfigured', async () => {
		const replicas = new MemoryReplicas(work);
		await expect(new TemplateReplicationJob(replicas).runOnce()).rejects.toBeInstanceOf(
			TemplateInfrastructureUnavailable
		);
		expect(replicas.enqueued).toBe(0);
		expect(replicas.claimed).toBe(0);
	});

	it('returns idle after enqueueing new-host replicas when there is no claimable work', async () => {
		const replicas = new MemoryReplicas();
		const result = await new TemplateReplicationJob(
			replicas,
			new ReplicaStorage(),
			new FakeActivator(),
			() => new Date(now)
		).runOnce();
		expect(result).toEqual({ state: 'idle', enqueued: 2 });
	});
});

import { describe, expect, it } from 'vitest';
import type { ApiKeyRecord, ApiKeyStore } from '../../src/auth/api-key.js';
import { ApiKeyService } from '../../src/auth/api-key.js';
import type { AuditService } from '../../src/audit/audit.js';
import {
	TemplateInfrastructureUnavailable,
	TemplateIntegrityError,
	TemplateService,
	TemplateSourceNotFound,
	TemplateSourceNotReady,
	TemplateVersionConflict,
	type ScopedObjectGrant,
	type Template,
	type TemplateDeleteResult,
	type TemplateMachineResolver,
	type TemplateObjectStore,
	type TemplatePublisher,
	type TemplateRepository,
	type TemplateSourceMachine
} from '../../src/domain/templates.js';
import type { OrganizationService } from '../../src/domain/organizations.js';
import { Router } from '../../src/http/router.js';
import {
	registerTemplateRoutes,
	type TemplateRouteServices
} from '../../src/http/routes/templates.js';

const checksumA = `sha256:${'a'.repeat(64)}`;
const checksumB = `sha256:${'b'.repeat(64)}`;
const now = new Date('2026-08-09T12:00:00.000Z');

class MemoryTemplates implements TemplateRepository {
	readonly templates = new Map<string, Template>();
	readonly inUse = new Set<string>();

	async list(organizationId: string, projectId?: string, includeDeleted = false) {
		return [...this.templates.values()].filter(
			(template) =>
				template.organizationId === organizationId &&
				(projectId === undefined || template.projectId === projectId) &&
				(includeDeleted || !template.deletedAt)
		);
	}

	async insert(template: Template): Promise<void> {
		const conflict = [...this.templates.values()].some(
			(existing) =>
				existing.projectId === template.projectId &&
				existing.name === template.name &&
				existing.version === template.version
		);
		if (conflict) throw Object.assign(new Error('unique'), { code: '23505' });
		this.templates.set(template.id, template);
	}

	async findVersion(organizationId: string, projectId: string, name: string, version: string) {
		return [...this.templates.values()].find(
			(template) =>
				template.organizationId === organizationId &&
				template.projectId === projectId &&
				template.name === name &&
				template.version === version
		);
	}

	async remove(
		idOrVersion: string,
		organizationId: string,
		projectId?: string
	): Promise<TemplateDeleteResult> {
		const template = [...this.templates.values()].find(
			(candidate) =>
				(candidate.id === idOrVersion ||
					`${candidate.name}@${candidate.version}` === idOrVersion) &&
				candidate.organizationId === organizationId &&
				(projectId === undefined || candidate.projectId === projectId) &&
				!candidate.deletedAt
		);
		if (!template) return 'not_found';
		if (this.inUse.has(template.id)) return 'in_use';
		this.templates.set(template.id, { ...template, deletedAt: new Date(now) });
		return 'deleted';
	}
}

class MemoryMachines implements TemplateMachineResolver {
	constructor(readonly machines: ReadonlyArray<TemplateSourceMachine>) {}

	async get(id: string, organizationId: string, projectId?: string) {
		return this.machines.find(
			(machine) =>
				machine.id === id &&
				machine.organizationId === organizationId &&
				(projectId === undefined || machine.projectId === projectId)
		);
	}
}

class FakeStorage implements TemplateObjectStore {
	readonly uploads: string[] = [];
	readonly uploadArtifacts: Array<{ readonly checksum: string; readonly sizeBytes: number }> = [];
	readonly downloads: string[] = [];
	readonly deleted: string[] = [];
	artifact = { checksum: checksumA, sizeBytes: 8_388_608 };
	grantProtocol = 'https:';

	async createUploadGrant(
		objectKey: string,
		artifact: { readonly checksum: string; readonly sizeBytes: number },
		expiresAt: Date
	): Promise<ScopedObjectGrant> {
		this.uploads.push(objectKey);
		this.uploadArtifacts.push(artifact);
		return {
			method: 'PUT',
			url: `${this.grantProtocol}//objects.example.test/upload/${encodeURIComponent(objectKey)}?signature=scoped`,
			headers: {
				'x-amz-server-side-encryption': 'AES256',
				'content-length': String(artifact.sizeBytes)
			},
			expiresAt
		};
	}

	async createDownloadGrant(objectKey: string, expiresAt: Date): Promise<ScopedObjectGrant> {
		this.downloads.push(objectKey);
		return {
			method: 'GET',
			url: `https://objects.example.test/download/${encodeURIComponent(objectKey)}?signature=scoped`,
			expiresAt
		};
	}

	async stat(): Promise<{ readonly checksum: string; readonly sizeBytes: number }> {
		return this.artifact;
	}

	async delete(objectKey: string): Promise<void> {
		this.deleted.push(objectKey);
	}
}

class FakePublisher implements TemplatePublisher {
	exportCalls = 0;
	uploadCalls = 0;
	discardCalls = 0;
	artifact = { checksum: checksumA, sizeBytes: 8_388_608 };
	lastExport?: Parameters<TemplatePublisher['export']>[0];
	lastUpload?: Parameters<TemplatePublisher['upload']>[0];

	async export(input: Parameters<TemplatePublisher['export']>[0]) {
		this.exportCalls += 1;
		this.lastExport = input;
		return { exportId: input.exportId, ...this.artifact };
	}

	async upload(input: Parameters<TemplatePublisher['upload']>[0]) {
		this.uploadCalls += 1;
		this.lastUpload = input;
		return this.artifact;
	}

	async discard(): Promise<void> {
		this.discardCalls += 1;
	}
}

const sourceMachine = (overrides: Partial<TemplateSourceMachine> = {}): TemplateSourceMachine => ({
	id: 'm_source-machine-123',
	organizationId: 'org-a',
	projectId: 'project-a',
	state: 'running',
	ready: true,
	architecture: 'x86_64',
	hostId: 'host-a',
	hostAddress: '10.0.0.2',
	hostMachineId: 'local-a',
	leaseId: 'lease-a',
	expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
	...overrides
});

const publish = (service: TemplateService, overrides: Record<string, string> = {}) =>
	service.publish({
		organizationId: 'org-a',
		projectId: 'project-a',
		machineId: 'm_source-machine-123',
		name: 'browser-ready',
		version: 'v1.2.3',
		...overrides
	});

describe('durable template publication', () => {
	it('publishes only from the current tenant ready machine and builds immutable metadata', async () => {
		const repository = new MemoryTemplates();
		const storage = new FakeStorage();
		const publisher = new FakePublisher();
		const service = new TemplateService(
			repository,
			new MemoryMachines([sourceMachine()]),
			storage,
			publisher,
			() => new Date(now)
		);

		const template = await publish(service);

		expect(template).toMatchObject({
			organizationId: 'org-a',
			projectId: 'project-a',
			name: 'browser-ready',
			version: 'v1.2.3',
			checksum: checksumA,
			sizeBytes: 8_388_608,
			sourceMachineId: 'm_source-machine-123'
		});
		expect(template.hostTemplateName).toMatch(/^t-[a-f0-9]{29}$/);
		expect(template.objectKey).toMatch(
			/^organizations\/org-a\/projects\/project-a\/templates\/browser-ready\/v1\.2\.3\/[^/]+\/snapshot\.tar\.zst$/
		);
		expect(template.manifest).toEqual({
			schema_version: 1,
			format: 'firecracker-snapshot-v1',
			architecture: 'x86_64',
			source: { machine_id: 'm_source-machine-123' },
			artifact: {
				object_key: template.objectKey,
				checksum: checksumA,
				size_bytes: 8_388_608
			}
		});
		expect(publisher.lastExport).toMatchObject({
			address: '10.0.0.2',
			hostMachineId: 'local-a',
			leaseId: 'lease-a'
		});
		expect(publisher.lastUpload).toMatchObject({
			address: '10.0.0.2',
			hostMachineId: 'local-a',
			leaseId: 'lease-a',
			artifact: { checksum: checksumA, sizeBytes: 8_388_608 },
			upload: { method: 'PUT' }
		});
		expect(publisher.lastUpload?.exportId).toBe(publisher.lastExport?.exportId);
		expect(storage.uploadArtifacts).toEqual([{ checksum: checksumA, sizeBytes: 8_388_608 }]);
		expect(publisher.discardCalls).toBe(1);
		expect(JSON.stringify([publisher.lastExport, publisher.lastUpload])).not.toContain('master');
		expect(repository.templates.get(template.id)).toEqual(template);
	});

	it('does not reveal or publish a machine owned by another tenant or project', async () => {
		const storage = new FakeStorage();
		const publisher = new FakePublisher();
		const service = new TemplateService(
			new MemoryTemplates(),
			new MemoryMachines([sourceMachine({ organizationId: 'org-b' })]),
			storage,
			publisher,
			() => new Date(now)
		);

		await expect(publish(service)).rejects.toBeInstanceOf(TemplateSourceNotFound);
		expect(storage.uploads).toHaveLength(0);
		expect(publisher.exportCalls).toBe(0);
	});

	it('fails closed for an unready source or missing durable integrations', async () => {
		const unavailable = new TemplateService(new MemoryTemplates());
		await expect(publish(unavailable)).rejects.toBeInstanceOf(TemplateInfrastructureUnavailable);

		const unready = new TemplateService(
			new MemoryTemplates(),
			new MemoryMachines([sourceMachine({ ready: false })]),
			new FakeStorage(),
			new FakePublisher(),
			() => new Date(now)
		);
		await expect(publish(unready)).rejects.toBeInstanceOf(TemplateSourceNotReady);

		const expired = new TemplateService(
			new MemoryTemplates(),
			new MemoryMachines([sourceMachine({ expiresAt: new Date(now.getTime() - 1) })]),
			new FakeStorage(),
			new FakePublisher(),
			() => new Date(now)
		);
		await expect(publish(expired)).rejects.toBeInstanceOf(TemplateSourceNotReady);

		const insecureStorage = new FakeStorage();
		insecureStorage.grantProtocol = 'http:';
		const publisher = new FakePublisher();
		const insecure = new TemplateService(
			new MemoryTemplates(),
			new MemoryMachines([sourceMachine()]),
			insecureStorage,
			publisher,
			() => new Date(now)
		);
		await expect(publish(insecure)).rejects.toBeInstanceOf(TemplateInfrastructureUnavailable);
		expect(publisher.exportCalls).toBe(1);
		expect(publisher.uploadCalls).toBe(0);
		expect(publisher.discardCalls).toBe(1);
	});

	it('rejects checksum mismatch and cleans partial durable artifacts', async () => {
		const repository = new MemoryTemplates();
		const storage = new FakeStorage();
		storage.artifact = { checksum: checksumB, sizeBytes: 8_388_608 };
		const service = new TemplateService(
			repository,
			new MemoryMachines([sourceMachine()]),
			storage,
			new FakePublisher(),
			() => new Date(now)
		);

		await expect(publish(service)).rejects.toBeInstanceOf(TemplateIntegrityError);
		expect(repository.templates.size).toBe(0);
		expect(storage.deleted).toEqual(storage.uploads);
	});

	it('keeps name/version immutable and retains versions used by running machines', async () => {
		const repository = new MemoryTemplates();
		const storage = new FakeStorage();
		const service = new TemplateService(
			repository,
			new MemoryMachines([sourceMachine()]),
			storage,
			new FakePublisher(),
			() => new Date(now)
		);
		const template = await publish(service);

		await expect(publish(service)).rejects.toBeInstanceOf(TemplateVersionConflict);
		expect(storage.deleted).toHaveLength(0);
		expect(storage.uploads).toHaveLength(1);
		repository.inUse.add(template.id);
		expect(await service.remove(template.id, 'org-a', 'project-a')).toBe('in_use');
		expect(await service.remove(template.id, 'org-b', 'project-a')).toBe('not_found');
		repository.inUse.delete(template.id);
		expect(await service.remove('browser-ready@v1.2.3', 'org-a', 'project-a')).toBe('deleted');
		expect(await service.list('org-a', 'project-a')).toHaveLength(0);
	});
});

class MemoryApiKeys implements ApiKeyStore {
	readonly records = new Map<string, ApiKeyRecord>();
	async insert(record: ApiKeyRecord): Promise<void> {
		this.records.set(record.prefix, record);
	}
	async findByPrefix(prefix: string) {
		return this.records.get(prefix);
	}
	async isActive(id: string, organizationId: string): Promise<boolean> {
		return [...this.records.values()].some(
			(record) =>
				record.id === id &&
				record.organizationId === organizationId &&
				!record.disabledAt &&
				!record.organizationDisabledAt &&
				!record.revokedAt
		);
	}
	async list(): Promise<ReadonlyArray<ApiKeyRecord>> {
		return [...this.records.values()];
	}
	async setDisabled(): Promise<boolean> {
		return false;
	}
	async rotate(): Promise<boolean> {
		return false;
	}
	async revoke(): Promise<boolean> {
		return false;
	}
	async touch(): Promise<void> {}
}

describe('template metadata API', () => {
	it('publishes metadata and denies cross-project or caller-selected object metadata', async () => {
		const scopedProject = '11111111-1111-4111-8111-111111111111';
		const otherProject = '22222222-2222-4222-8222-222222222222';
		const keys = new ApiKeyService(new MemoryApiKeys(), 'test');
		const created = await keys.create({
			organizationId: 'org-a',
			projectId: scopedProject,
			name: 'template publisher',
			scopes: ['templates:read', 'templates:write']
		});
		const templates = new TemplateService(
			new MemoryTemplates(),
			new MemoryMachines([sourceMachine({ projectId: scopedProject })]),
			new FakeStorage(),
			new FakePublisher(),
			() => new Date(now)
		);
		const services: TemplateRouteServices = {
			apiKeys: keys,
			audit: {
				capture: async (_input: unknown, operation: () => Promise<unknown>) => operation()
			} as AuditService,
			organizations: {} as OrganizationService,
			templates
		};
		const router = new Router<TemplateRouteServices>();
		registerTemplateRoutes(router);
		const request = (body: unknown) =>
			new Request('http://test/v1/templates', {
				method: 'POST',
				headers: { authorization: `Bearer ${created.key}` },
				body: JSON.stringify(body)
			});

		const crossProject = await router.handle(
			request({
				project_id: otherProject,
				machine_id: sourceMachine().id,
				name: 'safe',
				version: 'v1'
			}),
			services
		);
		expect(crossProject.status).toBe(403);

		const injected = await router.handle(
			request({
				machine_id: sourceMachine().id,
				name: 'safe',
				version: 'v1',
				object_key: 'attacker/chosen',
				checksum: checksumA
			}),
			services
		);
		expect(injected.status).toBe(400);

		const response = await router.handle(
			request({ machine_id: sourceMachine().id, name: 'safe', version: 'v1' }),
			services
		);
		expect(response.status).toBe(201);
		expect(response.headers.get('location')).toMatch(/^\/v1\/templates\//);
		expect(await response.json()).toMatchObject({
			project_id: scopedProject,
			name: 'safe',
			version: 'v1',
			checksum: checksumA
		});

		const unavailableRepository = new MemoryTemplates();
		const unavailable = await router.handle(
			request({ machine_id: sourceMachine().id, name: 'safe', version: 'v2' }),
			{ ...services, templates: new TemplateService(unavailableRepository) }
		);
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({
			title: 'template_infrastructure_unavailable'
		});
		expect(unavailableRepository.templates.size).toBe(0);
	});
});

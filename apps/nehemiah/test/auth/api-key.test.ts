import { describe, expect, it, vi } from 'vitest';
import {
	ApiKeyAllocationUnavailable,
	ApiKeyPrefixCollision,
	ApiKeyService,
	apiKeyDummyHash,
	type ApiKeyMaterial,
	type ApiKeyRecord,
	type ApiKeyStore
} from '../../src/auth/api-key.js';

class MemoryStore implements ApiKeyStore {
	readonly records = new Map<string, ApiKeyRecord>();
	insertAttempts = 0;

	async insert(record: ApiKeyRecord): Promise<void> {
		this.insertAttempts += 1;
		if (this.records.has(record.prefix)) throw new ApiKeyPrefixCollision();
		this.records.set(record.prefix, record);
	}

	async findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined> {
		return this.records.get(prefix);
	}

	async isActive(id: string, organizationId: string): Promise<boolean> {
		const now = new Date();
		return [...this.records.values()].some(
			(record) =>
				record.id === id &&
				record.organizationId === organizationId &&
				!record.disabledAt &&
				!record.organizationDisabledAt &&
				!record.revokedAt &&
				(!record.expiresAt || record.expiresAt > now)
		);
	}

	async list(organizationId: string, projectId?: string) {
		return [...this.records.values()].filter(
			(record) =>
				record.organizationId === organizationId &&
				(projectId === undefined || record.projectId === projectId)
		);
	}

	async setDisabled(id: string, organizationId: string, disabled: boolean): Promise<boolean> {
		for (const [prefix, record] of this.records) {
			if (record.id === id && record.organizationId === organizationId && !record.revokedAt) {
				this.records.set(prefix, {
					...record,
					disabledAt: disabled ? new Date() : undefined
				});
				return true;
			}
		}
		return false;
	}

	async rotate(
		id: string,
		organizationId: string,
		replacement: Pick<ApiKeyRecord, 'id' | 'prefix' | 'keyHash'>
	): Promise<boolean> {
		if (this.records.has(replacement.prefix)) throw new ApiKeyPrefixCollision();
		for (const [prefix, record] of this.records) {
			if (
				record.id === id &&
				record.organizationId === organizationId &&
				!record.disabledAt &&
				!record.revokedAt
			) {
				this.records.set(prefix, { ...record, revokedAt: new Date() });
				this.records.set(replacement.prefix, {
					...record,
					...replacement,
					disabledAt: undefined,
					revokedAt: undefined
				});
				return true;
			}
		}
		return false;
	}

	async revoke(id: string, organizationId: string): Promise<boolean> {
		for (const [prefix, record] of this.records) {
			if (record.id === id && record.organizationId === organizationId && !record.revokedAt) {
				this.records.set(prefix, { ...record, revokedAt: new Date() });
				return true;
			}
		}
		return false;
	}

	async touch(): Promise<void> {}
}

const material = (publicId: string, character: string): ApiKeyMaterial => ({
	publicId,
	secret: character.repeat(43)
});

describe('API keys', () => {
	it('returns a bc_ secret once and persists only an Argon2id hash', async () => {
		const store = new MemoryStore();
		const service = new ApiKeyService(store, 'test');
		const projectId = '11111111-1111-4111-8111-111111111111';
		const created = await service.create({
			organizationId: 'org-1',
			projectId,
			name: 'CI',
			scopes: ['machines:read', 'machines:write']
		});
		const stored = store.records.get(created.prefix)!;

		expect(created.key).toMatch(/^bc_test_[a-f0-9]{12}_/);
		expect(stored.keyHash).toMatch(/^\$argon2id\$/);
		expect(JSON.stringify(stored)).not.toContain(created.key);
		expect(await service.authenticate(created.key)).toMatchObject({
			organizationId: 'org-1',
			projectId
		});
		expect(await service.authenticate(`${created.key}bad`)).toBeUndefined();
	});

	it('rejects malformed project and expiry values before hashing a key', async () => {
		const service = new ApiKeyService(new MemoryStore(), 'test');
		await expect(
			service.create({
				organizationId: 'org-1',
				projectId: 'not-a-uuid',
				name: 'invalid project',
				scopes: ['machines:read']
			})
		).rejects.toMatchObject({ code: 'invalid_api_key' });
		await expect(
			service.create({
				organizationId: 'org-1',
				name: 'expired',
				scopes: ['machines:read'],
				expiresAt: new Date(0)
			})
		).rejects.toMatchObject({ code: 'invalid_api_key' });
	});

	it('denies disabled and revoked keys and allows an explicitly enabled key again', async () => {
		const store = new MemoryStore();
		const service = new ApiKeyService(store, 'test');
		const created = await service.create({
			organizationId: 'org-1',
			name: 'old',
			scopes: ['machines:read']
		});
		expect(await service.disable(created.id, 'org-1')).toBe(true);
		expect(await service.authenticate(created.key)).toBeUndefined();
		expect(await service.enable(created.id, 'org-1')).toBe(true);
		expect(await service.authenticate(created.key)).toMatchObject({ apiKeyId: created.id });
		await service.revoke(created.id, 'org-1');
		expect(await service.authenticate(created.key)).toBeUndefined();
		expect(await service.enable(created.id, 'org-1')).toBe(false);
	});

	it('always invokes one calibrated verifier for unknown, revoked, expired, and live prefixes', async () => {
		const store = new MemoryStore();
		const now = new Date('2026-08-09T12:00:00.000Z');
		const raws = {
			live: `bc_test_111111111111_${'A'.repeat(43)}`,
			revoked: `bc_test_222222222222_${'B'.repeat(43)}`,
			expired: `bc_test_333333333333_${'C'.repeat(43)}`,
			unknown: `bc_test_444444444444_${'D'.repeat(43)}`
		};
		for (const [index, kind] of ['live', 'revoked', 'expired'].entries()) {
			const raw = raws[kind as keyof typeof raws];
			const prefix = raw.slice(0, raw.lastIndexOf('_'));
			store.records.set(prefix, {
				id: `00000000-0000-4000-8000-00000000000${index + 1}`,
				organizationId: 'org-1',
				name: kind,
				prefix,
				keyHash: `hash:${raw}`,
				scopes: ['machines:read'],
				...(kind === 'revoked' ? { revokedAt: now } : {}),
				...(kind === 'expired' ? { expiresAt: new Date(now.getTime() - 1) } : {})
			});
		}
		const verifier = vi.fn(async (encoded: string, raw: string) => encoded === `hash:${raw}`);
		const service = new ApiKeyService(store, 'test', {
			verifySecret: verifier,
			now: () => now
		});

		expect(await service.authenticate(raws.live)).toMatchObject({ organizationId: 'org-1' });
		expect(await service.authenticate(raws.revoked)).toBeUndefined();
		expect(await service.authenticate(raws.expired)).toBeUndefined();
		expect(await service.authenticate(raws.unknown)).toBeUndefined();
		expect(verifier).toHaveBeenCalledTimes(4);
		expect(verifier.mock.calls.map(([encoded]) => encoded)).toEqual([
			`hash:${raws.live}`,
			`hash:${raws.revoked}`,
			`hash:${raws.expired}`,
			apiKeyDummyHash
		]);
	});

	it('bounds concurrent Argon verification without queueing unbounded work', async () => {
		const store = new MemoryStore();
		const raw = `bc_test_555555555555_${'E'.repeat(43)}`;
		const prefix = raw.slice(0, raw.lastIndexOf('_'));
		store.records.set(prefix, {
			id: '00000000-0000-4000-8000-000000000005',
			organizationId: 'org-1',
			name: 'bounded verifier',
			prefix,
			keyHash: 'hash:bounded',
			scopes: ['machines:read']
		});
		let release!: () => void;
		const verifier = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					release = () => resolve(true);
				})
		);
		const service = new ApiKeyService(store, 'test', {
			verifySecret: verifier,
			maxConcurrentVerifications: 1,
			maxQueuedVerifications: 0
		});
		const first = service.authenticate(raw);
		await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
		await expect(service.authenticate(raw)).rejects.toMatchObject({
			code: 'api_key_verifier_busy'
		});
		expect(verifier).toHaveBeenCalledOnce();
		release();
		await expect(first).resolves.toMatchObject({
			apiKeyId: '00000000-0000-4000-8000-000000000005'
		});
	});

	it('bounds API-key creation hashing before any durable insert', async () => {
		const store = new MemoryStore();
		let release!: () => void;
		const hashSecret = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve('$argon2id$bounded-hash');
				})
		);
		const service = new ApiKeyService(store, 'test', {
			hashSecret,
			maxConcurrentHashes: 1,
			maxQueuedHashes: 0
		});
		const first = service.create({
			organizationId: 'org-1',
			name: 'first bounded hash',
			scopes: ['machines:read']
		});
		await vi.waitFor(() => expect(hashSecret).toHaveBeenCalledOnce());

		await expect(
			service.create({
				organizationId: 'org-1',
				name: 'overflow hash',
				scopes: ['machines:read']
			})
		).rejects.toMatchObject({ code: 'api_key_hasher_busy' });
		expect(hashSecret).toHaveBeenCalledOnce();
		expect(store.insertAttempts).toBe(0);

		release();
		await expect(first).resolves.toMatchObject({ prefix: expect.stringMatching(/^bc_test_/) });
		expect(store.insertAttempts).toBe(1);
	});

	it('bounds rotation hashing without revoking the original key on overflow', async () => {
		const store = new MemoryStore();
		const original = await new ApiKeyService(store, 'test').create({
			organizationId: 'org-1',
			name: 'rotation source',
			scopes: ['machines:read']
		});
		let release!: () => void;
		const hashSecret = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve('$argon2id$bounded-rotation');
				})
		);
		const service = new ApiKeyService(store, 'test', {
			hashSecret,
			maxConcurrentHashes: 1,
			maxQueuedHashes: 0
		});
		const first = service.rotate(original.id, 'org-1');
		await vi.waitFor(() => expect(hashSecret).toHaveBeenCalledOnce());

		await expect(service.rotate(original.id, 'org-1')).rejects.toMatchObject({
			code: 'api_key_hasher_busy'
		});
		expect((await store.findByPrefix(original.prefix))?.revokedAt).toBeUndefined();

		release();
		await expect(first).resolves.toMatchObject({ prefix: expect.stringMatching(/^bc_test_/) });
		expect((await store.findByPrefix(original.prefix))?.revokedAt).toBeInstanceOf(Date);
	});

	it('retries only bounded prefix collisions and fails closed after five attempts', async () => {
		const store = new MemoryStore();
		store.records.set('bc_test_aaaaaaaaaaaa', {
			id: '00000000-0000-4000-8000-000000000001',
			organizationId: 'org-1',
			name: 'collision',
			prefix: 'bc_test_aaaaaaaaaaaa',
			keyHash: 'hash',
			scopes: ['machines:read']
		});
		const values = [material('aaaaaaaaaaaa', 'A'), material('bbbbbbbbbbbb', 'B')];
		const service = new ApiKeyService(store, 'test', {
			material: () => values.shift()!,
			hashSecret: async (raw) => `hash:${raw}`
		});
		const created = await service.create({
			organizationId: 'org-1',
			name: 'retry',
			scopes: ['machines:read']
		});
		expect(created.prefix).toBe('bc_test_bbbbbbbbbbbb');
		expect(store.insertAttempts).toBe(2);

		const exhaustedStore = new MemoryStore();
		exhaustedStore.records.set('bc_test_cccccccccccc', {
			id: '00000000-0000-4000-8000-000000000002',
			organizationId: 'org-1',
			name: 'collision',
			prefix: 'bc_test_cccccccccccc',
			keyHash: 'hash',
			scopes: ['machines:read']
		});
		const exhausted = new ApiKeyService(exhaustedStore, 'test', {
			material: () => material('cccccccccccc', 'C'),
			hashSecret: async () => 'hash'
		});
		await expect(
			exhausted.create({
				organizationId: 'org-1',
				name: 'exhausted',
				scopes: ['machines:read']
			})
		).rejects.toBeInstanceOf(ApiKeyAllocationUnavailable);
		expect(exhaustedStore.insertAttempts).toBe(5);
	});

	it('rotates to a one-time replacement while making the old key terminal', async () => {
		const store = new MemoryStore();
		const values = [material('aaaaaaaaaaaa', 'A'), material('bbbbbbbbbbbb', 'B')];
		const service = new ApiKeyService(store, 'test', {
			material: () => values.shift()!,
			hashSecret: async (raw) => `hash:${raw}`,
			verifySecret: async (encoded, raw) => encoded === `hash:${raw}`
		});
		const original = await service.create({
			organizationId: 'org-1',
			name: 'rotate',
			scopes: ['machines:read']
		});
		const replacement = await service.rotate(original.id, 'org-1');
		expect(replacement).toMatchObject({ prefix: 'bc_test_bbbbbbbbbbbb' });
		expect(replacement?.key).not.toBe(original.key);
		expect(await service.authenticate(original.key)).toBeUndefined();
		expect(await service.authenticate(replacement!.key)).toMatchObject({
			apiKeyId: replacement!.id
		});
	});
});

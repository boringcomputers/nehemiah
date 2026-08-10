import { describe, expect, it, vi } from 'vitest';
import { durableOperation, type StorageLike } from './durable-operation';

class MemoryStorage implements StorageLike {
	value: string | null = null;
	getItem(): string | null {
		return this.value;
	}
	setItem(_key: string, value: string): void {
		this.value = value;
	}
}

describe('durableOperation', () => {
	it('reuses one key for the same canonical operation until completion', () => {
		const storage = new MemoryStorage();
		const keys = vi.fn(() => 'stable-operation-key');
		const first = durableOperation(
			storage,
			'machine:create:project',
			{ ttl: 60, size: 1 },
			keys,
			1
		);
		const retry = durableOperation(
			storage,
			'machine:create:project',
			{ size: 1, ttl: 60 },
			keys,
			2
		);
		expect(retry.idempotencyKey).toBe(first.idempotencyKey);
		expect(keys).toHaveBeenCalledTimes(1);

		first.complete();
		keys.mockReturnValue('next-operation-key');
		expect(
			durableOperation(storage, 'machine:create:project', { ttl: 60, size: 1 }, keys, 3)
				.idempotencyKey
		).toBe('next-operation-key');
	});

	it('does not overwrite an ambiguous operation when the payload changes', () => {
		const storage = new MemoryStorage();
		const keys = vi.fn().mockReturnValueOnce('first-key').mockReturnValueOnce('second-key');
		expect(durableOperation(storage, 'fork:m1', { count: 1 }, keys, 1).idempotencyKey).toBe(
			'first-key'
		);
		expect(durableOperation(storage, 'fork:m1', { count: 2 }, keys, 2).idempotencyKey).toBe(
			'second-key'
		);
		expect(durableOperation(storage, 'fork:m1', { count: 1 }, keys, 3).idempotencyKey).toBe(
			'first-key'
		);
	});

	it('rejects poisoned persisted keys instead of putting them in a header', () => {
		const storage = new MemoryStorage();
		storage.value = JSON.stringify([
			{ scope: 'create', payload: '{}', idempotencyKey: 'bad\r\nheader', createdAt: 1 }
		]);
		expect(durableOperation(storage, 'create', {}, () => 'safe-key', 2).idempotencyKey).toBe(
			'safe-key'
		);
	});

	it('fails before a request when a new recovery key cannot be persisted', () => {
		const storage: StorageLike = {
			getItem: () => null,
			setItem: () => {
				throw new Error('storage disabled');
			}
		};
		expect(() => durableOperation(storage, 'create', {}, () => 'safe-key', 2)).toThrow(
			'request was not sent'
		);
	});
});

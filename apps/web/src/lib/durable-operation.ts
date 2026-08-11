const storageKey = 'nehemiah.pending-idempotency.v1';
const maximumRecords = 128;
const maximumAgeMs = 7 * 24 * 60 * 60 * 1_000;
const validKey = /^[A-Za-z0-9._:-]{1,200}$/;

interface StoredOperation {
	readonly scope: string;
	readonly payload: string;
	readonly idempotencyKey: string;
	readonly createdAt: number;
}

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const canonical = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
		.join(',')}}`;
};

const read = (storage: StorageLike, now: number): StoredOperation[] => {
	try {
		const decoded = JSON.parse(storage.getItem(storageKey) ?? '[]') as unknown;
		if (!Array.isArray(decoded)) return [];
		return decoded
			.filter(
				(value): value is StoredOperation =>
					typeof value === 'object' &&
					value !== null &&
					typeof (value as StoredOperation).scope === 'string' &&
					typeof (value as StoredOperation).payload === 'string' &&
					validKey.test((value as StoredOperation).idempotencyKey) &&
					Number.isSafeInteger((value as StoredOperation).createdAt) &&
					(value as StoredOperation).createdAt <= now &&
					now - (value as StoredOperation).createdAt <= maximumAgeMs
			)
			.slice(-maximumRecords);
	} catch {
		return [];
	}
};

const write = (storage: StorageLike, records: ReadonlyArray<StoredOperation>): boolean => {
	try {
		storage.setItem(storageKey, JSON.stringify(records.slice(-maximumRecords)));
		return true;
	} catch {
		return false;
	}
};

export const durableOperation = (
	storage: StorageLike,
	scope: string,
	payload: unknown,
	keyFactory: () => string = () => crypto.randomUUID(),
	now = Date.now()
): { readonly idempotencyKey: string; readonly complete: () => void } => {
	if (!scope || scope.length > 512) throw new Error('operation scope is invalid');
	const encodedPayload = canonical(payload);
	if (encodedPayload.length > 16_384) throw new Error('operation payload is too large');
	const records = read(storage, now);
	let record = records.find(
		(candidate) => candidate.scope === scope && candidate.payload === encodedPayload
	);
	if (!record) {
		const idempotencyKey = keyFactory();
		if (!validKey.test(idempotencyKey)) throw new Error('generated idempotency key is invalid');
		record = { scope, payload: encodedPayload, idempotencyKey, createdAt: now };
		records.push(record);
		if (!write(storage, records)) {
			throw new Error('Durable operation storage is unavailable; the request was not sent.');
		}
	}
	return {
		idempotencyKey: record.idempotencyKey,
		complete: () =>
			write(
				storage,
				read(storage, Date.now()).filter(
					(candidate) =>
						candidate.scope !== scope ||
						candidate.payload !== encodedPayload ||
						candidate.idempotencyKey !== record.idempotencyKey
				)
			)
	};
};

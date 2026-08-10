import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/client.js';

const decodeKey = (encoded: string): Buffer => {
	const key = Buffer.from(encoded, 'base64');
	if (key.length !== 32) {
		throw new Error('NEHEMIAH_HOST_CREDENTIAL_KEY must be a base64-encoded 32-byte key');
	}
	return key;
};

/** Envelope for per-host inbound credentials; the database never stores plaintext. */
export class HostCredentialCipher {
	readonly #key: Buffer;

	constructor(encodedKey: string) {
		this.#key = decodeKey(encodedKey);
	}

	encrypt(value: string): string {
		if (value.length < 32) throw new Error('host tokens must contain at least 32 characters');
		const nonce = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
		const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		return [
			'v1',
			nonce.toString('base64url'),
			ciphertext.toString('base64url'),
			cipher.getAuthTag().toString('base64url')
		].join('.');
	}

	decrypt(envelope: string): string {
		const [version, nonceText, ciphertextText, tagText, extra] = envelope.split('.');
		if (version !== 'v1' || !nonceText || !ciphertextText || !tagText || extra !== undefined) {
			throw new Error('invalid host credential envelope');
		}
		const decipher = createDecipheriv(
			'aes-256-gcm',
			this.#key,
			Buffer.from(nonceText, 'base64url')
		);
		decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(ciphertextText, 'base64url')),
			decipher.final()
		]).toString('utf8');
	}
}

export interface HostCredentialResolver {
	resolve(address: string): Promise<string>;
}

export class PostgresHostCredentialResolver implements HostCredentialResolver {
	constructor(
		private readonly database: Queryable,
		private readonly cipher: HostCredentialCipher
	) {}

	async resolve(address: string): Promise<string> {
		const result = await this.database.query<{ control_credential_ciphertext: string | null }>(
			`SELECT control_credential_ciphertext FROM hosts
			 WHERE address = $1::inet AND state <> 'stale'
			   AND desired_state IN ('active', 'draining')
			   AND credential_status = 'active'`,
			[address]
		);
		const envelope = result.rows[0]?.control_credential_ciphertext;
		if (!envelope) throw new Error('no active credential exists for the host address');
		return this.cipher.decrypt(envelope);
	}
}

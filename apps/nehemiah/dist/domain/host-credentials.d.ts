import type { Queryable } from '../db/client.js';
/** Envelope for per-host inbound credentials; the database never stores plaintext. */
export declare class HostCredentialCipher {
    #private;
    constructor(encodedKey: string);
    encrypt(value: string): string;
    decrypt(envelope: string): string;
}
export interface HostCredentialResolver {
    resolve(address: string): Promise<string>;
}
export declare class PostgresHostCredentialResolver implements HostCredentialResolver {
    private readonly database;
    private readonly cipher;
    constructor(database: Queryable, cipher: HostCredentialCipher);
    resolve(address: string): Promise<string>;
}

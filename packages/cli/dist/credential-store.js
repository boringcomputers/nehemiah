import { canonicalCredentialOrigin } from './config.js';
export class CredentialStoreUnavailable extends Error {
    code = 'credential_store_unavailable';
    constructor() {
        super('The operating-system credential store is unavailable. Unlock or install a platform keychain, then retry; for automation, configure NEHEMIAH_API_KEY or run `bc config set-key`.');
    }
}
const service = 'com.boringcomputers.nehemiah.cli';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refreshPattern = /^bc_refresh_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/i;
const accessPattern = /^bc_access_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/i;
const scopePattern = /^[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;
const maximumSecretBytes = 8_192;
const maximumExpiryMs = 4_102_444_800_000;
const sessionKeys = new Set([
    'version',
    'account',
    'origin',
    'refreshToken',
    'refreshExpiresAt',
    'accessToken',
    'accessExpiresAt',
    'organizationId',
    'projectId',
    'scopes'
]);
/** Strictly decodes only the bounded secret formats stored by released CLI versions. */
export function decodeDeviceCredential(secret) {
    if (refreshPattern.test(secret))
        return { kind: 'legacy', refreshToken: secret };
    if (Buffer.byteLength(secret, 'utf8') > maximumSecretBytes)
        return undefined;
    let value;
    try {
        value = JSON.parse(secret);
    }
    catch {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const keys = Object.keys(record);
    if (keys.length !== sessionKeys.size || keys.some((key) => !sessionKeys.has(key))) {
        return undefined;
    }
    const scopes = record.scopes;
    const origin = typeof record.origin === 'string' ? canonicalCredentialOrigin(record.origin) : undefined;
    if (record.version !== 1 ||
        typeof record.account !== 'string' ||
        !uuidPattern.test(record.account) ||
        origin === undefined ||
        origin !== record.origin ||
        typeof record.refreshToken !== 'string' ||
        !refreshPattern.test(record.refreshToken) ||
        typeof record.accessToken !== 'string' ||
        !accessPattern.test(record.accessToken) ||
        !validExpiry(record.refreshExpiresAt) ||
        !validExpiry(record.accessExpiresAt) ||
        typeof record.organizationId !== 'string' ||
        !uuidPattern.test(record.organizationId) ||
        typeof record.projectId !== 'string' ||
        !uuidPattern.test(record.projectId) ||
        !Array.isArray(scopes) ||
        scopes.length < 1 ||
        scopes.length > 16 ||
        scopes.some((scope) => typeof scope !== 'string' || !scopePattern.test(scope)) ||
        new Set(scopes).size !== scopes.length) {
        return undefined;
    }
    return { kind: 'session', session: record };
}
export function encodeDeviceSession(session) {
    const encoded = JSON.stringify(session);
    const decoded = decodeDeviceCredential(encoded);
    if (decoded?.kind !== 'session')
        throw new CredentialStoreUnavailable();
    return encoded;
}
function validExpiry(value) {
    return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximumExpiryMs;
}
/**
 * Stores the bounded access/refresh session in Keychain, Credential Manager, or
 * Secret Service through the maintained napi-rs keyring binding. No plaintext
 * fallback exists.
 */
export class SystemCredentialStore {
    async #entry(account) {
        if (!uuidPattern.test(account))
            throw new CredentialStoreUnavailable();
        try {
            const { AsyncEntry } = await import('@napi-rs/keyring');
            return new AsyncEntry(service, account);
        }
        catch {
            throw new CredentialStoreUnavailable();
        }
    }
    async get(account) {
        try {
            return (await (await this.#entry(account)).getPassword()) || undefined;
        }
        catch {
            throw new CredentialStoreUnavailable();
        }
    }
    async set(account, secret) {
        const decoded = decodeDeviceCredential(secret);
        if (decoded === undefined ||
            (decoded.kind === 'session' && decoded.session.account !== account)) {
            throw new CredentialStoreUnavailable();
        }
        try {
            await (await this.#entry(account)).setPassword(secret);
        }
        catch {
            throw new CredentialStoreUnavailable();
        }
    }
    async delete(account) {
        try {
            await (await this.#entry(account)).deletePassword();
        }
        catch (error) {
            // A missing/locked backend is indistinguishable in several platform
            // implementations, so never pretend local logout succeeded.
            if (error)
                throw new CredentialStoreUnavailable();
        }
    }
}
//# sourceMappingURL=credential-store.js.map
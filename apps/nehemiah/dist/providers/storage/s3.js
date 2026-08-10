import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const maximumGrantTtlSeconds = 15 * 60;
const maximumTemplateBytes = 1_099_511_627_776;
const maximumSinglePutBytes = 5 * 1_024 * 1_024 * 1_024;
const templateChecksum = /^sha256:[0-9a-f]{64}$/;
const templateObjectKey = /^organizations\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/templates\/[a-z0-9][a-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/snapshot\.tar\.zst$/;
export class S3ObjectStoreContractError extends Error {
}
const validatedEndpoint = (value) => {
    let endpoint;
    try {
        endpoint = new URL(value);
    }
    catch {
        throw new S3ObjectStoreContractError('S3 endpoint must be an origin-only HTTPS URL.');
    }
    if (endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== '/' ||
        endpoint.search ||
        endpoint.hash) {
        throw new S3ObjectStoreContractError('S3 endpoint must be an origin-only HTTPS URL.');
    }
    return endpoint;
};
const validateConfig = (config) => {
    const endpoint = validatedEndpoint(config.endpoint);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(config.region)) {
        throw new S3ObjectStoreContractError('S3 region is invalid.');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
        config.bucket.includes('..') ||
        config.bucket.includes('.-') ||
        config.bucket.includes('-.') ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(config.bucket)) {
        throw new S3ObjectStoreContractError('S3 bucket is invalid.');
    }
    if (!config.accessKeyId ||
        config.accessKeyId.length > 256 ||
        /\s|[\u0000-\u001f\u007f]/.test(config.accessKeyId) ||
        config.secretAccessKey.length < 8 ||
        config.secretAccessKey.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(config.secretAccessKey) ||
        (config.sessionToken !== undefined &&
            (!config.sessionToken ||
                config.sessionToken.length > 4_096 ||
                /[\u0000-\u001f\u007f]/.test(config.sessionToken)))) {
        throw new S3ObjectStoreContractError('S3 credentials are invalid.');
    }
    return endpoint;
};
const validateObjectKey = (objectKey) => {
    if (!templateObjectKey.test(objectKey) || Buffer.byteLength(objectKey, 'utf8') > 1_024) {
        throw new S3ObjectStoreContractError('Template object key is outside the managed namespace.');
    }
};
const sha256Hex = (encoded) => {
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
        throw new S3ObjectStoreContractError('Stored template is missing a full SHA-256 checksum.');
    }
    const digest = Buffer.from(encoded, 'base64');
    if (digest.byteLength !== 32 || digest.toString('base64') !== encoded) {
        throw new S3ObjectStoreContractError('Stored template has an invalid SHA-256 checksum.');
    }
    return digest.toString('hex');
};
const isNotFound = (error) => typeof error === 'object' &&
    error !== null &&
    (('name' in error && ['NotFound', 'NoSuchKey'].includes(String(error.name))) ||
        ('$metadata' in error &&
            typeof error.$metadata === 'object' &&
            error.$metadata !== null &&
            'httpStatusCode' in error.$metadata &&
            error.$metadata.httpStatusCode === 404));
/** Exact-object storage for immutable template exports. Upload capabilities
 * are issued only after the host computes the archive digest and size, so
 * SigV4 binds both values as well as encryption and create-only semantics. */
export class S3TemplateObjectStore {
    #endpoint;
    #bucket;
    #accessKeyId;
    #now;
    #send;
    #presign;
    constructor(config, dependencies = {}) {
        this.#endpoint = validateConfig(config);
        this.#bucket = config.bucket;
        this.#accessKeyId = config.accessKeyId;
        this.#now = dependencies.now ?? (() => new Date());
        const client = new S3Client({
            endpoint: this.#endpoint.origin,
            region: config.region,
            forcePathStyle: config.forcePathStyle ?? false,
            // The host computes a full-object checksum before this client presigns
            // the corresponding immutable PUT.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken })
            }
        });
        this.#send = dependencies.send ?? ((command) => client.send(command));
        this.#presign =
            dependencies.presign ?? ((command, options) => getSignedUrl(client, command, options));
    }
    createUploadGrant(objectKey, artifact, expiresAt) {
        if (!templateChecksum.test(artifact.checksum) ||
            !Number.isSafeInteger(artifact.sizeBytes) ||
            artifact.sizeBytes < 1 ||
            artifact.sizeBytes > maximumSinglePutBytes) {
            throw new S3ObjectStoreContractError('Template upload checksum or single-PUT size is invalid.');
        }
        return this.#grant('PUT', objectKey, expiresAt, artifact);
    }
    createDownloadGrant(objectKey, expiresAt) {
        return this.#grant('GET', objectKey, expiresAt);
    }
    async stat(objectKey) {
        validateObjectKey(objectKey);
        const result = (await this.#send(new HeadObjectCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            ChecksumMode: 'ENABLED'
        })));
        if (!Number.isSafeInteger(result.ContentLength) ||
            (result.ContentLength ?? 0) <= 0 ||
            result.ContentLength > maximumTemplateBytes ||
            (result.ChecksumType !== undefined && result.ChecksumType !== 'FULL_OBJECT') ||
            result.ServerSideEncryption !== 'AES256') {
            throw new S3ObjectStoreContractError('Stored template has invalid size, checksum type, or encryption metadata.');
        }
        return {
            checksum: `sha256:${sha256Hex(result.ChecksumSHA256)}`,
            sizeBytes: result.ContentLength
        };
    }
    async delete(objectKey) {
        validateObjectKey(objectKey);
        let versionId;
        try {
            const current = (await this.#send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey })));
            versionId = current.VersionId;
        }
        catch (error) {
            if (isNotFound(error))
                return;
            throw error;
        }
        if (versionId !== undefined &&
            (!versionId || versionId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(versionId))) {
            throw new S3ObjectStoreContractError('S3 returned an invalid object version identifier.');
        }
        await this.#send(new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            ...(versionId === undefined ? {} : { VersionId: versionId })
        }));
    }
    async #grant(method, objectKey, requestedExpiresAt, artifact) {
        validateObjectKey(objectKey);
        const now = this.#now();
        if (!Number.isFinite(now.getTime()) || !Number.isFinite(requestedExpiresAt.getTime())) {
            throw new S3ObjectStoreContractError('S3 grant expiry is invalid.');
        }
        const signingDate = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
        const expiresIn = Math.floor((requestedExpiresAt.getTime() - signingDate.getTime()) / 1_000);
        const effectiveExpiresAt = new Date(signingDate.getTime() + expiresIn * 1_000);
        if (expiresIn < 1 ||
            expiresIn > maximumGrantTtlSeconds ||
            effectiveExpiresAt <= now ||
            effectiveExpiresAt > requestedExpiresAt) {
            throw new S3ObjectStoreContractError('S3 grant expiry must be between 1 and 900 seconds.');
        }
        if (method === 'PUT' && artifact === undefined) {
            throw new S3ObjectStoreContractError('Template PUT grants require a checksum and size.');
        }
        const command = method === 'PUT'
            ? new PutObjectCommand({
                Bucket: this.#bucket,
                Key: objectKey,
                ServerSideEncryption: 'AES256',
                IfNoneMatch: '*',
                ...(artifact === undefined
                    ? {}
                    : {
                        ContentLength: artifact.sizeBytes,
                        ChecksumAlgorithm: 'SHA256',
                        ChecksumSHA256: Buffer.from(artifact.checksum.slice('sha256:'.length), 'hex').toString('base64')
                    })
            })
            : new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey });
        const url = await this.#presign(command, { expiresIn, signingDate });
        this.#validateSignedUrl(url, objectKey, expiresIn, method, artifact);
        return {
            method,
            url,
            headers: method === 'PUT'
                ? {
                    'x-amz-server-side-encryption': 'AES256',
                    'if-none-match': '*',
                    ...(artifact === undefined ? {} : { 'content-length': String(artifact.sizeBytes) })
                }
                : undefined,
            expiresAt: effectiveExpiresAt
        };
    }
    #validateSignedUrl(value, objectKey, expiresIn, method, artifact) {
        let url;
        try {
            url = new URL(value);
        }
        catch {
            throw new S3ObjectStoreContractError('S3 presigner returned an invalid URL.');
        }
        const virtualHost = `${this.#bucket}.${this.#endpoint.hostname}`;
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(url.pathname);
        }
        catch {
            throw new S3ObjectStoreContractError('S3 presigner returned an invalid object path.');
        }
        const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
        const exactObjectScope = (url.hostname === virtualHost && decodedPath === `/${objectKey}`) ||
            (url.hostname === this.#endpoint.hostname && decodedPath === `/${this.#bucket}/${objectKey}`);
        const credential = url.searchParams.get('X-Amz-Credential');
        const expectedChecksum = artifact === undefined
            ? undefined
            : Buffer.from(artifact.checksum.slice('sha256:'.length), 'hex').toString('base64');
        const queryNames = [...url.searchParams.keys()];
        const allowedQueryNames = new Set([
            'X-Amz-Algorithm',
            'X-Amz-Content-Sha256',
            'X-Amz-Credential',
            'X-Amz-Date',
            'X-Amz-Expires',
            'X-Amz-Security-Token',
            'X-Amz-Signature',
            'X-Amz-SignedHeaders',
            'x-amz-checksum-sha256',
            'x-amz-sdk-checksum-algorithm',
            'x-id'
        ]);
        if (url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            url.port !== this.#endpoint.port ||
            !exactObjectScope ||
            new Set(queryNames).size !== queryNames.length ||
            !queryNames.every((name) => allowedQueryNames.has(name)) ||
            url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
            url.searchParams.get('X-Amz-Content-Sha256') !== 'UNSIGNED-PAYLOAD' ||
            !/^[0-9]{8}T[0-9]{6}Z$/.test(url.searchParams.get('X-Amz-Date') ?? '') ||
            url.searchParams.get('X-Amz-Expires') !== String(expiresIn) ||
            url.searchParams.get('x-id') !== (method === 'PUT' ? 'PutObject' : 'GetObject') ||
            !credential?.startsWith(`${this.#accessKeyId}/`) ||
            !url.searchParams.get('X-Amz-Signature') ||
            !signedHeaders.includes('host') ||
            (method === 'PUT' &&
                (!signedHeaders.includes('if-none-match') ||
                    !signedHeaders.includes('x-amz-server-side-encryption'))) ||
            (method === 'PUT' &&
                artifact === undefined &&
                (url.searchParams.has('x-amz-sdk-checksum-algorithm') ||
                    [...url.searchParams.keys()].some((name) => name.startsWith('x-amz-checksum-')))) ||
            (method === 'PUT' &&
                artifact !== undefined &&
                (!signedHeaders.includes('content-length') ||
                    url.searchParams.get('x-amz-sdk-checksum-algorithm') !== 'SHA256' ||
                    url.searchParams.get('x-amz-checksum-sha256') !== expectedChecksum))) {
            throw new S3ObjectStoreContractError('S3 presigner returned a capability outside the requested object scope.');
        }
    }
}
//# sourceMappingURL=s3.js.map
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ScopedObjectGrant, TemplateObjectStore } from '../../domain/templates.js';
export interface S3TemplateObjectStoreConfig {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
    readonly forcePathStyle?: boolean;
}
type DataCommand = HeadObjectCommand | DeleteObjectCommand;
type GrantCommand = GetObjectCommand | PutObjectCommand;
interface PresignOptions {
    readonly expiresIn: number;
    readonly signingDate: Date;
}
export interface S3TemplateObjectStoreDependencies {
    readonly now?: () => Date;
    readonly send?: (command: DataCommand) => Promise<unknown>;
    readonly presign?: (command: GrantCommand, options: PresignOptions) => Promise<string>;
}
export declare class S3ObjectStoreContractError extends Error {
}
/** Exact-object storage for immutable template exports. Upload capabilities
 * are issued only after the host computes the archive digest and size, so
 * SigV4 binds both values as well as encryption and create-only semantics. */
export declare class S3TemplateObjectStore implements TemplateObjectStore {
    #private;
    constructor(config: S3TemplateObjectStoreConfig, dependencies?: S3TemplateObjectStoreDependencies);
    createUploadGrant(objectKey: string, artifact: {
        readonly checksum: string;
        readonly sizeBytes: number;
    }, expiresAt: Date): Promise<ScopedObjectGrant>;
    createDownloadGrant(objectKey: string, expiresAt: Date): Promise<ScopedObjectGrant>;
    stat(objectKey: string): Promise<{
        readonly checksum: string;
        readonly sizeBytes: number;
    }>;
    delete(objectKey: string): Promise<void>;
}
export {};

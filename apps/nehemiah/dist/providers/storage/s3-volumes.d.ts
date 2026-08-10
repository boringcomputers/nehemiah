import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { VolumeObjectGrant, VolumeObjectStore, VolumeGrantMethod } from '../../domain/volumes.js';
export interface S3VolumeObjectStoreConfig {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
    readonly forcePathStyle?: boolean;
    readonly brokerPublicUrl: string;
    /** A base64-encoded 32-byte HS256 key, separate from every storage credential. */
    readonly brokerSecret: string;
}
type StorageCommand = DeleteObjectCommand | DeleteObjectsCommand | GetObjectCommand | HeadObjectCommand | ListObjectVersionsCommand | ListObjectsV2Command | PutObjectCommand;
export interface S3VolumeObjectStoreDependencies {
    readonly now?: () => Date;
    readonly send?: (command: StorageCommand, options?: {
        readonly abortSignal?: AbortSignal;
    }) => Promise<unknown>;
}
export declare class S3VolumeObjectStoreContractError extends Error {
}
/**
 * Bounded, exact-key volume transport.
 *
 * The public capability reaches this broker, never S3. The broker keeps the
 * master storage principal private, verifies an HS256 header capability, and
 * streams one immutable revision into an exact reservation-derived key while
 * binding Content-Length, SHA-256 and SSE-S3 on the internal PutObject request.
 */
export declare class S3VolumeObjectStore implements VolumeObjectStore {
    #private;
    readonly deletionMode: "at-retention-boundary";
    readonly reservationSettlementSeconds = 60;
    constructor(config: S3VolumeObjectStoreConfig, dependencies?: S3VolumeObjectStoreDependencies);
    inspect(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
    }): Promise<{
        readonly observedSizeBytes: number;
    }>;
    issueGrant(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
        readonly method: VolumeGrantMethod;
        readonly capabilityExpiresAt?: Date;
        readonly expiresAt: Date;
        readonly maximumBytes?: number;
        readonly requireEncryptionAtRest: true;
        readonly reservationId?: string;
    }): Promise<VolumeObjectGrant>;
    scheduleDeletion(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
        readonly deleteAfter: Date;
    }): Promise<void>;
    matchesRequest(request: IncomingMessage): boolean;
    handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
}
export {};

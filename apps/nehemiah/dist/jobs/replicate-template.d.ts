import type { Queryable } from '../db/client.js';
import { type ScopedObjectGrant, type TemplateManifest, type TemplateObjectStore } from '../domain/templates.js';
export interface TemplateReplicaWork {
    readonly templateId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly name: string;
    readonly version: string;
    readonly hostId: string;
    readonly hostAddress: string;
    readonly hostTemplateName: string;
    readonly objectKey: string;
    readonly checksum: string;
    readonly sizeBytes: number;
    readonly manifest: TemplateManifest;
}
export interface TemplateReplicaRepository {
    enqueueMissing(): Promise<number>;
    claim(): Promise<TemplateReplicaWork | undefined>;
    markReady(templateId: string, hostId: string, verifiedChecksum: string): Promise<boolean>;
    markFailed(templateId: string, hostId: string, reason: string): Promise<void>;
}
/** Narrow activation boundary. Implementations download only from the scoped
 * grant, atomically install under hostTemplateName, and compute the checksum
 * from the installed artifact before returning. */
export interface TemplateActivator {
    activate(input: {
        readonly address: string;
        readonly hostTemplateName: string;
        readonly architecture: 'x86_64' | 'aarch64';
        readonly checksum: string;
        readonly sizeBytes: number;
        readonly download: ScopedObjectGrant;
    }): Promise<{
        readonly checksum: string;
        readonly sizeBytes: number;
    }>;
}
export declare class PostgresTemplateReplicaRepository implements TemplateReplicaRepository {
    private readonly database;
    constructor(database: Queryable);
    enqueueMissing(): Promise<number>;
    claim(): Promise<TemplateReplicaWork | undefined>;
    markReady(templateId: string, hostId: string, verifiedChecksum: string): Promise<boolean>;
    markFailed(templateId: string, hostId: string, reason: string): Promise<void>;
}
export type ReplicationRunResult = {
    readonly state: 'idle';
    readonly enqueued: number;
} | {
    readonly state: 'ready' | 'failed';
    readonly enqueued: number;
    readonly templateId: string;
    readonly hostId: string;
};
export declare class TemplateReplicationJob {
    private readonly repository;
    private readonly storage?;
    private readonly activator?;
    private readonly now;
    constructor(repository: TemplateReplicaRepository, storage?: TemplateObjectStore | undefined, activator?: TemplateActivator | undefined, now?: () => Date);
    runOnce(): Promise<ReplicationRunResult>;
}

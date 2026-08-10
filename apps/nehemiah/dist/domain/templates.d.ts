import type { PoolClient } from 'pg';
import type { Queryable } from '../db/client.js';
export interface TemplateDatabase extends Queryable {
    transaction<A>(operation: (client: PoolClient) => Promise<A>): Promise<A>;
}
export type TemplateArchitecture = 'x86_64' | 'aarch64';
export interface TemplateManifest {
    readonly schema_version: 1;
    readonly format: 'firecracker-snapshot-v1';
    readonly architecture: TemplateArchitecture;
    readonly source: {
        readonly machine_id: string;
    };
    readonly artifact: {
        readonly object_key: string;
        readonly checksum: string;
        readonly size_bytes: number;
    };
}
export interface Template {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly name: string;
    readonly version: string;
    readonly hostTemplateName: string;
    readonly sourceMachineId: string;
    readonly manifest: TemplateManifest;
    readonly objectKey: string;
    readonly checksum: string;
    readonly sizeBytes: number;
    readonly createdAt: Date;
    readonly deletedAt?: Date;
}
export interface TemplateSourceMachine {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly state: string;
    readonly ready: boolean;
    readonly architecture: TemplateArchitecture;
    readonly hostId?: string;
    readonly hostAddress?: string;
    readonly hostMachineId?: string;
    readonly leaseId: string;
    readonly expiresAt: Date;
}
export interface TemplateMachineResolver {
    get(id: string, organizationId: string, projectId?: string): Promise<TemplateSourceMachine | undefined>;
}
/** A short-lived, single-object grant. Implementations may use a presigned URL
 * or temporary prefix credentials, but must never return an S3 master key. */
export interface ScopedObjectGrant {
    readonly method: 'GET' | 'PUT';
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
}
export interface TemplateObjectStore {
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
/** Narrow host-side publication boundary. The host snapshots only the selected
 * current lease and uploads only through the scoped object grant. */
export interface TemplatePublisher {
    export(input: {
        readonly address: string;
        readonly hostMachineId: string;
        readonly leaseId: string;
        readonly exportId: string;
    }): Promise<{
        readonly exportId: string;
        readonly checksum: string;
        readonly sizeBytes: number;
    }>;
    upload(input: {
        readonly address: string;
        readonly hostMachineId: string;
        readonly leaseId: string;
        readonly exportId: string;
        readonly artifact: {
            readonly checksum: string;
            readonly sizeBytes: number;
        };
        readonly upload: ScopedObjectGrant;
    }): Promise<{
        readonly checksum: string;
        readonly sizeBytes: number;
    }>;
    discard(input: {
        readonly address: string;
        readonly hostMachineId: string;
        readonly leaseId: string;
        readonly exportId: string;
    }): Promise<void>;
}
export type TemplateDeleteResult = 'deleted' | 'in_use' | 'not_found';
export interface TemplateRepository {
    list(organizationId: string, projectId?: string, includeDeleted?: boolean): Promise<ReadonlyArray<Template>>;
    findVersion(organizationId: string, projectId: string, name: string, version: string): Promise<Template | undefined>;
    insert(template: Template): Promise<void>;
    remove(idOrVersion: string, organizationId: string, projectId?: string): Promise<TemplateDeleteResult>;
}
export declare class PostgresTemplateRepository implements TemplateRepository {
    private readonly database;
    constructor(database: TemplateDatabase);
    list(organizationId: string, projectId?: string, includeDeleted?: boolean): Promise<ReadonlyArray<Template>>;
    insert(template: Template): Promise<void>;
    findVersion(organizationId: string, projectId: string, name: string, version: string): Promise<Template | undefined>;
    remove(idOrVersion: string, organizationId: string, projectId?: string): Promise<TemplateDeleteResult>;
}
export declare class InvalidTemplateRequest extends Error {
    readonly code = "invalid_template_request";
}
export declare class TemplateSourceNotFound extends Error {
    readonly code = "template_source_not_found";
}
export declare class TemplateSourceNotReady extends Error {
    readonly code = "template_source_not_ready";
}
export declare class TemplateVersionConflict extends Error {
    readonly code = "template_version_conflict";
}
export declare class TemplateInfrastructureUnavailable extends Error {
    readonly code = "template_infrastructure_unavailable";
}
export declare class TemplateIntegrityError extends Error {
    readonly code = "template_integrity_failed";
}
export declare const validTemplateChecksum: (value: string) => boolean;
export declare const validateScopedObjectGrant: (grant: ScopedObjectGrant, method: ScopedObjectGrant["method"], now: Date) => void;
export declare class TemplateService {
    #private;
    private readonly machines?;
    private readonly storage?;
    private readonly publisher?;
    private readonly now;
    constructor(repository: TemplateRepository | TemplateDatabase, machines?: TemplateMachineResolver | undefined, storage?: TemplateObjectStore | undefined, publisher?: TemplatePublisher | undefined, now?: () => Date);
    list(organizationId: string, projectId?: string, includeDeleted?: boolean): Promise<ReadonlyArray<Template>>;
    publish(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly machineId: string;
        readonly name: string;
        readonly version: string;
    }): Promise<Template>;
    remove(idOrVersion: string, organizationId: string, projectId?: string): Promise<TemplateDeleteResult>;
}
export declare const templateJson: (template: Template) => {
    id: string;
    project_id: string;
    name: string;
    version: string;
    manifest: TemplateManifest;
    checksum: string;
    size_bytes: number;
    source_machine_id: string;
    created_at: string;
};

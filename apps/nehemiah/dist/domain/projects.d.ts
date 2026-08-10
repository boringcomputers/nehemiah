import { Database } from '../db/client.js';
export declare const defaultProjectsPerOrganization = 16;
export declare const maximumProjectsPerOrganization = 64;
export interface Project {
    readonly id: string;
    readonly organization_id: string;
    readonly slug: string;
    readonly name: string;
    readonly max_machines: number;
    readonly max_vcpus: number;
    readonly max_memory_mb: number;
    readonly max_disk_mb: number;
    readonly max_storage_mb: number;
}
export interface ProjectCreateResult {
    readonly project: Project;
    readonly replayed: boolean;
}
export declare class ProjectQuotaExceeded extends Error {
    readonly code = "project_quota_exceeded";
    readonly status = 429;
    readonly retryAfterSeconds = 86400;
}
export declare class ProjectSlugConflict extends Error {
    readonly code = "project_slug_conflict";
    readonly status = 409;
}
export declare class ProjectAllocationIntegrityError extends Error {
    readonly code = "project_allocation_integrity_failed";
}
export declare class ProjectService {
    private readonly database;
    constructor(database: Database);
    list(organizationId: string, projectId?: string): Promise<ReadonlyArray<Project>>;
    belongsToOrganization(projectId: string, organizationId: string): Promise<boolean>;
    create(input: {
        readonly organizationId: string;
        readonly slug: string;
        readonly name: string;
    }): Promise<ProjectCreateResult>;
}

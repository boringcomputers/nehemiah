import type { Queryable } from '../db/client.js';
export interface Project {
    readonly id: string;
    readonly organization_id: string;
    readonly slug: string;
    readonly name: string;
    readonly max_machines: number;
    readonly max_vcpus: number;
    readonly max_memory_mb: number;
    readonly max_storage_mb: number;
}
export declare class ProjectService {
    private readonly database;
    constructor(database: Queryable);
    list(organizationId: string): Promise<ReadonlyArray<Project>>;
    belongsToOrganization(projectId: string, organizationId: string): Promise<boolean>;
}

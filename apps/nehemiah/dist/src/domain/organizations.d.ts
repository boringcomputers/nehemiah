import type { Queryable } from '../db/client.js';
export interface Organization {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}
export declare class OrganizationService {
    private readonly database;
    constructor(database: Queryable);
    listForUser(clerkUserId: string): Promise<ReadonlyArray<Organization>>;
    userCanAccess(clerkUserId: string, organizationId: string): Promise<boolean>;
}

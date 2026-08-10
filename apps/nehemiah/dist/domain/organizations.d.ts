import type { Queryable } from '../db/client.js';
export interface Organization {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}
export type MembershipRole = 'owner' | 'admin' | 'member' | 'billing';
export declare class OrganizationService {
    private readonly database;
    constructor(database: Queryable);
    listForUser(clerkUserId: string): Promise<ReadonlyArray<Organization>>;
    userEnabled(clerkUserId: string): Promise<boolean>;
    membershipRole(clerkUserId: string, organizationId: string): Promise<MembershipRole | undefined>;
}

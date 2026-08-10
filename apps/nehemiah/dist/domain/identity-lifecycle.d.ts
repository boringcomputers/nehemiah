import { Database } from '../db/client.js';
export type IdentityLifecycleActorType = 'user' | 'system';
export interface IdentityLifecycleContext {
    readonly actorType: IdentityLifecycleActorType;
    readonly actorId: string;
    /** The operator organization, when the actor is a dashboard user. */
    readonly actorOrganizationId?: string;
    readonly reason: string;
    readonly requestId?: string;
    readonly userAgent?: string;
}
export interface IdentityLifecycleState {
    readonly id: string;
    readonly disabledAt?: Date;
    readonly changed: boolean;
}
export type IdentityProviderSyncEventType = 'user.disabled' | 'user.deleted' | 'membership.upserted' | 'membership.removed';
export type IdentityProviderMembershipRole = 'owner' | 'admin' | 'member' | 'billing';
export interface IdentityProviderSyncInput {
    readonly provider: 'clerk';
    readonly eventId: string;
    readonly sourceVersion: number;
    readonly eventType: IdentityProviderSyncEventType;
    readonly clerkUserId: string;
    readonly organizationId?: string;
    readonly role?: IdentityProviderMembershipRole;
}
export interface IdentityProviderSyncResult {
    readonly provider: 'clerk';
    readonly eventId: string;
    readonly sourceVersion: number;
    readonly result: 'applied' | 'stale' | 'replayed';
    readonly changed: boolean;
    readonly userId: string;
    readonly organizationId?: string;
}
export declare class InvalidIdentityLifecycleRequest extends Error {
    readonly code = "invalid_identity_lifecycle_request";
}
export declare class IdentityLifecycleAuthorizationDenied extends Error {
    readonly code = "fleet_operator_required";
    constructor();
}
export declare class IdentityProviderSyncTargetNotFound extends Error {
    readonly code = "identity_provider_target_not_found";
    constructor();
}
export declare class IdentityProviderSyncConflict extends Error {
    readonly code = "identity_provider_sync_conflict";
    constructor();
}
export declare class IdentityLifecycleService {
    #private;
    private readonly database;
    constructor(database: Database);
    syncIdentityProvider(input: IdentityProviderSyncInput, context: IdentityLifecycleContext): Promise<IdentityProviderSyncResult>;
    disableUser(id: string, context: IdentityLifecycleContext): Promise<IdentityLifecycleState | undefined>;
    enableUser(id: string, context: IdentityLifecycleContext): Promise<IdentityLifecycleState | undefined>;
    disableOrganization(id: string, context: IdentityLifecycleContext): Promise<IdentityLifecycleState | undefined>;
    enableOrganization(id: string, context: IdentityLifecycleContext): Promise<IdentityLifecycleState | undefined>;
}

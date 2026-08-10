import type { Queryable } from '../db/client.js';
export type AuditActorType = 'user' | 'api_key' | 'host' | 'system';
export type AuditOutcome = 'requested' | 'succeeded' | 'failed' | 'denied';
export interface AuditActor {
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly actorType: AuditActorType;
    readonly actorId?: string;
    readonly requestId?: string;
    readonly userAgent?: string;
}
export interface AuditRecord extends AuditActor {
    readonly operationId?: string;
    readonly action: string;
    readonly outcome: AuditOutcome;
    readonly reasonCode?: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export type AuthenticationCredentialKind = 'api_key' | 'device_access' | 'clerk' | 'unknown';
export interface AuthenticationAuditRecord {
    readonly action: 'authentication' | 'authorization';
    readonly credentialKind: AuthenticationCredentialKind;
    readonly dedupeIdentity: string;
    readonly outcome: 'succeeded' | 'denied';
    readonly reasonCode: string;
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly actorType: AuditActorType;
    readonly actorId?: string;
    readonly requestId?: string;
    readonly userAgent?: string;
    readonly source: string;
    readonly route: string;
    readonly method: string;
}
export interface AuditCompletion {
    readonly outcome?: Exclude<AuditOutcome, 'requested'>;
    readonly reasonCode?: string;
    readonly projectId?: string;
    readonly resourceId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly deferTerminal?: boolean;
}
export interface AuditOperation<T> extends AuditActor {
    readonly operationId?: string;
    readonly action: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly complete?: (result: T) => AuditCompletion;
    readonly failureReason?: (error: unknown) => string;
    readonly failureHandled?: (error: unknown) => boolean;
}
export declare class AuditCompletionUnavailable extends Error {
    readonly code = "audit_completion_unavailable";
    readonly operationMayHaveCompleted = true;
    constructor(cause: unknown);
}
export declare const auditFailureReason: (error: unknown) => string;
/** Store a fixed-size one-way fingerprint, never caller-controlled header text. */
export declare const auditUserAgentFingerprint: (value: string | undefined) => string | null;
/**
 * Append-only audit writer.
 *
 * `capture` always commits a requested event before running the supplied action.
 * This intentionally fails closed: if durable audit intent is unavailable, no
 * external or authorization-changing side effect is attempted. A terminal event
 * uses the same operation ID, so an unmatched request is an observable recovery
 * obligation instead of an invisible audit gap.
 */
export declare class AuditService {
    private readonly database;
    constructor(database: Queryable);
    record(input: AuditRecord): Promise<{
        eventKey: string;
        operationId: string;
    }>;
    /**
     * Record every authentication attempt in a fixed collision-conservative
     * counter, plus one representative immutable event per outcome/hour. Raw
     * credentials and raw addresses never enter the query parameters.
     */
    authentication(input: AuthenticationAuditRecord): Promise<void>;
    capture<T>(input: AuditOperation<T>, operation: () => Promise<T>): Promise<T>;
}

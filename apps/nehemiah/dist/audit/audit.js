import { createHash, randomUUID } from 'node:crypto';
export class AuditCompletionUnavailable extends Error {
    code = 'audit_completion_unavailable';
    operationMayHaveCompleted = true;
    constructor(cause) {
        super('The operation result could not be durably audited.', { cause });
    }
}
const safeToken = (value, fallback) => /^[a-z][a-z0-9._:-]{0,127}$/.test(value) ? value : fallback;
const classReason = (error) => error.constructor.name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .toLowerCase();
export const auditFailureReason = (error) => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = Reflect.get(error, 'code');
        if (typeof code === 'string')
            return safeToken(code.toLowerCase(), 'operation_failed');
    }
    return error instanceof Error
        ? safeToken(classReason(error), 'operation_failed')
        : 'operation_failed';
};
const bounded = (value, maximum) => value ? value.slice(0, maximum) : null;
/** Store a fixed-size one-way fingerprint, never caller-controlled header text. */
export const auditUserAgentFingerprint = (value) => value ? `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}` : null;
/**
 * Append-only audit writer.
 *
 * `capture` always commits a requested event before running the supplied action.
 * This intentionally fails closed: if durable audit intent is unavailable, no
 * external or authorization-changing side effect is attempted. A terminal event
 * uses the same operation ID, so an unmatched request is an observable recovery
 * obligation instead of an invisible audit gap.
 */
export class AuditService {
    database;
    constructor(database) {
        this.database = database;
    }
    async record(input) {
        const eventKey = `audit:${randomUUID()}`;
        const operationId = input.operationId ?? randomUUID();
        await this.database.query(`INSERT INTO audit_events
			 (event_key, operation_id, organization_id, project_id, actor_type, actor_id,
			  action, outcome, reason_code, resource_type, resource_id, request_id,
			  user_agent, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [
            eventKey,
            operationId,
            input.organizationId ?? null,
            input.projectId ?? null,
            input.actorType,
            bounded(input.actorId, 256),
            safeToken(input.action, 'unknown_action'),
            input.outcome,
            input.reasonCode ? safeToken(input.reasonCode.toLowerCase(), 'operation_failed') : null,
            bounded(input.resourceType, 128),
            bounded(input.resourceId, 256),
            bounded(input.requestId, 128),
            auditUserAgentFingerprint(input.userAgent),
            input.metadata ?? {}
        ]);
        return { eventKey, operationId };
    }
    /**
     * Record every authentication attempt in a fixed collision-conservative
     * counter, plus one representative immutable event per outcome/hour. Raw
     * credentials and raw addresses never enter the query parameters.
     */
    async authentication(input) {
        const windowSeconds = 3_600;
        const slot = createHash('sha256')
            .update('nehemiah-authentication-audit-v1\0')
            .update(input.action)
            .update('\0')
            .update(input.credentialKind)
            .update('\0')
            .update(input.dedupeIdentity)
            .update('\0')
            .update(input.source)
            .digest()
            .readUInt16BE(0);
        await this.database.query(`WITH current_window(window_started_at) AS (
			   SELECT to_timestamp(
			     floor(extract(epoch FROM statement_timestamp()) / $1::integer) * $1::integer
			   )
			 ), applied AS (
			   INSERT INTO authentication_attempt_windows
			     (credential_kind, bucket_slot, window_started_at, attempt_count,
			      succeeded_count, denied_count, last_reason_code, last_seen_at)
			   SELECT $2, $3, window_started_at, 1,
			          CASE WHEN $4 = 'succeeded' THEN 1 ELSE 0 END,
			          CASE WHEN $4 = 'denied' THEN 1 ELSE 0 END,
			          $5, statement_timestamp()
			   FROM current_window
			   ON CONFLICT (credential_kind, bucket_slot) DO UPDATE SET
			     window_started_at = GREATEST(
			       authentication_attempt_windows.window_started_at,
			       EXCLUDED.window_started_at
			     ),
			     attempt_count = CASE
			       WHEN EXCLUDED.window_started_at > authentication_attempt_windows.window_started_at
			         THEN 1
			       ELSE LEAST(authentication_attempt_windows.attempt_count + 1, 2000000002)
			     END,
			     succeeded_count = CASE
			       WHEN EXCLUDED.window_started_at > authentication_attempt_windows.window_started_at
			         THEN EXCLUDED.succeeded_count
			       ELSE LEAST(
			         authentication_attempt_windows.succeeded_count + EXCLUDED.succeeded_count,
			         1000000001
			       )
			     END,
			     denied_count = CASE
			       WHEN EXCLUDED.window_started_at > authentication_attempt_windows.window_started_at
			         THEN EXCLUDED.denied_count
			       ELSE LEAST(
			         authentication_attempt_windows.denied_count + EXCLUDED.denied_count,
			         1000000001
			       )
			     END,
			     last_reason_code = EXCLUDED.last_reason_code,
			     last_seen_at = statement_timestamp()
			   RETURNING window_started_at
			 )
			 INSERT INTO audit_events
			   (event_key, operation_id, organization_id, project_id, actor_type, actor_id,
			    action, outcome, reason_code, resource_type, resource_id, request_id,
			    user_agent, metadata)
			 SELECT $16 || ':' || $2 || ':' || $3::text || ':' ||
			          extract(epoch FROM applied.window_started_at)::bigint::text || ':' || $4,
			        gen_random_uuid(), $6, $7, $8, $9,
			        $16 || '.' || $2, $4, $5, 'credential', $10, $11, $12,
			        jsonb_build_object(
			          'source', $13::text,
			          'route', $14::text,
			          'method', $15::text,
			          'coalesced_window_seconds', $1::integer
			        )
			 FROM applied
			 ON CONFLICT (event_key) DO NOTHING`, [
            windowSeconds,
            input.credentialKind,
            slot,
            input.outcome,
            safeToken(input.reasonCode.toLowerCase(), 'authentication_failed'),
            input.organizationId ?? null,
            input.projectId ?? null,
            input.actorType,
            bounded(input.actorId, 256),
            bounded(input.actorId, 256),
            bounded(input.requestId, 128),
            auditUserAgentFingerprint(input.userAgent),
            bounded(input.source, 128),
            bounded(input.route, 128),
            bounded(input.method.toUpperCase(), 16),
            input.action
        ]);
    }
    async capture(input, operation) {
        const operationId = input.operationId ?? randomUUID();
        const base = {
            operationId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            actorType: input.actorType,
            actorId: input.actorId,
            requestId: input.requestId,
            userAgent: input.userAgent,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId
        };
        await this.record({ ...base, outcome: 'requested', metadata: input.metadata });
        let result;
        try {
            result = await operation();
        }
        catch (error) {
            if (input.failureHandled?.(error))
                throw error;
            try {
                await this.record({
                    ...base,
                    outcome: 'failed',
                    reasonCode: input.failureReason?.(error) ?? auditFailureReason(error)
                });
            }
            catch (auditError) {
                throw new AuditCompletionUnavailable(auditError);
            }
            throw error;
        }
        const completion = input.complete?.(result);
        if (completion?.deferTerminal)
            return result;
        try {
            await this.record({
                ...base,
                projectId: completion?.projectId ?? input.projectId,
                outcome: completion?.outcome ?? 'succeeded',
                reasonCode: completion?.reasonCode,
                resourceId: completion?.resourceId ?? input.resourceId,
                metadata: completion?.metadata
            });
        }
        catch (error) {
            throw new AuditCompletionUnavailable(error);
        }
        return result;
    }
}
//# sourceMappingURL=audit.js.map
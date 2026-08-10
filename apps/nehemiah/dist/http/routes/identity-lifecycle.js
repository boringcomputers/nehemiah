import { IdentityLifecycleAuthorizationDenied, IdentityProviderSyncConflict, IdentityProviderSyncTargetNotFound, InvalidIdentityLifecycleRequest } from '../../domain/identity-lifecycle.js';
import { authenticate, canAdminister } from '../auth.js';
import { HttpRequestError, json, problem, readJson } from '../router.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeProviderToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const syncEvents = [
    'user.disabled',
    'user.deleted',
    'membership.upserted',
    'membership.removed'
];
const membershipRoles = [
    'owner',
    'admin',
    'member',
    'billing'
];
const parseIdentityProviderSync = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new InvalidIdentityLifecycleRequest('The identity provider sync body must be an object.');
    }
    const body = value;
    if (body.provider !== 'clerk') {
        throw new InvalidIdentityLifecycleRequest('The identity provider is not supported.');
    }
    if (typeof body.event_id !== 'string' ||
        body.event_id.length > 128 ||
        !safeProviderToken.test(body.event_id)) {
        throw new InvalidIdentityLifecycleRequest('event_id must be a safe 1 to 128 character token');
    }
    if (typeof body.source_version !== 'number' ||
        !Number.isSafeInteger(body.source_version) ||
        body.source_version < 1) {
        throw new InvalidIdentityLifecycleRequest('source_version must be a positive safe integer');
    }
    if (typeof body.event_type !== 'string' ||
        !syncEvents.includes(body.event_type)) {
        throw new InvalidIdentityLifecycleRequest('event_type is not supported');
    }
    if (typeof body.clerk_user_id !== 'string' || !safeProviderToken.test(body.clerk_user_id)) {
        throw new InvalidIdentityLifecycleRequest('clerk_user_id must be a safe 1 to 256 character subject');
    }
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 512) {
        throw new InvalidIdentityLifecycleRequest('reason must contain 1 to 512 characters');
    }
    const eventType = body.event_type;
    const membershipEvent = eventType.startsWith('membership.');
    const expectedKeys = new Set([
        'provider',
        'event_id',
        'source_version',
        'event_type',
        'clerk_user_id',
        'reason',
        ...(membershipEvent ? ['organization_id'] : []),
        ...(eventType === 'membership.upserted' ? ['role'] : [])
    ]);
    if (Object.keys(body).some((key) => !expectedKeys.has(key)) ||
        Object.keys(body).length !== expectedKeys.size) {
        throw new InvalidIdentityLifecycleRequest('The identity provider sync body contains missing or unsupported fields.');
    }
    if (membershipEvent &&
        (typeof body.organization_id !== 'string' || !uuid.test(body.organization_id))) {
        throw new InvalidIdentityLifecycleRequest('membership events require a valid local organization UUID');
    }
    if (eventType === 'membership.upserted' &&
        (typeof body.role !== 'string' ||
            !membershipRoles.includes(body.role))) {
        throw new InvalidIdentityLifecycleRequest('membership.upserted requires a supported role');
    }
    return {
        input: {
            provider: 'clerk',
            eventId: body.event_id,
            sourceVersion: body.source_version,
            eventType,
            clerkUserId: body.clerk_user_id,
            ...(membershipEvent ? { organizationId: body.organization_id } : {}),
            ...(eventType === 'membership.upserted'
                ? { role: body.role }
                : {})
        },
        reason: body.reason.trim()
    };
};
const reason = async (request, requestId) => {
    try {
        const body = await readJson(request, 4_096);
        if (typeof body !== 'object' ||
            body === null ||
            Array.isArray(body) ||
            Object.keys(body).length !== 1 ||
            typeof body.reason !== 'string' ||
            !body.reason.trim() ||
            body.reason.length > 512) {
            return problem(400, 'invalid_identity_lifecycle_request', 'A reason containing 1 to 512 characters is required.', requestId);
        }
        return body.reason.trim();
    }
    catch (error) {
        if (error instanceof HttpRequestError)
            throw error;
        return problem(400, 'invalid_identity_lifecycle_request', 'The identity lifecycle request is invalid.', requestId);
    }
};
export const registerIdentityLifecycleRoutes = (router) => {
    const lifecycle = (target, transition) => async ({ request, params, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal) {
            return problem(401, 'unauthorized', 'A valid operator session is required.', requestId);
        }
        const action = `identity.${target === 'users' ? 'user' : 'organization'}.${transition}`;
        if (principal.kind !== 'user' ||
            !canAdminister(principal) ||
            !(await services.hosts.isOperatorOrganization(principal.organizationId))) {
            await services.audit.record({
                organizationId: principal.organizationId,
                actorType: principal.kind,
                actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
                requestId,
                userAgent: request.headers.get('user-agent') ?? undefined,
                action,
                outcome: 'denied',
                reasonCode: 'fleet_operator_required',
                resourceType: target === 'users' ? 'user' : 'organization',
                resourceId: params.id
            });
            return problem(403, 'fleet_operator_required', 'An owner or administrator in an authorized fleet operator organization is required.', requestId);
        }
        if (!uuid.test(params.id)) {
            return problem(400, 'invalid_identity_lifecycle_request', 'A valid target identity ID is required.', requestId);
        }
        const lifecycleReason = await reason(request, requestId);
        if (lifecycleReason instanceof Response)
            return lifecycleReason;
        const context = {
            actorType: 'user',
            actorId: principal.clerkUserId,
            actorOrganizationId: principal.organizationId,
            reason: lifecycleReason,
            requestId,
            userAgent: request.headers.get('user-agent') ?? undefined
        };
        try {
            const state = target === 'users'
                ? transition === 'disable'
                    ? await services.identityLifecycle.disableUser(params.id, context)
                    : await services.identityLifecycle.enableUser(params.id, context)
                : transition === 'disable'
                    ? await services.identityLifecycle.disableOrganization(params.id, context)
                    : await services.identityLifecycle.enableOrganization(params.id, context);
            return state
                ? json({
                    [target === 'users' ? 'user' : 'organization']: {
                        id: state.id,
                        disabled_at: state.disabledAt?.toISOString()
                    },
                    changed: state.changed
                })
                : problem(404, 'not_found', 'The target identity was not found.', requestId);
        }
        catch (error) {
            if (error instanceof IdentityLifecycleAuthorizationDenied) {
                return problem(403, error.code, error.message, requestId);
            }
            if (error instanceof InvalidIdentityLifecycleRequest) {
                return problem(400, error.code, error.message, requestId);
            }
            throw error;
        }
    };
    router.post('/v1/operator/identity-provider/sync', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal) {
            return problem(401, 'unauthorized', 'A valid operator session is required.', requestId);
        }
        if (principal.kind !== 'user' ||
            !canAdminister(principal) ||
            !(await services.hosts.isOperatorOrganization(principal.organizationId))) {
            await services.audit.record({
                organizationId: principal.organizationId,
                actorType: principal.kind,
                actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
                requestId,
                userAgent: request.headers.get('user-agent') ?? undefined,
                action: 'identity.provider.sync',
                outcome: 'denied',
                reasonCode: 'fleet_operator_required',
                resourceType: 'identity_provider_event',
                resourceId: 'unparsed'
            });
            return problem(403, 'fleet_operator_required', 'An owner or administrator in an authorized fleet operator organization is required.', requestId);
        }
        let parsed;
        try {
            parsed = parseIdentityProviderSync(await readJson(request, 16_384));
        }
        catch (error) {
            await services.audit.record({
                organizationId: principal.organizationId,
                actorType: 'user',
                actorId: principal.clerkUserId,
                requestId,
                userAgent: request.headers.get('user-agent') ?? undefined,
                action: 'identity.provider.sync',
                outcome: 'denied',
                reasonCode: error instanceof HttpRequestError ? error.code : 'invalid_identity_provider_sync',
                resourceType: 'identity_provider_event',
                resourceId: 'unparsed'
            });
            if (error instanceof HttpRequestError)
                throw error;
            if (error instanceof InvalidIdentityLifecycleRequest) {
                return problem(400, 'invalid_identity_provider_sync', error.message, requestId);
            }
            throw error;
        }
        try {
            const result = await services.identityLifecycle.syncIdentityProvider(parsed.input, {
                actorType: 'user',
                actorId: principal.clerkUserId,
                actorOrganizationId: principal.organizationId,
                reason: parsed.reason,
                requestId,
                userAgent: request.headers.get('user-agent') ?? undefined
            });
            return json({
                provider: result.provider,
                event_id: result.eventId,
                source_version: result.sourceVersion,
                result: result.result,
                changed: result.changed,
                user_id: result.userId,
                ...(result.organizationId ? { organization_id: result.organizationId } : {})
            });
        }
        catch (error) {
            if (error instanceof IdentityLifecycleAuthorizationDenied) {
                return problem(403, error.code, error.message, requestId);
            }
            if (error instanceof IdentityProviderSyncTargetNotFound) {
                return problem(404, error.code, error.message, requestId);
            }
            if (error instanceof IdentityProviderSyncConflict) {
                return problem(409, error.code, error.message, requestId);
            }
            if (error instanceof InvalidIdentityLifecycleRequest) {
                return problem(400, 'invalid_identity_provider_sync', error.message, requestId);
            }
            throw error;
        }
    });
    router.post('/v1/operator/users/:id/disable', lifecycle('users', 'disable'));
    router.post('/v1/operator/users/:id/enable', lifecycle('users', 'enable'));
    router.post('/v1/operator/organizations/:id/disable', lifecycle('organizations', 'disable'));
    router.post('/v1/operator/organizations/:id/enable', lifecycle('organizations', 'enable'));
};
//# sourceMappingURL=identity-lifecycle.js.map
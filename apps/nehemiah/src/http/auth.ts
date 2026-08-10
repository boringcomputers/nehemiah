import { createHash } from 'node:crypto';
import {
	apiKeyPublicPrefix,
	ApiKeyVerifierBusy,
	type ApiKeyPrincipal,
	type ApiKeyScope,
	type ApiKeyService
} from '../auth/api-key.js';
import {
	ApiRateLimitExceeded,
	coarseClientIdentity,
	type ApiAdmission
} from '../auth/api-admission.js';
import type { DashboardPrincipal, SessionVerifier } from '../auth/clerk.js';
import { authenticateClerkSession } from '../auth/clerk.js';
import type { DeviceAuthorizationService } from '../auth/device.js';
import type { AuditService } from '../audit/audit.js';
import type { OrganizationService } from '../domain/organizations.js';
import type { MembershipRole } from '../domain/organizations.js';
import { requestId } from '../telemetry.js';

export type Principal =
	| ApiKeyPrincipal
	| (DashboardPrincipal & { readonly organizationId: string; readonly role: MembershipRole });

export interface AuthServices {
	readonly apiKeys: ApiKeyService;
	readonly audit: AuditService;
	readonly organizations: OrganizationService;
	readonly clerkSessionVerifier?: SessionVerifier;
	readonly deviceAuthorizations?: DeviceAuthorizationService;
	readonly apiAdmission?: ApiAdmission;
}

const bearer = (request: Request): string | undefined => {
	const value = request.headers.get('authorization');
	return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
};

type RawIdentity = ApiKeyPrincipal | DashboardPrincipal;

interface RawAuthentication {
	readonly identity?: RawIdentity;
	readonly credentialKind: 'api_key' | 'device_access' | 'clerk' | 'unknown';
	readonly dedupeIdentity: string;
	readonly actorId?: string;
	readonly reasonCode: string;
}

interface AuthenticatedRequest {
	readonly principal: Principal | RawIdentity;
	readonly attempt: RawAuthentication;
	readonly services: AuthServices;
}

const authenticatedRequests = new WeakMap<Request, AuthenticatedRequest>();

const tokenFingerprint = (token: string): string =>
	createHash('sha256').update('nehemiah-auth-attempt-v1\0').update(token).digest('hex');

const classifyPresentedCredential = (token: string): RawAuthentication => {
	if (token.startsWith('bc_access_')) {
		return {
			credentialKind: 'device_access',
			dedupeIdentity: tokenFingerprint(token),
			reasonCode: 'credential_unverified'
		};
	}
	if (token.startsWith('bc_')) {
		const prefix = apiKeyPublicPrefix(token);
		return {
			credentialKind: 'api_key',
			dedupeIdentity: prefix ?? tokenFingerprint(token),
			actorId: prefix,
			reasonCode: 'credential_unverified'
		};
	}
	return {
		credentialKind: 'clerk',
		dedupeIdentity: tokenFingerprint(token),
		reasonCode: 'credential_unverified'
	};
};

const routeClass = (request: Request): string => {
	const resource = new URL(request.url).pathname.split('/').filter(Boolean)[1];
	return resource && /^[a-z][a-z0-9-]{0,31}$/.test(resource) ? `/v1/${resource}` : '/unknown';
};

const recordAttempt = async (
	request: Request,
	services: AuthServices,
	attempt: RawAuthentication,
	input: {
		readonly action: 'authentication' | 'authorization';
		readonly outcome: 'succeeded' | 'denied';
		readonly reasonCode: string;
		readonly principal?: Principal | RawIdentity;
		readonly route?: string;
	}
): Promise<void> => {
	const principal = input.principal;
	await services.audit.authentication?.({
		action: input.action,
		credentialKind: attempt.credentialKind,
		dedupeIdentity: `${attempt.dedupeIdentity}\0${input.action}\0${input.reasonCode}`,
		outcome: input.outcome,
		reasonCode: input.reasonCode,
		organizationId: principal?.organizationId,
		projectId: principal?.kind === 'api_key' ? principal.projectId : undefined,
		actorType:
			principal?.kind === 'user'
				? 'user'
				: principal
					? 'api_key'
					: attempt.actorId
						? 'api_key'
						: 'system',
		actorId:
			principal?.kind === 'user'
				? principal.clerkUserId
				: principal?.kind === 'api_key'
					? (principal.deviceFamilyId ?? principal.apiKeyId)
					: attempt.actorId,
		requestId: requestId(request),
		userAgent: request.headers.get('user-agent') ?? undefined,
		source: coarseClientIdentity(request.headers.get('x-nehemiah-client-address')),
		route: input.route ?? routeClass(request),
		method: request.method
	});
};

const authenticateRawIdentity = async (
	request: Request,
	services: AuthServices
): Promise<RawAuthentication> => {
	const token = bearer(request);
	const presented: RawAuthentication = token
		? classifyPresentedCredential(token)
		: {
				credentialKind: 'unknown',
				dedupeIdentity: 'missing',
				reasonCode: 'credential_missing'
			};
	try {
		await services.apiAdmission?.preAuthenticate(request, token);
	} catch (error) {
		if (error instanceof ApiRateLimitExceeded) {
			await recordAttempt(request, services, presented, {
				action: 'authentication',
				outcome: 'denied',
				reasonCode: 'preauth_rate_limited'
			});
		}
		throw error;
	}
	if (!token) return presented;
	if (token.startsWith('bc_access_')) {
		const identity = await services.deviceAuthorizations?.authenticateAccess(token);
		return {
			identity,
			credentialKind: 'device_access',
			dedupeIdentity: identity?.deviceFamilyId ?? presented.dedupeIdentity,
			actorId: identity?.deviceFamilyId,
			reasonCode: identity ? 'credential_verified' : 'credential_invalid_or_inactive'
		};
	}
	if (token.startsWith('bc_')) {
		try {
			const identity = await services.apiKeys.authenticate(token);
			const prefix = apiKeyPublicPrefix(token);
			return {
				identity,
				credentialKind: 'api_key',
				dedupeIdentity: identity?.apiKeyId ?? prefix ?? tokenFingerprint(token),
				actorId: identity?.apiKeyId ?? prefix,
				reasonCode: identity ? 'credential_verified' : 'credential_invalid_or_inactive'
			};
		} catch (error) {
			if (error instanceof ApiKeyVerifierBusy) {
				await recordAttempt(request, services, presented, {
					action: 'authentication',
					outcome: 'denied',
					reasonCode: 'verifier_capacity_limited'
				});
				throw new ApiRateLimitExceeded(1);
			}
			throw error;
		}
	}
	const identity = services.clerkSessionVerifier
		? await authenticateClerkSession(token, services.clerkSessionVerifier)
		: undefined;
	return {
		identity,
		credentialKind: 'clerk',
		dedupeIdentity: identity?.clerkUserId ?? tokenFingerprint(token),
		actorId: identity?.clerkUserId,
		reasonCode: identity ? 'credential_verified' : 'credential_invalid_or_inactive'
	};
};

const admitIdentity = async (
	identity: ApiKeyPrincipal | DashboardPrincipal,
	services: AuthServices,
	organizationId = identity.organizationId
): Promise<void> => {
	await services.apiAdmission?.authenticate({
		principalId:
			identity.kind === 'api_key' ? `api_key:${identity.apiKeyId}` : `user:${identity.clerkUserId}`,
		organizationId,
		projectId: identity.kind === 'api_key' ? identity.projectId : undefined
	});
};

const admitIdentityWithAudit = async (
	request: Request,
	attempt: RawAuthentication,
	identity: ApiKeyPrincipal | DashboardPrincipal,
	services: AuthServices,
	organizationId = identity.organizationId
): Promise<void> => {
	try {
		await admitIdentity(identity, services, organizationId);
	} catch (error) {
		if (error instanceof ApiRateLimitExceeded) {
			await recordAttempt(request, services, attempt, {
				action: 'authentication',
				outcome: 'denied',
				reasonCode: 'postauth_rate_limited',
				principal: organizationId ? { ...identity, organizationId } : identity
			});
		}
		throw error;
	}
};

export const authenticateIdentity = async (
	request: Request,
	services: AuthServices
): Promise<ApiKeyPrincipal | DashboardPrincipal | undefined> => {
	const attempt = await authenticateRawIdentity(request, services);
	const identity = attempt.identity;
	if (
		identity?.kind === 'user' &&
		!(await services.organizations.userEnabled(identity.clerkUserId))
	) {
		await recordAttempt(request, services, attempt, {
			action: 'authorization',
			outcome: 'denied',
			reasonCode: 'user_disabled',
			principal: identity
		});
		return undefined;
	}
	if (!identity) {
		await recordAttempt(request, services, attempt, {
			action: 'authentication',
			outcome: 'denied',
			reasonCode: attempt.reasonCode
		});
		return undefined;
	}
	await admitIdentityWithAudit(request, attempt, identity, services);
	await recordAttempt(request, services, attempt, {
		action: 'authentication',
		outcome: 'succeeded',
		reasonCode: 'credential_verified',
		principal: identity
	});
	authenticatedRequests.set(request, { principal: identity, attempt, services });
	return identity;
};

export const authenticate = async (
	request: Request,
	services: AuthServices
): Promise<Principal | undefined> => {
	const attempt = await authenticateRawIdentity(request, services);
	const identity = attempt.identity;
	if (!identity) {
		await recordAttempt(request, services, attempt, {
			action: 'authentication',
			outcome: 'denied',
			reasonCode: attempt.reasonCode
		});
		return undefined;
	}
	if (identity.kind === 'api_key') {
		await admitIdentityWithAudit(request, attempt, identity, services);
		await recordAttempt(request, services, attempt, {
			action: 'authentication',
			outcome: 'succeeded',
			reasonCode: 'credential_verified',
			principal: identity
		});
		authenticatedRequests.set(request, { principal: identity, attempt, services });
		return identity;
	}
	const session = identity;
	const organizationId =
		request.headers.get('x-nehemiah-organization-id') ?? session.organizationId;
	if (!organizationId) {
		await recordAttempt(request, services, attempt, {
			action: 'authorization',
			outcome: 'denied',
			reasonCode: 'organization_required',
			principal: session
		});
		return undefined;
	}
	const role = await services.organizations.membershipRole(session.clerkUserId, organizationId);
	if (!role) {
		await recordAttempt(request, services, attempt, {
			action: 'authorization',
			outcome: 'denied',
			reasonCode: 'membership_inactive',
			principal: { ...session, organizationId }
		});
		return undefined;
	}
	await admitIdentityWithAudit(request, attempt, session, services, organizationId);
	const principal = { ...session, organizationId, role };
	await recordAttempt(request, services, attempt, {
		action: 'authentication',
		outcome: 'succeeded',
		reasonCode: 'credential_verified',
		principal
	});
	authenticatedRequests.set(request, { principal, attempt, services });
	return principal;
};

/** Called by the router after a deliberately coarse 403/404 response. */
export const auditHttpAuthorizationDenial = async (
	request: Request,
	route: string,
	status: number
): Promise<void> => {
	if (status !== 403 && status !== 404) return;
	const authenticated = authenticatedRequests.get(request);
	if (!authenticated) return;
	await recordAttempt(request, authenticated.services, authenticated.attempt, {
		action: 'authorization',
		outcome: 'denied',
		reasonCode: status === 403 ? 'scope_or_role_denied' : 'resource_not_found_or_denied',
		principal: authenticated.principal,
		route
	});
};

export const projectFor = (principal: Principal, requested?: string): string | undefined =>
	principal.kind === 'api_key' && principal.projectId ? principal.projectId : requested;

export const permits = (principal: Principal, scope: ApiKeyScope): boolean => {
	if (principal.kind === 'api_key') return principal.scopes.has(scope);
	if (principal.role === 'owner' || principal.role === 'admin') return true;
	if (principal.role === 'billing') return scope === 'billing:read';
	return (
		scope === 'machines:read' ||
		scope === 'machines:write' ||
		scope === 'templates:read' ||
		scope === 'volumes:read' ||
		scope === 'volumes:write'
	);
};

export const canAdminister = (principal: Principal): boolean =>
	principal.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin');

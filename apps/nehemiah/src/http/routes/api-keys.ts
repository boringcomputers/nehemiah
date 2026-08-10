import type { ApiKeyScope, ApiKeyService } from '../../auth/api-key.js';
import {
	apiKeyScopes,
	ApiKeyAllocationUnavailable,
	ApiKeyAuthorizationDenied,
	ApiKeyHasherBusy,
	ApiKeyQuotaExceeded,
	InvalidApiKeyRequest
} from '../../auth/api-key.js';
import { authenticate, canAdminister, type AuthServices } from '../auth.js';
import { json, problem, readJson, type Handler, type Router } from '../router.js';

export interface ApiKeyRouteServices extends AuthServices {
	readonly apiKeys: ApiKeyService;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const auditContext = (request: Request, requestId: string) => ({
	requestId,
	userAgent: request.headers.get('user-agent') ?? undefined
});

const hashingBusy = (error: ApiKeyHasherBusy, requestId: string): Response => {
	const response = problem(429, error.code, error.message, requestId, {
		retry_after_seconds: 1
	});
	response.headers.set('retry-after', '1');
	return response;
};

export const registerApiKeyRoutes = <S extends ApiKeyRouteServices>(router: Router<S>): void => {
	router.get('/v1/api-keys', async ({ request, url, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
			return problem(
				403,
				'administrator_required',
				'An owner or admin role is required.',
				requestId
			);
		}
		const keys = await services.apiKeys.list(
			principal.organizationId,
			url.searchParams.get('project_id') ?? undefined
		);
		return json({
			api_keys: keys.map((key) => ({
				id: key.id,
				project_id: key.projectId,
				name: key.name,
				prefix: key.prefix,
				scopes: key.scopes,
				created_at: key.createdAt?.toISOString(),
				last_used_at: key.lastUsedAt?.toISOString(),
				expires_at: key.expiresAt?.toISOString(),
				disabled_at: key.disabledAt?.toISOString(),
				revoked_at: key.revokedAt?.toISOString()
			}))
		});
	});

	router.post('/v1/api-keys', async ({ request, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
			return problem(
				403,
				'dashboard_session_required',
				'API keys can only be created by a dashboard user.',
				requestId
			);
		}
		const body = await readJson<{
			name?: string;
			project_id?: string;
			scopes?: ApiKeyScope[];
			expires_at?: string;
		}>(request);
		if (
			!body.name ||
			!body.scopes?.length ||
			body.scopes.some((scope) => !apiKeyScopes.includes(scope))
		) {
			return problem(400, 'invalid_api_key', 'A name and valid scopes are required.', requestId);
		}
		try {
			const created = await services.apiKeys.create({
				organizationId: principal.organizationId,
				projectId: body.project_id,
				name: body.name,
				scopes: body.scopes,
				expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
				actorId: principal.clerkUserId,
				requestId,
				userAgent: request.headers.get('user-agent') ?? undefined
			});
			return json({ ...created, secret_displayed_once: true }, 201, {
				'cache-control': 'no-store'
			});
		} catch (error) {
			if (error instanceof ApiKeyHasherBusy) {
				return hashingBusy(error, requestId);
			}
			if (error instanceof ApiKeyQuotaExceeded) {
				return problem(409, error.code, error.message, requestId);
			}
			if (error instanceof ApiKeyAuthorizationDenied) {
				return problem(403, error.code, error.message, requestId);
			}
			if (error instanceof InvalidApiKeyRequest) {
				return problem(400, error.code, error.message, requestId);
			}
			if (error instanceof ApiKeyAllocationUnavailable) {
				return problem(
					503,
					error.code,
					'Could not allocate a unique API-key prefix. Retry later.',
					requestId
				);
			}
			throw error;
		}
	});

	const setDisabled =
		(disabled: boolean): Handler<S> =>
		async ({ request, params, services, requestId }) => {
			const principal = await authenticate(request, services);
			if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
				return problem(
					403,
					'administrator_required',
					'An owner or admin role is required.',
					requestId
				);
			}
			if (!uuid.test(params.id!)) {
				return problem(400, 'invalid_api_key', 'A valid API-key ID is required.', requestId);
			}
			try {
				const accepted = disabled
					? await services.apiKeys.disable(
							params.id!,
							principal.organizationId,
							principal.clerkUserId,
							auditContext(request, requestId)
						)
					: await services.apiKeys.enable(
							params.id!,
							principal.organizationId,
							principal.clerkUserId,
							auditContext(request, requestId)
						);
				return accepted
					? new Response(null, { status: 204 })
					: problem(404, 'not_found', 'API key not found or not active.', requestId);
			} catch (error) {
				if (error instanceof ApiKeyAuthorizationDenied) {
					return problem(403, error.code, error.message, requestId);
				}
				throw error;
			}
		};

	router.post('/v1/api-keys/:id/disable', setDisabled(true));
	router.post('/v1/api-keys/:id/enable', setDisabled(false));

	router.post('/v1/api-keys/:id/rotate', async ({ request, params, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
			return problem(
				403,
				'administrator_required',
				'An owner or admin role is required.',
				requestId
			);
		}
		if (!uuid.test(params.id!)) {
			return problem(400, 'invalid_api_key', 'A valid API-key ID is required.', requestId);
		}
		try {
			const replacement = await services.apiKeys.rotate(
				params.id!,
				principal.organizationId,
				principal.clerkUserId,
				auditContext(request, requestId)
			);
			return replacement
				? json(
						{
							...replacement,
							rotated_from_id: params.id!,
							secret_displayed_once: true
						},
						201,
						{ 'cache-control': 'no-store' }
					)
				: problem(404, 'not_found', 'API key not found or not active.', requestId);
		} catch (error) {
			if (error instanceof ApiKeyHasherBusy) {
				return hashingBusy(error, requestId);
			}
			if (error instanceof ApiKeyQuotaExceeded) {
				return problem(409, error.code, error.message, requestId);
			}
			if (error instanceof ApiKeyAuthorizationDenied) {
				return problem(403, error.code, error.message, requestId);
			}
			if (error instanceof ApiKeyAllocationUnavailable) {
				return problem(
					503,
					error.code,
					'Could not allocate a unique API-key prefix. Retry later.',
					requestId
				);
			}
			throw error;
		}
	});

	router.delete('/v1/api-keys/:id', async ({ request, params, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
			return problem(
				403,
				'administrator_required',
				'An owner or admin role is required.',
				requestId
			);
		}
		if (!uuid.test(params.id!)) {
			return problem(400, 'invalid_api_key', 'A valid API-key ID is required.', requestId);
		}
		try {
			const revoked = await services.apiKeys.revoke(
				params.id!,
				principal.organizationId,
				principal.clerkUserId,
				auditContext(request, requestId)
			);
			return revoked
				? new Response(null, { status: 204 })
				: problem(404, 'not_found', 'API key not found.', requestId);
		} catch (error) {
			if (error instanceof ApiKeyAuthorizationDenied) {
				return problem(403, error.code, error.message, requestId);
			}
			throw error;
		}
	});
};

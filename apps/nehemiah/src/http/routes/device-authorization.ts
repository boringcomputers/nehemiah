import { apiKeyScopes, type ApiKeyScope } from '../../auth/api-key.js';
import {
	DeviceAuthorizationError,
	type DeviceAuthorizationService,
	type DeviceDecision
} from '../../auth/device.js';
import { authenticate, authenticateIdentity, type AuthServices } from '../auth.js';
import { json, problem, readJson, type Router } from '../router.js';

export interface DeviceAuthorizationRouteServices extends AuthServices {
	readonly deviceAuthorizations: DeviceAuthorizationService;
}

const noStore = {
	'cache-control': 'no-store',
	pragma: 'no-cache'
} as const;

const errorResponse = (error: DeviceAuthorizationError, requestId: string): Response => {
	const headers = new Headers(noStore);
	if (error.retryAfterSeconds !== undefined) {
		headers.set('retry-after', String(error.retryAfterSeconds));
	}
	const response = problem(error.status, error.code, error.message, requestId, {
		error: error.code,
		...(error.retryAfterSeconds === undefined ? {} : { interval: error.retryAfterSeconds })
	});
	const merged = new Headers(response.headers);
	for (const [name, value] of headers) merged.set(name, value);
	return new Response(response.body, { status: response.status, headers: merged });
};

const handle = async (requestId: string, operation: () => Promise<Response>): Promise<Response> => {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof DeviceAuthorizationError) return errorResponse(error, requestId);
		throw error;
	}
};

const userAgent = (request: Request): string | undefined =>
	request.headers.get('user-agent')?.slice(0, 512) || undefined;

export const registerDeviceAuthorizationRoutes = <S extends DeviceAuthorizationRouteServices>(
	router: Router<S>
): void => {
	router.post('/v1/auth/device/code', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const body = await readJson<{ client_id?: unknown; scopes?: unknown }>(request, 16_384);
			const result = await services.deviceAuthorizations.issue({
				clientId: typeof body.client_id === 'string' ? body.client_id : '',
				scopes: Array.isArray(body.scopes) ? body.scopes : [],
				// main.ts strips any caller-supplied value and writes this from the
				// actual socket. Direct Router users intentionally share the unknown bucket.
				source: request.headers.get('x-nehemiah-remote-address') ?? 'unknown',
				requestId,
				userAgent: userAgent(request)
			});
			return json(result, 201, noStore);
		})
	);

	router.post('/v1/auth/device/inspect', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const identity = await authenticateIdentity(request, services);
			if (!identity || identity.kind !== 'user') {
				return problem(
					401,
					'dashboard_session_required',
					'Sign in to inspect a device authorization request.',
					requestId
				);
			}
			const body = await readJson<{ user_code?: unknown }>(request, 16_384);
			if (typeof body.user_code !== 'string') {
				throw new DeviceAuthorizationError('invalid_request', 'A user code is required.');
			}
			return json(
				await services.deviceAuthorizations.inspect({
					userCode: body.user_code,
					actorId: identity.clerkUserId
				}),
				200,
				noStore
			);
		})
	);

	router.post('/v1/auth/device/authorize', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const principal = await authenticate(request, services);
			if (!principal || principal.kind !== 'user') {
				return problem(
					401,
					'dashboard_session_required',
					'Sign in and select an organization to authorize this device.',
					requestId
				);
			}
			const body = await readJson<{
				user_code?: unknown;
				decision?: unknown;
				project_id?: unknown;
				scopes?: unknown;
			}>(request, 16_384);
			if (
				typeof body.user_code !== 'string' ||
				(body.decision !== 'approve' && body.decision !== 'deny')
			) {
				throw new DeviceAuthorizationError(
					'invalid_request',
					'A user code and decision are required.'
				);
			}
			await services.deviceAuthorizations.authorize({
				userCode: body.user_code,
				decision: body.decision as DeviceDecision,
				organizationId: principal.organizationId,
				projectId: typeof body.project_id === 'string' ? body.project_id : undefined,
				scopes: Array.isArray(body.scopes) ? (body.scopes as ApiKeyScope[]) : undefined,
				clerkUserId: principal.clerkUserId,
				requestId,
				userAgent: userAgent(request)
			});
			return json(
				{
					decision: body.decision,
					authorized: body.decision === 'approve',
					denied: body.decision === 'deny'
				},
				200,
				noStore
			);
		})
	);

	router.post('/v1/auth/device/token', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const body = await readJson<{ device_code?: unknown }>(request, 16_384);
			if (typeof body.device_code !== 'string' || body.device_code.length > 160) {
				throw new DeviceAuthorizationError('invalid_grant', 'The device code is invalid.');
			}
			return json(
				await services.deviceAuthorizations.exchange(body.device_code, {
					requestId,
					userAgent: userAgent(request)
				}),
				200,
				noStore
			);
		})
	);

	router.post('/v1/auth/device/refresh', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const body = await readJson<{ refresh_token?: unknown }>(request, 16_384);
			if (typeof body.refresh_token !== 'string' || body.refresh_token.length > 160) {
				throw new DeviceAuthorizationError('invalid_grant', 'The refresh token is invalid.');
			}
			await services.apiAdmission?.preAuthenticate(request, body.refresh_token);
			return json(
				await services.deviceAuthorizations.refresh(body.refresh_token, {
					requestId,
					userAgent: userAgent(request)
				}),
				200,
				noStore
			);
		})
	);

	router.post('/v1/auth/device/revoke', ({ request, services, requestId }) =>
		handle(requestId, async () => {
			const body = await readJson<{ refresh_token?: unknown }>(request, 16_384);
			if (typeof body.refresh_token === 'string' && body.refresh_token.length <= 160) {
				await services.deviceAuthorizations.revoke(body.refresh_token, {
					requestId,
					userAgent: userAgent(request)
				});
			}
			// Revocation is deliberately idempotent and does not disclose token validity.
			return new Response(null, { status: 204, headers: noStore });
		})
	);
};

export const defaultDeviceScopes: ReadonlyArray<ApiKeyScope> = apiKeyScopes.filter(
	(scope) => scope !== 'billing:read'
);

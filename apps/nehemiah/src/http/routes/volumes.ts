import { createHash } from 'node:crypto';
import { BillingAdmissionRejected } from '../../billing/admission.js';
import {
	InvalidVolumeRequest,
	volumeGrantJson,
	volumeJson,
	VolumeIdempotencyConflict,
	VolumeInfrastructureUnavailable,
	VolumeIntegrityError,
	VolumeProjectUnavailable,
	VolumeQuotaExceeded,
	type VolumeGrantMethod,
	type VolumeService
} from '../../domain/volumes.js';
import { authenticate, permits, projectFor, type AuthServices, type Principal } from '../auth.js';
import { json, problem, readJson, type Router } from '../router.js';

export interface VolumeRouteServices extends AuthServices {
	readonly volumes: VolumeService;
}

const auditActor = (
	principal: Principal,
	request: Request,
	requestId: string,
	projectId?: string
) => ({
	organizationId: principal.organizationId,
	projectId,
	actorType: principal.kind,
	actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
	requestId,
	userAgent: request.headers.get('user-agent') ?? undefined
});

const crossProject = (principal: Principal, requested?: string): boolean =>
	principal.kind === 'api_key' &&
	principal.projectId !== undefined &&
	requested !== undefined &&
	requested !== principal.projectId;

const validProjectId = (value: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const volumeProblem = (error: unknown, requestId: string): Response | undefined => {
	if (error instanceof BillingAdmissionRejected) {
		return problem(429, error.code, error.message, requestId);
	}
	if (error instanceof InvalidVolumeRequest) {
		return problem(400, error.code, error.message, requestId);
	}
	if (error instanceof VolumeProjectUnavailable) {
		return problem(404, error.code, error.message, requestId);
	}
	if (error instanceof VolumeQuotaExceeded) {
		return problem(409, error.code, error.message, requestId);
	}
	if (error instanceof VolumeIdempotencyConflict) {
		return problem(409, error.code, error.message, requestId);
	}
	if (error instanceof VolumeInfrastructureUnavailable) {
		return problem(503, error.code, error.message, requestId);
	}
	if (error instanceof VolumeIntegrityError) {
		return problem(502, error.code, error.message, requestId);
	}
	return undefined;
};

export const registerVolumeRoutes = <S extends VolumeRouteServices>(router: Router<S>): void => {
	router.post('/v1/volumes', async ({ request, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal) {
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		}
		if (!permits(principal, 'volumes:write')) {
			return problem(403, 'insufficient_scope', 'volumes:write is required.', requestId);
		}
		try {
			const idempotencyKey = request.headers.get('idempotency-key') ?? '';
			const body = await readJson<{
				project_id?: string;
				size_limit_mb?: number;
				ttl_seconds?: number;
				grant_ttl_seconds?: number;
			}>(request);
			if (
				typeof body !== 'object' ||
				body === null ||
				Array.isArray(body) ||
				Object.keys(body).some(
					(key) =>
						!['project_id', 'size_limit_mb', 'ttl_seconds', 'grant_ttl_seconds'].includes(key)
				)
			) {
				throw new InvalidVolumeRequest(
					'Only project_id, size_limit_mb, and TTL fields are accepted.'
				);
			}
			if (
				body.project_id !== undefined &&
				(typeof body.project_id !== 'string' || !validProjectId(body.project_id))
			) {
				throw new InvalidVolumeRequest('project_id must be a UUID.');
			}
			if (crossProject(principal, body.project_id)) {
				return problem(
					403,
					'cross_project_denied',
					'The API key is scoped to another project.',
					requestId
				);
			}
			const projectId = projectFor(principal, body.project_id);
			if (!projectId) return problem(400, 'project_required', 'project_id is required.', requestId);
			if (!validProjectId(projectId)) {
				throw new InvalidVolumeRequest('project_id must be a UUID.');
			}
			const created = await services.audit.capture(
				{
					// The requested event intentionally has no project FK. The service
					// proves tenant ownership before the completion event attaches it.
					...auditActor(principal, request, requestId),
					action: 'volume.create',
					resourceType: 'volume',
					metadata: {
						size_limit_mb: body.size_limit_mb,
						ttl_seconds: body.ttl_seconds,
						idempotency_key_hash: createHash('sha256').update(idempotencyKey).digest('hex')
					},
					complete: (result) => ({
						resourceId: result.volume.id,
						projectId: result.volume.projectId,
						metadata: { replayed: result.replayed }
					})
				},
				() =>
					services.volumes.create({
						organizationId: principal.organizationId,
						projectId,
						sizeLimitMb: body.size_limit_mb,
						ttlSeconds: body.ttl_seconds,
						grantTtlSeconds: body.grant_ttl_seconds,
						idempotencyKey
					})
			);
			return json(
				{ ...volumeJson(created.volume), grant: volumeGrantJson(created.grant) },
				created.replayed ? 200 : 201,
				{
					location: `/v1/volumes/${created.volume.id}`,
					'cache-control': 'no-store',
					...(created.replayed ? { 'idempotency-replayed': 'true' } : {})
				}
			);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return problem(400, 'invalid_volume_request', error.message, requestId);
			}
			return (
				volumeProblem(error, requestId) ??
				problem(500, 'internal_error', 'Volume creation failed.', requestId)
			);
		}
	});

	router.get('/v1/volumes', async ({ request, url, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal) {
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		}
		if (!permits(principal, 'volumes:read')) {
			return problem(403, 'insufficient_scope', 'volumes:read is required.', requestId);
		}
		const requestedProject = url.searchParams.get('project_id') ?? undefined;
		if (requestedProject !== undefined && !validProjectId(requestedProject)) {
			return problem(400, 'invalid_volume_request', 'project_id must be a UUID.', requestId);
		}
		if (crossProject(principal, requestedProject)) {
			return problem(
				403,
				'cross_project_denied',
				'The API key is scoped to another project.',
				requestId
			);
		}
		const projectId = projectFor(principal, requestedProject);
		return json({
			volumes: (await services.volumes.list(principal.organizationId, projectId)).map((volume) =>
				volumeJson(volume)
			)
		});
	});

	router.get('/v1/volumes/:id', async ({ request, params, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || !permits(principal, 'volumes:read')) {
			return problem(404, 'volume_not_found', 'Volume not found.', requestId);
		}
		const volume = await services.volumes.get(
			params.id!,
			principal.organizationId,
			projectFor(principal)
		);
		return volume
			? json(volumeJson(volume))
			: problem(404, 'volume_not_found', 'Volume not found.', requestId);
	});

	router.post('/v1/volumes/:id/grants', async ({ request, params, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal) {
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		}
		try {
			const body = await readJson<{
				method?: VolumeGrantMethod;
				ttl_seconds?: number;
			}>(request);
			if (
				typeof body !== 'object' ||
				body === null ||
				Array.isArray(body) ||
				Object.keys(body).some((key) => !['method', 'ttl_seconds'].includes(key)) ||
				!['GET', 'PUT'].includes(body.method ?? '')
			) {
				throw new InvalidVolumeRequest('method must be GET or PUT.');
			}
			const requiredScope = body.method === 'GET' ? 'volumes:read' : 'volumes:write';
			if (!permits(principal, requiredScope)) {
				return problem(403, 'insufficient_scope', `${requiredScope} is required.`, requestId);
			}
			const result = await services.audit.capture(
				{
					...auditActor(principal, request, requestId),
					action: 'volume.grant.issue',
					resourceType: 'volume',
					resourceId: params.id!,
					metadata: { method: body.method, ttl_seconds: body.ttl_seconds },
					complete: (issued) => ({
						outcome: issued ? 'succeeded' : 'denied',
						reasonCode: issued ? undefined : 'volume_not_found',
						projectId: issued?.volume.projectId
					})
				},
				() =>
					services.volumes.grant(
						params.id!,
						principal.organizationId,
						projectFor(principal),
						body.method!,
						body.ttl_seconds
					)
			);
			return result
				? json({ volume: volumeJson(result.volume), grant: volumeGrantJson(result.grant) }, 200, {
						'cache-control': 'no-store'
					})
				: problem(404, 'volume_not_found', 'Volume not found.', requestId);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return problem(400, 'invalid_volume_request', error.message, requestId);
			}
			return (
				volumeProblem(error, requestId) ??
				problem(500, 'internal_error', 'Grant issuance failed.', requestId)
			);
		}
	});

	router.delete('/v1/volumes/:id', async ({ request, params, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal || !permits(principal, 'volumes:write')) {
			return problem(404, 'volume_not_found', 'Volume not found.', requestId);
		}
		try {
			const result = await services.audit.capture(
				{
					...auditActor(principal, request, requestId),
					action: 'volume.delete',
					resourceType: 'volume',
					resourceId: params.id!,
					complete: (deleted) => ({
						outcome: deleted ? 'succeeded' : 'denied',
						reasonCode: deleted ? undefined : 'volume_not_found',
						projectId: deleted?.volume.projectId,
						metadata: deleted ? { delete_after: deleted.deleteAfter.toISOString() } : undefined
					})
				},
				() => services.volumes.remove(params.id!, principal.organizationId, projectFor(principal))
			);
			return result
				? new Response(null, {
						status: 204,
						headers: { 'x-volume-delete-after': result.deleteAfter.toISOString() }
					})
				: problem(404, 'volume_not_found', 'Volume not found.', requestId);
		} catch (error) {
			return (
				volumeProblem(error, requestId) ??
				problem(500, 'internal_error', 'Volume deletion failed.', requestId)
			);
		}
	});
};

import { createHash, randomUUID } from 'node:crypto';
import type { GatewayCapability } from '../../auth/capability.js';
import {
	canonicalGatewayCapabilities,
	gatewayCapabilities,
	issueCapabilityToken
} from '../../auth/capability.js';
import { BillingAdmissionRejected } from '../../billing/admission.js';
import { HostRequestError } from '../../clients/nehemiahd.js';
import type { Queryable } from '../../db/client.js';
import type { MachineService } from '../../domain/machines.js';
import type { NetworkPolicyDeclaration } from '../../domain/network-policy.js';
import {
	IdempotencyConflict,
	InvalidMachineRequest,
	ManagedNetworkEgressUnavailable,
	MachineNotForkable,
	machineJson,
	ReplayedCreateFailure,
	ReplayedForkFailure
} from '../../domain/machines.js';
import { CapacityUnavailable, QuotaExceeded } from '../../scheduler/scheduler.js';
import { authenticate, permits, projectFor, type AuthServices, type Principal } from '../auth.js';
import { json, problem, readJson, type Router } from '../router.js';

export interface MachineRouteServices extends AuthServices {
	readonly database: Queryable;
	readonly machines: MachineService;
	readonly gatewaySecret: string;
	readonly gatewayPublicUrl: string;
	readonly previewBaseDomain?: string;
	readonly defaultRegion?: string;
}

class MachineSessionLeaseUnavailable extends Error {
	readonly code = 'machine_session_lease_unavailable';
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const auditActor = (
	principal: Principal,
	request: Request,
	requestId: string,
	projectId: string
) => ({
	organizationId: principal.organizationId,
	projectId,
	actorType: principal.kind,
	actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
	requestId,
	userAgent: request.headers.get('user-agent') ?? undefined
});

const previewUrl = (
	services: MachineRouteServices,
	machineId: string,
	leaseId: string,
	port: number,
	token: string
): string => {
	const url = new URL(services.gatewayPublicUrl);
	if (services.previewBaseDomain) {
		const label = createHash('sha256')
			.update(`${machineId}:${leaseId}:${port}`)
			.digest('hex')
			.slice(0, 32);
		url.hostname = `p-${label}.${services.previewBaseDomain}`;
	}
	url.pathname = `/preview/${machineId}/${port}/`;
	url.hash = `token=${encodeURIComponent(token)}`;
	return url.toString();
};

const owned = async (
	services: MachineRouteServices,
	request: Request,
	id: string,
	scope: 'machines:read' | 'machines:write'
) => {
	const principal = await authenticate(request, services);
	if (!principal || !permits(principal, scope)) return undefined;
	const machine = await services.machines.get(id, principal.organizationId, projectFor(principal));
	return machine ? { principal, machine } : undefined;
};

export const registerMachineRoutes = <S extends MachineRouteServices>(router: Router<S>): void => {
	router.post('/v1/machines', async ({ request, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal)
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		if (!permits(principal, 'machines:write')) {
			return problem(403, 'insufficient_scope', 'machines:write is required.', requestId);
		}
		try {
			const body = await readJson<{
				project_id?: string;
				region?: string;
				architecture?: 'x86_64' | 'aarch64';
				template?: string;
				template_id?: string;
				oci_reference?: string;
				ttl_seconds?: number;
				vcpus?: number;
				memory_mb?: number;
				disk_mb?: number;
				network_policy?: NetworkPolicyDeclaration;
			}>(request);
			if (body.oci_reference !== undefined) {
				return problem(
					501,
					'not_supported',
					'Managed OCI image imports are not implemented. Use a built-in template or template_id.',
					requestId
				);
			}
			const projectId = projectFor(principal, body.project_id);
			if (!projectId) return problem(400, 'project_required', 'project_id is required.', requestId);
			if (
				principal.kind === 'api_key' &&
				principal.projectId &&
				body.project_id !== undefined &&
				body.project_id !== principal.projectId
			) {
				return problem(
					403,
					'cross_project_denied',
					'The API key is scoped to another project.',
					requestId
				);
			}
			const createInput = {
				organizationId: principal.organizationId,
				projectId,
				region: body.region ?? services.defaultRegion ?? 'ca-tor-1',
				architecture: body.architecture ?? 'x86_64',
				resources: {
					vcpus: body.vcpus ?? 1,
					memoryMb: body.memory_mb ?? 512,
					diskMb: body.disk_mb ?? 5_120
				},
				template: body.template,
				templateId: body.template_id,
				ociReference: body.oci_reference,
				networkPolicy: body.network_policy,
				ttlSeconds: body.ttl_seconds ?? 900,
				idempotencyKey: request.headers.get('idempotency-key') ?? ''
			} as const;
			const result = await services.audit.capture(
				{
					...auditActor(principal, request, requestId, projectId),
					action: 'machine.create',
					resourceType: 'machine',
					metadata: {
						region: createInput.region,
						architecture: createInput.architecture,
						ttl_seconds: createInput.ttlSeconds,
						idempotency_key_hash: createHash('sha256')
							.update(createInput.idempotencyKey)
							.digest('hex')
					},
					complete: (created) => ({
						resourceId: created.machine.id,
						metadata: { replayed: created.replayed, state: created.machine.state }
					})
				},
				() => services.machines.create(createInput)
			);
			return json(
				machineJson(result.machine),
				result.machine.ready ? (result.replayed ? 200 : 201) : 202,
				result.replayed ? { 'idempotency-replayed': 'true' } : undefined
			);
		} catch (error) {
			if (error instanceof ManagedNetworkEgressUnavailable)
				return problem(501, error.code, error.message, requestId);
			if (error instanceof IdempotencyConflict)
				return problem(409, error.code, error.message, requestId);
			if (error instanceof ReplayedCreateFailure)
				return problem(error.status, error.code, error.message, requestId);
			if (error instanceof InvalidMachineRequest || error instanceof SyntaxError) {
				return problem(400, 'invalid_request', error.message, requestId);
			}
			if (error instanceof QuotaExceeded) return problem(429, error.code, error.message, requestId);
			if (error instanceof BillingAdmissionRejected)
				return problem(429, error.code, error.message, requestId);
			if (error instanceof CapacityUnavailable)
				return problem(503, error.code, error.message, requestId);
			if (error instanceof HostRequestError) {
				return problem(
					error.ambiguous ? 503 : 502,
					error.ambiguous ? 'host_result_pending' : 'host_request_failed',
					error.ambiguous
						? 'The host result is not yet known; retry with the same Idempotency-Key.'
						: 'The selected host rejected the machine request.',
					requestId
				);
			}
			return problem(
				500,
				'internal_error',
				'The machine request could not be completed.',
				requestId
			);
		}
	});

	router.get('/v1/machines', async ({ request, url, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal)
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		if (!permits(principal, 'machines:read')) {
			return problem(403, 'insufficient_scope', 'machines:read is required.', requestId);
		}
		const project = projectFor(principal, url.searchParams.get('project_id') ?? undefined);
		const machines = await services.machines.list(
			principal.organizationId,
			project,
			url.searchParams.get('cursor') ?? undefined,
			Number(url.searchParams.get('limit') ?? 50)
		);
		return json({
			machines: machines.map(machineJson),
			next_cursor: machines.length ? machines.at(-1)!.id : undefined
		});
	});

	router.get('/v1/machines/:id', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:read');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		return json(machineJson(result.machine));
	});

	router.delete('/v1/machines/:id', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:write');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		await services.audit.capture(
			{
				...auditActor(result.principal, request, requestId, result.machine.projectId),
				action: 'machine.destroy',
				resourceType: 'machine',
				resourceId: result.machine.id,
				metadata: { prior_state: result.machine.state }
			},
			() =>
				services.machines.destroy(
					result.machine.id,
					result.principal.organizationId,
					projectFor(result.principal)
				)
		);
		return new Response(null, { status: 204 });
	});

	router.post('/v1/machines/:id/extend', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:write');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		try {
			const body = await readJson<{ ttl_seconds?: number }>(request);
			const ttlSeconds = body.ttl_seconds ?? 900;
			const idempotencyKey = request.headers.get('idempotency-key') ?? '';
			const extension = await services.audit.capture(
				{
					...auditActor(result.principal, request, requestId, result.machine.projectId),
					action: 'machine.extend',
					resourceType: 'machine',
					resourceId: result.machine.id,
					metadata: {
						ttl_seconds: ttlSeconds,
						idempotency_key_hash: createHash('sha256').update(idempotencyKey).digest('hex')
					},
					complete: (extended) => ({
						outcome: extended.applied ? 'succeeded' : 'denied',
						reasonCode: extended.applied ? undefined : 'machine_not_started',
						metadata: {
							expires_at: extended.machine?.expiresAt.toISOString(),
							replayed: extended.replayed
						}
					})
				},
				() =>
					services.machines.extend(
						result.machine.id,
						result.principal.organizationId,
						projectFor(result.principal),
						ttlSeconds,
						idempotencyKey
					)
			);
			return json(
				extension.machine ? machineJson(extension.machine) : machineJson(result.machine),
				200,
				extension.replayed ? { 'idempotency-replayed': 'true' } : undefined
			);
		} catch (error) {
			if (error instanceof ManagedNetworkEgressUnavailable)
				return problem(501, error.code, error.message, requestId);
			if (error instanceof IdempotencyConflict)
				return problem(409, error.code, error.message, requestId);
			if (error instanceof InvalidMachineRequest || error instanceof SyntaxError) {
				return problem(400, 'invalid_request', error.message, requestId);
			}
			if (error instanceof HostRequestError) {
				return problem(
					error.ambiguous ? 503 : 502,
					error.ambiguous ? 'host_result_pending' : 'host_request_failed',
					error.ambiguous
						? 'The host result is not yet known; retry with the same Idempotency-Key.'
						: 'The selected host rejected the extend request.',
					requestId
				);
			}
			if (error instanceof BillingAdmissionRejected)
				return problem(429, error.code, error.message, requestId);
			throw error;
		}
	});

	router.post('/v1/machines/:id/fork', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:write');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		try {
			const body = await readJson<{ count?: number }>(request);
			const count = body.count ?? 1;
			const idempotencyKey = request.headers.get('idempotency-key') ?? '';
			const auditOperationId = randomUUID();
			const forked = await services.audit.capture(
				{
					...auditActor(result.principal, request, requestId, result.machine.projectId),
					operationId: auditOperationId,
					action: 'machine.fork',
					resourceType: 'machine',
					resourceId: result.machine.id,
					metadata: {
						count,
						idempotency_key_hash: createHash('sha256').update(idempotencyKey).digest('hex')
					},
					complete: (fork) => ({
						deferTerminal: fork.pending || fork.auditOperationId === auditOperationId,
						metadata: {
							fork_operation_id: fork.operationId,
							child_ids: fork.machines.map((machine) => machine.id),
							replayed: fork.replayed,
							state: fork.cleanupPending
								? 'cleanup_pending'
								: fork.pending
									? 'pending'
									: 'succeeded'
						}
					}),
					failureHandled: (error) =>
						error instanceof ReplayedForkFailure && error.auditOperationId === auditOperationId
				},
				() =>
					services.machines.fork(
						result.machine.id,
						result.principal.organizationId,
						projectFor(result.principal),
						count,
						idempotencyKey,
						auditOperationId
					)
			);
			const payload = forked.pending
				? {
						operation: {
							id: forked.operationId,
							state: forked.cleanupPending ? 'cleanup_pending' : 'pending',
							idempotency_key: forked.idempotencyKey,
							source_machine_id: result.machine.id,
							requested: count
						},
						machines: forked.machines.map(machineJson),
						requested: count
					}
				: count === 1
					? machineJson(forked.machines[0]!)
					: {
							machines: forked.machines.map(machineJson),
							requested: count
						};
			return json(
				payload,
				forked.pending ? 202 : forked.replayed ? 200 : 201,
				forked.replayed ? { 'idempotency-replayed': 'true' } : undefined
			);
		} catch (error) {
			if (error instanceof ManagedNetworkEgressUnavailable)
				return problem(501, error.code, error.message, requestId);
			if (error instanceof IdempotencyConflict)
				return problem(409, error.code, error.message, requestId);
			if (error instanceof ReplayedForkFailure)
				return problem(error.status, error.code, error.message, requestId);
			if (error instanceof InvalidMachineRequest || error instanceof SyntaxError)
				return problem(400, 'invalid_request', error.message, requestId);
			if (error instanceof MachineNotForkable)
				return problem(422, error.code, error.message, requestId);
			if (error instanceof QuotaExceeded) return problem(429, error.code, error.message, requestId);
			if (error instanceof BillingAdmissionRejected)
				return problem(429, error.code, error.message, requestId);
			if (error instanceof CapacityUnavailable)
				return problem(503, error.code, error.message, requestId);
			if (error instanceof HostRequestError) {
				return problem(
					error.ambiguous ? 503 : error.status === 422 || error.status === 501 ? 422 : 502,
					error.ambiguous
						? 'host_result_pending'
						: error.status === 422 || error.status === 501
							? 'machine_not_forkable'
							: 'host_request_failed',
					error.ambiguous
						? 'The host result is not yet known; retry with the same Idempotency-Key.'
						: 'The source host rejected the fork request.',
					requestId
				);
			}
			return problem(500, 'internal_error', 'The fork request could not be completed.', requestId);
		}
	});

	router.post('/v1/machines/:id/exec', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:write');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		const body = await readJson<{ command?: string; timeout_seconds?: number }>(request);
		if (!body.command || body.command.length > 65_536) {
			return problem(
				400,
				'invalid_command',
				'command is required and must be at most 64 KiB.',
				requestId
			);
		}
		const timeout = body.timeout_seconds ?? 30;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120) {
			return problem(
				400,
				'invalid_timeout',
				'timeout_seconds must be an integer from 1 to 120.',
				requestId
			);
		}
		try {
			const execution = await services.audit.capture(
				{
					...auditActor(result.principal, request, requestId, result.machine.projectId),
					action: 'machine.exec',
					resourceType: 'machine',
					resourceId: result.machine.id,
					// Deliberately omit the command and all output from audit metadata.
					metadata: { timeout_seconds: timeout },
					complete: (executed) => ({
						outcome: executed ? 'succeeded' : 'denied',
						reasonCode: executed ? undefined : 'machine_not_ready',
						metadata: executed
							? {
									exit_code: executed.exit_code,
									timed_out: executed.timed_out,
									duration_ms: executed.duration_ms
								}
							: undefined
					})
				},
				() =>
					services.machines.exec(
						result.machine.id,
						result.principal.organizationId,
						projectFor(result.principal),
						body.command!,
						timeout
					)
			);
			return execution
				? json(execution)
				: problem(409, 'machine_not_ready', 'The guest agent is not ready.', requestId);
		} catch (error) {
			if (
				error instanceof HostRequestError &&
				error.status === 503 &&
				error.code === 'guest_agent_unavailable' &&
				!error.ambiguous
			) {
				const response = problem(
					503,
					error.code,
					'The managed guest agent is unavailable; serial recovery is not exposed to tenant requests.',
					requestId,
					{ retry_after_seconds: 1 }
				);
				response.headers.set('Retry-After', '1');
				return response;
			}
			if (
				error instanceof HostRequestError &&
				error.status === 429 &&
				error.code === 'guest_operation_capacity_reached' &&
				!error.ambiguous
			) {
				const response = problem(
					429,
					error.code,
					'The host has reached its bounded guest-operation capacity.',
					requestId,
					{ retry_after_seconds: 1 }
				);
				response.headers.set('Retry-After', '1');
				return response;
			}
			throw error;
		}
	});

	router.post('/v1/machines/:id/sessions', async ({ request, params, services, requestId }) => {
		const result = await owned(services, request, params.id!, 'machines:write');
		if (!result) return problem(404, 'not_found', 'Machine not found.', requestId);
		if (!result.machine.ready) {
			await services.audit.record({
				...auditActor(result.principal, request, requestId, result.machine.projectId),
				action: 'machine.session.issue',
				outcome: 'denied',
				reasonCode: 'machine_not_ready',
				resourceType: 'machine',
				resourceId: result.machine.id
			});
			return problem(409, 'machine_not_ready', 'The guest agent is not ready.', requestId);
		}
		const body = await readJson<{
			capabilities?: GatewayCapability[];
			port?: number;
			ttl_seconds?: number;
		}>(request);
		if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
			return problem(
				400,
				'invalid_capability',
				'capabilities must be a nonempty array.',
				requestId
			);
		}
		const requestedCapabilities = [...new Set(body.capabilities ?? ['tty'])];
		if (
			requestedCapabilities.length === 0 ||
			requestedCapabilities.some(
				(value) =>
					typeof value !== 'string' || !gatewayCapabilities.includes(value as GatewayCapability)
			)
		) {
			return problem(400, 'invalid_capability', 'An unknown capability was requested.', requestId);
		}
		const capabilities = canonicalGatewayCapabilities(requestedCapabilities as GatewayCapability[]);
		if (capabilities.includes('agent')) {
			return problem(
				501,
				'not_supported',
				'Managed host-local LLM agents are not supported. Run an agent inside the guest through exec, TTY, and file primitives.',
				requestId
			);
		}
		const portIsValid =
			body.port !== undefined &&
			Number.isSafeInteger(body.port) &&
			body.port >= 1 &&
			body.port <= 65_535;
		if (capabilities.includes('preview') && !portIsValid) {
			return problem(400, 'invalid_port', 'Preview sessions require a valid port.', requestId);
		}
		if (!capabilities.includes('preview') && body.port !== undefined) {
			return problem(400, 'invalid_port', 'port is only valid for preview sessions.', requestId);
		}
		const ttl = body.ttl_seconds ?? 300;
		if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 900) {
			return problem(
				400,
				'invalid_ttl',
				'ttl_seconds must be an integer from 1 to 900.',
				requestId
			);
		}
		const capabilityId = randomUUID();
		const issuerType =
			result.principal.kind === 'user'
				? 'clerk_user'
				: result.principal.deviceFamilyId
					? 'device_family'
					: 'api_key';
		const issuerId =
			result.principal.kind === 'user'
				? result.principal.clerkUserId
				: (result.principal.deviceFamilyId ?? result.principal.apiKeyId);
		let token: string;
		try {
			token = await services.audit.capture(
				{
					...auditActor(result.principal, request, requestId, result.machine.projectId),
					action: 'machine.session.issue',
					resourceType: 'machine',
					resourceId: result.machine.id,
					metadata: { capabilities, port: body.port, ttl_seconds: ttl }
				},
				async () => {
					const grant = await services.database.query<{
						id: string;
						created_at: Date;
						expires_at: Date;
					}>(
						`WITH clock AS MATERIALIZED (
						   SELECT date_trunc('second', statement_timestamp()) AS issued_at
						 ), active_api_key AS MATERIALIZED (
						   SELECT key.id
						   FROM api_keys key
						   JOIN organizations issuer_organization
						     ON issuer_organization.id = key.organization_id
						   CROSS JOIN clock
						   WHERE $9 = 'api_key' AND key.id::text = $10
						     AND key.organization_id = $3
						     AND (key.project_id IS NULL OR key.project_id = $4)
						     AND key.disabled_at IS NULL AND key.revoked_at IS NULL
						     AND issuer_organization.disabled_at IS NULL
						     AND (key.expires_at IS NULL OR key.expires_at > clock.issued_at)
						   FOR SHARE OF key, issuer_organization
						 ), active_device_family AS MATERIALIZED (
						   SELECT family.id
						   FROM device_refresh_families family
						   JOIN device_authorizations device_auth
						     ON device_auth.id = family.device_authorization_id
						   JOIN users approver ON approver.id = device_auth.approved_by
						   JOIN organizations issuer_organization
						     ON issuer_organization.id = family.organization_id
						   JOIN organization_members member
						     ON member.user_id = device_auth.approved_by
						    AND member.organization_id = family.organization_id
						   CROSS JOIN clock
						   WHERE $9 = 'device_family' AND family.id::text = $10
						     AND family.organization_id = $3 AND family.project_id = $4
						     AND family.revoked_at IS NULL AND family.expires_at > clock.issued_at
						     AND approver.disabled_at IS NULL
						     AND issuer_organization.disabled_at IS NULL
						     AND member.role IN ('owner', 'admin', 'member')
						   FOR SHARE OF family, device_auth, approver, issuer_organization, member
						 ), active_clerk_user AS MATERIALIZED (
						   SELECT user_record.id
						   FROM users user_record
						   JOIN organization_members member ON member.user_id = user_record.id
						   JOIN organizations issuer_organization
						     ON issuer_organization.id = member.organization_id
						   WHERE $9 = 'clerk_user' AND user_record.clerk_user_id = $10
						     AND member.organization_id = $3
						     AND user_record.disabled_at IS NULL
						     AND issuer_organization.disabled_at IS NULL
						     AND member.role IN ('owner', 'admin', 'member')
						   FOR SHARE OF user_record, member, issuer_organization
						 )
						 INSERT INTO machine_gateway_grants
						 (id, machine_id, organization_id, project_id, lease_id,
						  capabilities, port, expires_at, created_at, issuer_type, issuer_id)
						 SELECT $1, m.id, m.organization_id, m.project_id, m.lease_id,
						        $6::text[], $7::integer,
						        clock.issued_at + make_interval(secs => $8::integer),
						        clock.issued_at, $9, $10
						 FROM machines m CROSS JOIN clock
						 WHERE m.id = $2 AND m.organization_id = $3 AND m.project_id = $4
						   AND m.lease_id = $5 AND m.state = 'running' AND m.ready = true
						   AND m.expires_at > clock.issued_at
						   AND (EXISTS (SELECT 1 FROM active_api_key)
						     OR EXISTS (SELECT 1 FROM active_device_family)
						     OR EXISTS (SELECT 1 FROM active_clerk_user))
						 RETURNING id, created_at, expires_at`,
						[
							capabilityId,
							result.machine.id,
							result.machine.organizationId,
							result.machine.projectId,
							result.machine.leaseId,
							capabilities,
							body.port ?? null,
							ttl,
							issuerType,
							issuerId
						]
					);
					const persisted = grant.rows[0];
					if (!persisted) throw new MachineSessionLeaseUnavailable();
					return issueCapabilityToken(
						{
							machineId: result.machine.id,
							organizationId: result.machine.organizationId,
							projectId: result.machine.projectId,
							leaseId: result.machine.leaseId,
							capabilities: capabilities as GatewayCapability[],
							port: body.port
						},
						services.gatewaySecret,
						ttl,
						{ capabilityId, issuedAt: persisted.created_at }
					);
				}
			);
		} catch (error) {
			if (error instanceof MachineSessionLeaseUnavailable) {
				return problem(
					409,
					'machine_lease_changed',
					'The machine lease changed while the session was being issued.',
					requestId
				);
			}
			throw error;
		}
		return json(
			{
				id: capabilityId,
				token,
				expires_in: ttl,
				gateway_url: services.gatewayPublicUrl,
				preview_url: capabilities.includes('preview')
					? previewUrl(services, result.machine.id, result.machine.leaseId, body.port!, token)
					: undefined
			},
			200,
			{ 'cache-control': 'no-store' }
		);
	});

	router.delete(
		'/v1/machines/:id/sessions/:sessionId',
		async ({ request, params, services, requestId }) => {
			const result = await owned(services, request, params.id!, 'machines:write');
			if (!result || !uuid.test(params.sessionId!)) {
				return problem(404, 'not_found', 'Machine session not found.', requestId);
			}
			const revoked = await services.audit.capture(
				{
					...auditActor(result.principal, request, requestId, result.machine.projectId),
					action: 'machine.session.revoke',
					resourceType: 'machine_session',
					resourceId: params.sessionId!
				},
				() =>
					services.database.query<{ id: string }>(
						`UPDATE machine_gateway_grants
						 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
						 WHERE id = $1 AND machine_id = $2 AND organization_id = $3
						   AND project_id = $4
						 RETURNING id`,
						[
							params.sessionId!,
							result.machine.id,
							result.machine.organizationId,
							result.machine.projectId
						]
					)
			);
			return revoked.rows[0]
				? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
				: problem(404, 'not_found', 'Machine session not found.', requestId);
		}
	);
};

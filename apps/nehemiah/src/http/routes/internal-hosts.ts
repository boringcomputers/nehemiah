import { timingSafeEqual } from 'node:crypto';
import {
	canonicalGatewayCapabilities,
	gatewayCapabilities,
	type GatewayCapability
} from '../../auth/capability.js';
import type { AuditService } from '../../audit/audit.js';
import {
	MeteringHostLifecycleError,
	MeteringInputError,
	MeteringRateLimitError,
	type AuthoritativeMetering,
	type HostUsageObservation
} from '../../billing/metering.js';
import {
	HostEnrollmentError,
	HostHeartbeatError,
	type HostLifecycle,
	type HostService
} from '../../domain/hosts.js';
import {
	HostCredentialAdmission,
	HostCredentialRateLimitExceeded,
	HostCredentialVerifierBusy
} from '../../auth/host-admission.js';
import { InvalidRuntimeCohort, parseRuntimeCohort } from '../../domain/runtime-cohort.js';
import {
	InvalidStreamAdmission,
	StreamAdmissionRejected,
	StreamRequestRateExceeded,
	type StreamAdmissionService
} from '../../domain/stream-admission.js';
import type { Queryable } from '../../db/client.js';
import { authenticate, canAdminister, type AuthServices, type Principal } from '../auth.js';
import { HttpRequestError, json, problem, readJson, type Router } from '../router.js';

export interface InternalRouteServices extends AuthServices {
	readonly audit: AuditService;
	readonly database: Queryable;
	readonly hosts: HostService;
	readonly metering?: AuthoritativeMetering;
	readonly streamAdmission?: StreamAdmissionService;
	readonly gatewayToken: string;
}

const equal = (left: string | undefined, right: string): boolean => {
	if (!left) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};

const bearer = (request: Request): string | undefined => {
	const value = request.headers.get('authorization');
	return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
};

const gatewayRouteCapabilities = new Set(['tty', 'vnc', 'agent', 'files', 'preview']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostCredentialAdmission = new HostCredentialAdmission();

const authenticateHost = async (
	request: Request,
	hostId: string,
	credential: string | undefined,
	hosts: HostService,
	requestId: string
): Promise<number | Response> => {
	if (!credential) {
		return problem(401, 'unauthorized', 'The host credential is invalid.', requestId);
	}
	try {
		const generation = await hostCredentialAdmission.verify(request, hostId, () =>
			hosts.authenticateGeneration(hostId, credential)
		);
		return generation === undefined
			? problem(401, 'unauthorized', 'The host credential is invalid.', requestId)
			: generation;
	} catch (error) {
		if (error instanceof HostCredentialRateLimitExceeded) {
			const response = problem(429, error.code, error.message, requestId, {
				retry_after_seconds: error.retryAfterSeconds
			});
			response.headers.set('retry-after', String(error.retryAfterSeconds));
			return response;
		}
		if (error instanceof HostCredentialVerifierBusy) {
			const response = problem(503, error.code, error.message, requestId, {
				retry_after_seconds: 1
			});
			response.headers.set('retry-after', '1');
			return response;
		}
		throw error;
	}
};

const lifecycleJson = (host: HostLifecycle): Record<string, unknown> => ({
	id: host.id,
	desired_state: host.desiredState,
	credential_generation: host.credentialGeneration,
	credential_status: host.credentialStatus,
	credential_rotated_at: host.credentialRotatedAt.toISOString(),
	credential_revoked_at: host.credentialRevokedAt?.toISOString(),
	lifecycle_reason: host.lifecycleReason
});

type OperatorPrincipal = Extract<Principal, { readonly kind: 'user' }>;

const operator = async <S extends InternalRouteServices>(
	request: Request,
	services: S,
	requestId: string,
	action: string,
	hostId: string
): Promise<OperatorPrincipal | Response> => {
	const principal = await authenticate(request, services);
	if (!principal) {
		return problem(401, 'unauthorized', 'A valid operator session is required.', requestId);
	}
	if (
		principal.kind !== 'user' ||
		!canAdminister(principal) ||
		!(await services.hosts.isOperatorOrganization(principal.organizationId))
	) {
		await services.audit.record({
			organizationId: principal.organizationId,
			actorType: principal.kind,
			actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
			requestId,
			userAgent: request.headers.get('user-agent') ?? undefined,
			action,
			outcome: 'denied',
			reasonCode: 'fleet_operator_required',
			resourceType: 'host',
			resourceId: hostId
		});
		return problem(
			403,
			'fleet_operator_required',
			'An owner or administrator in an authorized fleet operator organization is required.',
			requestId
		);
	}
	return principal;
};

const reasonBody = async (
	request: Request,
	requestId: string
): Promise<{ reason?: string } | Response> => {
	try {
		const body = await readJson<{ reason?: unknown }>(request);
		if (
			typeof body !== 'object' ||
			body === null ||
			Array.isArray(body) ||
			Object.keys(body).some((key) => key !== 'reason') ||
			(body.reason !== undefined &&
				(typeof body.reason !== 'string' ||
					body.reason.trim().length === 0 ||
					body.reason.length > 512))
		) {
			return problem(
				400,
				'invalid_host_lifecycle_request',
				'reason must be a non-empty string of at most 512 characters.',
				requestId
			);
		}
		return { reason: typeof body.reason === 'string' ? body.reason : undefined };
	} catch (error) {
		return problem(
			400,
			'invalid_host_lifecycle_request',
			error instanceof Error ? error.message : 'The request body is invalid.',
			requestId
		);
	}
};

export const registerInternalHostRoutes = <S extends InternalRouteServices>(
	router: Router<S>
): void => {
	router.post('/internal/v1/hosts/register', async ({ request, services, requestId }) => {
		const enrollmentToken = bearer(request);
		if (!enrollmentToken) {
			return problem(401, 'unauthorized', 'The host enrollment grant is invalid.', requestId);
		}
		await services.apiAdmission?.preAuthenticate(request, enrollmentToken);
		if (!/^nhe_[A-Za-z0-9_-]{43}$/.test(enrollmentToken)) {
			return problem(401, 'unauthorized', 'The host enrollment grant is invalid.', requestId);
		}
		let input: {
			provider_id: string;
			region_id: string;
			address: string;
			architecture: 'x86_64' | 'aarch64';
			control_token: string;
			gateway_token: string;
			total_vcpus: number;
			total_memory_mb: number;
			total_disk_mb: number;
			runtime_cohort: unknown;
		};
		try {
			input = await readJson(request);
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			return problem(400, 'invalid_host_registration', 'The request body is invalid.', requestId);
		}
		const allowedFields = new Set([
			'provider_id',
			'region_id',
			'address',
			'architecture',
			'control_token',
			'gateway_token',
			'total_vcpus',
			'total_memory_mb',
			'total_disk_mb',
			'runtime_cohort'
		]);
		if (
			typeof input !== 'object' ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input).length !== allowedFields.size ||
			Object.keys(input).some((key) => !allowedFields.has(key)) ||
			!['provider_id', 'region_id', 'address', 'control_token', 'gateway_token'].every(
				(key) => typeof Reflect.get(input, key) === 'string'
			) ||
			!['x86_64', 'aarch64'].includes(input.architecture) ||
			![input.total_vcpus, input.total_memory_mb, input.total_disk_mb].every(
				(value) => Number.isSafeInteger(value) && value > 0
			) ||
			input.control_token.length < 32 ||
			input.gateway_token.length < 32
		) {
			return problem(
				400,
				'invalid_host_registration',
				'The host identity, credentials, and positive resource totals are required.',
				requestId
			);
		}
		let runtimeCohort;
		try {
			runtimeCohort = parseRuntimeCohort(input.runtime_cohort, input.architecture);
		} catch (error) {
			if (!(error instanceof InvalidRuntimeCohort)) throw error;
			return problem(400, error.code, error.message, requestId);
		}
		let host;
		try {
			host = await services.audit.capture(
				{
					actorType: 'system',
					actorId: 'host-enrollment',
					requestId,
					userAgent: request.headers.get('user-agent') ?? undefined,
					action: 'host.register',
					resourceType: 'host',
					metadata: {
						provider_id: input.provider_id,
						region_id: input.region_id,
						address: input.address,
						architecture: input.architecture
					},
					complete: (registered) => ({
						resourceId: registered.id,
						metadata: { enrollment_grant_id: registered.grantId }
					})
				},
				() =>
					services.hosts.register(enrollmentToken, {
						providerId: input.provider_id,
						regionId: input.region_id,
						address: input.address,
						architecture: input.architecture,
						controlToken: input.control_token,
						gatewayToken: input.gateway_token,
						totalVcpus: input.total_vcpus,
						totalMemoryMb: input.total_memory_mb,
						totalDiskMb: input.total_disk_mb,
						runtimeCohort
					})
			);
		} catch (error) {
			if (error instanceof HostEnrollmentError) {
				return problem(
					error.code === 'invalid_host_enrollment' ? 400 : 401,
					error.code,
					error.code === 'invalid_host_enrollment'
						? error.message
						: 'The host enrollment grant is invalid or no longer active.',
					requestId
				);
			}
			throw error;
		}
		return json(
			{
				id: host.id,
				credential: host.credential,
				credential_generation: host.credentialGeneration,
				secret_displayed_once: true
			},
			201,
			{ 'cache-control': 'no-store' }
		);
	});

	router.post(
		'/internal/v1/hosts/:id/heartbeat',
		async ({ request, params, services, requestId }) => {
			const credentialGeneration = await authenticateHost(
				request,
				params.id!,
				bearer(request),
				services.hosts,
				requestId
			);
			if (credentialGeneration instanceof Response) return credentialGeneration;
			let body: {
				state: 'ready' | 'draining' | 'unhealthy';
				available_vcpus: number;
				available_memory_mb: number;
				available_disk_mb: number;
				machine_count: number;
				kvm_available: boolean;
				daemon_version: string;
				runtime_cohort: unknown;
			};
			try {
				body = await readJson(request, 16 * 1024);
			} catch (error) {
				if (error instanceof HttpRequestError) {
					return problem(error.status, error.code, error.detail, requestId);
				}
				throw error;
			}
			const fields = new Set([
				'state',
				'available_vcpus',
				'available_memory_mb',
				'available_disk_mb',
				'machine_count',
				'kvm_available',
				'daemon_version',
				'runtime_cohort'
			]);
			if (
				typeof body !== 'object' ||
				body === null ||
				Array.isArray(body) ||
				Object.keys(body).length !== fields.size ||
				Object.keys(body).some((key) => !fields.has(key)) ||
				!['ready', 'draining', 'unhealthy'].includes(String(body.state)) ||
				![
					body.available_vcpus,
					body.available_memory_mb,
					body.available_disk_mb,
					body.machine_count
				].every((value) => Number.isSafeInteger(value) && value >= 0) ||
				typeof body.kvm_available !== 'boolean' ||
				typeof body.daemon_version !== 'string'
			) {
				return problem(
					400,
					'invalid_host_heartbeat',
					'The heartbeat must contain the exact bounded host state, capacity, daemon version, and runtime cohort fields.',
					requestId
				);
			}
			let runtimeCohort;
			try {
				runtimeCohort = parseRuntimeCohort(body.runtime_cohort);
			} catch (error) {
				if (!(error instanceof InvalidRuntimeCohort)) throw error;
				return problem(400, error.code, error.message, requestId);
			}
			let accepted;
			try {
				accepted = await services.hosts.heartbeat(
					params.id!,
					{
						state: body.state,
						availableVcpus: body.available_vcpus,
						availableMemoryMb: body.available_memory_mb,
						availableDiskMb: body.available_disk_mb,
						machineCount: body.machine_count,
						kvmAvailable: body.kvm_available,
						daemonVersion: body.daemon_version,
						runtimeCohort
					},
					credentialGeneration
				);
			} catch (error) {
				if (error instanceof HostHeartbeatError) {
					const response = problem(
						error.code === 'host_heartbeat_rate_limited' ? 429 : 400,
						error.code,
						error.message,
						requestId,
						error.retryAfterSeconds === undefined
							? {}
							: { retry_after_seconds: error.retryAfterSeconds }
					);
					if (error.retryAfterSeconds !== undefined) {
						response.headers.set('retry-after', String(error.retryAfterSeconds));
					}
					return response;
				}
				throw error;
			}
			if (!accepted) {
				return problem(
					409,
					'host_lifecycle_conflict',
					'The host is stale or its desired lifecycle state changed.',
					requestId
				);
			}
			return new Response(null, { status: 204 });
		}
	);

	router.post(
		'/internal/v1/hosts/:id/usage-observations',
		async ({ request, params, services, requestId }) => {
			const credentialGeneration = await authenticateHost(
				request,
				params.id!,
				bearer(request),
				services.hosts,
				requestId
			);
			if (credentialGeneration instanceof Response) return credentialGeneration;
			const metering = services.metering;
			if (!metering) {
				return problem(
					503,
					'metering_unavailable',
					'The authoritative metering ingestor is unavailable.',
					requestId
				);
			}
			let raw: unknown;
			try {
				raw = await readJson(request, 256 * 1024);
			} catch (error) {
				return problem(
					error instanceof Error && 'status' in error && typeof error.status === 'number'
						? error.status
						: 400,
					'invalid_metering_batch',
					'The metering observation batch is invalid.',
					requestId
				);
			}
			if (
				typeof raw !== 'object' ||
				raw === null ||
				Array.isArray(raw) ||
				Object.keys(raw).some((key) => key !== 'observations') ||
				!Array.isArray(Reflect.get(raw, 'observations'))
			) {
				return problem(
					400,
					'invalid_metering_batch',
					'The body must contain only an observations array.',
					requestId
				);
			}
			const fields = new Set([
				'machine_id',
				'host_machine_id',
				'lease_id',
				'lease_generation',
				'host_boot_id',
				'sequence',
				'kind',
				'quality',
				'quality_reason',
				'runtime_ns',
				'egress_bytes',
				'egress_counter_epoch',
				'observed_monotonic_ns',
				'observed_at',
				'vcpus',
				'memory_bytes',
				'process_id'
			]);
			const observations: HostUsageObservation[] = [];
			for (const item of Reflect.get(raw, 'observations') as unknown[]) {
				if (
					typeof item !== 'object' ||
					item === null ||
					Array.isArray(item) ||
					Object.keys(item).length !== fields.size ||
					Object.keys(item).some((key) => !fields.has(key))
				) {
					return problem(
						400,
						'invalid_metering_batch',
						'Every observation must contain exactly the metering contract fields.',
						requestId
					);
				}
				const value = item as Record<string, unknown>;
				if (
					![
						'machine_id',
						'host_machine_id',
						'lease_id',
						'lease_generation',
						'host_boot_id',
						'sequence',
						'kind',
						'quality',
						'quality_reason',
						'runtime_ns',
						'egress_bytes',
						'egress_counter_epoch',
						'observed_monotonic_ns',
						'observed_at',
						'memory_bytes'
					].every((key) => typeof value[key] === 'string') ||
					typeof value.vcpus !== 'number' ||
					typeof value.process_id !== 'number'
				) {
					return problem(
						400,
						'invalid_metering_batch',
						'Meter counters and identifiers must use their documented JSON types.',
						requestId
					);
				}
				observations.push({
					machineId: value.machine_id as string,
					hostMachineId: value.host_machine_id as string,
					leaseId: value.lease_id as string,
					leaseGeneration: value.lease_generation as string,
					hostBootId: value.host_boot_id as string,
					sequence: value.sequence as string,
					kind: value.kind as HostUsageObservation['kind'],
					quality: value.quality as HostUsageObservation['quality'],
					qualityReason: value.quality_reason as HostUsageObservation['qualityReason'],
					runtimeNs: value.runtime_ns as string,
					egressBytes: value.egress_bytes as string,
					egressCounterEpoch: value.egress_counter_epoch as string,
					observedMonotonicNs: value.observed_monotonic_ns as string,
					observedAt: value.observed_at as string,
					vcpus: value.vcpus,
					memoryBytes: value.memory_bytes as string,
					processId: value.process_id
				});
			}
			try {
				const receipts = await metering.ingest(params.id!, observations, credentialGeneration);
				return json({
					receipts: receipts.map((receipt) => ({
						lease_id: receipt.leaseId,
						lease_generation: receipt.leaseGeneration,
						host_boot_id: receipt.hostBootId,
						sequence: receipt.sequence,
						outcome: receipt.outcome,
						acknowledged: receipt.acknowledged
					}))
				});
			} catch (error) {
				if (error instanceof MeteringRateLimitError) {
					const response = problem(429, 'metering_rate_limited', error.message, requestId, {
						retry_after_seconds: error.retryAfterSeconds
					});
					response.headers.set('retry-after', String(error.retryAfterSeconds));
					return response;
				}
				if (error instanceof MeteringInputError) {
					return problem(422, 'invalid_metering_observation', error.message, requestId);
				}
				if (error instanceof MeteringHostLifecycleError) {
					return problem(
						409,
						'host_lifecycle_conflict',
						'The host lifecycle no longer accepts observations.',
						requestId
					);
				}
				throw error;
			}
		}
	);

	router.post('/v1/operator/host-enrollments', async ({ request, services, requestId }) => {
		const principal = await operator(
			request,
			services,
			requestId,
			'host.enrollment.issue',
			'new-host'
		);
		if (principal instanceof Response) return principal;
		let body: Record<string, unknown>;
		try {
			body = await readJson(request);
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			return problem(400, 'invalid_host_enrollment', 'The request body is invalid.', requestId);
		}
		const fields = new Set([
			'provider_id',
			'region_id',
			'address',
			'architecture',
			'total_vcpus',
			'total_memory_mb',
			'total_disk_mb',
			'ttl_seconds',
			'runtime_cohort'
		]);
		if (
			typeof body !== 'object' ||
			body === null ||
			Array.isArray(body) ||
			Object.keys(body).some((key) => !fields.has(key)) ||
			!['provider_id', 'region_id', 'address'].every(
				(key) => typeof body[key] === 'string' && String(body[key]).length > 0
			) ||
			!['x86_64', 'aarch64'].includes(String(body.architecture)) ||
			![body.total_vcpus, body.total_memory_mb, body.total_disk_mb].every(
				(value) => Number.isSafeInteger(value) && Number(value) > 0
			) ||
			(body.ttl_seconds !== undefined &&
				(!Number.isSafeInteger(body.ttl_seconds) ||
					Number(body.ttl_seconds) < 60 ||
					Number(body.ttl_seconds) > 1800))
		) {
			return problem(
				400,
				'invalid_host_enrollment',
				'A provider, region, overlay address, architecture, positive resource totals, and optional 60-1800 second TTL are required.',
				requestId
			);
		}
		let runtimeCohort;
		try {
			runtimeCohort = parseRuntimeCohort(
				body.runtime_cohort,
				body.architecture as 'x86_64' | 'aarch64'
			);
		} catch (error) {
			if (!(error instanceof InvalidRuntimeCohort)) throw error;
			return problem(400, error.code, error.message, requestId);
		}
		try {
			const grant = await services.audit.capture(
				{
					organizationId: principal.organizationId,
					actorType: 'user',
					actorId: principal.clerkUserId,
					requestId,
					userAgent: request.headers.get('user-agent') ?? undefined,
					action: 'host.enrollment.issue',
					resourceType: 'host_enrollment',
					metadata: {
						provider_id: body.provider_id,
						region_id: body.region_id,
						address: body.address,
						architecture: body.architecture
					},
					complete: (issued) => ({
						resourceId: issued.id,
						metadata: {
							host_id: issued.hostId,
							expires_at: issued.expiresAt.toISOString()
						}
					})
				},
				() =>
					services.hosts.issueEnrollment({
						providerId: String(body.provider_id),
						regionId: String(body.region_id),
						address: String(body.address),
						architecture: body.architecture as 'x86_64' | 'aarch64',
						totalVcpus: Number(body.total_vcpus),
						totalMemoryMb: Number(body.total_memory_mb),
						totalDiskMb: Number(body.total_disk_mb),
						ttlSeconds: body.ttl_seconds === undefined ? 600 : Number(body.ttl_seconds),
						issuedByOrganizationId: principal.organizationId,
						issuedByUserId: principal.clerkUserId,
						runtimeCohort
					})
			);
			return json(
				{
					id: grant.id,
					host_id: grant.hostId,
					token: grant.token,
					expires_at: grant.expiresAt.toISOString(),
					secret_displayed_once: true
				},
				201,
				{ 'cache-control': 'no-store' }
			);
		} catch (error) {
			if (error instanceof HostEnrollmentError) {
				return problem(
					error.code === 'host_not_enrollable' ? 409 : 400,
					error.code,
					error.message,
					requestId
				);
			}
			throw error;
		}
	});

	router.post(
		'/v1/operator/host-enrollments/:id/revoke',
		async ({ request, params, services, requestId }) => {
			if (!uuid.test(params.id!)) {
				return problem(
					400,
					'invalid_host_enrollment',
					'A valid enrollment ID is required.',
					requestId
				);
			}
			const principal = await operator(
				request,
				services,
				requestId,
				'host.enrollment.revoke',
				params.id!
			);
			if (principal instanceof Response) return principal;
			const revoked = await services.audit.capture(
				{
					organizationId: principal.organizationId,
					actorType: 'user',
					actorId: principal.clerkUserId,
					requestId,
					userAgent: request.headers.get('user-agent') ?? undefined,
					action: 'host.enrollment.revoke',
					resourceType: 'host_enrollment',
					resourceId: params.id!,
					complete: (accepted) =>
						accepted ? {} : { outcome: 'denied', reasonCode: 'host_enrollment_not_active' }
				},
				() => services.hosts.revokeEnrollment(params.id!)
			);
			return revoked
				? new Response(null, { status: 204 })
				: problem(
						409,
						'host_enrollment_not_active',
						'The enrollment grant is unknown or no longer active.',
						requestId
					);
		}
	);

	// This is a private fleet-admin surface and is intentionally omitted from the
	// customer OpenAPI. Global authority requires both a dashboard owner/admin role
	// and explicit membership of the selected organization in the operator allowlist.
	for (const operation of [
		{
			path: 'drain',
			action: 'host.drain',
			run: (hosts: HostService, id: string, reason?: string) => hosts.drain(id, reason)
		},
		{
			path: 'activate',
			action: 'host.activate',
			run: (hosts: HostService, id: string, reason?: string) => hosts.activate(id, reason)
		},
		{
			path: 'quarantine',
			action: 'host.quarantine',
			run: (hosts: HostService, id: string, reason?: string) => hosts.quarantine(id, reason)
		},
		{
			path: 'revoke',
			action: 'host.revoke',
			run: (hosts: HostService, id: string, reason?: string) => hosts.revoke(id, reason)
		}
	] as const) {
		router.post(
			`/v1/operator/hosts/:id/${operation.path}`,
			async ({ request, params, services, requestId }) => {
				const principal = await operator(
					request,
					services,
					requestId,
					operation.action,
					params.id!
				);
				if (principal instanceof Response) return principal;
				const body = await reasonBody(request, requestId);
				if (body instanceof Response) return body;
				const host = await services.audit.capture(
					{
						organizationId: principal.organizationId,
						actorType: 'user',
						actorId: principal.clerkUserId,
						requestId,
						userAgent: request.headers.get('user-agent') ?? undefined,
						action: operation.action,
						resourceType: 'host',
						resourceId: params.id!,
						complete: (result) =>
							result
								? { metadata: { desired_state: result.desiredState } }
								: { outcome: 'denied', reasonCode: 'host_transition_denied' }
					},
					() => operation.run(services.hosts, params.id!, body.reason)
				);
				return host
					? json({ host: lifecycleJson(host) })
					: problem(
							409,
							'host_transition_denied',
							'The host does not exist or cannot make that lifecycle transition.',
							requestId
						);
			}
		);
	}

	router.post(
		'/v1/operator/hosts/:id/credentials/rotate',
		async ({ request, params, services, requestId }) => {
			const principal = await operator(
				request,
				services,
				requestId,
				'host.credentials.rotate',
				params.id!
			);
			if (principal instanceof Response) return principal;
			let body: { control_token?: unknown; gateway_token?: unknown; reason?: unknown };
			try {
				body = await readJson(request);
			} catch (error) {
				return problem(
					400,
					'invalid_host_credential_rotation',
					error instanceof Error ? error.message : 'The request body is invalid.',
					requestId
				);
			}
			if (
				typeof body !== 'object' ||
				body === null ||
				Array.isArray(body) ||
				Object.keys(body).some(
					(key) => !['control_token', 'gateway_token', 'reason'].includes(key)
				) ||
				typeof body.control_token !== 'string' ||
				body.control_token.length < 32 ||
				typeof body.gateway_token !== 'string' ||
				body.gateway_token.length < 32 ||
				body.control_token === body.gateway_token ||
				(body.reason !== undefined &&
					(typeof body.reason !== 'string' ||
						body.reason.trim().length === 0 ||
						body.reason.length > 512))
			) {
				return problem(
					400,
					'invalid_host_credential_rotation',
					'control_token and gateway_token must be distinct and contain at least 32 characters; reason is optional and bounded to 512 characters.',
					requestId
				);
			}
			const controlToken = body.control_token;
			const gatewayToken = body.gateway_token;
			const reason = typeof body.reason === 'string' ? body.reason : undefined;
			const host = await services.audit.capture(
				{
					organizationId: principal.organizationId,
					actorType: 'user',
					actorId: principal.clerkUserId,
					requestId,
					userAgent: request.headers.get('user-agent') ?? undefined,
					action: 'host.credentials.rotate',
					resourceType: 'host',
					resourceId: params.id!,
					complete: (result) =>
						result
							? { metadata: { credential_generation: result.credentialGeneration } }
							: { outcome: 'denied', reasonCode: 'host_credential_rotation_denied' }
				},
				() => services.hosts.rotateCredentials(params.id!, { controlToken, gatewayToken }, reason)
			);
			if (!host) {
				return problem(
					409,
					'host_credential_rotation_denied',
					'A revoked or unknown host cannot rotate credentials.',
					requestId
				);
			}
			return json(
				{
					host: lifecycleJson(host),
					credential: host.credential,
					secret_displayed_once: true
				},
				200,
				{ 'cache-control': 'no-store' }
			);
		}
	);

	router.get(
		'/internal/v1/routing/machines/:id',
		async ({ request, params, services, requestId }) => {
			if (!equal(bearer(request), services.gatewayToken)) {
				return problem(401, 'unauthorized', 'The gateway credential is invalid.', requestId);
			}
			const capability = request.headers.get('x-nehemiah-capability');
			const capabilityId = request.headers.get('x-nehemiah-capability-id');
			const capabilityListText = request.headers.get('x-nehemiah-capabilities');
			const capabilityOrganizationId = request.headers.get('x-nehemiah-capability-organization-id');
			const capabilityProjectId = request.headers.get('x-nehemiah-capability-project-id');
			const capabilityLeaseId = request.headers.get('x-nehemiah-capability-lease-id');
			const capabilityExpiresAtText = request.headers.get('x-nehemiah-capability-expires-at');
			const portText = request.headers.get('x-nehemiah-preview-port');
			const streamId = request.headers.get('x-nehemiah-stream-id');
			const streamInstanceId = request.headers.get('x-nehemiah-stream-instance-id');
			const streamBandwidthText = request.headers.get(
				'x-nehemiah-stream-bandwidth-bytes-per-second'
			);
			const streamBandwidth = Number(streamBandwidthText);
			const port = portText === null ? undefined : Number(portText);
			const requestedCapabilities = capabilityListText?.split(',') ?? [];
			const capabilities = canonicalGatewayCapabilities(
				requestedCapabilities.filter((value): value is GatewayCapability =>
					gatewayCapabilities.includes(value as GatewayCapability)
				)
			);
			const capabilityExpiresAt = capabilityExpiresAtText
				? new Date(capabilityExpiresAtText)
				: undefined;
			if (
				!capability ||
				!gatewayRouteCapabilities.has(capability) ||
				!capabilityId ||
				!uuid.test(capabilityId) ||
				!capabilityOrganizationId ||
				!uuid.test(capabilityOrganizationId) ||
				!capabilityProjectId ||
				!uuid.test(capabilityProjectId) ||
				!capabilityLeaseId ||
				!uuid.test(capabilityLeaseId) ||
				requestedCapabilities.length === 0 ||
				requestedCapabilities.length !== capabilities.length ||
				capabilityListText !== capabilities.join(',') ||
				!capabilities.includes(capability as GatewayCapability) ||
				!capabilityExpiresAt ||
				Number.isNaN(capabilityExpiresAt.getTime()) ||
				capabilityExpiresAt.getTime() % 1_000 !== 0 ||
				!streamId ||
				!uuid.test(streamId) ||
				!streamInstanceId ||
				!Number.isSafeInteger(streamBandwidth) ||
				streamBandwidth < 1 ||
				streamBandwidth > 1_073_741_824 ||
				(capabilities.includes('preview')
					? !Number.isSafeInteger(port) || port! < 1 || port! > 65_535
					: portText !== null)
			) {
				return problem(
					400,
					'invalid_route_capability',
					'The complete signed capability scope and exact preview port are required.',
					requestId
				);
			}
			if (!services.streamAdmission) {
				return problem(
					503,
					'stream_admission_unavailable',
					'Global stream admission is unavailable.',
					requestId
				);
			}
			try {
				await services.streamAdmission.admitRouteRequest({
					id: streamId,
					organizationId: capabilityOrganizationId,
					projectId: capabilityProjectId,
					authorityKind: 'machine_capability',
					authorityId: capabilityId,
					instanceId: streamInstanceId,
					bandwidthBytesPerSecond: streamBandwidth
				});
			} catch (error) {
				if (error instanceof StreamRequestRateExceeded) {
					const response = problem(429, error.code, error.message, requestId, {
						retry_after_seconds: error.retryAfterSeconds
					});
					response.headers.set('retry-after', String(error.retryAfterSeconds));
					return response;
				}
				if (error instanceof InvalidStreamAdmission) {
					return problem(400, error.code, error.message, requestId);
				}
				throw error;
			}
			const result = await services.database.query<{
				host_id: string;
				host_address: string;
				host_machine_id: string;
				lease_id: string;
				organization_id: string;
				project_id: string;
				expires_at: Date;
				capability_id: string;
				capabilities: string[];
				capability_port: number | null;
				capability_expires_at: Date;
			}>(
				`SELECT h.id AS host_id, host(h.address) AS host_address,
				        m.host_machine_id, m.lease_id, m.organization_id::text,
				        m.project_id::text,
				        LEAST(m.expires_at, g.expires_at) AS expires_at,
				        g.id::text AS capability_id, g.capabilities,
				        g.port AS capability_port, g.expires_at AS capability_expires_at
				 FROM machines m JOIN hosts h ON h.id = m.host_id
				 JOIN machine_gateway_grants g
				   ON g.id = $3::uuid AND g.machine_id = m.id
				  AND g.organization_id = m.organization_id AND g.project_id = m.project_id
				  AND g.lease_id = m.lease_id AND $2 = ANY(g.capabilities)
				  AND g.capabilities = $4::text[]
				  AND g.port IS NOT DISTINCT FROM $5::integer
				  AND g.expires_at = $6::timestamptz
				  AND g.organization_id = $7::uuid AND g.project_id = $8::uuid
				  AND g.lease_id = $9::uuid
				  AND g.revoked_at IS NULL AND g.expires_at > statement_timestamp()
				 WHERE m.id = $1 AND m.state = 'running' AND m.ready = true
				   AND m.expires_at > now() AND h.state IN ('ready', 'draining')
				   AND h.desired_state IN ('active', 'draining')
				   AND h.credential_status = 'active'
				   AND h.last_heartbeat_at > now() - interval '30 seconds'
				   AND $6::timestamptz > statement_timestamp()
				   AND CASE g.issuer_type
				     WHEN 'api_key' THEN EXISTS (
				       SELECT 1 FROM api_keys key
				       JOIN organizations issuer_organization
				         ON issuer_organization.id = key.organization_id
				       WHERE key.id::text = g.issuer_id
				         AND key.organization_id = g.organization_id
				         AND (key.project_id IS NULL OR key.project_id = g.project_id)
				         AND key.disabled_at IS NULL AND key.revoked_at IS NULL
				         AND issuer_organization.disabled_at IS NULL
				         AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
				     )
					 WHEN 'device_family' THEN EXISTS (
					   SELECT 1 FROM device_refresh_families family
					   JOIN device_authorizations device_auth
					     ON device_auth.id = family.device_authorization_id
					   JOIN users approver ON approver.id = device_auth.approved_by
					   JOIN organizations issuer_organization
					     ON issuer_organization.id = family.organization_id
					   JOIN organization_members member
					     ON member.user_id = device_auth.approved_by
					    AND member.organization_id = family.organization_id
					   WHERE family.id::text = g.issuer_id
					     AND family.organization_id = g.organization_id
					     AND family.project_id = g.project_id
					     AND family.revoked_at IS NULL
					     AND family.expires_at > statement_timestamp()
					     AND approver.disabled_at IS NULL
					     AND issuer_organization.disabled_at IS NULL
					     AND member.role IN ('owner', 'admin', 'member')
					 )
				     WHEN 'clerk_user' THEN EXISTS (
				       SELECT 1 FROM users user_record
				       JOIN organization_members member ON member.user_id = user_record.id
				       JOIN organizations issuer_organization
				         ON issuer_organization.id = member.organization_id
					   WHERE user_record.clerk_user_id = g.issuer_id
					     AND member.organization_id = g.organization_id
					     AND user_record.disabled_at IS NULL
					     AND issuer_organization.disabled_at IS NULL
					     AND member.role IN ('owner', 'admin', 'member')
					 )
				     ELSE false
				   END`,
				[
					params.id!,
					capability,
					capabilityId,
					capabilities,
					port ?? null,
					capabilityExpiresAt,
					capabilityOrganizationId,
					capabilityProjectId,
					capabilityLeaseId
				]
			);
			const route = result.rows[0];
			if (!route)
				return problem(404, 'route_not_found', 'No live route exists for this machine.', requestId);
			const hostToken = await services.hosts.gatewayCredential(route.host_id);
			if (!hostToken) {
				return problem(
					502,
					'host_credential_unavailable',
					'The host route is not usable.',
					requestId
				);
			}
			let stream;
			try {
				stream = await services.streamAdmission.acquire({
					id: streamId,
					organizationId: route.organization_id,
					projectId: route.project_id,
					authorityKind: 'machine_capability',
					authorityId: route.capability_id,
					instanceId: streamInstanceId,
					bandwidthBytesPerSecond: streamBandwidth
				});
			} catch (error) {
				if (error instanceof StreamAdmissionRejected) {
					return problem(429, error.code, error.message, requestId);
				}
				if (error instanceof InvalidStreamAdmission) {
					return problem(400, error.code, error.message, requestId);
				}
				throw error;
			}
			return json(
				{
					host_address: route.host_address,
					host_machine_id: route.host_machine_id,
					lease_id: route.lease_id,
					organization_id: route.organization_id,
					project_id: route.project_id,
					expires_at: route.expires_at.toISOString(),
					capability_id: route.capability_id,
					capabilities: route.capabilities,
					capability_port: route.capability_port ?? undefined,
					capability_expires_at: route.capability_expires_at.toISOString(),
					stream_id: stream.id,
					stream_bandwidth_bytes_per_second: stream.bandwidthBytesPerSecond,
					stream_expires_at: stream.expiresAt.toISOString(),
					host_token: hostToken
				},
				200,
				{ 'cache-control': 'no-store' }
			);
		}
	);

	router.delete(
		'/internal/v1/routing/streams/:id',
		async ({ request, params, services, requestId }) => {
			if (!equal(bearer(request), services.gatewayToken)) {
				return problem(401, 'unauthorized', 'The gateway credential is invalid.', requestId);
			}
			const instanceId = request.headers.get('x-nehemiah-stream-instance-id');
			if (!services.streamAdmission || !params.id || !instanceId) {
				return problem(
					503,
					'stream_admission_unavailable',
					'Global stream admission is unavailable.',
					requestId
				);
			}
			try {
				await services.streamAdmission.release(params.id, instanceId);
			} catch (error) {
				if (error instanceof InvalidStreamAdmission) {
					return problem(400, error.code, error.message, requestId);
				}
				throw error;
			}
			return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
		}
	);
};

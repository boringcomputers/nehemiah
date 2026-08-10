import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { hash, verify } from '@node-rs/argon2';
import { HostCredentialCipher } from './host-credentials.js';
import { InvalidRuntimeCohort, parseRuntimeCohort, runtimeCohortWire } from './runtime-cohort.js';
export class HostEnrollmentError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class HostHeartbeatError extends Error {
    code;
    retryAfterSeconds;
    constructor(code, message, retryAfterSeconds) {
        super(message);
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
const positive = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be positive`);
};
const lifecycle = (row) => ({
    id: row.id,
    desiredState: row.desired_state,
    credentialGeneration: row.credential_generation,
    credentialStatus: row.credential_status,
    credentialRotatedAt: row.credential_rotated_at,
    credentialRevokedAt: row.credential_revoked_at ?? undefined,
    lifecycleReason: row.lifecycle_reason ?? undefined
});
const lifecycleReturning = `id, desired_state, credential_generation, credential_status,
	credential_rotated_at, credential_revoked_at, lifecycle_reason`;
const checkedReason = (reason, fallback) => {
    const normalized = reason.trim() || fallback;
    if (normalized.length > 512)
        throw new Error('host lifecycle reason must not exceed 512 characters');
    return normalized;
};
const newHostCredential = async () => {
    const credential = `nh_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const credentialHash = await hash(credential, {
        algorithm: 2 /* Algorithm.Argon2id */,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1
    });
    return { credential, credentialHash };
};
const validateHostCredentials = (controlToken, gatewayToken, enrollmentToken) => {
    if (controlToken.length < 32 ||
        gatewayToken.length < 32 ||
        controlToken === gatewayToken ||
        controlToken === enrollmentToken ||
        gatewayToken === enrollmentToken) {
        throw new HostEnrollmentError('invalid_host_enrollment', 'host control, gateway, and enrollment credentials must be strong and distinct');
    }
};
const enrollmentTokenHash = (token) => createHash('sha256').update(token, 'utf8').digest();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validateHostIdentity = (input, allowedAddresses) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.providerId)) {
        throw new HostEnrollmentError('invalid_host_enrollment', 'providerId is required and invalid');
    }
    for (const [name, value, maximum] of [
        ['totalVcpus', input.totalVcpus, 4096],
        ['totalMemoryMb', input.totalMemoryMb, 16_777_216],
        ['totalDiskMb', input.totalDiskMb, 9_007_199_254_740_991]
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
            throw new HostEnrollmentError('invalid_host_enrollment', `${name} must be a bounded positive integer`);
        }
    }
    const addressVersion = isIP(input.address);
    if (addressVersion === 0 ||
        !allowedAddresses.check(input.address, addressVersion === 4 ? 'ipv4' : 'ipv6')) {
        throw new HostEnrollmentError('invalid_host_enrollment', 'host address must be a literal IP in the managed overlay network');
    }
};
const validateCohort = (cohort, architecture) => {
    try {
        return parseRuntimeCohort(runtimeCohortWire(cohort), architecture);
    }
    catch (error) {
        throw new HostEnrollmentError('invalid_host_enrollment', error instanceof InvalidRuntimeCohort ? error.message : 'runtime cohort is invalid');
    }
};
export class HostService {
    database;
    credentialCipher;
    expectedDaemonVersion;
    #allowedAddresses = new BlockList();
    constructor(database, credentialCipher = new HostCredentialCipher('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='), allowedCidrs = [
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        'fd00::/8'
    ], expectedDaemonVersion) {
        this.database = database;
        this.credentialCipher = credentialCipher;
        this.expectedDaemonVersion = expectedDaemonVersion;
        if (expectedDaemonVersion !== undefined &&
            !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(expectedDaemonVersion)) {
            throw new Error('expected managed-host daemon version is invalid');
        }
        for (const cidr of allowedCidrs) {
            const [network, prefixText, extra] = cidr.split('/');
            const version = network ? isIP(network) : 0;
            const prefix = Number(prefixText);
            if (!network ||
                extra !== undefined ||
                !Number.isSafeInteger(prefix) ||
                (version === 4 && (prefix < 0 || prefix > 32)) ||
                (version === 6 && (prefix < 0 || prefix > 128)) ||
                version === 0) {
                throw new Error(`invalid managed-host CIDR: ${cidr}`);
            }
            this.#allowedAddresses.addSubnet(network, prefix, version === 4 ? 'ipv4' : 'ipv6');
        }
    }
    async register(enrollmentToken, input) {
        validateHostIdentity(input, this.#allowedAddresses);
        const cohort = validateCohort(input.runtimeCohort, input.architecture);
        if (!/^nhe_[A-Za-z0-9_-]{43}$/.test(enrollmentToken)) {
            throw new HostEnrollmentError('invalid_enrollment_grant', 'The host enrollment grant is invalid or no longer active.');
        }
        validateHostCredentials(input.controlToken, input.gatewayToken, enrollmentToken);
        const tokenHash = enrollmentTokenHash(enrollmentToken);
        const eligible = await this.database.query(`SELECT 1 FROM host_enrollment_grants
			 WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL
			   AND expires_at > statement_timestamp()
			   AND provider_id = $2 AND region_id = $3 AND address = $4::inet
				   AND architecture = $5 AND total_vcpus = $6
				   AND total_memory_mb = $7 AND total_disk_mb = $8
				   AND runtime_cohort_id = $9 AND runtime_contract_version = $10
				   AND runtime_arch = $11 AND runtime_kernel_sha256 = $12
				   AND runtime_firecracker_sha256 = $13 AND runtime_jailer_sha256 = $14
				   AND runtime_python_rootfs_sha256 = $15
				   AND runtime_desktop_rootfs_sha256 = $16`, [
            tokenHash,
            input.providerId,
            input.regionId,
            input.address,
            input.architecture,
            input.totalVcpus,
            input.totalMemoryMb,
            input.totalDiskMb,
            cohort.id,
            cohort.contractVersion,
            cohort.arch,
            cohort.kernelSha256,
            cohort.firecrackerSha256,
            cohort.jailerSha256,
            cohort.pythonRootfsSha256,
            cohort.desktopRootfsSha256
        ]);
        if (!eligible.rowCount) {
            throw new HostEnrollmentError('invalid_enrollment_grant', 'The host enrollment grant is invalid or no longer active.');
        }
        const controlCredentialCiphertext = this.credentialCipher.encrypt(input.controlToken);
        const gatewayCredentialCiphertext = this.credentialCipher.encrypt(input.gatewayToken);
        const { credential, credentialHash } = await newHostCredential();
        const result = await this.database.query(`WITH provider_lock AS MATERIALIZED (
			 SELECT pg_advisory_xact_lock(hashtextextended($2, 684752901))
			), claimed AS (
			 UPDATE host_enrollment_grants
			 SET consumed_at = statement_timestamp()
			 FROM provider_lock
			 WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL
			   AND expires_at > statement_timestamp()
				   AND provider_id = $2 AND region_id = $3 AND address = $4::inet
				   AND architecture = $5 AND total_vcpus = $9
				   AND total_memory_mb = $10 AND total_disk_mb = $11
				   AND runtime_cohort_id = $12 AND runtime_contract_version = $13
				   AND runtime_arch = $14 AND runtime_kernel_sha256 = $15
				   AND runtime_firecracker_sha256 = $16 AND runtime_jailer_sha256 = $17
				   AND runtime_python_rootfs_sha256 = $18
				   AND runtime_desktop_rootfs_sha256 = $19
				 RETURNING id, host_id
			), registered AS (
				 INSERT INTO hosts
				 (id, provider_id, region_id, address, architecture, state, credential_hash,
				  control_credential_ciphertext, gateway_credential_ciphertext,
				  total_vcpus, total_memory_mb, total_disk_mb,
				  runtime_cohort_id, runtime_contract_version, runtime_arch,
				  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
				  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
				 SELECT claimed.host_id, $2, $3, $4, $5, 'unhealthy', $6, $7, $8, $9, $10, $11,
				        $12, $13, $14, $15, $16, $17, $18, $19
			 FROM claimed
			 ON CONFLICT (provider_id) DO UPDATE SET
			   region_id = EXCLUDED.region_id, address = EXCLUDED.address,
			   architecture = EXCLUDED.architecture, state = 'unhealthy',
			   credential_hash = EXCLUDED.credential_hash,
			   control_credential_ciphertext = EXCLUDED.control_credential_ciphertext,
			   gateway_credential_ciphertext = EXCLUDED.gateway_credential_ciphertext,
			   credential_generation = hosts.credential_generation + 1,
			   credential_status = 'active', credential_rotated_at = now(),
			   credential_revoked_at = NULL,
				   total_vcpus = EXCLUDED.total_vcpus,
				   total_memory_mb = EXCLUDED.total_memory_mb,
				   total_disk_mb = EXCLUDED.total_disk_mb,
				   runtime_cohort_id = EXCLUDED.runtime_cohort_id,
				   runtime_contract_version = EXCLUDED.runtime_contract_version,
				   runtime_arch = EXCLUDED.runtime_arch,
				   runtime_kernel_sha256 = EXCLUDED.runtime_kernel_sha256,
				   runtime_firecracker_sha256 = EXCLUDED.runtime_firecracker_sha256,
				   runtime_jailer_sha256 = EXCLUDED.runtime_jailer_sha256,
				   runtime_python_rootfs_sha256 = EXCLUDED.runtime_python_rootfs_sha256,
				   runtime_desktop_rootfs_sha256 = EXCLUDED.runtime_desktop_rootfs_sha256,
				   updated_at = now()
			 WHERE hosts.id = EXCLUDED.id
			   AND hosts.enrollment_completed_at IS NULL
			   AND hosts.desired_state = 'active'
			   AND hosts.credential_status = 'active'
			 RETURNING hosts.id, hosts.credential_generation
			)
			SELECT registered.id, registered.credential_generation, claimed.id AS grant_id
			FROM registered CROSS JOIN claimed`, [
            tokenHash,
            input.providerId,
            input.regionId,
            input.address,
            input.architecture,
            credentialHash,
            controlCredentialCiphertext,
            gatewayCredentialCiphertext,
            input.totalVcpus,
            input.totalMemoryMb,
            input.totalDiskMb,
            cohort.id,
            cohort.contractVersion,
            cohort.arch,
            cohort.kernelSha256,
            cohort.firecrackerSha256,
            cohort.jailerSha256,
            cohort.pythonRootfsSha256,
            cohort.desktopRootfsSha256
        ]);
        const registered = result.rows[0];
        if (!registered) {
            throw new HostEnrollmentError('invalid_enrollment_grant', 'The host enrollment grant is invalid or no longer active.');
        }
        return {
            id: registered.id,
            grantId: registered.grant_id,
            credential,
            credentialGeneration: registered.credential_generation
        };
    }
    async issueEnrollment(input) {
        validateHostIdentity(input, this.#allowedAddresses);
        const cohort = validateCohort(input.runtimeCohort, input.architecture);
        if (!Number.isSafeInteger(input.ttlSeconds) ||
            input.ttlSeconds < 60 ||
            input.ttlSeconds > 1800) {
            throw new HostEnrollmentError('invalid_host_enrollment', 'ttlSeconds must be an integer between 60 and 1800');
        }
        if (!uuid.test(input.issuedByOrganizationId) || !input.issuedByUserId.trim()) {
            throw new HostEnrollmentError('invalid_host_enrollment', 'an issuing organization and user are required');
        }
        const id = randomUUID();
        const reservedHostId = randomUUID();
        const token = `nhe_${randomBytes(32).toString('base64url')}`;
        const result = await this.database.query(`WITH provider_lock AS MATERIALIZED (
			 SELECT pg_advisory_xact_lock(hashtextextended($2, 684752901))
			), existing AS MATERIALIZED (
			 SELECT h.* FROM hosts h, provider_lock WHERE h.provider_id = $2 FOR UPDATE OF h
			), eligible AS MATERIALIZED (
			 SELECT COALESCE((SELECT id FROM existing), $12::uuid) AS host_id
			 FROM regions r, provider_lock
			 WHERE r.id = $3 AND r.enabled = true
			   AND NOT EXISTS (
			     SELECT 1 FROM existing h
			     WHERE h.enrollment_completed_at IS NOT NULL
			        OR h.desired_state <> 'active'
			        OR h.credential_status <> 'active'
			        OR h.region_id <> $3 OR h.address <> $4::inet
			        OR h.architecture <> $5
			   )
			), revoked AS (
			 UPDATE host_enrollment_grants g
			 SET revoked_at = statement_timestamp()
			 FROM eligible
			 WHERE g.provider_id = $2 AND g.consumed_at IS NULL AND g.revoked_at IS NULL
			 RETURNING g.id
			), revocation_barrier AS MATERIALIZED (
			 SELECT count(*) AS revoked_count FROM revoked
			), inserted AS (
			 INSERT INTO host_enrollment_grants
			  (id, token_hash, host_id, provider_id, region_id, address, architecture,
			   total_vcpus, total_memory_mb, total_disk_mb, issued_by_organization_id,
			   issued_by_user_id, expires_at, runtime_cohort_id, runtime_contract_version,
			   runtime_arch, runtime_kernel_sha256, runtime_firecracker_sha256,
			   runtime_jailer_sha256, runtime_python_rootfs_sha256,
			   runtime_desktop_rootfs_sha256)
			 SELECT $1, $13, eligible.host_id, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			        statement_timestamp() + ($11 * interval '1 second'),
			        $14, $15, $16, $17, $18, $19, $20, $21
			 FROM eligible CROSS JOIN revocation_barrier
			 RETURNING id, host_id, expires_at
			)
			SELECT id, host_id, expires_at FROM inserted`, [
            id,
            input.providerId,
            input.regionId,
            input.address,
            input.architecture,
            input.totalVcpus,
            input.totalMemoryMb,
            input.totalDiskMb,
            input.issuedByOrganizationId,
            input.issuedByUserId,
            input.ttlSeconds,
            reservedHostId,
            enrollmentTokenHash(token),
            cohort.id,
            cohort.contractVersion,
            cohort.arch,
            cohort.kernelSha256,
            cohort.firecrackerSha256,
            cohort.jailerSha256,
            cohort.pythonRootfsSha256,
            cohort.desktopRootfsSha256
        ]);
        const grant = result.rows[0];
        if (!grant) {
            throw new HostEnrollmentError('host_not_enrollable', 'The provider host is already enrolled or is not eligible for enrollment.');
        }
        return { id: grant.id, hostId: grant.host_id, token, expiresAt: grant.expires_at };
    }
    async revokeEnrollment(grantId) {
        const result = await this.database.query(`UPDATE host_enrollment_grants
			 SET revoked_at = statement_timestamp()
			 WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
			 RETURNING id`, [grantId]);
        return Boolean(result.rowCount);
    }
    async gatewayCredential(hostId) {
        const result = await this.database.query(`SELECT gateway_credential_ciphertext FROM hosts
			 WHERE id = $1 AND state <> 'stale'
			   AND desired_state IN ('active', 'draining')
			   AND credential_status = 'active'`, [hostId]);
        const envelope = result.rows[0]?.gateway_credential_ciphertext;
        return envelope ? this.credentialCipher.decrypt(envelope) : undefined;
    }
    async authenticate(hostId, credential) {
        return (await this.authenticateGeneration(hostId, credential)) !== undefined;
    }
    async authenticateGeneration(hostId, credential) {
        const result = await this.database.query(`SELECT credential_hash, credential_generation FROM hosts
			 WHERE id = $1 AND state <> 'stale'
			   AND desired_state IN ('active', 'draining')
			   AND credential_status = 'active'`, [hostId]);
        const row = result.rows[0];
        return row?.credential_hash && (await verify(row.credential_hash, credential))
            ? row.credential_generation
            : undefined;
    }
    async heartbeat(hostId, heartbeat, credentialGeneration) {
        positive(credentialGeneration, 'credentialGeneration');
        for (const [name, value] of Object.entries({
            availableVcpus: heartbeat.availableVcpus,
            availableMemoryMb: heartbeat.availableMemoryMb,
            availableDiskMb: heartbeat.availableDiskMb,
            machineCount: heartbeat.machineCount
        })) {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new HostHeartbeatError('invalid_host_heartbeat', `${name} must be a bounded non-negative integer`);
            }
        }
        if (heartbeat.machineCount > 10_000 ||
            heartbeat.availableVcpus > 4_096 ||
            heartbeat.availableMemoryMb > 16_777_216 ||
            heartbeat.availableDiskMb > Number.MAX_SAFE_INTEGER ||
            !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(heartbeat.daemonVersion)) {
            throw new HostHeartbeatError('invalid_host_heartbeat', 'heartbeat capacity or daemon version is invalid');
        }
        if (this.expectedDaemonVersion !== undefined &&
            heartbeat.daemonVersion !== this.expectedDaemonVersion) {
            throw new HostHeartbeatError('invalid_host_heartbeat', 'heartbeat daemon version is not approved for this control-plane release');
        }
        let cohort;
        try {
            cohort = parseRuntimeCohort(runtimeCohortWire(heartbeat.runtimeCohort));
        }
        catch (error) {
            throw new HostHeartbeatError('invalid_host_heartbeat', error instanceof Error ? error.message : 'runtime cohort is invalid');
        }
        const state = heartbeat.kvmAvailable ? heartbeat.state : 'unhealthy';
        const result = await this.database.query(`WITH current_host AS MATERIALIZED (
			 SELECT * FROM hosts
			 WHERE id = $1 AND state <> 'stale'
			   AND desired_state IN ('active', 'draining')
			   AND credential_status = 'active' AND credential_generation = $9
			 FOR UPDATE
			), classified AS MATERIALIZED (
			 SELECT current_host.*,
			   runtime_cohort_id = $10 AND runtime_contract_version = $11
			     AND runtime_arch = $12 AND runtime_kernel_sha256 = $13
			     AND runtime_firecracker_sha256 = $14 AND runtime_jailer_sha256 = $15
			     AND runtime_python_rootfs_sha256 = $16
			     AND runtime_desktop_rootfs_sha256 = $17 AS cohort_matches,
			   $4::integer <= total_vcpus AND $5::integer <= total_memory_mb
			     AND $6::bigint <= total_disk_mb AS resources_valid,
			   last_heartbeat_at IS NULL
			     OR last_heartbeat_at <= statement_timestamp() - interval '5 seconds' AS cadence_valid
			 FROM current_host
			), updated AS (
			 UPDATE hosts host
			 SET state = CASE
			       WHEN host.state = 'stale' THEN 'stale'::host_state
			       WHEN $2::host_state = 'unhealthy' THEN 'unhealthy'::host_state
			       WHEN host.desired_state = 'draining' THEN 'draining'::host_state
			       ELSE $2::host_state
			     END,
			     last_heartbeat_at = statement_timestamp(),
			     enrollment_completed_at = COALESCE(host.enrollment_completed_at, statement_timestamp()),
			     daemon_version = $3,
			     reported_available_vcpus = $4,
			     reported_available_memory_mb = $5,
			     reported_available_disk_mb = $6,
			     reported_machine_count = $7, updated_at = statement_timestamp()
			 FROM classified
			 WHERE host.id = classified.id AND classified.cohort_matches
			   AND classified.resources_valid AND classified.cadence_valid
			 RETURNING host.id, host.state
			), sampled AS (
			INSERT INTO host_heartbeats
			 (host_id, state, available_vcpus, available_memory_mb, available_disk_mb,
			  machine_count, kvm_available, daemon_version, credential_generation,
			  runtime_cohort_id, runtime_contract_version, runtime_arch,
			  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
			  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256, sample_slot)
			SELECT id, state, $4, $5, $6, $7, $8, $3, $9,
			       $10, $11, $12, $13, $14, $15, $16, $17,
			       mod(floor(extract(epoch FROM statement_timestamp()) / 300)::bigint, 1024)::integer
			FROM updated
			ON CONFLICT (host_id, sample_slot) DO UPDATE SET
			 observed_at = EXCLUDED.observed_at, state = EXCLUDED.state,
			 available_vcpus = EXCLUDED.available_vcpus,
			 available_memory_mb = EXCLUDED.available_memory_mb,
			 available_disk_mb = EXCLUDED.available_disk_mb,
			 machine_count = EXCLUDED.machine_count,
			 kvm_available = EXCLUDED.kvm_available,
			 daemon_version = EXCLUDED.daemon_version,
			 credential_generation = EXCLUDED.credential_generation,
			 runtime_cohort_id = EXCLUDED.runtime_cohort_id,
			 runtime_contract_version = EXCLUDED.runtime_contract_version,
			 runtime_arch = EXCLUDED.runtime_arch,
			 runtime_kernel_sha256 = EXCLUDED.runtime_kernel_sha256,
			 runtime_firecracker_sha256 = EXCLUDED.runtime_firecracker_sha256,
			 runtime_jailer_sha256 = EXCLUDED.runtime_jailer_sha256,
			 runtime_python_rootfs_sha256 = EXCLUDED.runtime_python_rootfs_sha256,
			 runtime_desktop_rootfs_sha256 = EXCLUDED.runtime_desktop_rootfs_sha256
			RETURNING host_id
			)
			SELECT CASE
			 WHEN NOT EXISTS (SELECT 1 FROM current_host) THEN 'conflict'
			 WHEN NOT (SELECT cohort_matches AND resources_valid FROM classified) THEN 'invalid'
			 WHEN NOT (SELECT cadence_valid FROM classified) THEN 'rate_limited'
			 WHEN EXISTS (SELECT 1 FROM sampled) THEN 'accepted'
			 ELSE 'conflict'
			END AS result`, [
            hostId,
            state,
            heartbeat.daemonVersion,
            heartbeat.availableVcpus,
            heartbeat.availableMemoryMb,
            heartbeat.availableDiskMb,
            heartbeat.machineCount,
            heartbeat.kvmAvailable,
            credentialGeneration,
            cohort.id,
            cohort.contractVersion,
            cohort.arch,
            cohort.kernelSha256,
            cohort.firecrackerSha256,
            cohort.jailerSha256,
            cohort.pythonRootfsSha256,
            cohort.desktopRootfsSha256
        ]);
        const outcome = result.rows[0]?.result ?? 'conflict';
        if (outcome === 'invalid') {
            throw new HostHeartbeatError('invalid_host_heartbeat', 'heartbeat capacity or runtime cohort does not match the enrolled host');
        }
        if (outcome === 'rate_limited') {
            throw new HostHeartbeatError('host_heartbeat_rate_limited', 'heartbeat cadence exceeds the durable per-host limit', 5);
        }
        return outcome === 'accepted';
    }
    async markStale(staleAfterMs) {
        const result = await this.database.query(`UPDATE hosts SET state = 'stale', updated_at = now()
			 WHERE state IN ('ready', 'draining', 'unhealthy')
			   AND desired_state IN ('active', 'draining')
			   AND credential_status = 'active'
			   AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 * interval '1 millisecond'))
			 RETURNING id`, [staleAfterMs]);
        return result.rows.map((row) => row.id);
    }
    async setDraining(hostId, draining) {
        return Boolean(draining ? await this.drain(hostId) : await this.activate(hostId));
    }
    async isOperatorOrganization(organizationId) {
        const result = await this.database.query('SELECT 1 FROM fleet_operator_organizations WHERE organization_id = $1', [organizationId]);
        return Boolean(result.rowCount);
    }
    async drain(hostId, reason = 'operator requested drain') {
        const result = await this.database.query(`UPDATE hosts
			 SET desired_state = 'draining',
			     state = CASE WHEN state = 'ready' THEN 'draining'::host_state ELSE 'unhealthy'::host_state END,
			     lifecycle_reason = $2, lifecycle_updated_at = now(), updated_at = now()
			 WHERE id = $1 AND desired_state NOT IN ('quarantined', 'revoked')
			   AND credential_status = 'active'
			 RETURNING ${lifecycleReturning}`, [hostId, checkedReason(reason, 'operator requested drain')]);
        return result.rows[0] ? lifecycle(result.rows[0]) : undefined;
    }
    async activate(hostId, reason = 'operator requested activation') {
        const result = await this.database.query(`UPDATE hosts
			 SET desired_state = 'active', state = 'unhealthy',
			     reported_available_vcpus = NULL, reported_available_memory_mb = NULL,
			     reported_available_disk_mb = NULL, reported_machine_count = NULL,
			     lifecycle_reason = $2, lifecycle_updated_at = now(), updated_at = now()
			 WHERE id = $1 AND desired_state <> 'revoked' AND credential_status = 'active'
			 RETURNING ${lifecycleReturning}`, [hostId, checkedReason(reason, 'operator requested activation')]);
        return result.rows[0] ? lifecycle(result.rows[0]) : undefined;
    }
    async quarantine(hostId, reason = 'operator quarantined host') {
        const result = await this.database.query(`UPDATE hosts
			 SET desired_state = 'quarantined', state = 'stale', credential_status = 'revoked',
			     credential_hash = NULL, control_credential_ciphertext = NULL,
			     gateway_credential_ciphertext = NULL,
			     credential_revoked_at = COALESCE(credential_revoked_at, now()),
			     reported_available_vcpus = 0, reported_available_memory_mb = 0,
			     reported_available_disk_mb = 0, reported_machine_count = NULL,
			     lifecycle_reason = $2, lifecycle_updated_at = now(), updated_at = now()
			 WHERE id = $1 AND desired_state <> 'revoked'
			 RETURNING ${lifecycleReturning}`, [hostId, checkedReason(reason, 'operator quarantined host')]);
        return result.rows[0] ? lifecycle(result.rows[0]) : undefined;
    }
    async revoke(hostId, reason = 'operator revoked host') {
        const result = await this.database.query(`UPDATE hosts
			 SET desired_state = 'revoked', state = 'stale', credential_status = 'revoked',
			     credential_hash = NULL, control_credential_ciphertext = NULL,
			     gateway_credential_ciphertext = NULL,
			     credential_revoked_at = COALESCE(credential_revoked_at, now()),
			     reported_available_vcpus = 0, reported_available_memory_mb = 0,
			     reported_available_disk_mb = 0, reported_machine_count = NULL,
			     lifecycle_reason = $2, lifecycle_updated_at = now(), updated_at = now()
			 WHERE id = $1
			 RETURNING ${lifecycleReturning}`, [hostId, checkedReason(reason, 'operator revoked host')]);
        return result.rows[0] ? lifecycle(result.rows[0]) : undefined;
    }
    async rotateCredentials(hostId, input, reason = 'operator rotated host credentials') {
        validateHostCredentials(input.controlToken, input.gatewayToken);
        const controlCredentialCiphertext = this.credentialCipher.encrypt(input.controlToken);
        const gatewayCredentialCiphertext = this.credentialCipher.encrypt(input.gatewayToken);
        const { credential, credentialHash } = await newHostCredential();
        const result = await this.database.query(`UPDATE hosts
			 SET desired_state = CASE
			       WHEN desired_state = 'quarantined' THEN desired_state
			       ELSE 'draining'::host_desired_state
			     END,
			     state = CASE
			       WHEN desired_state = 'quarantined' THEN 'stale'::host_state
			       ELSE 'unhealthy'::host_state
			     END,
			     credential_hash = $2, control_credential_ciphertext = $3,
			     gateway_credential_ciphertext = $4,
			     credential_generation = credential_generation + 1,
			     credential_status = 'active', credential_rotated_at = now(),
			     credential_revoked_at = NULL, lifecycle_reason = $5,
			     reported_available_vcpus = NULL, reported_available_memory_mb = NULL,
			     reported_available_disk_mb = NULL, reported_machine_count = NULL,
			     lifecycle_updated_at = now(), updated_at = now()
			 WHERE id = $1 AND desired_state <> 'revoked'
			 RETURNING ${lifecycleReturning}`, [
            hostId,
            credentialHash,
            controlCredentialCiphertext,
            gatewayCredentialCiphertext,
            checkedReason(reason, 'operator rotated host credentials')
        ]);
        return result.rows[0] ? { ...lifecycle(result.rows[0]), credential } : undefined;
    }
}
//# sourceMappingURL=hosts.js.map
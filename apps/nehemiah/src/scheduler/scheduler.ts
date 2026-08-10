import type { PoolClient } from 'pg';
import { BillingAdmissionPolicy } from '../billing/admission.js';
import { Database } from '../db/client.js';
import { validateResources, type Resources } from './capacity.js';

export interface ScheduleRequest {
	readonly organizationId: string;
	readonly projectId: string;
	readonly region: string;
	readonly architecture: 'x86_64' | 'aarch64';
	readonly resources: Resources;
	readonly templateId?: string;
	readonly machineId?: string;
}

export interface Reservation {
	readonly hostId: string;
	readonly address: string;
	readonly cachedTemplate: boolean;
	readonly runtimeCohortId?: string;
	readonly sourceSha256?: string;
	/** True when the scheduler atomically persisted the machine assignment. */
	readonly assignmentCommitted?: boolean;
}

export class CapacityUnavailable extends Error {
	readonly code = 'capacity_unavailable';
}

export class QuotaExceeded extends Error {
	readonly code = 'quota_exceeded';
}

type ProjectLimits = {
	max_machines: number;
	max_vcpus: number;
	max_memory_mb: number;
	max_disk_mb: string;
};

type OrganizationLimits = {
	max_machines: number;
	max_vcpus: number;
	max_memory_mb: number;
	max_disk_mb: string;
};

type ProjectUsage = {
	machines: string;
	vcpus: string;
	memory_mb: string;
	disk_mb: string;
};

export class Scheduler {
	constructor(
		private readonly database: Database,
		private readonly billingAdmission = new BillingAdmissionPolicy()
	) {}

	async reserve(request: ScheduleRequest): Promise<Reservation> {
		validateResources(request.resources);
		return this.database.transaction(async (client) => {
			await this.enforceQuota(client, request);
			const selected = await client.query<{
				id: string;
				address: string;
				cached_template: boolean;
				runtime_cohort_id: string | null;
				source_sha256: string | null;
			}>(
				`SELECT h.id, host(h.address) AS address,
				        COALESCE(tr.state = 'ready', false) AS cached_template,
				        h.runtime_cohort_id,
				        CASE
				          WHEN $7::text IS NULL THEN NULL
				          WHEN candidate.template_id IS NOT NULL
				            THEN regexp_replace(t.checksum, '^sha256:', '')
				          WHEN candidate.template_name = 'python' THEN h.runtime_python_rootfs_sha256
				          WHEN candidate.template_name = 'desktop' THEN h.runtime_desktop_rootfs_sha256
				          ELSE NULL
				        END AS source_sha256
				 FROM hosts h
				 LEFT JOIN templates requested_template
				   ON requested_template.id = $6 AND requested_template.deleted_at IS NULL
				 LEFT JOIN template_replicas tr
				   ON tr.host_id = h.id AND tr.template_id = requested_template.id
				 LEFT JOIN machines candidate ON candidate.id = $7
				 LEFT JOIN templates t
				   ON t.id = candidate.template_id AND t.deleted_at IS NULL
				 WHERE h.region_id = $1 AND h.architecture = $2 AND h.state = 'ready'
				   AND h.desired_state = 'active' AND h.credential_status = 'active'
				   AND h.last_heartbeat_at > now() - interval '30 seconds'
				   AND LEAST(h.total_vcpus - h.reserved_vcpus,
				             COALESCE(h.reported_available_vcpus, h.total_vcpus - h.reserved_vcpus)) >= $3
				   AND LEAST(h.total_memory_mb - h.reserved_memory_mb,
				             COALESCE(h.reported_available_memory_mb, h.total_memory_mb - h.reserved_memory_mb)) >= $4
				   AND LEAST(h.total_disk_mb - h.reserved_disk_mb,
				             COALESCE(h.reported_available_disk_mb, h.total_disk_mb - h.reserved_disk_mb)) >= $5
				   AND ($6::uuid IS NULL OR
				        (requested_template.id IS NOT NULL AND tr.state = 'ready'))
				   AND ($7::text IS NULL OR (
				     candidate.id IS NOT NULL
				     AND h.runtime_cohort_id IS NOT NULL
				     AND CASE
				       WHEN candidate.template_id IS NOT NULL
				         THEN regexp_replace(t.checksum, '^sha256:', '')
				       WHEN candidate.template_name = 'python' THEN h.runtime_python_rootfs_sha256
				       WHEN candidate.template_name = 'desktop' THEN h.runtime_desktop_rootfs_sha256
				       ELSE NULL
				     END ~ '^[0-9a-f]{64}$'
				   ))
				 ORDER BY cached_template DESC,
				          (h.total_memory_mb - h.reserved_memory_mb - $4) ASC,
				          (h.total_vcpus - h.reserved_vcpus - $3) ASC,
				          h.id ASC
				 FOR UPDATE OF h SKIP LOCKED LIMIT 1`,
				[
					request.region,
					request.architecture,
					request.resources.vcpus,
					request.resources.memoryMb,
					request.resources.diskMb,
					request.templateId ?? null,
					request.machineId ?? null
				]
			);
			const host = selected.rows[0];
			if (!host) throw new CapacityUnavailable('No healthy host has enough reserved capacity.');
			await client.query(
				`UPDATE hosts SET
				 reserved_vcpus = reserved_vcpus + $2,
				 reserved_memory_mb = reserved_memory_mb + $3,
				 reserved_disk_mb = reserved_disk_mb + $4,
				 updated_at = now()
				 WHERE id = $1`,
				[host.id, request.resources.vcpus, request.resources.memoryMb, request.resources.diskMb]
			);
			if (request.machineId) {
				const assigned = await client.query<{ organization_id: string }>(
					`UPDATE machines SET host_id = $2, runtime_cohort_id = $3,
					     source_sha256 = $4, state = 'starting', placed_at = now(),
						 startup_deadline_at = now() + interval '2 minutes'
						 WHERE id = $1 AND state IN ('requested', 'placing')
					 RETURNING organization_id`,
					[request.machineId, host.id, host.runtime_cohort_id, host.source_sha256]
				);
				const machine = assigned.rows[0];
				if (!machine) throw new Error('machine could not be assigned atomically');
				await client.query(
					`INSERT INTO machine_events
					 (event_key, machine_id, organization_id, from_state, to_state, observed_by)
					 VALUES ($1, $2, $3, 'requested', 'starting', 'control-plane')
					 ON CONFLICT (event_key) DO NOTHING`,
					[`${request.machineId}:assigned`, request.machineId, machine.organization_id]
				);
			}
			return {
				hostId: host.id,
				address: host.address,
				cachedTemplate: host.cached_template,
				runtimeCohortId: host.runtime_cohort_id ?? undefined,
				sourceSha256: host.source_sha256 ?? undefined,
				assignmentCommitted: Boolean(request.machineId)
			};
		});
	}

	async release(hostId: string, resources: Resources, machineId?: string): Promise<void> {
		await this.database.transaction(async (client) => {
			if (machineId) {
				const claimed = await client.query(
					`UPDATE machines SET reservation_released_at = now()
					 WHERE id = $1 AND reservation_released_at IS NULL`,
					[machineId]
				);
				if (!claimed.rowCount) return;
			}
			await client.query(
				`UPDATE hosts SET
				 reserved_vcpus = GREATEST(0, reserved_vcpus - $2),
				 reserved_memory_mb = GREATEST(0, reserved_memory_mb - $3),
				 reserved_disk_mb = GREATEST(0, reserved_disk_mb - $4),
				 updated_at = now()
				 WHERE id = $1`,
				[hostId, resources.vcpus, resources.memoryMb, resources.diskMb]
			);
		});
	}

	private async enforceQuota(client: PoolClient, request: ScheduleRequest): Promise<void> {
		// All admission paths take the organization lock before the project lock.
		// This serializes sibling projects and prevents creating projects from
		// multiplying the organization's machine/resource allowance.
		const organizationResult = await client.query<OrganizationLimits>(
			`SELECT o.max_machines, o.max_vcpus, o.max_memory_mb, o.max_disk_mb
			 FROM organizations o
			 WHERE o.id = $1 FOR UPDATE OF o`,
			[request.organizationId]
		);
		const organizationLimits = organizationResult.rows[0];
		if (!organizationLimits) throw new QuotaExceeded('Organization does not exist.');
		let candidateSeconds = 0n;
		if (request.machineId) {
			const candidate = await client.query<{ remaining_seconds: string }>(
				`SELECT CEIL(GREATEST(
				   EXTRACT(EPOCH FROM (expires_at - statement_timestamp())), 0
				 ))::numeric::text AS remaining_seconds
				 FROM machines
				 WHERE id = $1 AND organization_id = $2 AND project_id = $3
				   AND state IN ('requested', 'placing')`,
				[request.machineId, request.organizationId, request.projectId]
			);
			if (candidate.rows[0]) candidateSeconds = BigInt(candidate.rows[0].remaining_seconds);
		}
		await this.billingAdmission.enforce(client, request.organizationId, {
			vcpuSeconds: candidateSeconds * BigInt(request.resources.vcpus),
			memoryMebibyteSeconds: candidateSeconds * BigInt(request.resources.memoryMb)
		});
		const limitsResult = await client.query<ProjectLimits>(
			`SELECT max_machines, max_vcpus, max_memory_mb, max_disk_mb FROM projects
			 WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
			[request.projectId, request.organizationId]
		);
		const limits = limitsResult.rows[0];
		if (!limits) throw new QuotaExceeded('Project does not belong to this organization.');
		const usageResult = await client.query<ProjectUsage>(
			`SELECT count(*) AS machines, COALESCE(sum(vcpus), 0) AS vcpus,
			        COALESCE(sum(memory_mb), 0) AS memory_mb,
			        COALESCE(sum(disk_mb), 0) AS disk_mb
			 FROM machines WHERE project_id = $1
			 AND state NOT IN ('requested', 'placing', 'stopped', 'failed', 'lost')`,
			[request.projectId]
		);
		const usage = usageResult.rows[0]!;
		const organizationUsageResult = await client.query<ProjectUsage>(
			`SELECT count(*) AS machines, COALESCE(sum(vcpus), 0) AS vcpus,
			        COALESCE(sum(memory_mb), 0) AS memory_mb,
			        COALESCE(sum(disk_mb), 0) AS disk_mb
			 FROM machines WHERE organization_id = $1
			 AND state NOT IN ('requested', 'placing', 'stopped', 'failed', 'lost')`,
			[request.organizationId]
		);
		const organizationUsage = organizationUsageResult.rows[0]!;
		if (
			Number(organizationUsage.machines) + 1 > organizationLimits.max_machines ||
			Number(organizationUsage.vcpus) + request.resources.vcpus > organizationLimits.max_vcpus ||
			Number(organizationUsage.memory_mb) + request.resources.memoryMb >
				organizationLimits.max_memory_mb ||
			Number(organizationUsage.disk_mb) + request.resources.diskMb >
				Number(organizationLimits.max_disk_mb)
		) {
			throw new QuotaExceeded('Organization machine quota would be exceeded.');
		}
		if (
			Number(usage.machines) + 1 > limits.max_machines ||
			Number(usage.vcpus) + request.resources.vcpus > limits.max_vcpus ||
			Number(usage.memory_mb) + request.resources.memoryMb > limits.max_memory_mb ||
			Number(usage.disk_mb) + request.resources.diskMb > Number(limits.max_disk_mb)
		) {
			throw new QuotaExceeded('Project machine quota would be exceeded.');
		}
	}
}

import { randomUUID } from 'node:crypto';
export const defaultProjectsPerOrganization = 16;
export const maximumProjectsPerOrganization = 64;
export class ProjectQuotaExceeded extends Error {
    code = 'project_quota_exceeded';
    status = 429;
    retryAfterSeconds = 86_400;
}
export class ProjectSlugConflict extends Error {
    code = 'project_slug_conflict';
    status = 409;
}
export class ProjectAllocationIntegrityError extends Error {
    code = 'project_allocation_integrity_failed';
}
const projectColumns = `id, organization_id, slug, name, max_machines, max_vcpus,
	max_memory_mb, max_disk_mb, max_storage_mb`;
const projectFromRow = (row) => {
    const maxDiskMb = typeof row.max_disk_mb === 'number' ? row.max_disk_mb : Number(row.max_disk_mb);
    const maxStorageMb = typeof row.max_storage_mb === 'number' ? row.max_storage_mb : Number(row.max_storage_mb);
    if (!Number.isSafeInteger(maxDiskMb) || maxDiskMb < 0) {
        throw new Error('project max_disk_mb is outside the JSON safe-integer range');
    }
    if (!Number.isSafeInteger(maxStorageMb) || maxStorageMb < 0) {
        throw new Error('project max_storage_mb is outside the JSON safe-integer range');
    }
    return {
        id: row.id,
        organization_id: row.organization_id,
        slug: row.slug,
        name: row.name,
        max_machines: row.max_machines,
        max_vcpus: row.max_vcpus,
        max_memory_mb: row.max_memory_mb,
        max_disk_mb: maxDiskMb,
        max_storage_mb: maxStorageMb
    };
};
const validOrganizationLimit = (value) => Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximumProjectsPerOrganization;
const postgresConstraint = (error, code, constraint) => typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code &&
    Reflect.get(error, 'constraint') === constraint;
const findBySlug = async (database, organizationId, slug) => {
    const existing = await database.query(`SELECT ${projectColumns}
		 FROM projects WHERE organization_id = $1 AND slug = $2`, [organizationId, slug]);
    return existing.rows[0] ? projectFromRow(existing.rows[0]) : undefined;
};
const replayOrConflict = (existing, normalizedName) => {
    if (existing.name.trim() !== normalizedName) {
        throw new ProjectSlugConflict('This project slug is already used with a different normalized name.');
    }
    return { project: existing, replayed: true };
};
export class ProjectService {
    database;
    constructor(database) {
        this.database = database;
    }
    async list(organizationId, projectId) {
        const result = await this.database.query(`SELECT project.id, project.organization_id, project.slug, project.name,
			        project.max_machines, project.max_vcpus, project.max_memory_mb,
			        project.max_disk_mb, project.max_storage_mb,
			        organization.max_projects AS organization_max_projects,
			        (
			          SELECT count(*)::integer
			            FROM (
			              SELECT 1 FROM projects retained
			               WHERE retained.organization_id = project.organization_id
			               LIMIT $3
			            ) bounded_retained
			        ) AS organization_project_count
			 FROM projects project
			 JOIN organizations organization ON organization.id = project.organization_id
			 WHERE project.organization_id = $1
			   AND ($2::uuid IS NULL OR project.id = $2)
			 ORDER BY project.name, project.id
			 LIMIT $3`, [organizationId, projectId ?? null, maximumProjectsPerOrganization + 1]);
        const boundary = result.rows[0];
        if (boundary &&
            (!validOrganizationLimit(boundary.organization_max_projects) ||
                !Number.isSafeInteger(boundary.organization_project_count) ||
                boundary.organization_project_count < 0 ||
                boundary.organization_project_count > boundary.organization_max_projects ||
                result.rows.length > boundary.organization_max_projects)) {
            throw new ProjectAllocationIntegrityError('The retained project allocation invariant is not valid.');
        }
        return result.rows.map(projectFromRow);
    }
    async belongsToOrganization(projectId, organizationId) {
        const result = await this.database.query('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [projectId, organizationId]);
        return Boolean(result.rowCount);
    }
    async create(input) {
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug))
            throw new Error('invalid project slug');
        const normalizedName = input.name.trim();
        if (!normalizedName || input.name.length > 160)
            throw new Error('invalid project name');
        try {
            return await this.database.transaction(async (client) => {
                const organization = await client.query('SELECT max_projects FROM organizations WHERE id = $1 FOR UPDATE', [input.organizationId]);
                const organizationLimit = organization.rows[0]?.max_projects;
                if (!validOrganizationLimit(organizationLimit)) {
                    throw new ProjectAllocationIntegrityError('The organization project limit is unavailable or invalid.');
                }
                const existing = await findBySlug(client, input.organizationId, input.slug);
                if (existing)
                    return replayOrConflict(existing, normalizedName);
                const retained = await client.query(`SELECT count(*)::integer AS count
					 FROM (
					   SELECT 1 FROM projects WHERE organization_id = $1 LIMIT $2
					 ) bounded_projects`, [input.organizationId, organizationLimit + 1]);
                const retainedCount = retained.rows[0]?.count;
                if (!Number.isSafeInteger(retainedCount) || Number(retainedCount) < 0) {
                    throw new ProjectAllocationIntegrityError('The retained project count is unavailable or invalid.');
                }
                if (Number(retainedCount) >= organizationLimit) {
                    throw new ProjectQuotaExceeded('This organization has reached its retained project limit.');
                }
                const result = await client.query(`INSERT INTO projects (id, organization_id, slug, name)
					 VALUES ($1, $2, $3, $4)
					 RETURNING ${projectColumns}`, [randomUUID(), input.organizationId, input.slug, normalizedName]);
                return { project: projectFromRow(result.rows[0]), replayed: false };
            });
        }
        catch (error) {
            if (error instanceof ProjectQuotaExceeded ||
                postgresConstraint(error, '23514', 'projects_organization_retained_quota')) {
                throw new ProjectQuotaExceeded('This organization has reached its retained project limit.');
            }
            if (postgresConstraint(error, '23505', 'projects_organization_id_slug_key')) {
                const existing = await findBySlug(this.database, input.organizationId, input.slug);
                if (existing)
                    return replayOrConflict(existing, normalizedName);
            }
            throw error;
        }
    }
}
//# sourceMappingURL=projects.js.map
export class ProjectService {
    database;
    constructor(database) {
        this.database = database;
    }
    async list(organizationId) {
        const result = await this.database.query(`SELECT id, organization_id, slug, name, max_machines, max_vcpus,
			        max_memory_mb, max_storage_mb
			 FROM projects WHERE organization_id = $1 ORDER BY name`, [organizationId]);
        return result.rows;
    }
    async belongsToOrganization(projectId, organizationId) {
        const result = await this.database.query('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [projectId, organizationId]);
        return Boolean(result.rowCount);
    }
}
//# sourceMappingURL=projects.js.map
export class OrganizationService {
    database;
    constructor(database) {
        this.database = database;
    }
    async listForUser(clerkUserId) {
        const result = await this.database.query(`SELECT o.id, o.slug, o.name
			 FROM organizations o
			 JOIN organization_members om ON om.organization_id = o.id
			 JOIN users u ON u.id = om.user_id
			 WHERE u.clerk_user_id = $1
			   AND u.disabled_at IS NULL AND o.disabled_at IS NULL
			 ORDER BY o.name`, [clerkUserId]);
        return result.rows;
    }
    async userEnabled(clerkUserId) {
        const result = await this.database.query('SELECT 1 FROM users WHERE clerk_user_id = $1 AND disabled_at IS NULL', [clerkUserId]);
        return Boolean(result.rowCount);
    }
    async membershipRole(clerkUserId, organizationId) {
        const result = await this.database.query(`SELECT om.role FROM organization_members om
			 JOIN users u ON u.id = om.user_id
			 JOIN organizations o ON o.id = om.organization_id
			 WHERE u.clerk_user_id = $1 AND om.organization_id = $2
			   AND u.disabled_at IS NULL AND o.disabled_at IS NULL`, [clerkUserId, organizationId]);
        return result.rows[0]?.role;
    }
}
//# sourceMappingURL=organizations.js.map
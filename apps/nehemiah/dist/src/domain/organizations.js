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
			 WHERE u.clerk_user_id = $1 ORDER BY o.name`, [clerkUserId]);
        return result.rows;
    }
    async userCanAccess(clerkUserId, organizationId) {
        const result = await this.database.query(`SELECT 1 FROM organization_members om
			 JOIN users u ON u.id = om.user_id
			 WHERE u.clerk_user_id = $1 AND om.organization_id = $2`, [clerkUserId, organizationId]);
        return Boolean(result.rowCount);
    }
}
//# sourceMappingURL=organizations.js.map
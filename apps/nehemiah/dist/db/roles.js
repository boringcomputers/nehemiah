const rolePattern = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
export const databaseRoleFromUrl = (raw) => {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error('database URL is invalid');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new Error('database URL must use postgres:// or postgresql://');
    }
    const role = decodeURIComponent(parsed.username);
    if (!rolePattern.test(role))
        throw new Error('database URL must contain a safe PostgreSQL role name');
    return role;
};
const quoteRole = (role) => {
    if (!rolePattern.test(role))
        throw new Error('invalid PostgreSQL runtime role name');
    return `"${role}"`;
};
/**
 * Give the runtime exactly the data privileges it needs while keeping schema
 * ownership, DDL, migration metadata, and append-only ledger mutation with the
 * migration role. This is rerun after every migration so newly created objects
 * cannot accidentally inherit PostgreSQL's broad PUBLIC defaults.
 */
export const applyRuntimeRolePrivileges = async (database, runtimeRole) => {
    const role = quoteRole(runtimeRole);
    await database.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await database.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC');
    await database.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC');
    await database.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC');
    await database.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await database.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await database.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON schema_migrations FROM ${role}`);
    for (const ledger of [
        'machine_events',
        'usage_events',
        'audit_events',
        'host_usage_observations',
        'meter_raw_usage_events',
        'metering_exceptions',
        'metering_exception_resolutions',
        'identity_provider_sync_receipts'
    ]) {
        await database.query(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ${ledger} FROM ${role}`);
    }
    await database.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
		 ON device_retention_capacity FROM ${role}`);
    // Future tables/sequences created by this migration owner receive the same
    // narrow runtime grants. A later migration still reruns the explicit grants
    // above, which covers environments whose owner changed intentionally.
    await database.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC');
    await database.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC');
    await database.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC');
    await database.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await database.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
};
export const assertSeparatedDatabaseRoles = async (database, runtimeRole) => {
    const result = await database.query(`
		SELECT current_user,
		       pg_get_userbyid(datdba) AS database_owner
		FROM pg_database
		WHERE datname = current_database()
	`);
    const row = result.rows[0];
    if (!row)
        throw new Error('could not inspect PostgreSQL role ownership');
    if (row.current_user === runtimeRole) {
        throw new Error('migration and runtime PostgreSQL roles must be distinct');
    }
    if (row.database_owner === runtimeRole) {
        throw new Error('runtime PostgreSQL role must not own the database');
    }
};
//# sourceMappingURL=roles.js.map
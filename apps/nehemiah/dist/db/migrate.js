import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './client.js';
import { productionDatabaseUrlIssue } from './url.js';
import { applyRuntimeRolePrivileges, assertSeparatedDatabaseRoles, databaseRoleFromUrl } from './roles.js';
const migrationLockKey = 1_315_269_989;
const checksum = (contents) => createHash('sha256').update(contents).digest('hex');
const run = async () => {
    const production = process.env.NEHEMIAH_ENV === 'production' || process.env.NODE_ENV === 'production';
    const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim() ||
        (production ? '' : 'postgres://postgres:postgres@127.0.0.1:5432/nehemiah');
    if (!runtimeDatabaseUrl)
        throw new Error('DATABASE_URL is required in production');
    const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim() || runtimeDatabaseUrl;
    if (production) {
        for (const [name, value] of [
            ['DATABASE_URL', runtimeDatabaseUrl],
            ['MIGRATION_DATABASE_URL', migrationDatabaseUrl]
        ]) {
            const issue = productionDatabaseUrlIssue(value);
            if (issue)
                throw new Error(`${name} ${issue}`);
        }
    }
    if (production && migrationDatabaseUrl === runtimeDatabaseUrl) {
        throw new Error('MIGRATION_DATABASE_URL must use a separate migration role in production');
    }
    const runtimeRole = databaseRoleFromUrl(runtimeDatabaseUrl);
    const database = new Database(migrationDatabaseUrl);
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDirectory, 'migrations'),
        join(moduleDirectory, '../../src/db/migrations')
    ];
    let directory;
    for (const candidate of candidates) {
        try {
            await access(candidate);
            directory = candidate;
            break;
        }
        catch {
            // Try the source-tree fallback used by local builds.
        }
    }
    if (!directory)
        throw new Error('database migration directory is missing');
    try {
        if (migrationDatabaseUrl !== runtimeDatabaseUrl) {
            await assertSeparatedDatabaseRoles(database, runtimeRole);
        }
        const names = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
        const migrations = await Promise.all(names.map(async (name) => {
            const sql = await readFile(join(directory, name), 'utf8');
            return { name, sql, checksum: checksum(sql) };
        }));
        const migrated = await database.withAdvisoryLock(migrationLockKey, async (client) => {
            await client.query(`
				CREATE TABLE IF NOT EXISTS schema_migrations (
					name text PRIMARY KEY,
					checksum text,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
			`);
            await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
            const unknown = await client.query(`SELECT name FROM schema_migrations
				 WHERE NOT (name = ANY($1::text[])) ORDER BY name`, [names]);
            if (unknown.rows.length) {
                throw new Error(`database contains migrations absent from this build: ${unknown.rows
                    .map(({ name }) => name)
                    .join(', ')}`);
            }
            for (const migration of migrations) {
                const prior = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [migration.name]);
                if (prior.rows[0]) {
                    if (prior.rows[0].checksum === null) {
                        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL', [migration.name, migration.checksum]);
                    }
                    else if (prior.rows[0].checksum !== migration.checksum) {
                        throw new Error(`migration checksum mismatch: ${migration.name}`);
                    }
                    continue;
                }
                await client.query('BEGIN');
                try {
                    await client.query(migration.sql);
                    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
                        migration.name,
                        migration.checksum
                    ]);
                    await client.query('COMMIT');
                }
                catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                }
                process.stdout.write(`applied ${migration.name}\n`);
            }
            await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL');
            await client.query(`DO $$
			BEGIN
			  IF NOT EXISTS (
			    SELECT 1 FROM pg_constraint
			    WHERE conname = 'schema_migrations_checksum_check'
			      AND conrelid = 'schema_migrations'::regclass
			  ) THEN
			    ALTER TABLE schema_migrations
			      ADD CONSTRAINT schema_migrations_checksum_check
			      CHECK (checksum ~ '^[0-9a-f]{64}$');
			  END IF;
			END $$`);
            return true;
        });
        if (migrated === undefined) {
            throw new Error('another migration process currently owns the database migration lock');
        }
        if (migrationDatabaseUrl !== runtimeDatabaseUrl) {
            await database.transaction(async (client) => {
                await applyRuntimeRolePrivileges(client, runtimeRole);
            });
        }
    }
    finally {
        await database.close();
    }
};
await run();
//# sourceMappingURL=migrate.js.map
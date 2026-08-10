import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redacted } from 'effect';
import { loadConfig } from '../config.js';
import { Database } from './client.js';
import { Effect } from 'effect';
const run = async () => {
    const config = await Effect.runPromise(loadConfig());
    const database = new Database(Redacted.value(config.databaseUrl));
    const directory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    try {
        await database.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				name text PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)
		`);
        for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
            const prior = await database.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
            if (prior.rowCount)
                continue;
            const sql = await readFile(join(directory, name), 'utf8');
            await database.transaction(async (client) => {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
            });
            process.stdout.write(`applied ${name}\n`);
        }
    }
    finally {
        await database.close();
    }
};
await run();
//# sourceMappingURL=migrate.js.map
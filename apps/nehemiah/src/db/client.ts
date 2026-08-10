import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

export const expectedDatabaseMigration = {
	name: '0035_project_allocation_bounds.sql',
	checksum: '5ef6f45bfb4d52336c8b32cd1ba0cc9d79806d79139f2e48543f040086bbb72e'
} as const;

export interface Queryable {
	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: ReadonlyArray<unknown>
	): Promise<QueryResult<R>>;
}

export class Database implements Queryable {
	readonly #pool: Pool;

	constructor(config: string | PoolConfig) {
		this.#pool = new Pool(typeof config === 'string' ? { connectionString: config } : config);
	}

	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values: ReadonlyArray<unknown> = []
	): Promise<QueryResult<R>> {
		return this.#pool.query<R>(text, [...values]);
	}

	async transaction<A>(operation: (client: PoolClient) => Promise<A>): Promise<A> {
		const client = await this.#pool.connect();
		try {
			await client.query('BEGIN');
			const result = await operation(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Run work while holding a session-scoped PostgreSQL advisory lock.
	 *
	 * The checked-out client is intentionally held for the whole callback: acquiring
	 * and releasing through the pool independently could leak the lock on a different
	 * session. `undefined` means another process already owns the singleton job.
	 */
	async withAdvisoryLock<A>(
		key: number,
		operation: (client: PoolClient) => Promise<A>
	): Promise<A | undefined> {
		if (!Number.isSafeInteger(key)) throw new Error('advisory lock key must be an integer');
		const client = await this.#pool.connect();
		let destroyClient = false;
		try {
			const result = await client.query<{ acquired: boolean }>(
				'SELECT pg_try_advisory_lock($1) AS acquired',
				[key]
			);
			if (!result.rows[0]?.acquired) return undefined;
			try {
				return await operation(client);
			} finally {
				const unlocked = await client.query<{ unlocked: boolean }>(
					'SELECT pg_advisory_unlock($1) AS unlocked',
					[key]
				);
				if (!unlocked.rows[0]?.unlocked) destroyClient = true;
			}
		} catch (error) {
			destroyClient = true;
			throw error;
		} finally {
			client.release(destroyClient);
		}
	}

	async ping(): Promise<void> {
		const result = await this.#pool.query<{
			machines: string | null;
			migrated: boolean;
			latest: boolean;
		}>(
			`SELECT to_regclass('public.machines')::text AS machines,
					 EXISTS (SELECT 1 FROM schema_migrations
					         WHERE name = $1 AND checksum = $2) AS migrated,
					 COALESCE((SELECT max(name) = $1 FROM schema_migrations), false) AS latest`,
			[expectedDatabaseMigration.name, expectedDatabaseMigration.checksum]
		);
		if (!result.rows[0]?.machines || !result.rows[0].migrated || !result.rows[0].latest) {
			throw new Error('database schema has not been migrated');
		}
	}

	poolSnapshot(): { readonly total: number; readonly idle: number; readonly waiting: number } {
		return {
			total: this.#pool.totalCount,
			idle: this.#pool.idleCount,
			waiting: this.#pool.waitingCount
		};
	}

	async close(): Promise<void> {
		await this.#pool.end();
	}
}

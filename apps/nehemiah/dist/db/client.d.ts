import { type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
export declare const expectedDatabaseMigration: {
    readonly name: "0035_project_allocation_bounds.sql";
    readonly checksum: "5ef6f45bfb4d52336c8b32cd1ba0cc9d79806d79139f2e48543f040086bbb72e";
};
export interface Queryable {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
}
export declare class Database implements Queryable {
    #private;
    constructor(config: string | PoolConfig);
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
    transaction<A>(operation: (client: PoolClient) => Promise<A>): Promise<A>;
    /**
     * Run work while holding a session-scoped PostgreSQL advisory lock.
     *
     * The checked-out client is intentionally held for the whole callback: acquiring
     * and releasing through the pool independently could leak the lock on a different
     * session. `undefined` means another process already owns the singleton job.
     */
    withAdvisoryLock<A>(key: number, operation: (client: PoolClient) => Promise<A>): Promise<A | undefined>;
    ping(): Promise<void>;
    poolSnapshot(): {
        readonly total: number;
        readonly idle: number;
        readonly waiting: number;
    };
    close(): Promise<void>;
}

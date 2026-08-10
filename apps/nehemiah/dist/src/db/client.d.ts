import { type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
export interface Queryable {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
}
export declare class Database implements Queryable {
    #private;
    constructor(config: string | PoolConfig);
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
    transaction<A>(operation: (client: PoolClient) => Promise<A>): Promise<A>;
    ping(): Promise<void>;
    close(): Promise<void>;
}

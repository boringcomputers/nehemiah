import type { Queryable } from './client.js';
export declare const databaseRoleFromUrl: (raw: string) => string;
/**
 * Give the runtime exactly the data privileges it needs while keeping schema
 * ownership, DDL, migration metadata, and append-only ledger mutation with the
 * migration role. This is rerun after every migration so newly created objects
 * cannot accidentally inherit PostgreSQL's broad PUBLIC defaults.
 */
export declare const applyRuntimeRolePrivileges: (database: Queryable, runtimeRole: string) => Promise<void>;
export declare const assertSeparatedDatabaseRoles: (database: Queryable, runtimeRole: string) => Promise<void>;

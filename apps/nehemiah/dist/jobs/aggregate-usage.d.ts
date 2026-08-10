import type { Queryable } from '../db/client.js';
/** Refresh derived daily summaries; source usage_events remains immutable. */
export declare const aggregateUsage: (database: Queryable, through?: Date) => Promise<void>;

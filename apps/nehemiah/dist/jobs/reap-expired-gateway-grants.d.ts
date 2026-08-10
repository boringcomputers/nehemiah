import type { Queryable } from '../db/client.js';
/**
 * Delete a bounded, oldest-first batch without blocking another control-plane
 * replica doing the same work. Repeated periodic runs eventually drain the
 * expiry index while keeping each transaction small.
 */
export declare const reapExpiredGatewayGrants: (database: Queryable, batchSize?: number) => Promise<number>;

/**
 * Delete a bounded, oldest-first batch without blocking another control-plane
 * replica doing the same work. Repeated periodic runs eventually drain the
 * expiry index while keeping each transaction small.
 */
export const reapExpiredGatewayGrants = async (database, batchSize = 1_000) => {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
        throw new Error('gateway grant reaper batch size must be from 1 to 10000');
    }
    const result = await database.query(`WITH expired AS (
		   SELECT id FROM machine_gateway_grants
		   WHERE expires_at <= now()
		   ORDER BY expires_at, id
		   LIMIT $1
		   FOR UPDATE SKIP LOCKED
		 )
		 DELETE FROM machine_gateway_grants grants
		 USING expired
		 WHERE grants.id = expired.id
		 RETURNING grants.id`, [batchSize]);
    return result.rowCount ?? result.rows.length;
};
//# sourceMappingURL=reap-expired-gateway-grants.js.map
import type { Queryable } from '../db/client.js';

/** Refresh derived daily summaries; source usage_events remains immutable. */
export const aggregateUsage = async (database: Queryable, through = new Date()): Promise<void> => {
	await database.query(
		`INSERT INTO usage_daily
		 (organization_id, project_id, usage_date, dimension, quantity, refreshed_at)
			 SELECT organization_id, project_id, (period_start AT TIME ZONE 'UTC')::date,
			        dimension, sum(quantity), now()
			 FROM usage_events WHERE period_start < $1
			 GROUP BY organization_id, project_id,
			          (period_start AT TIME ZONE 'UTC')::date, dimension
		 ON CONFLICT (organization_id, project_id, usage_date, dimension)
		 DO UPDATE SET quantity = EXCLUDED.quantity, refreshed_at = now()`,
		[through]
	);
};

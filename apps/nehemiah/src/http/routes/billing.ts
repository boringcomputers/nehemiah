import type { Database } from '../../db/client.js';
import { authenticate, permits, projectFor, type AuthServices } from '../auth.js';
import { json, problem, type Router } from '../router.js';

export interface BillingRouteServices extends AuthServices {
	readonly database: Database;
}

export const registerBillingRoutes = <S extends BillingRouteServices>(router: Router<S>): void => {
	router.get('/v1/billing/usage', async ({ request, url, services, requestId }) => {
		const principal = await authenticate(request, services);
		if (!principal)
			return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
		if (!permits(principal, 'billing:read')) {
			return problem(403, 'insufficient_scope', 'billing:read is required.', requestId);
		}
		const from =
			url.searchParams.get('from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
		const to = url.searchParams.get('to') ?? new Date().toISOString();
		const projectId = projectFor(principal, url.searchParams.get('project_id') ?? undefined);
		const result = await services.database.query<{
			usage_date: string;
			project_id: string;
			dimension: string;
			quantity: string;
		}>(
			`SELECT usage_date, project_id, dimension, quantity FROM usage_daily
			 WHERE organization_id = $1 AND usage_date >= $2::date AND usage_date <= $3::date
			   AND ($4::uuid IS NULL OR project_id = $4)
			 ORDER BY usage_date, project_id, dimension`,
			[principal.organizationId, from, to, projectId ?? null]
		);
		const account = await services.database.query<{
			plan: string;
			spend_cap_cents: number | null;
			delinquent_at: Date | null;
		}>(
			'SELECT plan, spend_cap_cents, delinquent_at FROM billing_accounts WHERE organization_id = $1',
			[principal.organizationId]
		);
		return json({ account: account.rows[0] ?? { plan: 'private_beta' }, usage: result.rows });
	});
};

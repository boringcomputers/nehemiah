import type { Handler } from './router.js';
import { json, problem } from './router.js';

export interface Readiness {
	ping(): Promise<void>;
}

export interface HealthServices {
	readonly readiness: Readiness;
	readonly startedAt: Date;
}

export const healthz: Handler<HealthServices> = ({ services }) =>
	json({
		ok: true,
		service: 'nehemiah-control-plane',
		started_at: services.startedAt.toISOString()
	});

export const readyz: Handler<HealthServices> = async ({ services, requestId }) => {
	try {
		await services.readiness.ping();
		return json({ ok: true });
	} catch {
		return problem(503, 'not_ready', 'The control plane database is unavailable.', requestId);
	}
};

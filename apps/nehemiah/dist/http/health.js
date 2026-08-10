import { json, problem } from './router.js';
export const healthz = ({ services }) => json({
    ok: true,
    service: 'nehemiah-control-plane',
    started_at: services.startedAt.toISOString()
});
export const readyz = async ({ services, requestId }) => {
    try {
        await services.readiness.ping();
        return json({ ok: true });
    }
    catch {
        return problem(503, 'not_ready', 'The control plane database is unavailable.', requestId);
    }
};
//# sourceMappingURL=health.js.map
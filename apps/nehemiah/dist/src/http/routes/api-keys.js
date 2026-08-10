import { apiKeyScopes } from '../../auth/api-key.js';
import { authenticate } from '../auth.js';
import { json, problem, readJson } from '../router.js';
export const registerApiKeyRoutes = (router) => {
    router.post('/v1/api-keys', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal || principal.kind !== 'user') {
            return problem(403, 'dashboard_session_required', 'API keys can only be created by a dashboard user.', requestId);
        }
        const body = await readJson(request);
        if (!body.name || !body.scopes?.length || body.scopes.some((scope) => !apiKeyScopes.includes(scope))) {
            return problem(400, 'invalid_api_key', 'A name and valid scopes are required.', requestId);
        }
        const created = await services.apiKeys.create({
            organizationId: principal.organizationId,
            projectId: body.project_id,
            name: body.name,
            scopes: body.scopes,
            expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
            actorId: principal.clerkUserId
        });
        return json({ ...created, secret_displayed_once: true }, 201, { 'cache-control': 'no-store' });
    });
};
//# sourceMappingURL=api-keys.js.map
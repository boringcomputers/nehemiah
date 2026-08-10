import { ProjectQuotaExceeded, ProjectSlugConflict } from '../../domain/projects.js';
import { authenticate, authenticateIdentity, canAdminister } from '../auth.js';
import { json, problem, readJson } from '../router.js';
export const registerOrganizationRoutes = (router) => {
    router.get('/v1/organizations', async ({ request, services, requestId }) => {
        const identity = await authenticateIdentity(request, services);
        if (!identity || identity.kind !== 'user') {
            return problem(403, 'dashboard_session_required', 'A dashboard session is required.', requestId);
        }
        return json({ organizations: await services.organizations.listForUser(identity.clerkUserId) });
    });
    router.get('/v1/projects', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal)
            return problem(401, 'unauthorized', 'A valid session is required.', requestId);
        return json({
            projects: await services.projects.list(principal.organizationId, principal.kind === 'api_key' ? principal.projectId : undefined)
        });
    });
    router.post('/v1/projects', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal || principal.kind !== 'user' || !canAdminister(principal)) {
            return problem(403, 'dashboard_session_required', 'A dashboard session is required.', requestId);
        }
        let body;
        try {
            body = await readJson(request);
        }
        catch (error) {
            return problem(400, 'invalid_project', error instanceof SyntaxError ? error.message : 'The request body is invalid.', requestId);
        }
        if (!body.slug ||
            !body.name ||
            !/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.slug) ||
            !body.name.trim() ||
            body.name.length > 160) {
            return problem(400, 'invalid_project', 'A valid name and slug are required.', requestId);
        }
        let creation;
        try {
            creation = await services.audit.capture({
                organizationId: principal.organizationId,
                projectId: undefined,
                actorType: 'user',
                actorId: principal.clerkUserId,
                requestId,
                userAgent: request.headers.get('user-agent') ?? undefined,
                action: 'project.create',
                resourceType: 'project',
                metadata: { slug: body.slug },
                complete: ({ project, replayed }) => ({
                    projectId: project.id,
                    resourceId: project.id,
                    metadata: { slug: project.slug, replayed }
                })
            }, () => services.projects.create({
                organizationId: principal.organizationId,
                slug: body.slug,
                name: body.name
            }));
        }
        catch (error) {
            if (error instanceof ProjectQuotaExceeded) {
                const response = problem(error.status, error.code, error.message, requestId, {
                    retry_after_seconds: error.retryAfterSeconds
                });
                response.headers.set('retry-after', String(error.retryAfterSeconds));
                response.headers.set('cache-control', 'no-store');
                return response;
            }
            if (error instanceof ProjectSlugConflict) {
                return problem(error.status, error.code, error.message, requestId);
            }
            throw error;
        }
        return json(creation.project, creation.replayed ? 200 : 201);
    });
};
//# sourceMappingURL=organizations.js.map
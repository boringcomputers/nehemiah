import { InvalidTemplateRequest, TemplateInfrastructureUnavailable, TemplateIntegrityError, TemplateSourceNotFound, TemplateSourceNotReady, templateJson, TemplateVersionConflict } from '../../domain/templates.js';
import { authenticate, canAdminister, permits, projectFor } from '../auth.js';
import { json, problem, readJson } from '../router.js';
const auditActor = (principal, request, requestId, projectId) => ({
    organizationId: principal.organizationId,
    projectId,
    actorType: principal.kind,
    actorId: principal.kind === 'api_key' ? principal.apiKeyId : principal.clerkUserId,
    requestId,
    userAgent: request.headers.get('user-agent') ?? undefined
});
export const registerTemplateRoutes = (router) => {
    router.post('/v1/templates', async ({ request, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal) {
            return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
        }
        if (!permits(principal, 'templates:write') ||
            (principal.kind === 'user' && !canAdminister(principal))) {
            return problem(403, 'insufficient_scope', 'templates:write and an administrator role are required.', requestId);
        }
        try {
            const body = await readJson(request);
            if (typeof body !== 'object' ||
                body === null ||
                Array.isArray(body) ||
                Object.keys(body).some((key) => !['project_id', 'machine_id', 'name', 'version'].includes(key))) {
                return problem(400, 'invalid_template_request', 'Only project_id, machine_id, name, and version are accepted.', requestId);
            }
            if (body.project_id !== undefined && typeof body.project_id !== 'string') {
                return problem(400, 'invalid_template_request', 'project_id must be a string.', requestId);
            }
            if (principal.kind === 'api_key' &&
                principal.projectId &&
                body.project_id !== undefined &&
                body.project_id !== principal.projectId) {
                return problem(403, 'cross_project_denied', 'The API key is scoped to another project.', requestId);
            }
            const projectId = projectFor(principal, body.project_id);
            if (!projectId)
                return problem(400, 'project_required', 'project_id is required.', requestId);
            if (typeof body.machine_id !== 'string' ||
                typeof body.name !== 'string' ||
                typeof body.version !== 'string' ||
                body.machine_id === '' ||
                body.name === '' ||
                body.version === '') {
                return problem(400, 'invalid_template_request', 'machine_id, name, and version are required.', requestId);
            }
            const template = await services.audit.capture({
                ...auditActor(principal, request, requestId, projectId),
                action: 'template.publish',
                resourceType: 'template',
                metadata: { source_machine_id: body.machine_id },
                complete: (created) => ({ resourceId: created.id })
            }, () => services.templates.publish({
                organizationId: principal.organizationId,
                projectId,
                machineId: body.machine_id,
                name: body.name,
                version: body.version
            }));
            return json(templateJson(template), 201, { location: `/v1/templates/${template.id}` });
        }
        catch (error) {
            if (error instanceof InvalidTemplateRequest || error instanceof SyntaxError) {
                return problem(400, 'invalid_template_request', error.message, requestId);
            }
            if (error instanceof TemplateSourceNotFound) {
                return problem(404, error.code, error.message, requestId);
            }
            if (error instanceof TemplateSourceNotReady) {
                return problem(409, error.code, error.message, requestId);
            }
            if (error instanceof TemplateVersionConflict) {
                return problem(409, error.code, error.message, requestId);
            }
            if (error instanceof TemplateInfrastructureUnavailable) {
                return problem(503, error.code, error.message, requestId);
            }
            if (error instanceof TemplateIntegrityError) {
                return problem(502, error.code, error.message, requestId);
            }
            throw error;
        }
    });
    router.get('/v1/templates', async ({ request, url, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal)
            return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
        if (!permits(principal, 'templates:read')) {
            return problem(403, 'insufficient_scope', 'templates:read is required.', requestId);
        }
        const requestedProject = url.searchParams.get('project_id') ?? undefined;
        if (principal.kind === 'api_key' &&
            principal.projectId &&
            requestedProject !== undefined &&
            requestedProject !== principal.projectId) {
            return problem(403, 'cross_project_denied', 'The API key is scoped to another project.', requestId);
        }
        const projectId = projectFor(principal, requestedProject);
        return json({
            templates: (await services.templates.list(principal.organizationId, projectId)).map(templateJson)
        });
    });
    router.delete('/v1/templates/:id', async ({ request, url, params, services, requestId }) => {
        const principal = await authenticate(request, services);
        if (!principal) {
            return problem(401, 'unauthorized', 'A valid API key or session is required.', requestId);
        }
        if (!permits(principal, 'templates:write') ||
            (principal.kind === 'user' && !canAdminister(principal))) {
            return problem(403, 'insufficient_scope', 'templates:write and an administrator role are required.', requestId);
        }
        const requestedProject = url.searchParams.get('project_id') ?? undefined;
        if (principal.kind === 'api_key' &&
            principal.projectId &&
            requestedProject !== undefined &&
            requestedProject !== principal.projectId) {
            return problem(403, 'cross_project_denied', 'The API key is scoped to another project.', requestId);
        }
        const projectId = projectFor(principal, requestedProject);
        const result = await services.audit.capture({
            ...auditActor(principal, request, requestId, projectId),
            action: 'template.delete',
            resourceType: 'template',
            resourceId: params.id,
            complete: (outcome) => outcome === 'deleted'
                ? { outcome: 'succeeded' }
                : { outcome: 'denied', reasonCode: `template_${outcome}` }
        }, () => services.templates.remove(params.id, principal.organizationId, projectId));
        if (result === 'deleted')
            return new Response(null, { status: 204 });
        if (result === 'in_use') {
            return problem(409, 'template_in_use', 'Running machines still reference this immutable template version.', requestId);
        }
        return problem(404, 'template_not_found', 'Template not found.', requestId);
    });
};
//# sourceMappingURL=templates.js.map
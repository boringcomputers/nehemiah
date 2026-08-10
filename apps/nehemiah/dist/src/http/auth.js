import { authenticateClerkSession } from '../auth/clerk.js';
const bearer = (request) => {
    const value = request.headers.get('authorization');
    return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
};
export const authenticate = async (request, services) => {
    const token = bearer(request);
    if (!token)
        return undefined;
    if (token.startsWith('bc_'))
        return services.apiKeys.authenticate(token);
    if (!services.clerkSessionVerifier)
        return undefined;
    const session = await authenticateClerkSession(token, services.clerkSessionVerifier);
    if (!session)
        return undefined;
    const organizationId = request.headers.get('x-nehemiah-organization-id') ?? session.organizationId;
    if (!organizationId)
        return undefined;
    if (!(await services.organizations.userCanAccess(session.clerkUserId, organizationId)))
        return undefined;
    return { ...session, organizationId };
};
export const projectFor = (principal, requested) => principal.kind === 'api_key' && principal.projectId ? principal.projectId : requested;
export const permits = (principal, scope) => principal.kind === 'user' || principal.scopes.has(scope);
//# sourceMappingURL=auth.js.map
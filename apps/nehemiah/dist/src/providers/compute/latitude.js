const providerHost = (resource) => ({
    id: resource.id,
    hostname: resource.attributes.hostname,
    status: resource.attributes.status,
    region: resource.attributes.region?.site?.slug ?? 'unknown',
    primaryIpv4: resource.attributes.primary_ipv4,
    plan: resource.attributes.plan?.slug
});
export class LatitudeProvider {
    token;
    fetcher;
    baseUrl;
    constructor(token, fetcher = fetch, baseUrl = 'https://api.latitude.sh') {
        this.token = token;
        this.fetcher = fetcher;
        this.baseUrl = baseUrl;
    }
    async listCapacity() {
        const body = await this.request('/servers');
        return body.data.map(providerHost);
    }
    async provisionHost(request) {
        const body = await this.request('/servers', {
            method: 'POST',
            headers: { 'idempotency-key': request.idempotencyKey },
            body: JSON.stringify({
                data: {
                    type: 'servers',
                    attributes: {
                        project: request.project,
                        plan: request.plan,
                        site: request.site,
                        operating_system: request.operatingSystem,
                        hostname: request.hostname,
                        user_data: request.userData
                    }
                }
            })
        });
        return providerHost(body.data);
    }
    async getHost(id) {
        try {
            const body = await this.request(`/servers/${encodeURIComponent(id)}`);
            return providerHost(body.data);
        }
        catch (error) {
            if (error instanceof LatitudeError && error.status === 404)
                return undefined;
            throw error;
        }
    }
    async deleteHost(id) {
        await this.request(`/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    async request(path, init = {}) {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await this.fetcher(`${this.baseUrl}${path}`, {
                    ...init,
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        authorization: `Bearer ${this.token}`,
                        ...init.headers
                    }
                });
                if (response.ok) {
                    if (response.status === 204)
                        return undefined;
                    return (await response.json());
                }
                const text = await response.text();
                const error = new LatitudeError(response.status, text);
                if (response.status < 500 && response.status !== 429)
                    throw error;
                lastError = error;
            }
            catch (error) {
                lastError = error;
                if (error instanceof LatitudeError && error.status < 500 && error.status !== 429)
                    throw error;
            }
            if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
        throw lastError;
    }
}
export class LatitudeError extends Error {
    status;
    responseBody;
    constructor(status, responseBody) {
        super(`Latitude API returned ${status}`);
        this.status = status;
        this.responseBody = responseBody;
    }
}
//# sourceMappingURL=latitude.js.map
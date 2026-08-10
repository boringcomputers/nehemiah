import type { ComputeProvider, ProviderHost, ProvisionHostRequest } from './provider.js';

interface LatitudeResource {
	readonly id: string;
	readonly attributes: {
		readonly hostname: string;
		readonly status: string;
		readonly primary_ipv4?: string;
		readonly region?: { readonly site?: { readonly slug?: string } };
		readonly plan?: { readonly slug?: string };
	};
}

const providerHost = (resource: LatitudeResource): ProviderHost => ({
	id: resource.id,
	hostname: resource.attributes.hostname,
	status: resource.attributes.status,
	region: resource.attributes.region?.site?.slug ?? 'unknown',
	primaryIpv4: resource.attributes.primary_ipv4,
	plan: resource.attributes.plan?.slug
});

export class LatitudeProvider implements ComputeProvider {
	constructor(
		private readonly token: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly baseUrl = 'https://api.latitude.sh'
	) {}

	async listCapacity(): Promise<ReadonlyArray<ProviderHost>> {
		const body = await this.request<{ data: LatitudeResource[] }>('/servers');
		return body.data.map(providerHost);
	}

	async provisionHost(request: ProvisionHostRequest): Promise<ProviderHost> {
		const body = await this.request<{ data: LatitudeResource }>('/servers', {
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

	async getHost(id: string): Promise<ProviderHost | undefined> {
		try {
			const body = await this.request<{ data: LatitudeResource }>(
				`/servers/${encodeURIComponent(id)}`
			);
			return providerHost(body.data);
		} catch (error) {
			if (error instanceof LatitudeError && error.status === 404) return undefined;
			throw error;
		}
	}

	async deleteHost(id: string): Promise<void> {
		await this.request(`/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
	}

	private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
		let lastError: unknown;
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
					if (response.status === 204) return undefined as T;
					return (await response.json()) as T;
				}
				const text = await response.text();
				const error = new LatitudeError(response.status, text);
				if (response.status < 500 && response.status !== 429) throw error;
				lastError = error;
			} catch (error) {
				lastError = error;
				if (error instanceof LatitudeError && error.status < 500 && error.status !== 429)
					throw error;
			}
			if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
		}
		throw lastError;
	}
}

export class LatitudeError extends Error {
	constructor(
		readonly status: number,
		readonly responseBody: string
	) {
		super(`Latitude API returned ${status}`);
	}
}

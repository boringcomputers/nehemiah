import type { ComputeProvider, ProviderHost, ProvisionHostRequest } from './provider.js';

export class FakeComputeProvider implements ComputeProvider {
	readonly hosts = new Map<string, ProviderHost>();
	readonly idempotency = new Map<string, string>();
	#sequence = 0;

	async listCapacity(): Promise<ReadonlyArray<ProviderHost>> {
		return [...this.hosts.values()];
	}

	async provisionHost(request: ProvisionHostRequest): Promise<ProviderHost> {
		const prior = this.idempotency.get(request.idempotencyKey);
		if (prior) return this.hosts.get(prior)!;
		const id = `fake-${++this.#sequence}`;
		const host: ProviderHost = {
			id,
			hostname: request.hostname,
			status: 'provisioning',
			region: request.site,
			plan: request.plan
		};
		this.hosts.set(id, host);
		this.idempotency.set(request.idempotencyKey, id);
		return host;
	}

	async getHost(id: string): Promise<ProviderHost | undefined> {
		return this.hosts.get(id);
	}

	async deleteHost(id: string): Promise<void> {
		this.hosts.delete(id);
	}
}

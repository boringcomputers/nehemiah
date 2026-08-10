export class FakeComputeProvider {
    hosts = new Map();
    idempotency = new Map();
    #sequence = 0;
    async listCapacity() {
        return [...this.hosts.values()];
    }
    async provisionHost(request) {
        const prior = this.idempotency.get(request.idempotencyKey);
        if (prior)
            return this.hosts.get(prior);
        const id = `fake-${++this.#sequence}`;
        const host = {
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
    async getHost(id) {
        return this.hosts.get(id);
    }
    async deleteHost(id) {
        this.hosts.delete(id);
    }
}
//# sourceMappingURL=fake.js.map
import { describe, expect, it } from 'vitest';
class TenantRepository {
    machines;
    constructor(machines) {
        this.machines = machines;
    }
    async find(id, organizationId, projectId) {
        return this.machines.find((machine) => machine.id === id &&
            machine.organizationId === organizationId &&
            (projectId === undefined || machine.projectId === projectId));
    }
}
describe('tenant lookup boundary', () => {
    it('does not reveal whether another organization owns an ID', async () => {
        const machine = {
            id: 'm_secret-machine',
            organizationId: 'org-a',
            projectId: 'project-a',
            leaseId: 'lease',
            state: 'running',
            region: 'ca-tor-1',
            architecture: 'x86_64',
            resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
            ready: true,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000)
        };
        const repository = new TenantRepository([machine]);
        expect(await repository.find(machine.id, 'org-b')).toBeUndefined();
        expect(await repository.find(machine.id, 'org-a', 'project-b')).toBeUndefined();
        expect(await repository.find(machine.id, 'org-a', 'project-a')).toBe(machine);
    });
});
//# sourceMappingURL=tenant-isolation.test.js.map
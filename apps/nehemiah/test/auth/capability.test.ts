import { describe, expect, it } from 'vitest';
import { issueCapabilityToken, verifyCapabilityToken } from '../../src/auth/capability.js';

describe('gateway capability tokens', () => {
	it('binds a short-lived token to machine, tenant, capability and preview port', async () => {
		const token = await issueCapabilityToken(
			{
				machineId: 'm_abc',
				organizationId: 'org-a',
				projectId: 'project-a',
				leaseId: 'lease-a',
				capabilities: ['preview'],
				port: 3000
			},
			'a sufficiently long gateway secret'
		);
		expect(await verifyCapabilityToken(token, 'a sufficiently long gateway secret')).toEqual({
			machineId: 'm_abc',
			organizationId: 'org-a',
			projectId: 'project-a',
			leaseId: 'lease-a',
			capabilities: ['preview'],
			port: 3000
		});
		await expect(verifyCapabilityToken(token, 'a different gateway secret')).rejects.toThrow();
	});

	it('refuses overly long sessions and unknown capabilities', async () => {
		await expect(
			issueCapabilityToken(
				{
					machineId: 'm_abc',
					organizationId: 'org-a',
					projectId: 'project-a',
					leaseId: 'lease-a',
					capabilities: ['tty']
				},
				'secret',
				901
			)
		).rejects.toThrow('15 minutes');
	});
});

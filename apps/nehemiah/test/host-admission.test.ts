import { describe, expect, it, vi } from 'vitest';
import {
	HostCredentialAdmission,
	HostCredentialRateLimitExceeded,
	HostCredentialVerifierBusy
} from '../src/auth/host-admission.js';

const request = (source: string) =>
	new Request('https://control.example/internal/v1/hosts/host/heartbeat', {
		headers: { 'x-nehemiah-remote-address': source }
	});

describe('host credential pre-admission', () => {
	it('uses a fixed collision-conservative window before invoking expensive verification', async () => {
		let now = 1_000;
		const admission = new HostCredentialAdmission({
			slots: 1_024,
			requestsPerSecond: 2,
			maximumConcurrentVerifications: 1,
			now: () => now
		});
		const verify = vi.fn(async () => 7);
		await expect(admission.verify(request('10.64.0.2'), 'host-a', verify)).resolves.toBe(7);
		await expect(admission.verify(request('10.64.0.2'), 'host-a', verify)).resolves.toBe(7);
		await expect(admission.verify(request('10.64.0.2'), 'host-a', verify)).rejects.toBeInstanceOf(
			HostCredentialRateLimitExceeded
		);
		expect(verify).toHaveBeenCalledTimes(2);

		now = 2_000;
		await expect(admission.verify(request('10.64.0.2'), 'host-a', verify)).resolves.toBe(7);
	});

	it('fails fast instead of queueing beyond the global verifier semaphore', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admission = new HostCredentialAdmission({
			slots: 1_024,
			requestsPerSecond: 8,
			maximumConcurrentVerifications: 1,
			now: () => 1_000
		});
		const first = admission.verify(request('10.64.0.2'), 'host-a', async () => held);
		await expect(
			admission.verify(request('10.64.0.3'), 'host-b', async () => undefined)
		).rejects.toBeInstanceOf(HostCredentialVerifierBusy);
		release();
		await expect(first).resolves.toBeUndefined();
	});
});

import { createHash } from 'node:crypto';

export class HostCredentialRateLimitExceeded extends Error {
	readonly code = 'host_credential_rate_limited';

	constructor(readonly retryAfterSeconds: number) {
		super('Host credential verification is temporarily rate limited.');
	}
}

export class HostCredentialVerifierBusy extends Error {
	readonly code = 'host_credential_verifier_busy';

	constructor() {
		super('Host credential verification is at its bounded concurrency limit.');
	}
}

interface Slot {
	window: number;
	count: number;
}

export interface HostCredentialAdmissionOptions {
	readonly slots?: number;
	readonly requestsPerSecond?: number;
	readonly maximumConcurrentVerifications?: number;
	readonly now?: () => number;
}

/**
 * A cheap process-local shield in front of Argon2. Slots are deliberately
 * collision-conservative: colliding peers share a budget rather than evicting
 * one another or growing attacker-controlled state. PostgreSQL remains the
 * cross-replica authority after the host has authenticated.
 */
export class HostCredentialAdmission {
	readonly #slots: Slot[];
	readonly #mask: number;
	readonly #requestsPerSecond: number;
	readonly #maximumConcurrentVerifications: number;
	readonly #now: () => number;
	#activeVerifications = 0;

	constructor(options: HostCredentialAdmissionOptions = {}) {
		const slots = options.slots ?? 65_536;
		const requestsPerSecond = options.requestsPerSecond ?? 8;
		const maximumConcurrentVerifications = options.maximumConcurrentVerifications ?? 4;
		if (!Number.isSafeInteger(slots) || slots < 1_024 || slots > 1_048_576 || slots & (slots - 1)) {
			throw new Error(
				'host credential admission slots must be a power of two from 1024 to 1048576'
			);
		}
		if (
			!Number.isSafeInteger(requestsPerSecond) ||
			requestsPerSecond < 1 ||
			requestsPerSecond > 1_000
		) {
			throw new Error('host credential requests per second must be from 1 to 1000');
		}
		if (
			!Number.isSafeInteger(maximumConcurrentVerifications) ||
			maximumConcurrentVerifications < 1 ||
			maximumConcurrentVerifications > 64
		) {
			throw new Error('host credential verifier concurrency must be from 1 to 64');
		}
		this.#slots = Array.from({ length: slots }, () => ({ window: -1, count: 0 }));
		this.#mask = slots - 1;
		this.#requestsPerSecond = requestsPerSecond;
		this.#maximumConcurrentVerifications = maximumConcurrentVerifications;
		this.#now = options.now ?? Date.now;
	}

	async verify<A>(request: Request, hostId: string, operation: () => Promise<A>): Promise<A> {
		const now = this.#now();
		const window = Math.floor(now / 1_000);
		const source = (request.headers.get('x-nehemiah-remote-address') ?? 'unknown').slice(0, 128);
		const slotIndex =
			createHash('sha256')
				.update(source)
				.update('\0')
				.update(hostId.slice(0, 128))
				.digest()
				.readUInt32BE(0) & this.#mask;
		const slot = this.#slots[slotIndex]!;
		if (slot.window !== window) {
			slot.window = window;
			slot.count = 0;
		}
		slot.count += 1;
		if (slot.count > this.#requestsPerSecond) {
			throw new HostCredentialRateLimitExceeded(
				Math.max(1, Math.ceil(((window + 1) * 1_000 - now) / 1_000))
			);
		}
		if (this.#activeVerifications >= this.#maximumConcurrentVerifications) {
			throw new HostCredentialVerifierBusy();
		}
		this.#activeVerifications += 1;
		try {
			return await operation();
		} finally {
			this.#activeVerifications -= 1;
		}
	}
}

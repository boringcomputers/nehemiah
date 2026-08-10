import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ControlPlaneShutdown,
	type ShutdownDependencies,
	type ShutdownServer
} from '../src/shutdown.js';

const deferred = (): { readonly promise: Promise<void>; resolve(): void } => {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
};

class FakeServer implements ShutdownServer {
	readonly events: string[];
	readonly closeImmediately: boolean;
	#callback?: (error?: Error) => void;

	constructor(events: string[], closeImmediately = true) {
		this.events = events;
		this.closeImmediately = closeImmediately;
	}

	close(callback: (error?: Error) => void): void {
		this.events.push('server_close');
		this.#callback = callback;
		if (this.closeImmediately) callback();
	}

	closeIdleConnections(): void {
		this.events.push('server_close_idle');
	}

	closeAllConnections(): void {
		this.events.push('server_force_close');
		this.#callback?.();
	}

	completeClose(): void {
		this.#callback?.();
	}
}

const dependencies = (
	server: ShutdownServer,
	events: string[],
	overrides: Partial<ShutdownDependencies> = {}
): ShutdownDependencies => ({
	server,
	stopTimers: () => events.push('timers_stopped'),
	closeDatabase: async () => {
		events.push('database_closed');
	},
	closeTelemetry: async () => {
		events.push('telemetry_closed');
	},
	forceTerminate: () => events.push('force_terminate'),
	...overrides
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ControlPlaneShutdown', () => {
	it('stops admission and keeps durable resources open until HTTP and jobs drain', async () => {
		const events: string[] = [];
		const requestGate = deferred();
		const jobGate = deferred();
		const coordinator = new ControlPlaneShutdown({ graceMs: 1_000, finalizerGraceMs: 1_000 });
		const request = coordinator.runRequest(
			async () => {
				events.push('request_started');
				await requestGate.promise;
				events.push('request_finished');
			},
			() => events.push('request_rejected')
		);
		const job = coordinator.runJob(async () => {
			events.push('job_started');
			await jobGate.promise;
			events.push('job_finished');
		});
		await Promise.resolve();

		const server = new FakeServer(events, false);
		const first = coordinator.shutdown(dependencies(server, events));
		const second = coordinator.shutdown(dependencies(server, events));
		expect(first).toBe(second);
		expect(coordinator.accepting).toBe(false);
		expect(events).toContain('timers_stopped');
		expect(events).not.toContain('database_closed');
		expect(events).not.toContain('telemetry_closed');

		let lateJobRan = false;
		await coordinator.runJob(async () => {
			lateJobRan = true;
		});
		await coordinator.runRequest(
			async () => {
				events.push('late_request_ran');
			},
			() => events.push('late_request_rejected')
		);
		expect(lateJobRan).toBe(false);
		expect(events).toContain('late_request_rejected');
		expect(events).not.toContain('late_request_ran');

		requestGate.resolve();
		await request;
		expect(events).toContain('request_finished');
		expect(events).not.toContain('database_closed');
		jobGate.resolve();
		await job;
		expect(events).not.toContain('database_closed');
		server.completeClose();
		await first;

		expect(events.indexOf('database_closed')).toBeGreaterThan(events.indexOf('request_finished'));
		expect(events.indexOf('database_closed')).toBeGreaterThan(events.indexOf('job_finished'));
		expect(events.indexOf('telemetry_closed')).toBeGreaterThan(events.indexOf('job_finished'));
		expect(events.filter((event) => event === 'server_close')).toHaveLength(1);
		expect(events.filter((event) => event === 'database_closed')).toHaveLength(1);
		expect(events.filter((event) => event === 'telemetry_closed')).toHaveLength(1);
	});

	it('force-closes connections only after the drain grace expires', async () => {
		vi.useFakeTimers();
		const events: string[] = [];
		const requestGate = deferred();
		const coordinator = new ControlPlaneShutdown({ graceMs: 1_000, finalizerGraceMs: 500 });
		const request = coordinator.runRequest(
			() => requestGate.promise,
			() => undefined
		);
		const server = new FakeServer(events, false);
		const stopped = coordinator.shutdown(dependencies(server, events));

		await vi.advanceTimersByTimeAsync(999);
		expect(events).not.toContain('server_force_close');
		expect(events).not.toContain('database_closed');
		await vi.advanceTimersByTimeAsync(1);
		await stopped;
		expect(events).toContain('server_force_close');
		expect(events.indexOf('database_closed')).toBeGreaterThan(events.indexOf('server_force_close'));
		expect(events.filter((event) => event === 'force_terminate')).toHaveLength(1);

		requestGate.resolve();
		await request;
	});

	it('bounds stuck finalizers after attempting both durable closes', async () => {
		vi.useFakeTimers();
		const events: string[] = [];
		const databaseGate = deferred();
		const telemetryGate = deferred();
		const coordinator = new ControlPlaneShutdown({ graceMs: 1_000, finalizerGraceMs: 200 });
		const server = new FakeServer(events);
		const stopped = coordinator.shutdown(
			dependencies(server, events, {
				closeDatabase: async () => {
					events.push('database_close_started');
					await databaseGate.promise;
				},
				closeTelemetry: async () => {
					events.push('telemetry_close_started');
					await telemetryGate.promise;
				}
			})
		);

		await vi.advanceTimersByTimeAsync(199);
		expect(events).toContain('database_close_started');
		expect(events).toContain('telemetry_close_started');
		expect(events).not.toContain('force_terminate');
		await vi.advanceTimersByTimeAsync(1);
		await stopped;
		expect(events.filter((event) => event === 'force_terminate')).toHaveLength(1);

		databaseGate.resolve();
		telemetryGate.resolve();
	});
});

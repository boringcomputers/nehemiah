export interface ShutdownServer {
	close(callback: (error?: Error) => void): unknown;
	closeIdleConnections?(): void;
	closeAllConnections?(): void;
}

export interface ShutdownDependencies {
	readonly server: ShutdownServer;
	readonly stopTimers: () => void;
	readonly closeDatabase: () => Promise<void>;
	readonly closeTelemetry: () => Promise<void>;
	readonly forceTerminate: () => void;
	readonly onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export type ShutdownPhase =
	'stop_timers' | 'server_close' | 'server_force_close' | 'database_close' | 'telemetry_close';

interface ShutdownOptions {
	readonly graceMs: number;
	readonly finalizerGraceMs: number;
}

const validDuration = (value: number): boolean =>
	Number.isSafeInteger(value) && value >= 1 && value <= 300_000;

const timeout = (milliseconds: number): { readonly promise: Promise<void>; cancel(): void } => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
	return {
		promise,
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
};

/** Coordinates process-local work with the HTTP listener and durable-resource
 * finalizers. Work must be admitted through runRequest/runJob so the tracked
 * sets are complete before shutdown takes its single-threaded snapshot. */
export class ControlPlaneShutdown {
	readonly #graceMs: number;
	readonly #finalizerGraceMs: number;
	readonly #requests = new Set<Promise<unknown>>();
	readonly #jobs = new Set<Promise<unknown>>();
	#accepting = true;
	#shutdownPromise?: Promise<void>;

	constructor(options: ShutdownOptions) {
		if (!validDuration(options.graceMs) || !validDuration(options.finalizerGraceMs)) {
			throw new Error('shutdown grace periods must be bounded positive integers');
		}
		this.#graceMs = options.graceMs;
		this.#finalizerGraceMs = options.finalizerGraceMs;
	}

	get accepting(): boolean {
		return this.#accepting;
	}

	runRequest(operation: () => Promise<void>, rejectDuringShutdown: () => void): Promise<void> {
		if (!this.#accepting) {
			rejectDuringShutdown();
			return Promise.resolve();
		}
		return this.#track(this.#requests, operation);
	}

	runJob<A>(operation: () => Promise<A>): Promise<A | undefined> {
		if (!this.#accepting) return Promise.resolve(undefined);
		return this.#track(this.#jobs, operation);
	}

	shutdown(dependencies: ShutdownDependencies): Promise<void> {
		this.#shutdownPromise ??= this.#execute(dependencies);
		return this.#shutdownPromise;
	}

	#track<A>(target: Set<Promise<unknown>>, operation: () => Promise<A>): Promise<A> {
		const work = Promise.resolve().then(operation);
		let tracked!: Promise<A>;
		tracked = work.finally(() => target.delete(tracked));
		target.add(tracked);
		return tracked;
	}

	async #execute(dependencies: ShutdownDependencies): Promise<void> {
		this.#accepting = false;
		try {
			dependencies.stopTimers();
		} catch (error) {
			dependencies.onError?.('stop_timers', error);
		}

		const serverClosed = new Promise<void>((resolve, reject) => {
			try {
				dependencies.server.close((error) => {
					if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
						resolve();
					} else if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
				dependencies.server.closeIdleConnections?.();
			} catch (error) {
				reject(error);
			}
		});
		const workDrained = Promise.allSettled([...this.#requests, ...this.#jobs]).then(
			() => undefined
		);
		const graceful = Promise.all([serverClosed, workDrained]).then(
			() => undefined,
			(error) => {
				dependencies.onError?.('server_close', error);
				return new Promise<void>(() => undefined);
			}
		);
		const grace = timeout(this.#graceMs);
		const drained = await Promise.race([
			graceful.then(() => true),
			grace.promise.then(() => false)
		]);
		grace.cancel();

		if (!drained) {
			try {
				dependencies.server.closeAllConnections?.();
			} catch (error) {
				dependencies.onError?.('server_force_close', error);
			}
		}

		const finalize = Promise.allSettled([
			Promise.resolve()
				.then(dependencies.closeDatabase)
				.catch((error) => dependencies.onError?.('database_close', error)),
			Promise.resolve()
				.then(dependencies.closeTelemetry)
				.catch((error) => dependencies.onError?.('telemetry_close', error))
		]).then(() => undefined);
		const finalizerGrace = timeout(this.#finalizerGraceMs);
		const finalized = await Promise.race([
			finalize.then(() => true),
			finalizerGrace.promise.then(() => false)
		]);
		finalizerGrace.cancel();
		// A forced connection close cannot cancel arbitrary provider/host I/O
		// already running inside a tracked operation. Even if the resource
		// finalizers return, timed-out work may retain a referenced socket or timer,
		// so the process boundary is the final containment mechanism.
		if (!drained || !finalized) dependencies.forceTerminate();
	}
}

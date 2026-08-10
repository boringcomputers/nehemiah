const validDuration = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 300_000;
const timeout = (milliseconds) => {
    let timer;
    const promise = new Promise((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
    });
    return {
        promise,
        cancel: () => {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    };
};
/** Coordinates process-local work with the HTTP listener and durable-resource
 * finalizers. Work must be admitted through runRequest/runJob so the tracked
 * sets are complete before shutdown takes its single-threaded snapshot. */
export class ControlPlaneShutdown {
    #graceMs;
    #finalizerGraceMs;
    #requests = new Set();
    #jobs = new Set();
    #accepting = true;
    #shutdownPromise;
    constructor(options) {
        if (!validDuration(options.graceMs) || !validDuration(options.finalizerGraceMs)) {
            throw new Error('shutdown grace periods must be bounded positive integers');
        }
        this.#graceMs = options.graceMs;
        this.#finalizerGraceMs = options.finalizerGraceMs;
    }
    get accepting() {
        return this.#accepting;
    }
    runRequest(operation, rejectDuringShutdown) {
        if (!this.#accepting) {
            rejectDuringShutdown();
            return Promise.resolve();
        }
        return this.#track(this.#requests, operation);
    }
    runJob(operation) {
        if (!this.#accepting)
            return Promise.resolve(undefined);
        return this.#track(this.#jobs, operation);
    }
    shutdown(dependencies) {
        this.#shutdownPromise ??= this.#execute(dependencies);
        return this.#shutdownPromise;
    }
    #track(target, operation) {
        const work = Promise.resolve().then(operation);
        let tracked;
        tracked = work.finally(() => target.delete(tracked));
        target.add(tracked);
        return tracked;
    }
    async #execute(dependencies) {
        this.#accepting = false;
        try {
            dependencies.stopTimers();
        }
        catch (error) {
            dependencies.onError?.('stop_timers', error);
        }
        const serverClosed = new Promise((resolve, reject) => {
            try {
                dependencies.server.close((error) => {
                    if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
                        resolve();
                    }
                    else if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
                dependencies.server.closeIdleConnections?.();
            }
            catch (error) {
                reject(error);
            }
        });
        const workDrained = Promise.allSettled([...this.#requests, ...this.#jobs]).then(() => undefined);
        const graceful = Promise.all([serverClosed, workDrained]).then(() => undefined, (error) => {
            dependencies.onError?.('server_close', error);
            return new Promise(() => undefined);
        });
        const grace = timeout(this.#graceMs);
        const drained = await Promise.race([
            graceful.then(() => true),
            grace.promise.then(() => false)
        ]);
        grace.cancel();
        if (!drained) {
            try {
                dependencies.server.closeAllConnections?.();
            }
            catch (error) {
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
        if (!drained || !finalized)
            dependencies.forceTerminate();
    }
}
//# sourceMappingURL=shutdown.js.map
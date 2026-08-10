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
export type ShutdownPhase = 'stop_timers' | 'server_close' | 'server_force_close' | 'database_close' | 'telemetry_close';
interface ShutdownOptions {
    readonly graceMs: number;
    readonly finalizerGraceMs: number;
}
/** Coordinates process-local work with the HTTP listener and durable-resource
 * finalizers. Work must be admitted through runRequest/runJob so the tracked
 * sets are complete before shutdown takes its single-threaded snapshot. */
export declare class ControlPlaneShutdown {
    #private;
    constructor(options: ShutdownOptions);
    get accepting(): boolean;
    runRequest(operation: () => Promise<void>, rejectDuringShutdown: () => void): Promise<void>;
    runJob<A>(operation: () => Promise<A>): Promise<A | undefined>;
    shutdown(dependencies: ShutdownDependencies): Promise<void>;
}
export {};

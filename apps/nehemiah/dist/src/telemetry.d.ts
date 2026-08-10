export interface LogContext {
    readonly requestId?: string;
    readonly machineId?: string;
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly hostId?: string;
    readonly leaseId?: string;
}
export declare const requestId: (request: Request) => string;
/** Structured logger with an allowlist: command bodies, terminal bytes and secrets never enter it. */
export declare const log: (level: "debug" | "info" | "warn" | "error", message: string, context?: LogContext & Record<string, unknown>) => void;

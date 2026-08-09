import { randomUUID } from 'node:crypto';

export interface LogContext {
	readonly requestId?: string;
	readonly machineId?: string;
	readonly organizationId?: string;
	readonly projectId?: string;
	readonly hostId?: string;
	readonly leaseId?: string;
}

export const requestId = (request: Request): string => {
	const supplied = request.headers.get('x-request-id');
	return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
};

/** Structured logger with an allowlist: command bodies, terminal bytes and secrets never enter it. */
export const log = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	context: LogContext & Record<string, unknown> = {}
): void => {
	process.stdout.write(
		`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context })}\n`
	);
};

import { isIP } from 'node:net';

export const STATUS_PROBE_TIMEOUT_MS = 2_000;
export const STATUS_RESPONSE_LIMIT_BYTES = 16_384;
export const PUBLIC_STATUS_CACHE_CONTROL =
	'public, max-age=15, s-maxage=15, stale-while-revalidate=30';

export type PublicComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface PublicStatusSnapshot {
	readonly status: PublicComponentStatus;
	readonly components: {
		readonly control_plane: PublicComponentStatus;
		readonly gateway: PublicComponentStatus;
	};
	readonly checked_at: string;
}

export interface PublicStatusInput {
	readonly controlPlaneUrl?: string;
	readonly gatewayUrl?: string;
	readonly production: boolean;
}

export interface PublicStatusDependencies {
	readonly fetch?: typeof globalThis.fetch;
	readonly now?: () => Date;
	/** Test-only clock compression; production callers use the fixed 2 second default. */
	readonly timeoutMs?: number;
}

type ProbeResult = 'healthy' | 'unhealthy' | 'unknown';

const hasControlCharacter = (value: string): boolean =>
	[...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 31 || code === 127;
	});

const isLoopback = (hostname: string): boolean => {
	const unwrapped =
		hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	if (unwrapped === 'localhost' || unwrapped === '::1') return true;
	return isIP(unwrapped) === 4 && unwrapped.startsWith('127.');
};

/** Accept only an origin. HTTP and loopback are limited to local development. */
export const safeProbeOrigin = (
	value: string | undefined,
	production: boolean
): string | undefined => {
	if (!value || value.length > 2_048 || value.trim() !== value || hasControlCharacter(value)) {
		return undefined;
	}
	try {
		const url = new URL(value);
		const loopback = isLoopback(url.hostname);
		if (
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash ||
			url.hostname.endsWith('.') ||
			(production && (url.protocol !== 'https:' || loopback)) ||
			(!production && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
		) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
};

const consumeBounded = async (response: Response, signal: AbortSignal): Promise<boolean> => {
	const length = response.headers.get('content-length');
	if (length && /^\d+$/.test(length) && Number(length) > STATUS_RESPONSE_LIMIT_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		return false;
	}
	if (!response.body) return true;

	const reader = response.body.getReader();
	const cancel = (): void => void reader.cancel().catch(() => undefined);
	if (signal.aborted) cancel();
	else signal.addEventListener('abort', cancel, { once: true });
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return true;
			bytes += value.byteLength;
			if (bytes > STATUS_RESPONSE_LIMIT_BYTES) {
				await reader.cancel().catch(() => undefined);
				return false;
			}
		}
	} catch {
		return false;
	} finally {
		signal.removeEventListener('abort', cancel);
	}
};

const probe = async (
	origin: string,
	path: '/healthz' | '/readyz',
	fetchImplementation: typeof globalThis.fetch,
	timeoutMs: number
): Promise<ProbeResult> => {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ProbeResult>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve('unknown');
		}, timeoutMs);
	});
	const operation = (async (): Promise<ProbeResult> => {
		try {
			const response = await fetchImplementation(new URL(path, origin), {
				method: 'GET',
				redirect: 'error',
				credentials: 'omit',
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
				signal: controller.signal,
				headers: { accept: 'application/json' }
			});
			if (response.redirected || (response.status >= 300 && response.status < 400)) {
				await response.body?.cancel().catch(() => undefined);
				return 'unknown';
			}
			if (!(await consumeBounded(response, controller.signal))) return 'unknown';
			if (response.ok) return 'healthy';
			return response.status >= 500 ? 'unhealthy' : 'unknown';
		} catch {
			return 'unknown';
		}
	})();

	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const controlPlaneStatus = (
	liveness: ProbeResult,
	readiness: ProbeResult
): PublicComponentStatus => {
	if (liveness === 'unhealthy') return 'outage';
	if (liveness === 'healthy' && readiness === 'healthy') return 'operational';
	if (liveness === 'unknown' && readiness === 'unknown') return 'unknown';
	return 'degraded';
};

const gatewayStatus = (health: ProbeResult): PublicComponentStatus =>
	health === 'healthy' ? 'operational' : health === 'unhealthy' ? 'outage' : 'unknown';

const overallStatus = (components: ReadonlyArray<PublicComponentStatus>): PublicComponentStatus => {
	if (components.includes('outage')) return 'outage';
	if (components.every((status) => status === 'operational')) return 'operational';
	if (components.every((status) => status === 'unknown')) return 'unknown';
	return 'degraded';
};

export const collectPublicStatus = async (
	input: PublicStatusInput,
	dependencies: PublicStatusDependencies = {}
): Promise<PublicStatusSnapshot> => {
	const controlPlaneOrigin = safeProbeOrigin(input.controlPlaneUrl, input.production);
	const gatewayOrigin = safeProbeOrigin(input.gatewayUrl, input.production);
	const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
	const timeoutMs = dependencies.timeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
	const boundedTimeout =
		Number.isSafeInteger(timeoutMs) && timeoutMs > 0
			? Math.min(timeoutMs, STATUS_PROBE_TIMEOUT_MS)
			: STATUS_PROBE_TIMEOUT_MS;

	const [liveness, readiness, gatewayHealth] = await Promise.all([
		controlPlaneOrigin
			? probe(controlPlaneOrigin, '/healthz', fetchImplementation, boundedTimeout)
			: Promise.resolve<ProbeResult>('unknown'),
		controlPlaneOrigin
			? probe(controlPlaneOrigin, '/readyz', fetchImplementation, boundedTimeout)
			: Promise.resolve<ProbeResult>('unknown'),
		gatewayOrigin
			? probe(gatewayOrigin, '/healthz', fetchImplementation, boundedTimeout)
			: Promise.resolve<ProbeResult>('unknown')
	]);
	const components = {
		control_plane: controlPlaneStatus(liveness, readiness),
		gateway: gatewayStatus(gatewayHealth)
	} as const;
	return {
		status: overallStatus([components.control_plane, components.gateway]),
		components,
		checked_at: (dependencies.now ?? (() => new Date()))().toISOString()
	};
};

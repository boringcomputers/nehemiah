import { randomUUID } from 'node:crypto';
import {
	ROOT_CONTEXT,
	SpanStatusCode,
	context,
	metrics,
	propagation,
	trace,
	type Attributes,
	type TextMapGetter
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK, core, tracing } from '@opentelemetry/sdk-node';
import { Redacted } from 'effect';
import type { Environment, TelemetryConfig } from './config.js';

export interface LogContext {
	readonly requestId?: string;
	readonly machineId?: string;
	readonly organizationId?: string;
	readonly projectId?: string;
	readonly hostId?: string;
	readonly leaseId?: string;
	readonly forkOperationId?: string;
	readonly sourceMachineId?: string;
	readonly method?: string;
	readonly path?: string;
	readonly status?: number;
	readonly duration_ms?: number;
	readonly port?: number;
	readonly environment?: string;
	readonly reason?: string;
	readonly result?: string;
	readonly error?: unknown;
}

export interface DatabasePoolSnapshot {
	readonly total: number;
	readonly idle: number;
	readonly waiting: number;
}

export interface MeteringHealthSnapshot {
	readonly backlog: number;
	readonly openExceptions: number;
}

export type ControlPlaneJob =
	| 'device_authorization_retention'
	| 'gateway_grant_expiry'
	| 'gateway_stream_expiry'
	| 'host_stale_marker'
	| 'machine_expiry'
	| 'machine_reconciliation'
	| 'template_replication'
	| 'usage_aggregation'
	| 'volume_deletion';

interface RuntimeConfig {
	readonly telemetry?: TelemetryConfig;
	readonly environment: Environment;
	readonly region: string;
}

const headerGetter: TextMapGetter<Headers> = {
	keys: (carrier) => [...carrier.keys()],
	get: (carrier, key) => carrier.get(key) ?? undefined
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const normalizedPathPattern =
	/^\/(?:[A-Za-z0-9._-]+|:[A-Za-z0-9_-]+)(?:\/(?:[A-Za-z0-9._-]+|:[A-Za-z0-9_-]+))*$/;
const boundedEnumPattern = /^[a-z][a-z0-9_]{0,63}$/;
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const safeIdentifier = (value: unknown): string | undefined =>
	typeof value === 'string' && idPattern.test(value) ? value : undefined;

const statusClass = (status: number): string =>
	Number.isInteger(status) && status >= 100 && status <= 599
		? `${Math.floor(status / 100)}xx`
		: 'unknown';

const errorType = (error: unknown): string => {
	if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
		return error.name;
	}
	return 'Error';
};

/** Build the only structured-log fields that may leave the process. Arbitrary
 * context keys and error text are intentionally discarded. */
export const safeLogRecord = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	input: LogContext = {},
	now = new Date()
): Record<string, unknown> => {
	const record: Record<string, unknown> = {
		timestamp: now.toISOString(),
		level,
		message: message.slice(0, 128)
	};
	for (const key of [
		'requestId',
		'machineId',
		'organizationId',
		'projectId',
		'hostId',
		'leaseId',
		'forkOperationId',
		'sourceMachineId'
	] as const) {
		const value = safeIdentifier(input[key]);
		if (value !== undefined) record[key] = value;
	}
	if (input.method && methods.has(input.method)) record.method = input.method;
	if (input.path && normalizedPathPattern.test(input.path)) record.route = input.path;
	if (Number.isInteger(input.status) && input.status! >= 100 && input.status! <= 599) {
		record.status = input.status;
	}
	if (Number.isFinite(input.duration_ms) && input.duration_ms! >= 0) {
		record.duration_ms = Math.round(input.duration_ms!);
	}
	if (Number.isSafeInteger(input.port) && input.port! >= 1 && input.port! <= 65_535) {
		record.port = input.port;
	}
	if (['development', 'test', 'staging', 'production'].includes(input.environment ?? '')) {
		record.environment = input.environment;
	}
	for (const key of ['reason', 'result'] as const) {
		const value = input[key];
		if (value && boundedEnumPattern.test(value)) record[key] = value;
	}
	if (input.error !== undefined) record.error_type = errorType(input.error);
	return record;
};

/** Structured logger with a strict allowlist. Headers, URLs, bodies, commands,
 * terminal bytes, raw IPs, signed URLs, and error messages never enter it. */
export const log = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	contextValue: LogContext = {}
): void => {
	process.stdout.write(`${JSON.stringify(safeLogRecord(level, message, contextValue))}\n`);
};

const generatedRequestIds = new WeakMap<Request, string>();

export const requestId = (request: Request): string => {
	const supplied = request.headers.get('x-request-id');
	if (
		supplied &&
		/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(supplied)
	) {
		return supplied;
	}
	const existing = generatedRequestIds.get(request);
	if (existing) return existing;
	const generated = randomUUID();
	generatedRequestIds.set(request, generated);
	return generated;
};

const lifecycleOperation = (method: string, route: string): string | undefined => {
	if (method === 'POST' && route === '/v1/machines') return 'create';
	if (method === 'DELETE' && route === '/v1/machines/:id') return 'destroy';
	if (method === 'POST' && route === '/v1/machines/:id/extend') return 'extend';
	if (method === 'POST' && route === '/v1/machines/:id/fork') return 'fork';
	if (method === 'POST' && route === '/v1/templates') return 'template_publish';
	return undefined;
};

class ControlPlaneTelemetry {
	readonly #tracer = trace.getTracer('nehemiah-control');
	readonly #requestCount = metrics
		.getMeter('nehemiah-control')
		.createCounter('nehemiah.control.http.server.request.count');
	readonly #requestDuration = metrics
		.getMeter('nehemiah-control')
		.createHistogram('nehemiah.control.http.server.request.duration', { unit: 's' });
	readonly #activeRequests = metrics
		.getMeter('nehemiah-control')
		.createUpDownCounter('nehemiah.control.http.server.active_requests');
	readonly #lifecycleCount = metrics
		.getMeter('nehemiah-control')
		.createCounter('nehemiah.control.machine.lifecycle.count');
	readonly #jobCount = metrics
		.getMeter('nehemiah-control')
		.createCounter('nehemiah.control.job.run.count');
	readonly #jobDuration = metrics
		.getMeter('nehemiah-control')
		.createHistogram('nehemiah.control.job.run.duration', { unit: 's' });
	readonly #sdk?: NodeSDK;

	constructor(sdk?: NodeSDK) {
		this.#sdk = sdk;
	}

	async request(
		input: { readonly request: Request; readonly requestId: string; readonly route: string },
		operation: () => Promise<Response>
	): Promise<Response> {
		const method = methods.has(input.request.method) ? input.request.method : 'OTHER';
		const base: Attributes = { 'http.request.method': method, 'http.route': input.route };
		const parent = propagation.extract(ROOT_CONTEXT, input.request.headers, headerGetter);
		return context.with(parent, () =>
			this.#tracer.startActiveSpan(
				`${method} ${input.route}`,
				{ attributes: base },
				async (span) => {
					const started = performance.now();
					this.#activeRequests.add(1, base);
					let status = 500;
					try {
						const response = await operation();
						status = response.status;
						return response;
					} catch (error) {
						span.setStatus({ code: SpanStatusCode.ERROR });
						span.setAttribute('error.type', errorType(error));
						throw error;
					} finally {
						this.#activeRequests.add(-1, base);
						const result = statusClass(status);
						const attributes = { ...base, 'http.response.status_class': result };
						this.#requestCount.add(1, attributes);
						this.#requestDuration.record((performance.now() - started) / 1_000, attributes);
						const lifecycle = lifecycleOperation(method, input.route);
						if (lifecycle) this.#lifecycleCount.add(1, { operation: lifecycle, result });
						span.setAttribute('http.response.status_code', status);
						if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
						span.end();
					}
				}
			)
		);
	}

	async job<A>(name: ControlPlaneJob, operation: () => Promise<A>): Promise<A> {
		return this.#tracer.startActiveSpan(
			`job ${name}`,
			{ attributes: { 'job.name': name } },
			async (span) => {
				const started = performance.now();
				let result = 'success';
				try {
					return await operation();
				} catch (error) {
					result = 'failure';
					span.setStatus({ code: SpanStatusCode.ERROR });
					span.setAttribute('error.type', errorType(error));
					throw error;
				} finally {
					const attributes = { 'job.name': name, result };
					this.#jobCount.add(1, attributes);
					this.#jobDuration.record((performance.now() - started) / 1_000, attributes);
					span.end();
				}
			}
		);
	}

	registerDatabasePool(read: () => DatabasePoolSnapshot): void {
		const meter = metrics.getMeter('nehemiah-control');
		for (const [name, field] of [
			['nehemiah.control.database.pool.connections', 'total'],
			['nehemiah.control.database.pool.idle', 'idle'],
			['nehemiah.control.database.pool.waiting', 'waiting']
		] as const) {
			meter.createObservableGauge(name).addCallback((observation) => {
				const value = read()[field];
				if (Number.isSafeInteger(value) && value >= 0) observation.observe(value);
			});
		}
	}

	registerMeteringHealth(read: () => Promise<MeteringHealthSnapshot>): void {
		const meter = metrics.getMeter('nehemiah-control');
		const backlog = meter.createObservableGauge('nehemiah.control.metering.backlog');
		const exceptions = meter.createObservableGauge(
			'nehemiah.control.metering.exception.open.count'
		);
		const callback = async (): Promise<MeteringHealthSnapshot | undefined> => {
			try {
				return await read();
			} catch {
				return undefined;
			}
		};
		backlog.addCallback(async (observation) => {
			const value = await callback();
			if (value && Number.isSafeInteger(value.backlog) && value.backlog >= 0) {
				observation.observe(value.backlog);
			}
		});
		exceptions.addCallback(async (observation) => {
			const value = await callback();
			if (value && Number.isSafeInteger(value.openExceptions) && value.openExceptions >= 0) {
				observation.observe(value.openExceptions);
			}
		});
	}

	inject(headers: Headers): void {
		propagation.inject(context.active(), headers, {
			set: (carrier, key, value) => carrier.set(key, value)
		});
	}

	async shutdown(): Promise<void> {
		await this.#sdk?.shutdown();
	}
}

let active = new ControlPlaneTelemetry();

const endpoint = (origin: string, signal: 'metrics' | 'traces'): string => `${origin}/v1/${signal}`;

/** Keep resource identity deployment-controlled and exclude credentials or
 * arbitrary environment/configuration values by construction. */
export const telemetryResourceAttributes = (
	telemetry: Pick<TelemetryConfig, 'serviceVersion' | 'instanceId' | 'deploymentEnvironment'>,
	region: string
): Attributes => ({
	'service.name': 'nehemiah-control',
	'service.version': telemetry.serviceVersion,
	'service.instance.id': telemetry.instanceId,
	'deployment.environment.name': telemetry.deploymentEnvironment,
	'cloud.region': region
});

export const initializeTelemetry = (config: RuntimeConfig): ControlPlaneTelemetry => {
	if (!config.telemetry) {
		active = new ControlPlaneTelemetry();
		return active;
	}
	const telemetry = config.telemetry;
	const headers = { Authorization: Redacted.value(telemetry.authorization) };
	const sdk = new NodeSDK({
		resource: resourceFromAttributes(telemetryResourceAttributes(telemetry, config.region)),
		traceExporter: new OTLPTraceExporter({
			url: endpoint(telemetry.endpoint, 'traces'),
			headers,
			timeoutMillis: telemetry.exportTimeoutMs
		}),
		metricReaders: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({
					url: endpoint(telemetry.endpoint, 'metrics'),
					headers,
					timeoutMillis: telemetry.exportTimeoutMs
				}),
				exportIntervalMillis: telemetry.exportIntervalMs,
				exportTimeoutMillis: telemetry.exportTimeoutMs
			})
		],
		sampler: new tracing.ParentBasedSampler({
			root: new tracing.TraceIdRatioBasedSampler(telemetry.traceSampleRatio)
		})
	});
	sdk.start();
	propagation.setGlobalPropagator(new core.W3CTraceContextPropagator());
	active = new ControlPlaneTelemetry(sdk);
	return active;
};

export const withControlPlaneRequestTelemetry = (
	input: { readonly request: Request; readonly requestId: string; readonly route: string },
	operation: () => Promise<Response>
): Promise<Response> => active.request(input, operation);

export const withJobTelemetry = <A>(
	name: ControlPlaneJob,
	operation: () => Promise<A>
): Promise<A> => active.job(name, operation);

export const registerDatabasePoolMetrics = (read: () => DatabasePoolSnapshot): void =>
	active.registerDatabasePool(read);

/** Global fleet gauges deliberately carry no tenant, machine, lease, or host labels. */
export const registerMeteringMetrics = (read: () => Promise<MeteringHealthSnapshot>): void =>
	active.registerMeteringHealth(read);

export const injectTraceHeaders = (headers: Headers): void => active.inject(headers);

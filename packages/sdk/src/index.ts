/**
 * nehemiah-sdk — Effect-native TypeScript client for the Nehemiah
 * Firecracker microVM API.
 *
 * REST calls go through `@effect/platform`'s `HttpClient` and validate responses
 * with `Schema`; errors are tagged; the serial console is a `Stream` with
 * `Scope`-based teardown. Relies on the global `fetch` / `WebSocket`.
 */

import {
	Context,
	Data,
	Duration,
	Effect,
	Layer,
	Queue,
	Schedule,
	Schema,
	Scope,
	Stream
} from 'effect';
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse
} from '@effect/platform';

// --- wire types (Schema-validated) ------------------------------------------

const MachineSchema = Schema.Struct({
	id: Schema.String,
	status: Schema.Literal('running'),
	mode: Schema.Literal('coldboot', 'snapshot', 'warm'),
	boot_ms: Schema.Number,
	template: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.String,
	/** Set on forks: the machine this one was branched from. */
	parent: Schema.optional(Schema.String)
});
const MachineListSchema = Schema.Struct({ machines: Schema.Array(MachineSchema) });

const TemplateSchema = Schema.Struct({
	name: Schema.String,
	published: Schema.Boolean,
	display: Schema.Boolean,
	size_mb: Schema.optional(Schema.Number),
	created_at: Schema.optional(Schema.String),
	source_template: Schema.optional(Schema.String)
});
const TemplateListSchema = Schema.Struct({ templates: Schema.Array(TemplateSchema) });

const VolumeSchema = Schema.Struct({
	id: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.String,
	quota_mb: Schema.Number,
	used_bytes: Schema.optional(Schema.Number),
	files: Schema.optional(Schema.Number)
});

/** A microVM as returned by the nehemiahd REST API. */
export type Machine = Schema.Schema.Type<typeof MachineSchema>;
export type MachineMode = Machine['mode'];
export type MachineStatus = Machine['status'];

/** A persistent volume (S3-backed storage that outlives a machine). */
export type Volume = Schema.Schema.Type<typeof VolumeSchema>;

/** A machine template: built-in (python, desktop) or published from a machine. */
export type Template = Schema.Schema.Type<typeof TemplateSchema>;

const ExecResultSchema = Schema.Struct({
	output: Schema.String,
	exit_code: Schema.NullOr(Schema.Number),
	timed_out: Schema.Boolean,
	duration_ms: Schema.Number
});

/** The result of running one command via {@link NehemiahClient.exec}. */
export type ExecResult = Schema.Schema.Type<typeof ExecResultSchema>;

export interface ExecOptions {
	/** Seconds before the command is abandoned (default 30, max 120). */
	readonly timeoutSeconds?: number;
}

export interface CreateMachineOptions {
	readonly template?: string;
	readonly ttlSeconds?: number;
	/** Give the machine internet (cold-boots instead of restoring a snapshot). */
	readonly net?: boolean;
	/** Restore this volume's snapshot into /root on boot. */
	readonly volume?: string;
}

export interface NehemiahClientOptions {
	/** Base URL of nehemiahd. Defaults to `http://localhost:8080`. */
	readonly baseUrl?: string;
	/** Optional bearer token (sent as `Authorization` and `?token=` on WS). */
	readonly token?: string;
}

// --- errors -----------------------------------------------------------------

/** The request never got a valid response (network error, timeout, bad body). */
export class RequestError extends Data.TaggedError('RequestError')<{
	readonly method: string;
	readonly path: string;
	readonly cause: unknown;
}> {}

/** The API responded with a non-2xx status. */
export class ResponseError extends Data.TaggedError('ResponseError')<{
	readonly status: number;
	readonly body: string;
}> {}

export type NehemiahError = RequestError | ResponseError;

// --- serial console ---------------------------------------------------------

/** A live serial-console channel: `output` streams guest bytes, `send` writes stdin. */
export interface TtyChannel {
	readonly output: Stream.Stream<Uint8Array>;
	readonly send: (data: Uint8Array | string) => Effect.Effect<void>;
}

// --- service ----------------------------------------------------------------

export interface NehemiahClient {
	readonly createMachine: (opts?: CreateMachineOptions) => Effect.Effect<Machine, NehemiahError>;
	readonly listMachines: Effect.Effect<ReadonlyArray<Machine>, NehemiahError>;
	readonly getMachine: (id: string) => Effect.Effect<Machine, NehemiahError>;
	readonly destroyMachine: (id: string) => Effect.Effect<void, NehemiahError>;
	readonly branchMachine: (id: string) => Effect.Effect<Machine, NehemiahError>;
	/**
	 * Fleet fork: N live clones from ONE snapshot of the machine (the source is
	 * paused once, however many clones are made). Partial failures keep the
	 * successes — the array holds whatever booted. Each clone's `parent` is set.
	 */
	readonly branchMachines: (
		id: string,
		count: number
	) => Effect.Effect<ReadonlyArray<Machine>, NehemiahError>;
	/**
	 * Freeze a running machine as a named template; new machines boot from it in
	 * milliseconds via `createMachine({template: name})`. 409 if the name exists.
	 */
	readonly publishMachine: (id: string, name: string) => Effect.Effect<Template, NehemiahError>;
	/** List templates: the built-ins plus everything published. */
	readonly listTemplates: Effect.Effect<ReadonlyArray<Template>, NehemiahError>;
	/** Delete a published template (built-ins are refused). */
	readonly deleteTemplate: (name: string) => Effect.Effect<void, NehemiahError>;
	/**
	 * Reset a machine's TTL to `ttlSeconds` from now (omit for the server's
	 * default; clamped like create). Returns the machine with its new expiry.
	 */
	readonly extendMachine: (id: string, ttlSeconds?: number) => Effect.Effect<Machine, NehemiahError>;
	/**
	 * Run one shell command in the machine and get `{output, exit_code}` back —
	 * deterministic, no TTY. A 409 means the console is busy (another exec or an
	 * agent run); `exit_code` is `null` when the command timed out.
	 */
	readonly exec: (
		id: string,
		command: string,
		opts?: ExecOptions
	) => Effect.Effect<ExecResult, NehemiahError>;
	/** Open a serial console. The socket is closed when the enclosing `Scope` closes. */
	readonly connectTty: (id: string) => Effect.Effect<TtyChannel, RequestError, Scope.Scope>;
	/** Create a persistent volume (storage that outlives a machine). */
	readonly createVolume: (ttlSeconds?: number) => Effect.Effect<Volume, NehemiahError>;
	/** Fetch a volume's metadata + usage. */
	readonly getVolume: (id: string) => Effect.Effect<Volume, NehemiahError>;
	/** Delete a volume and all its files. */
	readonly deleteVolume: (id: string) => Effect.Effect<void, NehemiahError>;
	/** Save a machine's /root into a volume (attach on launch via createMachine). */
	readonly saveMachine: (machineId: string, volumeId: string) => Effect.Effect<void, NehemiahError>;
}

export const NehemiahClient = Context.GenericTag<NehemiahClient>('nehemiah-sdk/NehemiahClient');

/** A `Layer` providing {@link NehemiahClient} from static options. */
export const layer = (options: NehemiahClientOptions = {}): Layer.Layer<NehemiahClient> =>
	Layer.succeed(NehemiahClient, make(options));

/** Build a {@link NehemiahClient} implementation directly (no layer). */
export const make = (options: NehemiahClientOptions = {}): NehemiahClient => {
	const baseUrl = (options.baseUrl ?? 'http://localhost:8080').replace(/\/+$/, '');
	const token = options.token;

	// One request → typed error, Schema-decoded body (or void when schema is null).
	const request = <A>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		schema: Schema.Schema<A> | null,
		body?: unknown
	): Effect.Effect<A, NehemiahError> =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const url = `${baseUrl}${path}`;
			let req =
				method === 'GET'
					? HttpClientRequest.get(url)
					: method === 'DELETE'
						? HttpClientRequest.del(url)
						: HttpClientRequest.post(url);
			if (token !== undefined)
				req = HttpClientRequest.setHeader(req, 'Authorization', `Bearer ${token}`);
			if (body !== undefined) req = HttpClientRequest.bodyUnsafeJson(req, body);

			const res = yield* client
				.execute(req)
				.pipe(Effect.mapError((cause) => new RequestError({ method, path, cause })));

			if (res.status >= 400) {
				const text = yield* res.text.pipe(Effect.orElseSucceed(() => ''));
				return yield* new ResponseError({ status: res.status, body: text });
			}
			if (schema === null) {
				yield* res.text.pipe(Effect.orElseSucceed(() => '')); // drain
				return undefined as A;
			}
			return yield* HttpClientResponse.schemaBodyJson(schema)(res).pipe(
				Effect.mapError((cause) => new RequestError({ method, path, cause }))
			);
		}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

	// Retry transient failures (transport errors + 5xx) up to twice, backing off.
	const retry = Schedule.exponential(Duration.millis(250)).pipe(
		Schedule.intersect(Schedule.recurs(2)),
		Schedule.whileInput(
			(e: NehemiahError) =>
				e._tag === 'RequestError' || (e._tag === 'ResponseError' && e.status >= 500)
		)
	);

	const connectTty = (id: string): Effect.Effect<TtyChannel, RequestError, Scope.Scope> =>
		Effect.gen(function* () {
			const wsBase = baseUrl.replace(/^http/, 'ws');
			let url = `${wsBase}/v1/machines/${encodeURIComponent(id)}/tty`;
			if (token !== undefined) url += `?token=${encodeURIComponent(token)}`;

			const queue = yield* Queue.unbounded<Uint8Array>();
			const socket = yield* Effect.acquireRelease(
				Effect.async<WebSocket, RequestError>((resume) => {
					const ws = new WebSocket(url);
					ws.binaryType = 'arraybuffer';
					ws.onopen = () => resume(Effect.succeed(ws));
					ws.onerror = () =>
						resume(
							Effect.fail(new RequestError({ method: 'WS', path: url, cause: 'tty socket error' }))
						);
					ws.onmessage = (e) => {
						const bytes = toUint8Array((e as MessageEvent).data);
						if (bytes !== undefined) Effect.runSync(Queue.offer(queue, bytes));
					};
					ws.onclose = () => Effect.runSync(Queue.shutdown(queue));
				}),
				(ws) => Effect.sync(() => ws.close())
			);

			return {
				output: Stream.fromQueue(queue),
				send: (data) =>
					Effect.sync(() =>
						socket.send(typeof data === 'string' ? new TextEncoder().encode(data) : data)
					)
			} satisfies TtyChannel;
		});

	return {
		createMachine: (opts = {}) => {
			const body: { template?: string; ttl_seconds?: number; net?: boolean; volume?: string } = {};
			if (opts.template !== undefined) body.template = opts.template;
			if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
			if (opts.net !== undefined) body.net = opts.net;
			if (opts.volume !== undefined) body.volume = opts.volume;
			return request('POST', '/v1/machines', MachineSchema, body).pipe(Effect.retry(retry));
		},
		createVolume: (ttlSeconds) =>
			request('POST', '/v1/volumes', VolumeSchema, ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
		getVolume: (id) => request('GET', `/v1/volumes/${encodeURIComponent(id)}`, VolumeSchema),
		deleteVolume: (id) => request('DELETE', `/v1/volumes/${encodeURIComponent(id)}`, null),
		saveMachine: (machineId, volumeId) =>
			request(
				'POST',
				`/v1/machines/${encodeURIComponent(machineId)}/save?volume=${encodeURIComponent(volumeId)}`,
				null
			),
		listMachines: request('GET', '/v1/machines', MachineListSchema).pipe(
			Effect.map((r) => r.machines)
		),
		getMachine: (id) => request('GET', `/v1/machines/${encodeURIComponent(id)}`, MachineSchema),
		destroyMachine: (id) => request('DELETE', `/v1/machines/${encodeURIComponent(id)}`, null),
		branchMachine: (id) =>
			request('POST', `/v1/machines/${encodeURIComponent(id)}/branch`, MachineSchema),
		branchMachines: (id, count) =>
			count <= 1
				? request('POST', `/v1/machines/${encodeURIComponent(id)}/branch`, MachineSchema).pipe(
						Effect.map((m) => [m] as ReadonlyArray<Machine>)
					)
				: request(
						'POST',
						`/v1/machines/${encodeURIComponent(id)}/branch?count=${Math.floor(count)}`,
						MachineListSchema
					).pipe(Effect.map((r) => r.machines)),
		publishMachine: (id, name) =>
			request('POST', `/v1/machines/${encodeURIComponent(id)}/publish`, TemplateSchema, { name }),
		listTemplates: request('GET', '/v1/templates', TemplateListSchema).pipe(
			Effect.map((r) => r.templates)
		),
		deleteTemplate: (name) => request('DELETE', `/v1/templates/${encodeURIComponent(name)}`, null),
		extendMachine: (id, ttlSeconds) =>
			request(
				'POST',
				`/v1/machines/${encodeURIComponent(id)}/extend`,
				MachineSchema,
				ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}
			).pipe(Effect.retry(retry)),
		// No retry: a command is not idempotent.
		exec: (id, command, opts = {}) =>
			request('POST', `/v1/machines/${encodeURIComponent(id)}/exec`, ExecResultSchema, {
				command,
				...(opts.timeoutSeconds !== undefined ? { timeout_seconds: opts.timeoutSeconds } : {})
			}),
		connectTty
	};
};

function toUint8Array(data: unknown): Uint8Array | undefined {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (typeof data === 'string') return new TextEncoder().encode(data);
	return undefined;
}

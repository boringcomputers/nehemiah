/**
 * Effect-native client for local, self-hosted, and Boring Computers Cloud
 * machines. The public methods deliberately keep the original nehemiahd
 * surface while adding the managed control-plane contract.
 */

import {
	Context,
	Data,
	Duration,
	Effect,
	Layer,
	Option,
	Queue,
	Schedule,
	Schema,
	Scope,
	Stream
} from 'effect';

export const CLOUD_BASE_URL = 'https://api.boringcomputers.com';
export const LOCAL_BASE_URL = 'http://localhost:8080';

export type TargetMode = 'local' | 'self-hosted' | 'cloud';
export type MachineState =
	'requested' | 'placing' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'lost';
export type MachineMode = 'coldboot' | 'snapshot' | 'warm';
export type MachineStatus = MachineState;
export type MachineSize = 'small' | 'medium' | 'large';
export type GatewayCapability = 'tty' | 'vnc' | 'agent' | 'files' | 'preview';

const MachineStateSchema = Schema.Literal(
	'requested',
	'placing',
	'starting',
	'running',
	'stopping',
	'stopped',
	'failed',
	'lost'
);

const ResourcesSchema = Schema.Struct({
	vcpus: Schema.Number,
	memory_mb: Schema.Number,
	disk_mb: Schema.Number
});

const NetworkPolicySchema = Schema.Struct({
	mode: Schema.Literal('off', 'allowlist'),
	hostnames: Schema.Array(Schema.String),
	cidrs: Schema.Array(Schema.String)
});

/**
 * The common machine model. Local-only boot information and cloud-only
 * lifecycle information are optional so callers can use one client contract.
 */
const MachineSchema = Schema.Struct({
	id: Schema.String,
	status: MachineStateSchema,
	state: Schema.optional(MachineStateSchema),
	ready: Schema.optional(Schema.Boolean),
	mode: Schema.optional(Schema.Literal('coldboot', 'snapshot', 'warm')),
	boot_ms: Schema.optional(Schema.Number),
	template: Schema.optional(Schema.String),
	template_id: Schema.optional(Schema.NullOr(Schema.String)),
	oci_reference: Schema.optional(Schema.NullOr(Schema.String)),
	project_id: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	architecture: Schema.optional(Schema.Literal('x86_64', 'aarch64')),
	resources: Schema.optional(ResourcesSchema),
	network_policy: Schema.optional(NetworkPolicySchema),
	created_at: Schema.String,
	started_at: Schema.optional(Schema.NullOr(Schema.String)),
	ready_at: Schema.optional(Schema.NullOr(Schema.String)),
	stopped_at: Schema.optional(Schema.NullOr(Schema.String)),
	expires_at: Schema.String,
	failure_reason: Schema.optional(Schema.NullOr(Schema.String)),
	parent: Schema.optional(Schema.String),
	parent_id: Schema.optional(Schema.String)
});

const MachineListSchema = Schema.Struct({
	machines: Schema.Array(MachineSchema),
	next_cursor: Schema.optional(Schema.String)
});

const PendingForkResponseSchema = Schema.Struct({
	operation: Schema.Struct({
		id: Schema.String,
		state: Schema.Literal('pending', 'cleanup_pending'),
		idempotency_key: Schema.String,
		source_machine_id: Schema.String,
		requested: Schema.Number
	}),
	machines: Schema.Array(MachineSchema),
	requested: Schema.Number
});
const SingleForkResponseSchema = Schema.Union(MachineSchema, PendingForkResponseSchema);
const BatchForkResponseSchema = Schema.Union(PendingForkResponseSchema, MachineListSchema);

const TemplateSchema = Schema.Struct({
	name: Schema.String,
	published: Schema.Boolean,
	display: Schema.Boolean,
	size_mb: Schema.optional(Schema.Number),
	created_at: Schema.optional(Schema.String),
	source_template: Schema.optional(Schema.String)
});
const TemplateListSchema = Schema.Struct({ templates: Schema.Array(TemplateSchema) });

const ManagedTemplateSchema = Schema.Struct({
	id: Schema.String,
	project_id: Schema.String,
	name: Schema.String,
	version: Schema.String,
	manifest: Schema.Struct({
		schema_version: Schema.Literal(1),
		format: Schema.Literal('firecracker-snapshot-v1'),
		architecture: Schema.Literal('x86_64', 'aarch64'),
		source: Schema.Struct({ machine_id: Schema.String }),
		artifact: Schema.Struct({
			object_key: Schema.String,
			checksum: Schema.String,
			size_bytes: Schema.Number
		})
	}),
	checksum: Schema.String,
	size_bytes: Schema.Number,
	source_machine_id: Schema.String,
	created_at: Schema.String
});
const ManagedTemplateListSchema = Schema.Struct({
	templates: Schema.Array(ManagedTemplateSchema)
});

const VolumeGrantSchema = Schema.Struct({
	method: Schema.Literal('GET', 'PUT'),
	url: Schema.String,
	headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
	expires_at: Schema.String,
	maximum_bytes: Schema.optional(Schema.Number)
});

const VolumeSchema = Schema.Struct({
	id: Schema.String,
	project_id: Schema.optional(Schema.String),
	created_at: Schema.String,
	expires_at: Schema.String,
	quota_mb: Schema.Number,
	used_bytes: Schema.optional(Schema.Number),
	files: Schema.optional(Schema.Number),
	deleted_at: Schema.optional(Schema.String),
	delete_after: Schema.optional(Schema.String),
	grant: Schema.optional(VolumeGrantSchema)
});
const ExecResultSchema = Schema.Struct({
	output: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	stderr: Schema.optional(Schema.String),
	exit_code: Schema.NullOr(Schema.Number),
	timed_out: Schema.Boolean,
	duration_ms: Schema.Number
});

const GatewaySessionSchema = Schema.Struct({
	id: Schema.String,
	token: Schema.String,
	expires_in: Schema.Number,
	gateway_url: Schema.String,
	preview_url: Schema.optional(Schema.String)
});

const FileUploadResultSchema = Schema.Struct({
	ok: Schema.Literal(true),
	path: Schema.String,
	bytes: Schema.Number,
	transport: Schema.Literal('vsock', 'serial')
});

export type Machine = Schema.Schema.Type<typeof MachineSchema>;
export type MachineResources = Schema.Schema.Type<typeof ResourcesSchema>;
export type NetworkPolicy = Schema.Schema.Type<typeof NetworkPolicySchema>;
export type Volume = Schema.Schema.Type<typeof VolumeSchema>;
export type VolumeGrant = Schema.Schema.Type<typeof VolumeGrantSchema>;
export type Template = Schema.Schema.Type<typeof TemplateSchema>;
export type ManagedTemplate = Schema.Schema.Type<typeof ManagedTemplateSchema>;
export type ExecResult = Schema.Schema.Type<typeof ExecResultSchema>;

export interface RateLimitMetadata {
	readonly limit?: number;
	readonly remaining?: number;
	readonly resetAt?: string;
	readonly retryAfterSeconds?: number;
}

export interface ResponseMetadata {
	readonly requestId?: string;
	readonly rateLimit?: RateLimitMetadata;
	readonly idempotencyReplayed?: boolean;
}

export interface MachinePage {
	readonly machines: ReadonlyArray<Machine>;
	readonly nextCursor?: string;
	readonly metadata: ResponseMetadata;
}

export interface GatewaySession {
	/** Durable, non-secret session identity used for explicit revocation. */
	readonly id: string;
	/** Treat this short-lived capability token as a secret. */
	readonly token: string;
	readonly expiresIn: number;
	readonly gatewayUrl: string;
	readonly previewUrl?: string;
	readonly metadata: ResponseMetadata;
}

export const MAX_FILE_TRANSFER_BYTES = 16 << 20;
export const MAX_FILE_TRANSFER_TIMEOUT_MS = 900_000;
/** Maximum unread TTY/VNC payload retained by one SDK channel. */
export const MAX_CHANNEL_BACKLOG_BYTES = 4 << 20;
/** Bounds per-frame queue overhead in addition to the byte budget. */
export const MAX_CHANNEL_BACKLOG_FRAMES = 256;
/** Maximum TTY frame accepted by the managed host and gateway contract. */
export const MAX_TTY_FRAME_BYTES = 64 << 10;
/** Maximum VNC frame accepted by the managed host and gateway contract. */
export const MAX_VNC_FRAME_BYTES = 1 << 20;
/** Maximum native WebSocket send backlog retained by one channel. */
export const MAX_CHANNEL_BUFFERED_AMOUNT_BYTES = 4 << 20;

export interface FileTransferOptions {
	/** Client-side transfer bound. Defaults to, and cannot exceed, 16 MiB. */
	readonly maximumBytes?: number;
	/** Transfer timeout in milliseconds. Defaults to the configured client timeout. */
	readonly timeoutMs?: number;
	/** Short-lived files capability lifetime in seconds (1-900). */
	readonly ttlSeconds?: number;
}

export interface FileUploadResult {
	readonly path: string;
	readonly bytes: number;
	readonly transport: 'vsock' | 'serial';
	readonly metadata: ResponseMetadata;
}

export interface FileDownloadResult {
	readonly data: Uint8Array;
	readonly bytes: number;
	readonly metadata: ResponseMetadata;
}

export interface ProblemDetails {
	readonly type: string;
	readonly title: string;
	readonly status: number;
	readonly detail: string;
	readonly requestId?: string;
	readonly [extension: string]: unknown;
}

export interface PendingForkOperation {
	readonly id: string;
	readonly state: 'pending' | 'cleanup_pending';
	readonly idempotencyKey: string;
	readonly sourceMachineId: string;
	readonly requested: number;
}

export interface ExecOptions {
	/** Guest command timeout in seconds (default 30, max 120). */
	readonly timeoutSeconds?: number;
}

export interface RequestOptions {
	readonly idempotencyKey?: string;
}

export interface CreateMachineOptions extends RequestOptions {
	/** Built-in or published template name. */
	readonly template?: string;
	/** Managed published-template UUID. */
	readonly templateId?: string;
	readonly ociReference?: string;
	readonly ttlSeconds?: number;
	readonly project?: string;
	readonly region?: string;
	readonly architecture?: 'x86_64' | 'aarch64';
	readonly size?: MachineSize;
	readonly resources?: Partial<{
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskMb: number;
	}>;
	/** Managed guest egress. Omission defaults to fully off. */
	readonly networkPolicy?: {
		readonly mode: 'off' | 'allowlist';
		readonly hostnames?: ReadonlyArray<string>;
		readonly cidrs?: ReadonlyArray<string>;
	};
	/** Local/self-hosted nehemiahd option. */
	readonly net?: boolean;
	/** Local/self-hosted nehemiahd option. */
	readonly volume?: string;
}

export interface ListMachinesOptions {
	readonly project?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface CreateVolumeOptions extends RequestOptions {
	readonly project?: string;
	readonly sizeLimitMb?: number;
	readonly ttlSeconds?: number;
	readonly grantTtlSeconds?: number;
}

export interface ListVolumesOptions {
	readonly project?: string;
}

export interface PublishTemplateOptions {
	readonly name: string;
	readonly version: string;
	readonly project?: string;
}

export interface ListManagedTemplatesOptions {
	readonly project?: string;
}

export interface DeleteManagedTemplateOptions {
	readonly project?: string;
}

export interface GatewaySessionOptions {
	readonly capabilities?: ReadonlyArray<GatewayCapability>;
	readonly port?: number;
	readonly ttlSeconds?: number;
}

export interface ReconnectOptions {
	/** Attempts made by {@link BinaryChannel.reconnect}; default 3. */
	readonly maxAttempts?: number;
	/** Initial reconnect delay; default 250ms. */
	readonly delayMs?: number;
}

export interface NehemiahClientOptions {
	/** Explicit endpoint behavior. Omitted means `local` for 0.1 compatibility. */
	readonly target?: TargetMode;
	/** Cloud defaults to https://api.boringcomputers.com; local defaults to localhost:8080. */
	readonly baseUrl?: string;
	/** B.C API key used as a bearer credential. */
	readonly apiKey?: string;
	/** Legacy alias for apiKey, preserved for self-hosted clients. */
	readonly token?: string;
	/** Default managed project ID. */
	readonly project?: string;
	/** Default managed region. */
	readonly region?: string;
	/** Per-attempt HTTP timeout. Default 30 seconds. */
	readonly timeoutMs?: number;
	/** Retry count after the first safe attempt. Default 2. */
	readonly maxRetries?: number;
	readonly retryDelayMs?: number;
	readonly idempotencyKey?: () => string;
	/** Called once for every HTTP response. Do not throw from this callback. */
	readonly onResponseMetadata?: (metadata: ResponseMetadata) => void;
}

// --- errors -----------------------------------------------------------------

/** The request never got a valid response (network error, timeout, bad body). */
export class RequestError extends Data.TaggedError('RequestError')<{
	readonly method: string;
	readonly path: string;
	readonly cause: unknown;
	/** Stable recovery identity when a durable mutation may have committed. */
	readonly idempotencyKey?: string;
}> {}

/** The API responded with a non-2xx status. */
export class ResponseError extends Data.TaggedError('ResponseError')<{
	readonly status: number;
	readonly body: string;
	readonly problem?: ProblemDetails;
	readonly metadata?: ResponseMetadata;
	/** Stable recovery identity when the response is retryable/ambiguous. */
	readonly idempotencyKey?: string;
}> {}

/** The selected target does not implement an otherwise valid client operation. */
export class NotSupported extends Data.TaggedError('NotSupported')<{
	readonly operation: string;
	readonly target: TargetMode;
	readonly detail: string;
	readonly status?: number;
	readonly problem?: ProblemDetails;
}> {}

/** A managed fork was accepted but has no safe terminal result yet. */
export class ForkPending extends Data.TaggedError('ForkPending')<{
	readonly message: string;
	readonly operation: PendingForkOperation;
	readonly machines: ReadonlyArray<Machine>;
	readonly metadata: ResponseMetadata;
}> {}

/** A TTY/VNC consumer stopped draining long enough to exhaust its fixed backlog. */
export class ChannelBacklogExceeded extends Data.TaggedError('ChannelBacklogExceeded')<{
	readonly capability: 'tty' | 'vnc';
	readonly maximumBytes: number;
	readonly maximumFrames: number;
	readonly limit: 'bytes' | 'frames';
}> {}

/** An outbound TTY/VNC frame or native WebSocket backlog exceeded its fixed bound. */
export class ChannelSendLimitExceeded extends Data.TaggedError('ChannelSendLimitExceeded')<{
	readonly capability: 'tty' | 'vnc';
	readonly attemptedBytes: number;
	readonly maximumFrameBytes: number;
	readonly maximumBufferedBytes: number;
	readonly limit: 'frame' | 'buffered';
}> {}

export type ChannelTerminalError = ChannelBacklogExceeded | ChannelSendLimitExceeded;

export type NehemiahError =
	| RequestError
	| ResponseError
	| NotSupported
	| ForkPending
	| ChannelBacklogExceeded
	| ChannelSendLimitExceeded;

// --- streaming --------------------------------------------------------------

/** A TTY/VNC byte channel. Closing the enclosing Scope closes the socket. */
export interface BinaryChannel {
	readonly output: Stream.Stream<Uint8Array, ChannelTerminalError>;
	readonly send: (
		data: Uint8Array | string
	) => Effect.Effect<void, RequestError | ChannelTerminalError>;
	/** Reissues a cloud capability before reconnecting. */
	readonly reconnect: Effect.Effect<void, NehemiahError>;
}

export type TtyChannel = BinaryChannel;
export type VncChannel = BinaryChannel;

// --- client -----------------------------------------------------------------

export interface NehemiahClient {
	readonly target: TargetMode;
	readonly baseUrl: string;
	readonly createMachine: (opts?: CreateMachineOptions) => Effect.Effect<Machine, NehemiahError>;
	/** Backward-compatible first-page list. Use listMachinesPage for pagination. */
	readonly listMachines: Effect.Effect<ReadonlyArray<Machine>, NehemiahError>;
	readonly listMachinesPage: (
		opts?: ListMachinesOptions
	) => Effect.Effect<MachinePage, NehemiahError>;
	readonly getMachine: (id: string) => Effect.Effect<Machine, NehemiahError>;
	readonly destroyMachine: (
		id: string,
		opts?: RequestOptions
	) => Effect.Effect<void, NehemiahError>;
	readonly branchMachine: (
		id: string,
		opts?: RequestOptions
	) => Effect.Effect<Machine, NehemiahError>;
	readonly branchMachines: (
		id: string,
		count: number,
		opts?: RequestOptions
	) => Effect.Effect<ReadonlyArray<Machine>, NehemiahError>;
	readonly publishMachine: (id: string, name: string) => Effect.Effect<Template, NehemiahError>;
	readonly listTemplates: Effect.Effect<ReadonlyArray<Template>, NehemiahError>;
	readonly deleteTemplate: (name: string) => Effect.Effect<void, NehemiahError>;
	/**
	 * Reserved managed-template publication contract. Cloud production currently
	 * returns `NotSupported` until aggregate storage quotas and durable eviction exist.
	 */
	readonly publishTemplate: (
		machineId: string,
		opts: PublishTemplateOptions
	) => Effect.Effect<ManagedTemplate, NehemiahError>;
	readonly listManagedTemplates: (
		opts?: ListManagedTemplatesOptions
	) => Effect.Effect<ReadonlyArray<ManagedTemplate>, NehemiahError>;
	readonly deleteManagedTemplate: (
		id: string,
		opts?: DeleteManagedTemplateOptions
	) => Effect.Effect<void, NehemiahError>;
	readonly extendMachine: (
		id: string,
		ttlSeconds?: number,
		opts?: RequestOptions
	) => Effect.Effect<Machine, NehemiahError>;
	readonly exec: (
		id: string,
		command: string,
		opts?: ExecOptions
	) => Effect.Effect<ExecResult, NehemiahError>;
	readonly createSession: (
		id: string,
		opts?: GatewaySessionOptions
	) => Effect.Effect<GatewaySession, NehemiahError>;
	readonly revokeSession: (
		machineId: string,
		sessionId: string
	) => Effect.Effect<void, NehemiahError>;
	/** Upload a bounded byte array as `/root/<name>` through a short-lived files capability. */
	readonly uploadFile: (
		id: string,
		name: string,
		data: Uint8Array,
		opts?: FileTransferOptions
	) => Effect.Effect<FileUploadResult, NehemiahError>;
	/** Download one absolute guest path through a short-lived files capability. */
	readonly downloadFile: (
		id: string,
		remotePath: string,
		opts?: FileTransferOptions
	) => Effect.Effect<FileDownloadResult, NehemiahError>;
	readonly getPreviewUrl: (
		id: string,
		port: number,
		ttlSeconds?: number
	) => Effect.Effect<string, NehemiahError>;
	readonly connectTty: (
		id: string,
		opts?: ReconnectOptions
	) => Effect.Effect<TtyChannel, NehemiahError, Scope.Scope>;
	readonly connectVnc: (
		id: string,
		opts?: ReconnectOptions
	) => Effect.Effect<VncChannel, NehemiahError, Scope.Scope>;
	readonly createVolume: (
		input?: number | CreateVolumeOptions
	) => Effect.Effect<Volume, NehemiahError>;
	readonly listVolumes: (
		opts?: ListVolumesOptions
	) => Effect.Effect<ReadonlyArray<Volume>, NehemiahError>;
	readonly getVolume: (id: string) => Effect.Effect<Volume, NehemiahError>;
	readonly createVolumeGrant: (
		id: string,
		method: 'GET' | 'PUT',
		ttlSeconds?: number
	) => Effect.Effect<VolumeGrant, NehemiahError>;
	readonly deleteVolume: (id: string) => Effect.Effect<void, NehemiahError>;
	readonly saveMachine: (machineId: string, volumeId: string) => Effect.Effect<void, NehemiahError>;
}

export const NehemiahClient = Context.GenericTag<NehemiahClient>('nehemiah-sdk/NehemiahClient');

export const layer = (options: NehemiahClientOptions = {}): Layer.Layer<NehemiahClient> =>
	Layer.succeed(NehemiahClient, make(options));

const sizeResources: Readonly<Record<MachineSize, MachineResources>> = {
	small: { vcpus: 1, memory_mb: 512, disk_mb: 5_120 },
	medium: { vcpus: 2, memory_mb: 2_048, disk_mb: 10_240 },
	large: { vcpus: 4, memory_mb: 4_096, disk_mb: 20_480 }
};

interface Detailed<A> {
	readonly value: A;
	readonly metadata: ResponseMetadata;
	readonly status: number;
}

type Method = 'GET' | 'POST' | 'DELETE';

const loopbackHostname = (hostname: string): boolean =>
	hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** Validate a credential-bearing API endpoint before any request can be created. */
export const apiOrigin = (value: string, target: TargetMode): string => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError('baseUrl must be an absolute API origin');
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== '' && url.pathname !== '/')
	) {
		throw new TypeError(
			'baseUrl must be a bare API origin without credentials, path, query, or fragment'
		);
	}
	const secure = url.protocol === 'https:';
	const loopbackDevelopment = url.protocol === 'http:' && loopbackHostname(url.hostname);
	if (target === 'cloud' ? !secure : !secure && !loopbackDevelopment) {
		throw new TypeError(
			target === 'cloud'
				? 'cloud baseUrl must use HTTPS'
				: 'local and self-hosted HTTP baseUrl must use an exact loopback host'
		);
	}
	return url.origin;
};

export const make = (options: NehemiahClientOptions = {}): NehemiahClient => {
	const target = options.target ?? 'local';
	const baseUrl = apiOrigin(
		options.baseUrl ?? (target === 'cloud' ? CLOUD_BASE_URL : LOCAL_BASE_URL),
		target
	);
	const credential = options.apiKey ?? options.token;
	const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
	const maxRetries = nonNegativeInteger(options.maxRetries, 2);
	const retryDelayMs = positiveInteger(options.retryDelayMs, 250);
	const nextKey = options.idempotencyKey ?? defaultIdempotencyKey;

	const requestDetailed = <A>(
		method: Method,
		path: string,
		schema: Schema.Schema<A> | null,
		requestOptions: {
			readonly body?: unknown;
			readonly idempotencyKey?: string;
			readonly retryable?: boolean;
			readonly timeoutMs?: number;
		} = {}
	): Effect.Effect<Detailed<A>, NehemiahError> => {
		const once = Effect.tryPromise({
			try: async () => {
				const controller = new AbortController();
				const requestTimeoutMs = requestOptions.timeoutMs ?? timeoutMs;
				const timer = setTimeout(
					() => controller.abort(new Error(`request timed out after ${requestTimeoutMs}ms`)),
					requestTimeoutMs
				);
				try {
					const headers: Record<string, string> = { accept: 'application/json' };
					if (credential !== undefined) headers.authorization = `Bearer ${credential}`;
					if (requestOptions.idempotencyKey !== undefined) {
						headers['idempotency-key'] = requestOptions.idempotencyKey;
					}
					let body: string | undefined;
					if (requestOptions.body !== undefined) {
						headers['content-type'] = 'application/json';
						body = JSON.stringify(requestOptions.body);
					}
					const response = await fetch(`${baseUrl}${path}`, {
						method,
						headers,
						body,
						signal: controller.signal
					});
					const metadata = responseMetadata(response.headers);
					try {
						options.onResponseMetadata?.(metadata);
					} catch {
						// Telemetry callbacks cannot change request semantics.
					}
					if (!response.ok) {
						const errorBody = await response.text().catch(() => '');
						throw new ResponseError({
							status: response.status,
							body: errorBody,
							problem: parseProblem(errorBody, response.status),
							metadata,
							...(requestOptions.idempotencyKey === undefined
								? {}
								: { idempotencyKey: requestOptions.idempotencyKey })
						});
					}
					if (schema === null) {
						await response.text().catch(() => '');
						return { value: undefined as A, metadata, status: response.status };
					}
					const raw = await response.json();
					const value = Schema.decodeUnknownSync(schema)(raw);
					return { value, metadata, status: response.status };
				} finally {
					clearTimeout(timer);
				}
			},
			catch: (cause) =>
				cause instanceof ResponseError
					? cause
					: new RequestError({
							method,
							path,
							cause,
							...(requestOptions.idempotencyKey === undefined
								? {}
								: { idempotencyKey: requestOptions.idempotencyKey })
						})
		});

		if (!requestOptions.retryable || maxRetries === 0) return once;
		const retry = (attempt: number): Effect.Effect<Detailed<A>, NehemiahError> =>
			once.pipe(
				Effect.catchAll((error) => {
					if (!isTransient(error) || attempt >= maxRetries) return Effect.fail(error);
					const exponentialMs = Math.min(60_000, retryDelayMs * 2 ** attempt);
					const retryAfterSeconds =
						error._tag === 'ResponseError'
							? error.metadata?.rateLimit?.retryAfterSeconds
							: undefined;
					const serverDelayMs =
						retryAfterSeconds !== undefined &&
						Number.isFinite(retryAfterSeconds) &&
						retryAfterSeconds >= 0
							? Math.ceil(retryAfterSeconds * 1_000)
							: 0;
					const delayMs = Math.min(60_000, Math.max(exponentialMs, serverDelayMs));
					return Effect.sleep(Duration.millis(delayMs)).pipe(Effect.zipRight(retry(attempt + 1)));
				})
			);
		return retry(0);
	};

	const request = <A>(
		method: Method,
		path: string,
		schema: Schema.Schema<A> | null,
		requestOptions?: {
			readonly body?: unknown;
			readonly idempotencyKey?: string;
			readonly retryable?: boolean;
			readonly timeoutMs?: number;
		}
	): Effect.Effect<A, NehemiahError> =>
		requestDetailed(method, path, schema, requestOptions).pipe(Effect.map(({ value }) => value));

	const unsupported = <A>(operation: string, detail: string): Effect.Effect<A, NotSupported> =>
		Effect.fail(new NotSupported({ operation, target, detail }));

	const localOnly = <A>(operation: string, effect: Effect.Effect<A, NehemiahError>) =>
		target === 'cloud'
			? unsupported<A>(
					operation,
					`${operation} is not available on the managed control-plane contract.`
				)
			: effect;
	const cloudOnly = <A>(operation: string, effect: Effect.Effect<A, NehemiahError>) =>
		target === 'cloud'
			? effect
			: unsupported<A>(operation, `${operation} is available only on the managed cloud target.`);
	const managedVolumeUnavailable = <A>(operation: string): Effect.Effect<A, NotSupported> =>
		unsupported(
			operation,
			'Managed volumes are disabled for the private beta until durable volume/revision counts and global transfer admission are enforced.'
		);

	const createMachine = (
		opts: CreateMachineOptions = {}
	): Effect.Effect<Machine, NehemiahError> => {
		if (target !== 'cloud') {
			if (opts.idempotencyKey !== undefined) {
				return unsupported(
					'createMachine idempotency',
					'The public local/self-hosted daemon does not provide durable idempotency replay.'
				);
			}
			if (
				opts.project !== undefined ||
				opts.region !== undefined ||
				opts.architecture !== undefined ||
				opts.size !== undefined ||
				opts.resources !== undefined ||
				opts.ociReference !== undefined ||
				opts.templateId !== undefined ||
				opts.networkPolicy !== undefined
			) {
				return unsupported(
					'createMachine managed options',
					'project, region, architecture, size, resources, template IDs, OCI sources, and network policies require the cloud target.'
				);
			}
			const body: { template?: string; ttl_seconds?: number; net?: boolean; volume?: string } = {};
			if (opts.template !== undefined) body.template = opts.template;
			if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
			if (opts.net !== undefined) body.net = opts.net;
			if (opts.volume !== undefined) body.volume = opts.volume;
			return request('POST', '/v1/machines', MachineSchema, {
				body
			});
		}
		const idempotencyKey = opts.idempotencyKey ?? nextKey();

		if (opts.net !== undefined || opts.volume !== undefined) {
			return unsupported(
				'createMachine local options',
				'net and volume are host-local options and are not accepted by the cloud control plane.'
			);
		}
		if (opts.ociReference !== undefined) {
			return unsupported(
				'createMachine',
				'Managed OCI image imports are not implemented. Use a built-in template or templateId.'
			);
		}
		if (opts.networkPolicy !== undefined && opts.networkPolicy.mode !== 'off') {
			return unsupported(
				'createMachine managed egress',
				'Managed guest egress is disabled until hard organization, project, and host-network traffic quotas are enforced.'
			);
		}
		const selected = opts.size === undefined ? undefined : sizeResources[opts.size];
		const resources = {
			vcpus: opts.resources?.vcpus ?? selected?.vcpus,
			memory_mb: opts.resources?.memoryMb ?? selected?.memory_mb,
			disk_mb: opts.resources?.diskMb ?? selected?.disk_mb
		};
		const body: Record<string, unknown> = {};
		const project = opts.project ?? options.project;
		const region = opts.region ?? options.region;
		if (project !== undefined) body.project_id = project;
		if (region !== undefined) body.region = region;
		if (opts.architecture !== undefined) body.architecture = opts.architecture;
		if (opts.template !== undefined) body.template = opts.template;
		if (opts.templateId !== undefined) body.template_id = opts.templateId;
		if (opts.networkPolicy !== undefined) body.network_policy = opts.networkPolicy;
		if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
		if (resources.vcpus !== undefined) body.vcpus = resources.vcpus;
		if (resources.memory_mb !== undefined) body.memory_mb = resources.memory_mb;
		if (resources.disk_mb !== undefined) body.disk_mb = resources.disk_mb;
		return request('POST', '/v1/machines', MachineSchema, {
			body,
			idempotencyKey,
			retryable: true
		});
	};

	const listMachinesPage = (
		opts: ListMachinesOptions = {}
	): Effect.Effect<MachinePage, NehemiahError> => {
		if (
			target !== 'cloud' &&
			(opts.project !== undefined || opts.cursor !== undefined || opts.limit !== undefined)
		) {
			return unsupported(
				'listMachines pagination',
				'Pagination and project filtering require the cloud target.'
			);
		}
		const query = new URLSearchParams();
		const project = opts.project ?? options.project;
		if (target === 'cloud' && project !== undefined) query.set('project_id', project);
		if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
		if (opts.limit !== undefined) query.set('limit', String(Math.floor(opts.limit)));
		const suffix = query.size === 0 ? '' : `?${query.toString()}`;
		return requestDetailed('GET', `/v1/machines${suffix}`, MachineListSchema, {
			retryable: true
		}).pipe(
			Effect.map(({ value, metadata }) => ({
				machines: value.machines,
				...(value.next_cursor !== undefined ? { nextCursor: value.next_cursor } : {}),
				metadata
			}))
		);
	};

	const cloudFork = <A>(
		effect: Effect.Effect<A, NehemiahError>,
		operation: string
	): Effect.Effect<A, NehemiahError> =>
		effect.pipe(
			Effect.catchAll((error) =>
				error._tag === 'ResponseError' &&
				(error.status === 501 || error.problem?.title === 'not_supported')
					? Effect.fail(
							new NotSupported({
								operation,
								target,
								detail: 'The configured control plane does not expose POST /v1/machines/{id}/fork.',
								status: error.status,
								problem: error.problem
							})
						)
					: Effect.fail(error)
			)
		);

	const pendingFork = (
		response: Schema.Schema.Type<typeof PendingForkResponseSchema>,
		id: string,
		wanted: number,
		idempotencyKey: string,
		metadata: ResponseMetadata,
		path: string
	): Effect.Effect<never, ForkPending | RequestError> => {
		if (
			response.operation.id.length === 0 ||
			response.operation.idempotency_key !== idempotencyKey ||
			response.operation.source_machine_id !== id ||
			response.operation.requested !== wanted ||
			response.requested !== wanted
		) {
			return Effect.fail(
				new RequestError({
					method: 'POST',
					path,
					cause: 'managed fork pending response did not match the requested operation'
				})
			);
		}
		return Effect.fail(
			new ForkPending({
				message: `Managed fork ${response.operation.id} is ${response.operation.state}. Retry with the same idempotency key.`,
				operation: {
					id: response.operation.id,
					state: response.operation.state,
					idempotencyKey: response.operation.idempotency_key,
					sourceMachineId: response.operation.source_machine_id,
					requested: response.operation.requested
				},
				machines: response.machines,
				metadata
			})
		);
	};

	const branchMachine = (id: string, opts: RequestOptions = {}) => {
		if (target !== 'cloud') {
			if (opts.idempotencyKey !== undefined) {
				return unsupported<Machine>(
					'branchMachine idempotency',
					'The public local/self-hosted daemon does not provide durable idempotency replay.'
				);
			}
			return request('POST', `/v1/machines/${encodeURIComponent(id)}/branch`, MachineSchema);
		}
		const key = opts.idempotencyKey ?? nextKey();
		const path = `/v1/machines/${encodeURIComponent(id)}/fork`;
		return cloudFork(
			requestDetailed('POST', path, SingleForkResponseSchema, {
				body: {},
				idempotencyKey: key,
				retryable: true
			}).pipe(
				Effect.flatMap(({ value, metadata, status }) => {
					if (status === 202) {
						return 'operation' in value
							? pendingFork(value, id, 1, key, metadata, path)
							: Effect.fail(
									new RequestError({
										method: 'POST',
										path,
										cause: 'managed fork 202 response omitted recovery operation data'
									})
								);
					}
					return 'operation' in value
						? Effect.fail(
								new RequestError({
									method: 'POST',
									path,
									cause: 'managed fork pending response used a terminal HTTP status'
								})
							)
						: Effect.succeed(value);
				})
			),
			'branchMachine'
		);
	};

	const branchMachines = (id: string, count: number, opts: RequestOptions = {}) => {
		const path = `/v1/machines/${encodeURIComponent(id)}/fork`;
		if (target === 'cloud' && (!Number.isSafeInteger(count) || count < 1 || count > 8)) {
			return Effect.fail(
				new RequestError({
					method: 'POST',
					path,
					cause: 'managed fork count must be an integer from 1 to 8'
				})
			);
		}
		const wanted = target === 'cloud' ? count : Math.max(1, Math.floor(count));
		if (target !== 'cloud') {
			if (opts.idempotencyKey !== undefined) {
				return unsupported<ReadonlyArray<Machine>>(
					'branchMachines idempotency',
					'The public local/self-hosted daemon does not provide durable idempotency replay.'
				);
			}
			return wanted <= 1
				? branchMachine(id, opts).pipe(Effect.map((machine) => [machine] as ReadonlyArray<Machine>))
				: request(
						'POST',
						`/v1/machines/${encodeURIComponent(id)}/branch?count=${wanted}`,
						MachineListSchema
					).pipe(Effect.map(({ machines }) => machines));
		}
		if (wanted <= 1) {
			return branchMachine(id, opts).pipe(
				Effect.map((machine) => [machine] as ReadonlyArray<Machine>)
			);
		}
		const key = opts.idempotencyKey ?? nextKey();
		return cloudFork(
			requestDetailed('POST', path, BatchForkResponseSchema, {
				body: { count: wanted },
				idempotencyKey: key,
				retryable: true
			}).pipe(
				Effect.flatMap(({ value, metadata, status }) => {
					if (status === 202) {
						return 'operation' in value
							? pendingFork(value, id, wanted, key, metadata, path)
							: Effect.fail(
									new RequestError({
										method: 'POST',
										path,
										cause: 'managed fork 202 response omitted recovery operation data'
									})
								);
					}
					if ('operation' in value) {
						return Effect.fail(
							new RequestError({
								method: 'POST',
								path,
								cause: 'managed fork pending response used a terminal HTTP status'
							})
						);
					}
					return value.machines.length === wanted
						? Effect.succeed(value.machines)
						: Effect.fail(
								new RequestError({
									method: 'POST',
									path,
									cause: 'managed fork response did not contain the entire requested batch'
								})
							);
				})
			),
			'branchMachines'
		);
	};

	const createSession = (
		id: string,
		opts: GatewaySessionOptions = {}
	): Effect.Effect<GatewaySession, NehemiahError> => {
		if (target !== 'cloud') {
			return unsupported(
				'createSession',
				'Short-lived gateway capabilities are only available on the cloud target.'
			);
		}
		if (opts.capabilities?.includes('agent')) {
			return unsupported(
				'createSession',
				'Managed host-local LLM agents are unavailable. Run an agent inside the guest through exec, TTY, and file primitives.'
			);
		}
		const body: Record<string, unknown> = {};
		if (opts.capabilities !== undefined) body.capabilities = opts.capabilities;
		if (opts.port !== undefined) body.port = opts.port;
		if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
		return requestDetailed(
			'POST',
			`/v1/machines/${encodeURIComponent(id)}/sessions`,
			GatewaySessionSchema,
			{ body, retryable: true }
		).pipe(
			Effect.map(({ value, metadata }) => ({
				id: value.id,
				token: value.token,
				expiresIn: value.expires_in,
				gatewayUrl: value.gateway_url.replace(/\/+$/, ''),
				...(value.preview_url !== undefined ? { previewUrl: value.preview_url } : {}),
				metadata
			}))
		);
	};

	interface NormalizedFileTransfer {
		readonly maximumBytes: number;
		readonly timeoutMs: number;
		readonly ttlSeconds: number;
	}

	const normalizeFileTransfer = (
		method: 'GET' | 'POST',
		path: string,
		opts: FileTransferOptions
	): Effect.Effect<NormalizedFileTransfer, RequestError> =>
		Effect.try({
			try: () => {
				const maximumBytes = opts.maximumBytes ?? MAX_FILE_TRANSFER_BYTES;
				const fileTimeoutMs = opts.timeoutMs ?? timeoutMs;
				const ttlSeconds =
					opts.ttlSeconds ?? Math.min(900, Math.max(30, Math.ceil(fileTimeoutMs / 1_000) + 10));
				if (
					!Number.isSafeInteger(maximumBytes) ||
					maximumBytes < 1 ||
					maximumBytes > MAX_FILE_TRANSFER_BYTES
				) {
					throw new Error('maximumBytes is outside the supported transfer bound');
				}
				if (
					!Number.isSafeInteger(fileTimeoutMs) ||
					fileTimeoutMs < 1 ||
					fileTimeoutMs > MAX_FILE_TRANSFER_TIMEOUT_MS
				) {
					throw new Error('timeoutMs is outside the supported transfer bound');
				}
				if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
					throw new Error('ttlSeconds is outside the supported capability lifetime');
				}
				return { maximumBytes, timeoutMs: fileTimeoutMs, ttlSeconds };
			},
			catch: (cause) => new RequestError({ method, path, cause })
		});

	const fileResponse = <A>(
		method: 'GET' | 'POST',
		path: string,
		session: GatewaySession,
		transfer: NormalizedFileTransfer,
		requestInit: Omit<RequestInit, 'method' | 'signal'>,
		decode: (response: Response) => Promise<A>,
		gatewayPath = path
	): Effect.Effect<Detailed<A>, NehemiahError> =>
		Effect.tryPromise({
			try: async () => {
				const endpoint = gatewayFileUrl(session, gatewayPath);
				const controller = new AbortController();
				const capabilityTimeoutMs = Math.max(1, session.expiresIn * 1_000 - 1_000);
				const effectiveTimeoutMs = Math.min(transfer.timeoutMs, capabilityTimeoutMs);
				const timer = setTimeout(
					() =>
						controller.abort(new Error(`file transfer timed out after ${effectiveTimeoutMs}ms`)),
					effectiveTimeoutMs
				);
				try {
					const response = await fetch(endpoint, {
						...requestInit,
						method,
						signal: controller.signal,
						redirect: 'error',
						credentials: 'omit',
						referrerPolicy: 'no-referrer'
					});
					const metadata = responseMetadata(response.headers);
					try {
						options.onResponseMetadata?.(metadata);
					} catch {
						// Telemetry callbacks cannot change request semantics.
					}
					if (!response.ok) {
						let errorBody = '';
						try {
							errorBody = new TextDecoder().decode(await boundedResponseBytes(response, 64 << 10));
						} catch {
							// Preserve the status while refusing to buffer an unbounded error body.
						}
						throw new ResponseError({
							status: response.status,
							body: errorBody,
							problem: parseProblem(errorBody, response.status),
							metadata
						});
					}
					return { value: await decode(response), metadata, status: response.status };
				} finally {
					clearTimeout(timer);
				}
			},
			catch: (cause) =>
				cause instanceof ResponseError ? cause : new RequestError({ method, path, cause })
		});

	const uploadFile = (
		id: string,
		name: string,
		data: Uint8Array,
		opts: FileTransferOptions = {}
	): Effect.Effect<FileUploadResult, NehemiahError> => {
		const path = `/v1/machines/${encodeURIComponent(id)}/upload`;
		return cloudOnly(
			'uploadFile',
			normalizeFileTransfer('POST', path, opts).pipe(
				Effect.flatMap((transfer) => {
					if (!validUploadName(name) || !(data instanceof Uint8Array)) {
						return Effect.fail(
							new RequestError({
								method: 'POST',
								path,
								cause: new Error('upload name or byte array is invalid')
							})
						);
					}
					if (data.byteLength > transfer.maximumBytes) {
						return Effect.fail(
							new RequestError({
								method: 'POST',
								path,
								cause: new Error('upload exceeds maximumBytes')
							})
						);
					}
					return createSession(id, {
						capabilities: ['files'],
						ttlSeconds: transfer.ttlSeconds
					}).pipe(
						Effect.flatMap((session) =>
							fileResponse(
								'POST',
								path,
								session,
								transfer,
								{
									headers: {
										authorization: `Bearer ${session.token}`,
										'content-type': 'application/octet-stream',
										'content-length': String(data.byteLength),
										'x-filename': name
									},
									body: data
								},
								async (response) => {
									const bytes = await boundedResponseBytes(response, 16 << 10);
									return Schema.decodeUnknownSync(FileUploadResultSchema)(
										JSON.parse(new TextDecoder().decode(bytes))
									);
								}
							)
						),
						Effect.map(({ value, metadata }) => ({
							path: value.path,
							bytes: value.bytes,
							transport: value.transport,
							metadata
						}))
					);
				})
			)
		);
	};

	const downloadFile = (
		id: string,
		remotePath: string,
		opts: FileTransferOptions = {}
	): Effect.Effect<FileDownloadResult, NehemiahError> => {
		const path = `/v1/machines/${encodeURIComponent(id)}/download`;
		return cloudOnly(
			'downloadFile',
			normalizeFileTransfer('GET', path, opts).pipe(
				Effect.flatMap((transfer) => {
					if (!validRemotePath(remotePath)) {
						return Effect.fail(
							new RequestError({
								method: 'GET',
								path,
								cause: new Error('remote path is invalid')
							})
						);
					}
					return createSession(id, {
						capabilities: ['files'],
						ttlSeconds: transfer.ttlSeconds
					}).pipe(
						Effect.flatMap((session) => {
							const query = new URLSearchParams({ path: remotePath });
							return fileResponse(
								'GET',
								path,
								session,
								transfer,
								{
									headers: {
										authorization: `Bearer ${session.token}`,
										accept: 'application/octet-stream'
									}
								},
								(response) => boundedResponseBytes(response, transfer.maximumBytes),
								`${path}?${query.toString()}`
							);
						}),
						Effect.map(({ value, metadata }) => ({
							data: value,
							bytes: value.byteLength,
							metadata
						}))
					);
				})
			)
		);
	};

	const openChannel = (
		id: string,
		capability: 'tty' | 'vnc',
		reconnectOptions: ReconnectOptions = {}
	): Effect.Effect<BinaryChannel, NehemiahError, Scope.Scope> =>
		Effect.gen(function* () {
			const disconnectSignal = Symbol('websocket-disconnected');
			const backlogFailureSignal = Symbol('websocket-backlog-failed');
			type ChannelFrame = {
				readonly _tag: 'ChannelFrame';
				readonly data: Uint8Array;
				readonly chargedBytes: number;
			};
			type ChannelQueueItem = ChannelFrame | typeof disconnectSignal | typeof backlogFailureSignal;
			// The queue has a structural frame ceiling and one reserved control slot;
			// manual admission below additionally enforces the stricter byte budget.
			const queue = yield* Queue.bounded<ChannelQueueItem>(MAX_CHANNEL_BACKLOG_FRAMES + 1);
			let current: WebSocket | undefined;
			let released = false;
			let disconnectPending = false;
			let queuedBytes = 0;
			let queuedFrames = 0;
			let terminalError: ChannelTerminalError | undefined;
			const socketPath = `/v1/machines/${encodeURIComponent(id)}/${capability}`;
			const maximumFrameBytes = capability === 'tty' ? MAX_TTY_FRAME_BYTES : MAX_VNC_FRAME_BYTES;

			const releaseQueuedFrame = (frame: ChannelFrame) => {
				queuedBytes -= frame.chargedBytes;
				queuedFrames -= 1;
			};
			const drainQueuedFrames = () => {
				for (const item of Effect.runSync(Queue.takeAll(queue))) {
					if (item !== disconnectSignal && item !== backlogFailureSignal) {
						releaseQueuedFrame(item);
					}
				}
			};
			const failTerminal = (socket: WebSocket, error: ChannelTerminalError) => {
				if (released || terminalError !== undefined) return;
				terminalError = error;
				disconnectPending = false;
				if (current === socket) current = undefined;
				socket.onmessage = null;
				socket.onclose = null;
				try {
					socket.close();
				} catch {
					// The channel is terminal even if a host WebSocket shim rejects close().
				}
				drainQueuedFrames();
				Effect.runSync(Queue.offer(queue, backlogFailureSignal));
			};
			const failBacklog = (socket: WebSocket, limit: 'bytes' | 'frames') =>
				failTerminal(
					socket,
					new ChannelBacklogExceeded({
						capability,
						maximumBytes: MAX_CHANNEL_BACKLOG_BYTES,
						maximumFrames: MAX_CHANNEL_BACKLOG_FRAMES,
						limit
					})
				);
			const offerFrame = (socket: WebSocket, bytes: Uint8Array) => {
				// Empty messages have no TTY/VNC meaning and otherwise evade a byte budget.
				if (bytes.byteLength === 0) return;
				if (bytes.byteLength > MAX_CHANNEL_BACKLOG_BYTES - queuedBytes) {
					failBacklog(socket, 'bytes');
					return;
				}
				if (queuedFrames >= MAX_CHANNEL_BACKLOG_FRAMES) {
					failBacklog(socket, 'frames');
					return;
				}
				queuedBytes += bytes.byteLength;
				queuedFrames += 1;
				Effect.runSync(
					Queue.offer(queue, {
						_tag: 'ChannelFrame',
						data: bytes,
						chargedBytes: bytes.byteLength
					})
				);
			};

			const socketTarget: Effect.Effect<
				{ readonly url: string; readonly protocol?: string },
				NehemiahError
			> =
				target === 'cloud'
					? createSession(id, { capabilities: [capability] }).pipe(
							Effect.flatMap((session) =>
								Effect.try({
									try: () => ({
										url: gatewayFileUrl(session, socketPath).replace(/^https:/, 'wss:'),
										protocol: `nehemiah.capability.${session.token}`
									}),
									catch: (cause) => new RequestError({ method: 'WS', path: socketPath, cause })
								})
							)
						)
					: Effect.succeed({
							url: `${baseUrl.replace(/^http/, 'ws')}/v1/machines/${encodeURIComponent(id)}/${capability}${
								credential === undefined ? '' : `?token=${encodeURIComponent(credential)}`
							}`
						});

			const connectOnce = socketTarget.pipe(
				Effect.flatMap(({ url, protocol }) =>
					Effect.async<WebSocket, RequestError>((resume) => {
						let settled = false;
						let closed = false;
						const socket = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
						socket.binaryType = 'arraybuffer';
						socket.onopen = () => {
							if (settled) return;
							settled = true;
							resume(Effect.succeed(socket));
						};
						socket.onerror = () => {
							if (settled) return;
							settled = true;
							// Never include the capability-bearing URL in an error.
							resume(
								Effect.fail(
									new RequestError({
										method: 'WS',
										path: socketPath,
										cause: `${capability} socket error`
									})
								)
							);
						};
						socket.onclose = () => {
							closed = true;
							if (!settled) {
								settled = true;
								resume(
									Effect.fail(
										new RequestError({
											method: 'WS',
											path: socketPath,
											cause: `${capability} socket closed before opening`
										})
									)
								);
								return;
							}
							if (released || current !== socket) return;
							current = undefined;
							disconnectPending = true;
							Effect.runSync(Queue.offer(queue, disconnectSignal));
						};
						socket.onmessage = (event) => {
							const bytes = toUint8Array((event as MessageEvent).data);
							if (bytes !== undefined && !closed && !released && terminalError === undefined) {
								offerFrame(socket, bytes);
							}
						};
					})
				)
			);

			const attach = (socket: WebSocket) =>
				Effect.sync(() => {
					if (current) {
						current.onclose = null;
						current.onmessage = null;
						current.close();
					}
					current = socket;
				});
			yield* connectOnce.pipe(Effect.tap(attach));
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					released = true;
					if (current) {
						current.onclose = null;
						current.onmessage = null;
						current.close();
					}
					drainQueuedFrames();
					Effect.runSync(Queue.shutdown(queue));
				})
			);

			const reconnectSchedule = Schedule.exponential(
				Duration.millis(positiveInteger(reconnectOptions.delayMs, 250))
			).pipe(
				Schedule.intersect(Schedule.recurs(nonNegativeInteger(reconnectOptions.maxAttempts, 3)))
			);
			const takeOutput = Effect.uninterruptibleMask((restore) =>
				restore(Queue.take(queue)).pipe(
					Effect.flatMap((item) => {
						if (item === disconnectSignal) {
							disconnectPending = false;
							return Effect.fail(Option.none<ChannelTerminalError>());
						}
						if (item === backlogFailureSignal) {
							return Effect.fail(
								Option.some(
									terminalError ??
										new ChannelBacklogExceeded({
											capability,
											maximumBytes: MAX_CHANNEL_BACKLOG_BYTES,
											maximumFrames: MAX_CHANNEL_BACKLOG_FRAMES,
											limit: 'bytes'
										})
								)
							);
						}
						releaseQueuedFrame(item);
						return Effect.succeed(item.data);
					})
				)
			);

			return {
				output: Stream.suspend(() =>
					terminalError === undefined
						? Stream.repeatEffectOption(takeOutput)
						: Stream.fail(terminalError)
				),
				send: (data) =>
					Effect.suspend<void, RequestError | ChannelTerminalError, never>(() => {
						if (terminalError !== undefined) return Effect.fail(terminalError);
						const socket = current;
						if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
							return Effect.fail(
								new RequestError({
									method: 'WS',
									path: socketPath,
									cause: `${capability} socket is not open`
								})
							);
						}
						const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
						const bufferedAmount = Number.isFinite(socket.bufferedAmount)
							? socket.bufferedAmount
							: 0;
						const limit =
							bytes.byteLength > maximumFrameBytes
								? 'frame'
								: bufferedAmount > MAX_CHANNEL_BUFFERED_AMOUNT_BYTES - bytes.byteLength
									? 'buffered'
									: undefined;
						if (limit !== undefined) {
							const error = new ChannelSendLimitExceeded({
								capability,
								attemptedBytes: bytes.byteLength,
								maximumFrameBytes,
								maximumBufferedBytes: MAX_CHANNEL_BUFFERED_AMOUNT_BYTES,
								limit
							});
							failTerminal(socket, error);
							return Effect.fail(error);
						}
						return Effect.try({
							try: () => socket.send(bytes),
							catch: (cause) => new RequestError({ method: 'WS', path: socketPath, cause })
						});
					}),
				reconnect: Effect.suspend(() =>
					terminalError !== undefined
						? Effect.fail(terminalError)
						: released
							? Effect.fail(
									new RequestError({
										method: 'WS',
										path: socketPath,
										cause: `${capability} channel has been released`
									})
								)
							: disconnectPending
								? Effect.fail(
										new RequestError({
											method: 'WS',
											path: socketPath,
											cause: `${capability} output must observe the disconnect before reconnecting`
										})
									)
								: connectOnce.pipe(
										Effect.retry(reconnectSchedule),
										Effect.tap(attach),
										Effect.asVoid
									)
				)
			};
		});

	const listMachines = listMachinesPage().pipe(Effect.map(({ machines }) => machines));

	return {
		target,
		baseUrl,
		createMachine,
		listMachines,
		listMachinesPage,
		getMachine: (id) =>
			request('GET', `/v1/machines/${encodeURIComponent(id)}`, MachineSchema, { retryable: true }),
		destroyMachine: (id, opts = {}) =>
			request('DELETE', `/v1/machines/${encodeURIComponent(id)}`, null, {
				idempotencyKey: opts.idempotencyKey,
				retryable: true
			}),
		branchMachine,
		branchMachines,
		publishMachine: (id, name) =>
			localOnly(
				'publishMachine',
				request('POST', `/v1/machines/${encodeURIComponent(id)}/publish`, TemplateSchema, {
					body: { name }
				})
			),
		listTemplates: localOnly(
			'listTemplates',
			request('GET', '/v1/templates', TemplateListSchema, { retryable: true }).pipe(
				Effect.map(({ templates }) => templates)
			)
		),
		deleteTemplate: (name) =>
			localOnly(
				'deleteTemplate',
				request('DELETE', `/v1/templates/${encodeURIComponent(name)}`, null, { retryable: true })
			),
		publishTemplate: (_machineId, _opts) =>
			unsupported(
				'publishTemplate',
				'Managed custom-template publication is disabled until aggregate tenant/host-cache quotas and durable eviction are enforced.'
			),
		listManagedTemplates: (opts = {}) => {
			const project = opts.project ?? options.project;
			const query = new URLSearchParams();
			if (project !== undefined) query.set('project_id', project);
			const suffix = query.size === 0 ? '' : `?${query.toString()}`;
			return cloudOnly(
				'listManagedTemplates',
				request('GET', `/v1/templates${suffix}`, ManagedTemplateListSchema, {
					retryable: true
				}).pipe(Effect.map(({ templates }) => templates))
			);
		},
		deleteManagedTemplate: (id, opts = {}) => {
			const project = opts.project ?? options.project;
			const query = new URLSearchParams();
			if (project !== undefined) query.set('project_id', project);
			const suffix = query.size === 0 ? '' : `?${query.toString()}`;
			return cloudOnly(
				'deleteManagedTemplate',
				request('DELETE', `/v1/templates/${encodeURIComponent(id)}${suffix}`, null, {
					retryable: true
				})
			);
		},
		extendMachine: (id, ttlSeconds, opts = {}) => {
			if (target !== 'cloud' && opts.idempotencyKey !== undefined) {
				return unsupported<Machine>(
					'extendMachine idempotency',
					'The public local/self-hosted daemon does not provide durable idempotency replay.'
				);
			}
			const idempotencyKey = target === 'cloud' ? (opts.idempotencyKey ?? nextKey()) : undefined;
			return request('POST', `/v1/machines/${encodeURIComponent(id)}/extend`, MachineSchema, {
				body: ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {},
				...(idempotencyKey === undefined ? {} : { idempotencyKey, retryable: true })
			});
		},
		exec: (id, command, opts = {}) =>
			// Commands are intentionally never retried: they are not idempotent.
			request('POST', `/v1/machines/${encodeURIComponent(id)}/exec`, ExecResultSchema, {
				timeoutMs: Math.max(timeoutMs, ((opts.timeoutSeconds ?? 30) + 5) * 1_000),
				body: {
					command,
					...(opts.timeoutSeconds !== undefined ? { timeout_seconds: opts.timeoutSeconds } : {})
				}
			}),
		createSession,
		revokeSession: (machineId, sessionId) =>
			cloudOnly(
				'revokeSession',
				request(
					'DELETE',
					`/v1/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}`,
					null,
					{ retryable: true }
				)
			),
		uploadFile,
		downloadFile,
		getPreviewUrl: (id, port, ttlSeconds) =>
			createSession(id, { capabilities: ['preview'], port, ttlSeconds }).pipe(
				Effect.flatMap((session) =>
					session.previewUrl === undefined
						? Effect.fail(
								new RequestError({
									method: 'POST',
									path: `/v1/machines/${encodeURIComponent(id)}/sessions`,
									cause: 'gateway session did not include preview_url'
								})
							)
						: Effect.succeed(session.previewUrl)
				)
			),
		connectTty: (id, opts) => openChannel(id, 'tty', opts),
		connectVnc: (id, opts) => openChannel(id, 'vnc', opts),
		createVolume: (input) => {
			const volumeOptions = typeof input === 'number' ? { ttlSeconds: input } : (input ?? {});
			if (target === 'cloud') return managedVolumeUnavailable('createVolume');
			if (volumeOptions.idempotencyKey !== undefined) {
				return unsupported<Volume>(
					'createVolume idempotency',
					'The public local/self-hosted volume route does not provide durable idempotency replay.'
				);
			}
			if (
				volumeOptions.project !== undefined ||
				volumeOptions.sizeLimitMb !== undefined ||
				volumeOptions.grantTtlSeconds !== undefined
			) {
				return unsupported(
					'createVolume managed options',
					'Project, allocation, and scoped-grant options require the cloud target.'
				);
			}
			return request('POST', '/v1/volumes', VolumeSchema, {
				body: volumeOptions.ttlSeconds ? { ttl_seconds: volumeOptions.ttlSeconds } : {}
			});
		},
		listVolumes: (opts = {}) => {
			if (target === 'cloud') return managedVolumeUnavailable('listVolumes');
			return unsupported(
				'listVolumes',
				'Volume listing is available only on the managed control-plane contract.'
			);
		},
		getVolume: (id) =>
			target === 'cloud'
				? managedVolumeUnavailable('getVolume')
				: request('GET', `/v1/volumes/${encodeURIComponent(id)}`, VolumeSchema, {
						retryable: true
					}),
		createVolumeGrant: (id, method, ttlSeconds) => {
			if (target === 'cloud') return managedVolumeUnavailable('createVolumeGrant');
			return unsupported(
				'createVolumeGrant',
				'Scoped object-store grants require the cloud target.'
			);
		},
		deleteVolume: (id) =>
			target === 'cloud'
				? managedVolumeUnavailable('deleteVolume')
				: request('DELETE', `/v1/volumes/${encodeURIComponent(id)}`, null, { retryable: true }),
		saveMachine: (machineId, volumeId) =>
			localOnly(
				'saveMachine',
				request(
					'POST',
					`/v1/machines/${encodeURIComponent(machineId)}/save?volume=${encodeURIComponent(volumeId)}`,
					null
				)
			)
	};
};

function gatewayFileUrl(session: GatewaySession, path: string): string {
	if (
		!Number.isSafeInteger(session.expiresIn) ||
		session.expiresIn < 1 ||
		session.expiresIn > 900 ||
		!/^[A-Za-z0-9._~-]{1,4096}$/.test(session.token)
	) {
		throw new Error('gateway session credentials are invalid');
	}
	const gateway = new URL(session.gatewayUrl);
	if (
		gateway.protocol !== 'https:' ||
		gateway.username !== '' ||
		gateway.password !== '' ||
		gateway.search !== '' ||
		gateway.hash !== '' ||
		(gateway.pathname !== '' && gateway.pathname !== '/')
	) {
		throw new Error('gateway session URL must be an HTTPS origin');
	}
	return new URL(path, gateway.origin).toString();
}

function validUploadName(value: string): boolean {
	return (
		value !== '.' &&
		value !== '..' &&
		new TextEncoder().encode(value).byteLength <= 255 &&
		/^[A-Za-z0-9._-]+$/.test(value)
	);
}

function validRemotePath(value: string): boolean {
	if (
		!value.startsWith('/') ||
		value === '/' ||
		new TextEncoder().encode(value).byteLength > 4_096 ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		return false;
	}
	return value
		.slice(1)
		.split('/')
		.every((part) => part !== '' && part !== '.' && part !== '..');
}

async function boundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const declared = response.headers.get('content-length');
	if (declared !== null) {
		if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error('response exceeds maximumBytes');
		}
	}
	if (!response.body) {
		if (declared !== null && declared !== '0') throw new Error('response body is missing');
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error('response exceeds maximumBytes');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (declared !== null && total !== Number(declared)) {
		throw new Error('response length did not match Content-Length');
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function parseProblem(body: string, responseStatus: number): ProblemDetails | undefined {
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		if (
			typeof value.type !== 'string' ||
			typeof value.title !== 'string' ||
			typeof value.detail !== 'string' ||
			typeof value.status !== 'number'
		) {
			return undefined;
		}
		return {
			...value,
			type: value.type,
			title: value.title,
			status: value.status || responseStatus,
			detail: value.detail,
			...(typeof value.request_id === 'string' ? { requestId: value.request_id } : {})
		};
	} catch {
		return undefined;
	}
}

function responseMetadata(headers: Headers): ResponseMetadata {
	const requestId = headers.get('x-request-id') ?? undefined;
	const limit = headerNumber(headers, 'ratelimit-limit', 'x-ratelimit-limit');
	const remaining = headerNumber(headers, 'ratelimit-remaining', 'x-ratelimit-remaining');
	const resetAt = headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset') ?? undefined;
	const retryAfterSeconds = headerNumber(headers, 'retry-after');
	const hasRateLimit =
		limit !== undefined ||
		remaining !== undefined ||
		resetAt !== undefined ||
		retryAfterSeconds !== undefined;
	return {
		...(requestId !== undefined ? { requestId } : {}),
		...(hasRateLimit
			? {
					rateLimit: {
						...(limit !== undefined ? { limit } : {}),
						...(remaining !== undefined ? { remaining } : {}),
						...(resetAt !== undefined ? { resetAt } : {}),
						...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
					}
				}
			: {}),
		...(headers.get('idempotency-replayed') === 'true' ? { idempotencyReplayed: true } : {})
	};
}

function headerNumber(headers: Headers, ...names: ReadonlyArray<string>): number | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value === null) continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function isTransient(error: NehemiahError): boolean {
	if (error._tag === 'RequestError') return true;
	if (error._tag !== 'ResponseError') return false;
	return [408, 425, 429].includes(error.status) || error.status >= 500;
}

function defaultIdempotencyKey(): string {
	const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
	if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
	return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function toUint8Array(data: unknown): Uint8Array | undefined {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		// Do not retain a huge backing buffer through a tiny view: the channel's
		// byte budget must bound the memory kept alive, not only the visible slice.
		const bytes = new Uint8Array(view.byteLength);
		bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
		return bytes;
	}
	if (typeof data === 'string') return new TextEncoder().encode(data);
	return undefined;
}

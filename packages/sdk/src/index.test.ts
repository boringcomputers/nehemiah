import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either, Stream } from 'effect';
import {
	ChannelBacklogExceeded,
	ChannelSendLimitExceeded,
	ForkPending,
	make,
	MAX_CHANNEL_BACKLOG_BYTES,
	MAX_CHANNEL_BACKLOG_FRAMES,
	MAX_CHANNEL_BUFFERED_AMOUNT_BYTES,
	MAX_TTY_FRAME_BYTES,
	MAX_VNC_FRAME_BYTES,
	NotSupported,
	RequestError,
	ResponseError,
	type NehemiahError
} from './index';

const MACHINE = {
	id: 'm1',
	status: 'running',
	mode: 'warm',
	boot_ms: 3,
	template: 'python',
	created_at: '2024-01-01T00:00:00Z',
	expires_at: '2024-01-01T00:01:00Z'
} as const;

const VOLUME = {
	id: 'vol-1',
	created_at: '2024-01-01T00:00:00Z',
	expires_at: '2024-01-08T00:00:00Z',
	quota_mb: 1024
} as const;

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function err(status: number, body = ''): Response {
	return new Response(body, { status });
}

function accepted(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 202,
		headers: { 'content-type': 'application/json', 'x-request-id': 'request-pending' }
	});
}

// A 2xx response with an empty body (the shape void endpoints return).
function empty(): Response {
	return new Response('', { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** URL of the nth fetch call. */
function calledUrl(n = 0): string {
	return String(fetchMock.mock.calls[n][0]);
}

/** Request init of the nth fetch call. */
function calledInit(n = 0): RequestInit {
	return fetchMock.mock.calls[n][1] as RequestInit;
}

// The request body is sent as encoded bytes; decode it back to a string.
function calledBody(n = 0): string {
	const body = calledInit(n).body;
	if (typeof body === 'string') return body;
	return new TextDecoder().decode(body as Uint8Array);
}

/** Run an effect and return its failure, asserting it did fail. */
async function failureOf<A>(effect: Effect.Effect<A, NehemiahError>): Promise<NehemiahError> {
	const either = await Effect.runPromise(Effect.either(effect));
	if (Either.isRight(either)) throw new Error('expected effect to fail');
	return either.left;
}

describe('make — base URL and auth', () => {
	it('normalizes a bare loopback origin and joins the path', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make({ baseUrl: 'http://localhost:8080/' }).getMachine('id'));

		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/id');
	});

	it('rejects unsafe or non-origin endpoints before a credential can be sent', () => {
		for (const [target, baseUrl] of [
			['cloud', 'http://attacker.example'],
			['cloud', 'https://user:pass@api.example'],
			['cloud', 'https://api.example/v1'],
			['cloud', 'https://api.example?redirect=evil'],
			['cloud', 'https://api.example/#secret'],
			['self-hosted', 'http://192.0.2.1:8080']
		] as const) {
			expect(() => make({ target, baseUrl, apiKey: 'bc_test_canary' })).toThrow(TypeError);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('defaults baseUrl to localhost:8080', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().getMachine('id'));

		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/id');
	});

	it('sends a bearer token when provided', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make({ token: 'secret' }).getMachine('id'));

		const headers = calledInit().headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer secret');
	});

	it('omits the Authorization header when no token is given', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().getMachine('id'));

		const headers = calledInit().headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
	});
});

describe('getMachine', () => {
	it('decodes a valid machine response', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		const machine = await Effect.runPromise(make().getMachine('id'));

		expect(machine).toEqual(MACHINE);
	});

	it('encodes the id into the path', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().getMachine('a b/c'));

		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/a%20b%2Fc');
	});

	it('fails with a ResponseError carrying status and body on 4xx', async () => {
		fetchMock.mockResolvedValue(err(404, 'not found'));

		const failure = await failureOf(make().getMachine('id'));

		expect(failure).toBeInstanceOf(ResponseError);
		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 404, body: 'not found' });
	});

	it('fails with a RequestError when the body does not match the schema', async () => {
		fetchMock.mockResolvedValue(ok({ id: 'm1' })); // missing required fields

		const failure = await failureOf(make().getMachine('id'));

		expect(failure).toBeInstanceOf(RequestError);
		expect(failure._tag).toBe('RequestError');
	});

	it('fails with a RequestError when the transport throws', async () => {
		fetchMock.mockRejectedValue(new Error('network down'));

		const failure = await failureOf(make().getMachine('id'));

		expect(failure).toBeInstanceOf(RequestError);
		expect(failure).toMatchObject({ _tag: 'RequestError', method: 'GET' });
	});
});

describe('listMachines', () => {
	it('unwraps the machines array from the envelope', async () => {
		fetchMock.mockResolvedValue(ok({ machines: [MACHINE, { ...MACHINE, id: 'm2' }] }));

		const machines = await Effect.runPromise(make().listMachines);

		expect(machines.map((m) => m.id)).toEqual(['m1', 'm2']);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines');
	});
});

describe('createMachine', () => {
	it('only includes provided options in the request body', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().createMachine({ template: 'python', net: true }));

		const init = calledInit();
		expect(init.method).toBe('POST');
		expect(JSON.parse(calledBody())).toEqual({ template: 'python', net: true });
	});

	it('sends an empty body when no options are given', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().createMachine());

		expect(JSON.parse(calledBody())).toEqual({});
	});

	it('retries on 5xx and succeeds', async () => {
		fetchMock.mockResolvedValueOnce(err(503, 'busy')).mockResolvedValueOnce(ok(MACHINE));

		const machine = await Effect.runPromise(
			make({ target: 'cloud' }).createMachine({ template: 'python' })
		);

		expect(machine).toEqual(MACHINE);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('gives up after three attempts on persistent 5xx', async () => {
		fetchMock.mockResolvedValue(err(500, 'boom'));

		const failure = await failureOf(
			make({ target: 'cloud' }).createMachine({ template: 'python' })
		);

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 500 });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not retry a 4xx', async () => {
		fetchMock.mockResolvedValue(err(400, 'bad'));

		const failure = await failureOf(make().createMachine({ template: 'python' }));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 400 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('never retries non-idempotent public local mutations', async () => {
		fetchMock.mockResolvedValue(err(503, 'completion unknown'));

		const failure = await failureOf(make().createMachine({ template: 'python' }));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(calledInit().headers).not.toHaveProperty('idempotency-key');
	});

	it('rejects durable mutation keys when the public local daemon cannot replay them', async () => {
		for (const effect of [
			make().createMachine({ idempotencyKey: 'local-create' }),
			make().branchMachine('m', { idempotencyKey: 'local-branch' }),
			make().extendMachine('m', 60, { idempotencyKey: 'local-extend' }),
			make().createVolume({ idempotencyKey: 'local-volume' })
		]) {
			const failure = await failureOf(effect);
			expect(failure).toBeInstanceOf(NotSupported);
			expect(failure).toMatchObject({ target: 'local' });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces the exact recovery identity after an ambiguous response', async () => {
		fetchMock.mockResolvedValue(err(503, 'completion unknown'));

		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).createMachine({
				template: 'python',
				idempotencyKey: 'machine-create-recovery'
			})
		);

		expect(failure).toMatchObject({
			_tag: 'ResponseError',
			status: 503,
			idempotencyKey: 'machine-create-recovery'
		});
		expect(calledInit().headers).toMatchObject({
			'idempotency-key': 'machine-create-recovery'
		});
	});

	it('surfaces the exact recovery identity after a transport failure', async () => {
		fetchMock.mockRejectedValue(new Error('response lost'));

		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).createMachine({
				template: 'python',
				idempotencyKey: 'machine-create-transport-recovery'
			})
		);

		expect(failure).toMatchObject({
			_tag: 'RequestError',
			method: 'POST',
			idempotencyKey: 'machine-create-transport-recovery'
		});
	});

	it('honors a bounded Retry-After delay before retrying a safe request', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response('busy', { status: 429, headers: { 'retry-after': '0.05' } })
			)
			.mockResolvedValueOnce(ok(MACHINE));
		const started = performance.now();

		await Effect.runPromise(
			make({ target: 'cloud', maxRetries: 1, retryDelayMs: 1 }).createMachine({
				template: 'python'
			})
		);

		expect(performance.now() - started).toBeGreaterThanOrEqual(40);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('destroyMachine & branchMachine', () => {
	it('DELETEs a machine and resolves to void', async () => {
		fetchMock.mockResolvedValue(empty());

		const out = await Effect.runPromise(make().destroyMachine('id'));

		expect(out).toBeUndefined();
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/id');
		expect(calledInit().method).toBe('DELETE');
	});

	it('POSTs to /branch and decodes the forked machine', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		const machine = await Effect.runPromise(make().branchMachine('id'));

		expect(machine).toEqual(MACHINE);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/id/branch');
		expect(calledInit().method).toBe('POST');
	});
});

describe('volumes', () => {
	it('createVolume sends the ttl when provided', async () => {
		fetchMock.mockResolvedValue(ok(VOLUME));

		const volume = await Effect.runPromise(make().createVolume(3600));

		expect(volume).toEqual(VOLUME);
		expect(calledUrl()).toBe('http://localhost:8080/v1/volumes');
		expect(JSON.parse(calledBody())).toEqual({ ttl_seconds: 3600 });
	});

	it('createVolume sends an empty body when ttl is omitted or zero', async () => {
		fetchMock.mockResolvedValue(ok(VOLUME));

		await Effect.runPromise(make().createVolume());

		expect(JSON.parse(calledBody())).toEqual({});
	});

	it('getVolume encodes the id and decodes optional fields', async () => {
		fetchMock.mockResolvedValue(ok({ ...VOLUME, used_bytes: 10, files: 2 }));

		const volume = await Effect.runPromise(make().getVolume('vol/1'));

		expect(volume).toMatchObject({ id: 'vol-1', used_bytes: 10, files: 2 });
		expect(calledUrl()).toBe('http://localhost:8080/v1/volumes/vol%2F1');
	});

	it('deleteVolume DELETEs and resolves to void', async () => {
		fetchMock.mockResolvedValue(empty());

		const out = await Effect.runPromise(make().deleteVolume('vol-1'));

		expect(out).toBeUndefined();
		expect(calledInit().method).toBe('DELETE');
	});

	it('fails every managed volume operation locally without sending credentials', async () => {
		const client = make({ target: 'cloud', project: 'project-1', apiKey: 'bc_secret' });
		for (const [operation, effect] of [
			['createVolume', client.createVolume({ idempotencyKey: 'volume-create-once' })],
			['listVolumes', client.listVolumes()],
			['getVolume', client.getVolume('vol/cloud')],
			['createVolumeGrant', client.createVolumeGrant('vol/cloud', 'GET', 90)],
			['deleteVolume', client.deleteVolume('vol/cloud')]
		] as const) {
			const result = await Effect.runPromise(Effect.either(effect));
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left).toMatchObject({ _tag: 'NotSupported', operation, target: 'cloud' });
			}
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('branchMachines (fleet fork)', () => {
	it('POSTs ?count=N and unwraps the machines array', async () => {
		const forks = [
			{ ...MACHINE, id: 'f1', parent: 'm1' },
			{ ...MACHINE, id: 'f2', parent: 'm1' }
		];
		fetchMock.mockResolvedValue(ok({ machines: forks, requested: 2 }));

		const out = await Effect.runPromise(make().branchMachines('m1', 2));

		expect(out.map((m) => m.id)).toEqual(['f1', 'f2']);
		expect(out[0].parent).toBe('m1');
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m1/branch?count=2');
	});

	it('count=1 uses the bare-machine endpoint and wraps it', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		const out = await Effect.runPromise(make().branchMachines('m1', 1));

		expect(out).toEqual([MACHINE]);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m1/branch');
	});

	it('uses the managed fork contract and preserves parent_id', async () => {
		const fork = { ...MACHINE, id: 'm_cloud_fork', parent_id: 'm_cloud_source' };
		fetchMock.mockResolvedValue(ok(fork));

		const out = await Effect.runPromise(
			make({ target: 'cloud', idempotencyKey: () => 'fork-once' }).branchMachine('m_cloud_source')
		);

		expect(out.parent_id).toBe('m_cloud_source');
		expect(calledUrl()).toBe('https://api.boringcomputers.com/v1/machines/m_cloud_source/fork');
		expect(calledInit().headers).toMatchObject({ 'idempotency-key': 'fork-once' });
		expect(JSON.parse(calledBody())).toEqual({});
	});

	it('surfaces a managed 202 with the exact key needed for safe recovery', async () => {
		const nextKey = vi.fn(() => 'generated-fork-key');
		const fork = { ...MACHINE, id: 'm_cloud_fork', parent_id: 'm_cloud_source' };
		fetchMock.mockResolvedValueOnce(
			accepted({
				operation: {
					id: '11111111-1111-4111-8111-111111111111',
					state: 'cleanup_pending',
					idempotency_key: 'generated-fork-key',
					source_machine_id: 'm_cloud_source',
					requested: 1
				},
				machines: [fork],
				requested: 1
			})
		);
		const client = make({ target: 'cloud', idempotencyKey: nextKey });
		const failure = await failureOf(client.branchMachine('m_cloud_source'));

		expect(failure).toBeInstanceOf(ForkPending);
		expect(failure).toMatchObject({
			operation: {
				id: '11111111-1111-4111-8111-111111111111',
				state: 'cleanup_pending',
				idempotencyKey: 'generated-fork-key',
				sourceMachineId: 'm_cloud_source',
				requested: 1
			},
			metadata: { requestId: 'request-pending' }
		});
		expect(nextKey).toHaveBeenCalledTimes(1);
		expect(calledInit().headers).toMatchObject({ 'idempotency-key': 'generated-fork-key' });

		fetchMock.mockResolvedValueOnce(ok(fork));
		await Effect.runPromise(
			client.branchMachine('m_cloud_source', {
				idempotencyKey: (failure as ForkPending).operation.idempotencyKey
			})
		);
		expect(calledInit(1).headers).toMatchObject({ 'idempotency-key': 'generated-fork-key' });
	});

	it('requires the managed batch response to contain every requested child', async () => {
		const forks = [
			{ ...MACHINE, id: 'm_cloud_fork_1', parent_id: 'm_cloud_source' },
			{ ...MACHINE, id: 'm_cloud_fork_2', parent_id: 'm_cloud_source' }
		];
		fetchMock.mockResolvedValueOnce(ok({ machines: forks, requested: 2 }));
		const out = await Effect.runPromise(
			make({ target: 'cloud' }).branchMachines('m_cloud_source', 2, {
				idempotencyKey: 'fork-batch'
			})
		);
		expect(out.map(({ id }) => id)).toEqual(['m_cloud_fork_1', 'm_cloud_fork_2']);
		expect(JSON.parse(calledBody())).toEqual({ count: 2 });

		fetchMock.mockResolvedValueOnce(ok({ machines: [forks[0]], requested: 2 }));
		const failure = await failureOf(make({ target: 'cloud' }).branchMachines('m_cloud_source', 2));
		expect(failure).toBeInstanceOf(RequestError);
		expect(failure).toMatchObject({
			method: 'POST',
			path: '/v1/machines/m_cloud_source/fork'
		});
	});

	it('retains batch operation recovery data on 202', async () => {
		const forks = [
			{ ...MACHINE, id: 'm_cloud_fork_1', parent_id: 'm_cloud_source' },
			{ ...MACHINE, id: 'm_cloud_fork_2', parent_id: 'm_cloud_source' }
		];
		fetchMock.mockResolvedValueOnce(
			accepted({
				operation: {
					id: '22222222-2222-4222-8222-222222222222',
					state: 'pending',
					idempotency_key: 'fork-batch-recovery',
					source_machine_id: 'm_cloud_source',
					requested: 2
				},
				machines: forks,
				requested: 2
			})
		);

		const failure = await failureOf(
			make({ target: 'cloud' }).branchMachines('m_cloud_source', 2, {
				idempotencyKey: 'fork-batch-recovery'
			})
		);
		expect(failure).toBeInstanceOf(ForkPending);
		expect(failure).toMatchObject({
			operation: { idempotencyKey: 'fork-batch-recovery', requested: 2 },
			machines: [{ id: 'm_cloud_fork_1' }, { id: 'm_cloud_fork_2' }]
		});
	});

	it.each([0, 1.5, 9])('rejects managed count %s before issuing a request', async (count) => {
		const failure = await failureOf(
			make({ target: 'cloud' }).branchMachines('m_cloud_source', count)
		);
		expect(failure).toBeInstanceOf(RequestError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('templates', () => {
	const TEMPLATE = {
		name: 'custom-py',
		published: true,
		display: false,
		size_mb: 1536,
		created_at: '2026-01-01T00:00:00Z',
		source_template: 'python'
	} as const;
	const MANAGED_TEMPLATE = {
		id: '123e4567-e89b-42d3-a456-426614174000',
		project_id: 'project-1',
		name: 'custom-py',
		version: 'v1.2.3',
		manifest: {
			schema_version: 1,
			format: 'firecracker-snapshot-v1',
			architecture: 'x86_64',
			source: { machine_id: 'm_cloud_source_123' },
			artifact: {
				object_key:
					'organizations/org/projects/project-1/templates/custom-py/v1.2.3/123e4567-e89b-42d3-a456-426614174000/snapshot.tar.zst',
				checksum: `sha256:${'ab'.repeat(32)}`,
				size_bytes: 8_388_608
			}
		},
		checksum: `sha256:${'ab'.repeat(32)}`,
		size_bytes: 8_388_608,
		source_machine_id: 'm_cloud_source_123',
		created_at: '2026-08-09T00:00:00Z'
	} as const;

	it('publishMachine POSTs the name and decodes the template', async () => {
		fetchMock.mockResolvedValue(ok(TEMPLATE));

		const t = await Effect.runPromise(make().publishMachine('m1', 'custom-py'));

		expect(t).toEqual(TEMPLATE);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m1/publish');
		expect(JSON.parse(calledBody())).toEqual({ name: 'custom-py' });
	});

	it('listTemplates unwraps the templates array (built-ins lack size)', async () => {
		fetchMock.mockResolvedValue(
			ok({ templates: [{ name: 'python', published: false, display: false }, TEMPLATE] })
		);

		const ts = await Effect.runPromise(make().listTemplates);

		expect(ts.map((t) => t.name)).toEqual(['python', 'custom-py']);
	});

	it('deleteTemplate DELETEs and surfaces the built-in refusal', async () => {
		fetchMock.mockResolvedValue(err(400, 'built-in templates cannot be deleted'));

		const failure = await failureOf(make().deleteTemplate('python'));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 400 });
		expect(calledUrl()).toBe('http://localhost:8080/v1/templates/python');
	});

	it('fails managed custom-template publication locally without making a request', async () => {
		const client = make({ target: 'cloud', project: 'project-1' });

		const failure = await failureOf(
			client.publishTemplate('m_cloud_source_123', {
				name: 'custom-py',
				version: 'v1.2.3'
			})
		);

		expect(failure).toMatchObject({
			_tag: 'NotSupported',
			operation: 'publishTemplate',
			target: 'cloud',
			detail: expect.stringContaining('disabled')
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('lists and deletes managed template records with explicit project scoping', async () => {
		fetchMock
			.mockResolvedValueOnce(ok({ templates: [MANAGED_TEMPLATE] }))
			.mockResolvedValueOnce(empty());
		const client = make({ target: 'cloud' });

		expect(
			await Effect.runPromise(client.listManagedTemplates({ project: 'project other' }))
		).toEqual([MANAGED_TEMPLATE]);
		await Effect.runPromise(
			client.deleteManagedTemplate(MANAGED_TEMPLATE.id, { project: 'project other' })
		);

		expect(calledUrl(0)).toBe(
			'https://api.boringcomputers.com/v1/templates?project_id=project+other'
		);
		expect(calledUrl(1)).toBe(
			`https://api.boringcomputers.com/v1/templates/${MANAGED_TEMPLATE.id}?project_id=project+other`
		);
	});

	it('returns typed target errors instead of decoding one template model as the other', async () => {
		const managedOnLocal = await failureOf(
			make().publishTemplate('m1', { name: 'safe', version: 'v1' })
		);
		const localOnCloud = await failureOf(make({ target: 'cloud' }).publishMachine('m1', 'safe'));
		expect(managedOnLocal).toBeInstanceOf(NotSupported);
		expect(localOnCloud).toBeInstanceOf(NotSupported);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('extendMachine', () => {
	it('POSTs the ttl and decodes the machine with its new expiry', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		const machine = await Effect.runPromise(make().extendMachine('m1', 300));

		expect(machine).toEqual(MACHINE);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m1/extend');
		expect(JSON.parse(calledBody())).toEqual({ ttl_seconds: 300 });
	});

	it('sends an empty body when ttl is omitted (server default)', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make().extendMachine('m1'));

		expect(JSON.parse(calledBody())).toEqual({});
	});
});

describe('exec', () => {
	const RESULT = { output: 'hi', exit_code: 0, timed_out: false, duration_ms: 42 } as const;

	it('POSTs the command and decodes the result', async () => {
		fetchMock.mockResolvedValue(ok(RESULT));

		const res = await Effect.runPromise(make().exec('m1', 'echo hi'));

		expect(res).toEqual(RESULT);
		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m1/exec');
		expect(calledInit().method).toBe('POST');
		expect(JSON.parse(calledBody())).toEqual({ command: 'echo hi' });
	});

	it('sends timeout_seconds when provided and accepts a null exit code', async () => {
		fetchMock.mockResolvedValue(ok({ ...RESULT, exit_code: null, timed_out: true }));

		const res = await Effect.runPromise(make().exec('m1', 'sleep 99', { timeoutSeconds: 5 }));

		expect(res.exit_code).toBeNull();
		expect(res.timed_out).toBe(true);
		expect(JSON.parse(calledBody())).toEqual({ command: 'sleep 99', timeout_seconds: 5 });
	});

	it('does not retry (commands are not idempotent) and surfaces the busy 409', async () => {
		fetchMock.mockResolvedValue(err(409, 'machine console is busy'));

		const failure = await failureOf(make().exec('m1', 'echo hi'));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 409 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('saveMachine', () => {
	it('POSTs to /save with the volume query param', async () => {
		fetchMock.mockResolvedValue(empty());

		await Effect.runPromise(make().saveMachine('m 1', 'vol/1'));

		expect(calledUrl()).toBe('http://localhost:8080/v1/machines/m%201/save?volume=vol%2F1');
		expect(calledInit().method).toBe('POST');
	});
});

describe('managed cloud contract', () => {
	const CLOUD_MACHINE = {
		id: 'm_cloud',
		project_id: 'project-1',
		state: 'starting',
		status: 'starting',
		ready: false,
		region: 'ca-tor-1',
		architecture: 'x86_64',
		resources: { vcpus: 2, memory_mb: 2048, disk_mb: 10240 },
		network_policy: { mode: 'off', hostnames: [], cidrs: [] },
		template: 'desktop',
		created_at: '2026-08-08T00:00:00Z',
		expires_at: '2026-08-08T00:15:00Z'
	} as const;

	it('uses the cloud endpoint, API key, project, region, resources, and idempotency', async () => {
		fetchMock.mockResolvedValue(ok(CLOUD_MACHINE));
		const client = make({
			target: 'cloud',
			apiKey: 'bc_secret',
			project: 'project-1',
			region: 'ca-tor-1',
			idempotencyKey: () => 'sdk-key'
		});

		await Effect.runPromise(
			client.createMachine({
				template: 'desktop',
				size: 'medium',
				networkPolicy: { mode: 'off', hostnames: [], cidrs: [] }
			})
		);

		expect(calledUrl()).toBe('https://api.boringcomputers.com/v1/machines');
		expect(calledInit().headers).toMatchObject({
			authorization: 'Bearer bc_secret',
			'idempotency-key': 'sdk-key'
		});
		expect(JSON.parse(calledBody())).toEqual({
			project_id: 'project-1',
			region: 'ca-tor-1',
			template: 'desktop',
			vcpus: 2,
			memory_mb: 2048,
			disk_mb: 10240,
			network_policy: { mode: 'off', hostnames: [], cidrs: [] }
		});
	});

	it('rejects managed guest egress without issuing a request', async () => {
		const failure = await failureOf(
			make({ target: 'cloud', apiKey: 'bc_secret', project: 'project-1' }).createMachine({
				template: 'python',
				networkPolicy: { mode: 'allowlist', cidrs: ['1.1.1.0/24'] }
			})
		);
		expect(failure).toMatchObject({ _tag: 'NotSupported', target: 'cloud' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects managed egress policy options on a local target', async () => {
		const failure = await failureOf(
			make().createMachine({
				template: 'python',
				networkPolicy: { mode: 'allowlist', cidrs: ['1.1.1.0/24'] }
			})
		);
		expect(failure).toMatchObject({ _tag: 'NotSupported', target: 'local' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends a published template UUID separately from a template name', async () => {
		fetchMock.mockResolvedValue(
			ok({ ...CLOUD_MACHINE, template: undefined, template_id: 'tpl-id' })
		);

		await Effect.runPromise(
			make({ target: 'cloud', project: 'project-1' }).createMachine({ templateId: 'tpl-id' })
		);

		expect(JSON.parse(calledBody())).toEqual({ project_id: 'project-1', template_id: 'tpl-id' });
	});

	it('returns typed NotSupported for managed OCI without making a request', async () => {
		const failure = await failureOf(
			make({ target: 'cloud', project: 'project-1' }).createMachine({
				ociReference: 'registry.example/image@sha256:deadbeef'
			})
		);

		expect(failure).toMatchObject({ _tag: 'NotSupported', operation: 'createMachine' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns cursor and response metadata from a page', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ machines: [CLOUD_MACHINE], next_cursor: 'm_cloud' }), {
				status: 200,
				headers: {
					'content-type': 'application/json',
					'x-request-id': 'req-1',
					'ratelimit-limit': '100',
					'ratelimit-remaining': '99'
				}
			})
		);

		const page = await Effect.runPromise(
			make({ target: 'cloud', project: 'project-1' }).listMachinesPage({ cursor: 'm_0', limit: 1 })
		);

		expect(calledUrl()).toBe(
			'https://api.boringcomputers.com/v1/machines?project_id=project-1&cursor=m_0&limit=1'
		);
		expect(page).toMatchObject({
			nextCursor: 'm_cloud',
			metadata: { requestId: 'req-1', rateLimit: { limit: 100, remaining: 99 } }
		});
	});

	it('decodes RFC 9457 problem details and rate-limit metadata', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					type: 'https://docs.boringcomputers.com/problems/quota_exceeded',
					title: 'quota_exceeded',
					status: 429,
					detail: 'Project quota reached.',
					request_id: 'req-quota'
				}),
				{
					status: 429,
					headers: {
						'content-type': 'application/problem+json',
						'retry-after': '30',
						'x-request-id': 'req-quota'
					}
				}
			)
		);

		const failure = await failureOf(make({ target: 'cloud', maxRetries: 0 }).getMachine('m'));

		expect(failure).toBeInstanceOf(ResponseError);
		expect(failure).toMatchObject({
			status: 429,
			problem: {
				title: 'quota_exceeded',
				detail: 'Project quota reached.',
				requestId: 'req-quota'
			},
			metadata: { requestId: 'req-quota', rateLimit: { retryAfterSeconds: 30 } }
		});
	});

	it('creates short-lived preview sessions and returns the server URL', async () => {
		fetchMock.mockResolvedValue(
			ok({
				id: '11111111-1111-4111-8111-111111111111',
				token: 'capability-secret',
				expires_in: 120,
				gateway_url: 'https://gateway.boringcomputers.com/',
				preview_url: 'https://gateway.boringcomputers.com/preview/m/3000/?token=redacted'
			})
		);

		const url = await Effect.runPromise(make({ target: 'cloud' }).getPreviewUrl('m', 3000, 120));

		expect(url).toContain('/preview/m/3000/');
		expect(calledUrl()).toBe('https://api.boringcomputers.com/v1/machines/m/sessions');
		expect(JSON.parse(calledBody())).toEqual({
			capabilities: ['preview'],
			port: 3000,
			ttl_seconds: 120
		});
	});

	it('rejects managed host-local agent sessions before transport', async () => {
		const failure = await failureOf(
			make({ target: 'cloud', apiKey: 'bc_test_key' }).createSession('m', {
				capabilities: ['agent']
			})
		);

		expect(failure).toMatchObject({
			_tag: 'NotSupported',
			operation: 'createSession',
			target: 'cloud'
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('revokes a durable machine session without putting the capability token in the URL', async () => {
		fetchMock.mockResolvedValue(empty());
		const client = make({ target: 'cloud', apiKey: 'bc_test_key' });

		await Effect.runPromise(
			client.revokeSession('m session', '11111111-1111-4111-8111-111111111111')
		);

		expect(calledInit().method).toBe('DELETE');
		expect(calledUrl()).toBe(
			'https://api.boringcomputers.com/v1/machines/m%20session/sessions/11111111-1111-4111-8111-111111111111'
		);
		expect(calledUrl()).not.toContain('capability');
	});

	it('uses query-free managed WebSocket URLs and a capability subprotocol', async () => {
		const sockets: Array<{ readonly url: string; readonly protocol?: string }> = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readonly readyState = TestWebSocket.OPEN;
			binaryType = '';
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: (() => void) | null = null;

			constructor(url: string, protocol?: string) {
				sockets.push({ url, ...(protocol === undefined ? {} : { protocol }) });
				queueMicrotask(() => this.onopen?.());
			}

			close(): void {}
			send(): void {}
		}
		vi.stubGlobal('WebSocket', TestWebSocket);

		for (const capability of ['tty', 'vnc'] as const) {
			fetchMock.mockResolvedValueOnce(
				ok({
					id: `11111111-1111-4111-8111-11111111111${capability === 'tty' ? '1' : '2'}`,
					token: `${capability}.capability.token`,
					expires_in: 120,
					gateway_url: 'https://gateway.example.test/'
				})
			);
			const client = make({ target: 'cloud' });
			await Effect.runPromise(
				Effect.scoped(
					capability === 'tty' ? client.connectTty('m_socket') : client.connectVnc('m_socket')
				)
			);
		}

		expect(sockets).toHaveLength(2);
		for (const [index, capability] of ['tty', 'vnc'].entries()) {
			const socket = sockets[index]!;
			const url = new URL(socket.url);
			expect(url.protocol).toBe('wss:');
			expect(url.pathname).toBe(`/v1/machines/m_socket/${capability}`);
			expect(url.search).toBe('');
			expect(url.hash).toBe('');
			expect(socket.protocol).toBe(`nehemiah.capability.${capability}.capability.token`);
		}
	});

	it('ends output on peer close and reconnects with a fresh capability', async () => {
		const sockets: TestWebSocket[] = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readonly readyState = TestWebSocket.OPEN;
			binaryType = '';
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: ((event: { data: unknown }) => void) | null = null;
			onclose: (() => void) | null = null;

			constructor() {
				sockets.push(this);
				queueMicrotask(() => this.onopen?.());
			}

			close(): void {}
			send(): void {}
		}
		vi.stubGlobal('WebSocket', TestWebSocket);
		fetchMock
			.mockResolvedValueOnce(
				ok({
					id: '11111111-1111-4111-8111-111111111111',
					token: 'tty.capability.token.1',
					expires_in: 120,
					gateway_url: 'https://gateway.example.test/'
				})
			)
			.mockResolvedValueOnce(
				ok({
					id: '22222222-2222-4222-8222-222222222222',
					token: 'tty.capability.token.2',
					expires_in: 120,
					gateway_url: 'https://gateway.example.test/'
				})
			);

		const [first, second] = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const channel = yield* make({ target: 'cloud' }).connectTty('m_socket');
					sockets[0]!.onclose?.();
					const beforeReconnect = yield* Stream.runCollect(channel.output);
					yield* channel.reconnect;
					sockets[1]!.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
					sockets[1]!.onclose?.();
					const afterReconnect = yield* Stream.runCollect(channel.output);
					return [beforeReconnect, afterReconnect] as const;
				})
			)
		);

		expect(first.length).toBe(0);
		expect([...second].map((bytes) => [...bytes])).toEqual([[1, 2, 3]]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sockets).toHaveLength(2);
	});

	it('fails a stalled channel when its byte backlog is exhausted and releases consumed bytes', async () => {
		const sockets: TestWebSocket[] = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readonly readyState = TestWebSocket.OPEN;
			binaryType = '';
			closeCalls = 0;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: ((event: { data: unknown }) => void) | null = null;
			onclose: (() => void) | null = null;

			constructor() {
				sockets.push(this);
				queueMicrotask(() => this.onopen?.());
			}

			close(): void {
				this.closeCalls += 1;
			}
			send(): void {}
		}
		vi.stubGlobal('WebSocket', TestWebSocket);

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const channel = yield* make().connectTty('m_backlog');
					const socket = sockets[0]!;
					const halfBudget = MAX_CHANNEL_BACKLOG_BYTES / 2;
					socket.onmessage?.({ data: new Uint8Array(halfBudget) });
					socket.onmessage?.({ data: new Uint8Array(halfBudget) });

					const first = yield* channel.output.pipe(Stream.take(1), Stream.runCollect);
					// Taking one frame must release exactly its bytes, allowing a full refill.
					socket.onmessage?.({ data: new Uint8Array(halfBudget) });
					const closeCallsAtExactBudget = socket.closeCalls;
					socket.onmessage?.({ data: new Uint8Array(1) });

					const overflow = yield* Stream.runDrain(channel.output).pipe(Effect.either);
					const sendAfterOverflow = yield* channel.send(new Uint8Array([1])).pipe(Effect.either);
					const reconnectAfterOverflow = yield* channel.reconnect.pipe(Effect.either);
					return {
						first: [...first],
						closeCallsAtExactBudget,
						closeCallsAfterOverflow: socket.closeCalls,
						overflow,
						sendAfterOverflow,
						reconnectAfterOverflow
					};
				})
			)
		);

		expect(result.first).toHaveLength(1);
		expect(result.first[0]?.byteLength).toBe(MAX_CHANNEL_BACKLOG_BYTES / 2);
		expect(result.closeCallsAtExactBudget).toBe(0);
		expect(result.closeCallsAfterOverflow).toBe(1);
		expect(sockets).toHaveLength(1);
		for (const failure of [
			result.overflow,
			result.sendAfterOverflow,
			result.reconnectAfterOverflow
		]) {
			expect(Either.isLeft(failure)).toBe(true);
			if (Either.isLeft(failure)) {
				expect(failure.left).toBeInstanceOf(ChannelBacklogExceeded);
				expect(failure.left).toMatchObject({
					_tag: 'ChannelBacklogExceeded',
					capability: 'tty',
					maximumBytes: MAX_CHANNEL_BACKLOG_BYTES,
					maximumFrames: MAX_CHANNEL_BACKLOG_FRAMES,
					limit: 'bytes'
				});
			}
		}
	});

	it('bounds outbound frames and the native WebSocket send backlog', async () => {
		const sockets: TestWebSocket[] = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readonly readyState = TestWebSocket.OPEN;
			binaryType = '';
			bufferedAmount = 0;
			closeCalls = 0;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: ((event: { data: unknown }) => void) | null = null;
			onclose: (() => void) | null = null;

			constructor() {
				sockets.push(this);
				queueMicrotask(() => this.onopen?.());
			}

			close(): void {
				this.closeCalls += 1;
			}
			send(data: ArrayBufferView): void {
				this.bufferedAmount += data.byteLength;
			}
		}
		vi.stubGlobal('WebSocket', TestWebSocket);

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const tty = yield* make().connectTty('m_send_tty');
					for (
						let sent = 0;
						sent < MAX_CHANNEL_BUFFERED_AMOUNT_BYTES;
						sent += MAX_TTY_FRAME_BYTES
					) {
						yield* tty.send(new Uint8Array(MAX_TTY_FRAME_BYTES));
					}
					const ttyExactBufferedAmount = sockets[0]!.bufferedAmount;
					const ttyOverflow = yield* tty.send(new Uint8Array(1)).pipe(Effect.either);
					const ttyOutput = yield* Stream.runDrain(tty.output).pipe(Effect.either);
					const ttyReconnect = yield* tty.reconnect.pipe(Effect.either);

					const vnc = yield* make().connectVnc('m_send_vnc');
					yield* vnc.send(new Uint8Array(MAX_VNC_FRAME_BYTES));
					const vncFrameOverflow = yield* vnc
						.send(new Uint8Array(MAX_VNC_FRAME_BYTES + 1))
						.pipe(Effect.either);
					return {
						ttyExactBufferedAmount,
						ttyOverflow,
						ttyOutput,
						ttyReconnect,
						vncFrameOverflow
					};
				})
			)
		);

		expect(result.ttyExactBufferedAmount).toBe(MAX_CHANNEL_BUFFERED_AMOUNT_BYTES);
		for (const failure of [result.ttyOverflow, result.ttyOutput, result.ttyReconnect]) {
			expect(Either.isLeft(failure)).toBe(true);
			if (Either.isLeft(failure)) {
				expect(failure.left).toMatchObject({
					_tag: 'ChannelSendLimitExceeded',
					capability: 'tty',
					limit: 'buffered'
				});
			}
		}
		expect(Either.isLeft(result.vncFrameOverflow)).toBe(true);
		if (Either.isLeft(result.vncFrameOverflow)) {
			expect(result.vncFrameOverflow.left).toBeInstanceOf(ChannelSendLimitExceeded);
			expect(result.vncFrameOverflow.left).toMatchObject({
				capability: 'vnc',
				limit: 'frame',
				attemptedBytes: MAX_VNC_FRAME_BYTES + 1
			});
		}
		expect(sockets.map((socket) => socket.closeCalls)).toEqual([1, 1]);
	});

	it('rejects a managed WebSocket gateway URL containing a query before opening a socket', async () => {
		fetchMock.mockResolvedValue(
			ok({
				id: '11111111-1111-4111-8111-111111111111',
				token: 'tty.capability.token',
				expires_in: 120,
				gateway_url: 'https://gateway.example.test/?token=must-not-propagate'
			})
		);
		const failure = await failureOf(
			Effect.scoped(make({ target: 'cloud', maxRetries: 0 }).connectTty('m_socket'))
		);

		expect(failure).toMatchObject({
			_tag: 'RequestError',
			method: 'WS',
			path: '/v1/machines/m_socket/tty'
		});
	});

	it('preserves a managed fork resource 404 instead of misclassifying it as unsupported', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					type: 'https://docs.boringcomputers.com/problems/not_found',
					title: 'not_found',
					status: 404,
					detail: 'No route matches this request.'
				}),
				{ status: 404, headers: { 'content-type': 'application/problem+json' } }
			)
		);
		const forkFailure = await failureOf(
			make({ target: 'cloud' }).branchMachine('m', { idempotencyKey: 'fork-once' })
		);
		expect(forkFailure).toBeInstanceOf(ResponseError);
		expect(forkFailure).toMatchObject({ status: 404, problem: { title: 'not_found' } });
	});

	it('maps only an explicit unsupported managed fork response to NotSupported', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					type: 'https://docs.boringcomputers.com/problems/not_supported',
					title: 'not_supported',
					status: 501,
					detail: 'Managed fork is unavailable.'
				}),
				{ status: 501, headers: { 'content-type': 'application/problem+json' } }
			)
		);
		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).branchMachine('m', {
				idempotencyKey: 'fork-once'
			})
		);
		expect(failure).toBeInstanceOf(NotSupported);
		expect(failure).toMatchObject({ operation: 'branchMachine', status: 501 });
	});

	it('never retries a command, even for a transient server response', async () => {
		fetchMock.mockResolvedValue(err(503, 'temporarily unavailable'));
		const failure = await failureOf(make({ target: 'cloud' }).exec('m', 'touch /tmp/once'));
		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('aborts an attempt at the configured timeout', async () => {
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		);

		const failure = await failureOf(
			make({ target: 'cloud', timeoutMs: 5, maxRetries: 0 }).getMachine('m')
		);

		expect(failure).toBeInstanceOf(RequestError);
		expect(failure).toMatchObject({ method: 'GET', path: '/v1/machines/m' });
	});
});

describe('cloud file transfers', () => {
	const session = {
		id: '11111111-1111-4111-8111-111111111111',
		token: 'files.capability.token',
		expires_in: 120,
		gateway_url: 'https://gateway.example.test/'
	};

	it('uploads through a files session with the capability only in Authorization', async () => {
		fetchMock
			.mockResolvedValueOnce(ok(session))
			.mockResolvedValueOnce(
				ok({ ok: true, path: '/root/input.txt', bytes: 5, transport: 'vsock' })
			);
		const client = make({ target: 'cloud', apiKey: 'bc_master_api_key', maxRetries: 0 });

		const result = await Effect.runPromise(
			client.uploadFile('m_file', 'input.txt', new TextEncoder().encode('hello'), {
				ttlSeconds: 120,
				timeoutMs: 5_000
			})
		);

		expect(calledUrl(0)).toBe('https://api.boringcomputers.com/v1/machines/m_file/sessions');
		expect(JSON.parse(calledBody(0))).toEqual({ capabilities: ['files'], ttl_seconds: 120 });
		expect(calledUrl(1)).toBe('https://gateway.example.test/v1/machines/m_file/upload');
		expect(calledUrl(1)).not.toContain(session.token);
		expect(calledUrl(1)).not.toContain('bc_master_api_key');
		expect(calledInit(1)).toMatchObject({
			method: 'POST',
			redirect: 'error',
			credentials: 'omit',
			referrerPolicy: 'no-referrer'
		});
		expect(calledInit(1).headers).toEqual({
			authorization: `Bearer ${session.token}`,
			'content-type': 'application/octet-stream',
			'content-length': '5',
			'x-filename': 'input.txt'
		});
		expect(result).toMatchObject({ path: '/root/input.txt', bytes: 5, transport: 'vsock' });
	});

	it('encodes a canonical remote path and returns bounded download bytes', async () => {
		fetchMock.mockResolvedValueOnce(ok(session)).mockResolvedValueOnce(
			new Response(new TextEncoder().encode('contents'), {
				status: 200,
				headers: { 'content-length': '8', 'content-type': 'application/octet-stream' }
			})
		);

		const result = await Effect.runPromise(
			make({ target: 'cloud', maxRetries: 0 }).downloadFile('m_file', '/root/a file.txt', {
				maximumBytes: 8,
				ttlSeconds: 60
			})
		);

		const gateway = new URL(calledUrl(1));
		expect(gateway.pathname).toBe('/v1/machines/m_file/download');
		expect(gateway.searchParams.get('path')).toBe('/root/a file.txt');
		expect(gateway.searchParams.has('token')).toBe(false);
		expect(calledInit(1).headers).toEqual({
			authorization: `Bearer ${session.token}`,
			accept: 'application/octet-stream'
		});
		expect(new TextDecoder().decode(result.data)).toBe('contents');
		expect(result.bytes).toBe(8);
	});

	it('fails closed on oversized downloads without putting the remote path in errors', async () => {
		fetchMock.mockResolvedValueOnce(ok(session)).mockResolvedValueOnce(
			new Response(new Uint8Array(9), {
				status: 200,
				headers: { 'content-length': '9' }
			})
		);

		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).downloadFile('m_file', '/root/customer-secret', {
				maximumBytes: 8
			})
		);

		expect(failure).toMatchObject({
			_tag: 'RequestError',
			method: 'GET',
			path: '/v1/machines/m_file/download'
		});
		expect(JSON.stringify(failure)).not.toContain('customer-secret');
	});

	it('enforces the observed byte bound when Content-Length is absent', async () => {
		fetchMock.mockResolvedValueOnce(ok(session)).mockResolvedValueOnce(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(5));
						controller.enqueue(new Uint8Array(5));
						controller.close();
					}
				}),
				{ status: 200 }
			)
		);

		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).downloadFile('m_file', '/root/file', {
				maximumBytes: 8
			})
		);
		expect(failure).toMatchObject({
			_tag: 'RequestError',
			path: '/v1/machines/m_file/download'
		});
	});

	it('aborts the gateway request at the bounded file timeout', async () => {
		fetchMock.mockResolvedValueOnce(ok(session)).mockImplementationOnce(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		);

		const failure = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).downloadFile('m_file', '/root/file', {
				timeoutMs: 5,
				ttlSeconds: 60
			})
		);
		expect(failure).toMatchObject({
			_tag: 'RequestError',
			method: 'GET',
			path: '/v1/machines/m_file/download'
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('rejects unsafe gateway origins, traversal paths, and unbounded options', async () => {
		fetchMock.mockResolvedValueOnce(
			ok({ ...session, gateway_url: 'http://gateway.example.test/?token=leak' })
		);
		const unsafeGateway = await failureOf(
			make({ target: 'cloud', maxRetries: 0 }).downloadFile('m_file', '/root/file')
		);
		expect(unsafeGateway).toMatchObject({ _tag: 'RequestError' });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		fetchMock.mockClear();
		const client = make({ target: 'cloud', maxRetries: 0 });
		for (const effect of [
			client.downloadFile('m_file', '/root/../secret'),
			client.uploadFile('m_file', '../escape', new Uint8Array()),
			client.downloadFile('m_file', '/root/file', { maximumBytes: (16 << 20) | 1 }),
			client.downloadFile('m_file', '/root/file', { timeoutMs: 900_001 })
		]) {
			expect(await failureOf(effect)).toBeInstanceOf(RequestError);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('keeps the files capability cloud-only', async () => {
		const failure = await failureOf(make().uploadFile('m_file', 'file.txt', new Uint8Array()));
		expect(failure).toMatchObject({ _tag: 'NotSupported', operation: 'uploadFile' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

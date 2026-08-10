import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either } from 'effect';
import { make, RequestError, ResponseError, type NehemiahError } from './index';

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
	it('strips trailing slashes from baseUrl and joins the path', async () => {
		fetchMock.mockResolvedValue(ok(MACHINE));

		await Effect.runPromise(make({ baseUrl: 'http://host:8080///' }).getMachine('id'));

		expect(calledUrl()).toBe('http://host:8080/v1/machines/id');
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

		const machine = await Effect.runPromise(make().createMachine({ template: 'python' }));

		expect(machine).toEqual(MACHINE);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('gives up after three attempts on persistent 5xx', async () => {
		fetchMock.mockResolvedValue(err(500, 'boom'));

		const failure = await failureOf(make().createMachine({ template: 'python' }));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 500 });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not retry a 4xx', async () => {
		fetchMock.mockResolvedValue(err(400, 'bad'));

		const failure = await failureOf(make().createMachine({ template: 'python' }));

		expect(failure).toMatchObject({ _tag: 'ResponseError', status: 400 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import {
	CLOUD_BASE_URL,
	ForkPending,
	NotSupported,
	RequestError,
	ResponseError,
	type Machine,
	type ManagedTemplate,
	type NehemiahClient
} from 'nehemiah-sdk';
import { runMachineCommand, parseArgs } from '../src/commands/machines.js';
import { runTemplateCommand } from '../src/commands/templates.js';
import { beginDeviceLogin, clientOptions, DeviceLoginUnavailable, runCli } from '../src/index.js';
import { canonicalCredentialOrigin, configPath, readConfig, writeConfig } from '../src/config.js';
import { readBoundedLocalFile, UnsafeLocalPath, writePrivateAtomic } from '../src/files.js';

const MACHINE: Machine = {
	id: 'm_1',
	status: 'running',
	ready: true,
	project_id: 'p_1',
	region: 'ca-tor-1',
	architecture: 'x86_64',
	resources: { vcpus: 1, memory_mb: 512, disk_mb: 5120 },
	created_at: '2026-08-08T00:00:00Z',
	expires_at: '2026-08-08T00:15:00Z'
};

function client(overrides: Partial<NehemiahClient> = {}): NehemiahClient {
	return {
		target: 'cloud',
		baseUrl: 'https://api.boringcomputers.com',
		createMachine: () => Effect.succeed(MACHINE),
		listMachines: Effect.succeed([MACHINE]),
		listMachinesPage: () =>
			Effect.succeed({ machines: [MACHINE], metadata: {}, nextCursor: 'm_1' }),
		getMachine: () => Effect.succeed(MACHINE),
		destroyMachine: () => Effect.void,
		branchMachine: () => Effect.succeed(MACHINE),
		branchMachines: () => Effect.succeed([MACHINE]),
		publishMachine: () => Effect.die('unused'),
		listTemplates: Effect.die('unused'),
		deleteTemplate: () => Effect.die('unused'),
		publishTemplate: () => Effect.die('unused'),
		listManagedTemplates: () => Effect.die('unused'),
		deleteManagedTemplate: () => Effect.die('unused'),
		extendMachine: () => Effect.succeed(MACHINE),
		exec: () =>
			Effect.succeed({
				stdout: 'hello\n',
				stderr: '',
				exit_code: 0,
				timed_out: false,
				duration_ms: 1
			}),
		createSession: () => Effect.die('unused'),
		uploadFile: () => Effect.die('unused'),
		downloadFile: () => Effect.die('unused'),
		getPreviewUrl: () => Effect.die('unused'),
		connectTty: () => Effect.die('unused'),
		connectVnc: () => Effect.die('unused'),
		createVolume: () => Effect.die('unused'),
		listVolumes: () => Effect.die('unused'),
		getVolume: () => Effect.die('unused'),
		createVolumeGrant: () => Effect.die('unused'),
		deleteVolume: () => Effect.die('unused'),
		saveMachine: () => Effect.die('unused'),
		...overrides
	};
}

const MANAGED_TEMPLATE: ManagedTemplate = {
	id: '123e4567-e89b-42d3-a456-426614174000',
	project_id: 'project-1',
	name: 'browser-ready',
	version: 'v1',
	manifest: {
		schema_version: 1,
		format: 'firecracker-snapshot-v1',
		architecture: 'x86_64',
		source: { machine_id: MACHINE.id },
		artifact: {
			object_key:
				'organizations/org/projects/project-1/templates/browser-ready/v1/id/snapshot.tar.zst',
			checksum: `sha256:${'ab'.repeat(32)}`,
			size_bytes: 4096
		}
	},
	checksum: `sha256:${'ab'.repeat(32)}`,
	size_bytes: 4096,
	source_machine_id: MACHINE.id,
	created_at: '2026-08-09T00:00:00Z'
};

describe('machine commands', () => {
	it('passes managed create options and idempotency key', async () => {
		const createMachine = vi.fn(() => Effect.succeed(MACHINE));
		await runMachineCommand(
			client({ createMachine }),
			'create',
			parseArgs(['--template', 'desktop', '--size', 'medium', '--idempotency-key', 'once'])
		);
		expect(createMachine).toHaveBeenCalledWith({
			template: 'desktop',
			size: 'medium',
			idempotencyKey: 'once'
		});
	});

	it('rejects managed egress flags before calling the SDK', async () => {
		const createMachine = vi.fn(() => Effect.succeed(MACHINE));
		for (const args of [
			['--allow-hostnames', 'api.example.com'],
			['--allow-cidrs', '1.1.1.0/24']
		]) {
			await expect(
				runMachineCommand(client({ createMachine }), 'create', parseArgs(args))
			).rejects.toMatchObject({ code: 'usage_error' });
		}
		expect(createMachine).not.toHaveBeenCalled();
	});

	it('rejects CIDR allowlists for local and self-hosted targets too', async () => {
		const createMachine = vi.fn(() => Effect.succeed(MACHINE));
		await expect(
			runMachineCommand(
				client({ target: 'self-hosted', createMachine }),
				'create',
				parseArgs(['--allow-cidrs', '1.1.1.0/24, 8.8.8.0/24'])
			)
		).rejects.toMatchObject({ code: 'usage_error' });
		expect(createMachine).not.toHaveBeenCalled();
	});

	it('returns pagination data for JSON automation', async () => {
		const output = await runMachineCommand(client(), 'list', parseArgs(['--limit', '1']));
		expect(output.value).toMatchObject({ next_cursor: 'm_1', machines: [MACHINE] });
	});

	it('does not hide a typed unavailable fork', async () => {
		const forkError = new NotSupported({
			operation: 'branchMachines',
			target: 'cloud',
			detail: 'fork route absent',
			status: 404
		});
		await expect(
			runMachineCommand(
				client({ branchMachines: () => Effect.fail(forkError) }),
				'fork',
				parseArgs(['m_1'])
			)
		).rejects.toBe(forkError);
	});

	it('passes the bounded batch count and idempotency key to managed fork', async () => {
		const branchMachines = vi.fn(() => Effect.succeed([MACHINE, { ...MACHINE, id: 'm_2' }]));
		const output = await runMachineCommand(
			client({ branchMachines }),
			'fork',
			parseArgs(['m_1', '--count', '2', '--idempotency-key', 'fork-cli-once'])
		);

		expect(branchMachines).toHaveBeenCalledWith('m_1', 2, {
			idempotencyKey: 'fork-cli-once'
		});
		expect(output.value).toMatchObject({ machines: [{ id: 'm_1' }, { id: 'm_2' }] });
	});

	it('prints an exact safe retry command for an accepted fork', async () => {
		const pending = new ForkPending({
			message: 'pending',
			operation: {
				id: '11111111-1111-4111-8111-111111111111',
				state: 'cleanup_pending',
				idempotencyKey: 'fork-recovery-key',
				sourceMachineId: 'm_1',
				requested: 2
			},
			machines: [MACHINE, { ...MACHINE, id: 'm_2' }],
			metadata: { requestId: 'request-1' }
		});
		const output = await runMachineCommand(
			client({ branchMachines: () => Effect.fail(pending) }),
			'fork',
			parseArgs(['m_1', '--count', '2'])
		);

		expect(output.value).toMatchObject({
			operation: {
				id: pending.operation.id,
				state: 'cleanup_pending',
				idempotency_key: 'fork-recovery-key',
				requested: 2
			}
		});
		expect(output.human).toContain(
			'bc machines fork m_1 --count 2 --idempotency-key fork-recovery-key'
		);
	});

	it('uploads only an explicit stable regular file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-cli-upload-'));
		const localPath = join(directory, 'input.txt');
		await writeFile(localPath, 'hello');
		const uploadFile = vi.fn(() =>
			Effect.succeed({
				path: '/root/renamed.txt',
				bytes: 5,
				transport: 'vsock' as const,
				metadata: {}
			})
		);

		const output = await runMachineCommand(
			client({ uploadFile }),
			'upload',
			parseArgs(['m_1', localPath, '--name', 'renamed.txt', '--max-bytes', '32'])
		);

		expect(uploadFile).toHaveBeenCalledWith('m_1', 'renamed.txt', expect.any(Uint8Array), {
			maximumBytes: 32
		});
		expect(output.value).toMatchObject({ local_path: localPath, path: '/root/renamed.txt' });
		await expect(readBoundedLocalFile(localPath, 4)).rejects.toBeInstanceOf(UnsafeLocalPath);

		const link = join(directory, 'link.txt');
		await symlink(localPath, link);
		await expect(readBoundedLocalFile(link)).rejects.toBeInstanceOf(UnsafeLocalPath);
	});

	it('downloads to an explicit atomic 0600 destination and refuses symlinks', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-cli-download-'));
		const localPath = join(directory, 'result.bin');
		const downloadFile = vi.fn(() =>
			Effect.succeed({ data: new TextEncoder().encode('result'), bytes: 6, metadata: {} })
		);

		const output = await runMachineCommand(
			client({ downloadFile }),
			'download',
			parseArgs(['m_1', '/root/result.bin', localPath, '--timeout-ms', '5000'])
		);

		expect(downloadFile).toHaveBeenCalledWith('m_1', '/root/result.bin', { timeoutMs: 5000 });
		expect(await readFile(localPath, 'utf8')).toBe('result');
		expect((await stat(localPath)).mode & 0o777).toBe(0o600);
		expect(output.value).toMatchObject({
			remote_path: '/root/result.bin',
			local_path: localPath,
			bytes: 6
		});

		const target = join(directory, 'target.bin');
		const link = join(directory, 'download-link.bin');
		await writeFile(target, 'untouched');
		await symlink(target, link);
		await expect(writePrivateAtomic(link, new Uint8Array([1]))).rejects.toBeInstanceOf(
			UnsafeLocalPath
		);
		expect(await readFile(target, 'utf8')).toBe('untouched');
	});

	it('requires both remote and local download paths', async () => {
		await expect(
			runMachineCommand(client(), 'download', parseArgs(['m_1', '/root/file']))
		).rejects.toMatchObject({ code: 'usage_error' });
	});
});

describe('managed template commands', () => {
	it('rejects managed publication locally without calling the SDK', async () => {
		const publishTemplate = vi.fn(() => Effect.succeed(MANAGED_TEMPLATE));
		await expect(
			runTemplateCommand(
				client({ publishTemplate }),
				'publish',
				parseArgs([
					MACHINE.id,
					'--name',
					'browser-ready',
					'--version',
					'v1',
					'--project',
					'project-1'
				])
			)
		).rejects.toMatchObject({
			code: 'usage_error',
			message: expect.stringContaining('disabled')
		});
		expect(publishTemplate).not.toHaveBeenCalled();
	});

	it('dispatches template list through the top-level CLI', async () => {
		const lines: string[] = [];
		const code = await runCli(['templates', 'list', '--project', 'project-1', '--json'], {
			client: client({ listManagedTemplates: () => Effect.succeed([MANAGED_TEMPLATE]) }),
			io: { out: (line) => lines.push(line), error: () => undefined }
		});
		expect(code).toBe(0);
		expect(JSON.parse(lines[0]!)).toEqual({ templates: [MANAGED_TEMPLATE] });
	});
});

describe('configuration and login', () => {
	it('uses the operating system user config directory', () => {
		expect(
			configPath({
				env: { XDG_CONFIG_HOME: '/users/me/config' },
				platform: 'linux',
				userHome: '/users/me'
			})
		).toBe('/users/me/config/nehemiah/config.json');
	});

	it('prefers environment credentials and defaults to cloud', () => {
		expect(
			clientOptions(
				{ NEHEMIAH_API_KEY: 'env-key', NEHEMIAH_PROJECT: 'env-project' },
				{ apiKey: 'file-key', project: 'file-project' }
			)
		).toMatchObject({ target: 'cloud', apiKey: 'env-key', project: 'env-project' });
	});

	it('treats an API-key staging URL as cloud unless target is explicit', () => {
		expect(
			clientOptions({ NEHEMIAH_API_KEY: 'env-key', NEHEMIAH_URL: 'https://staging.example' }, {})
		).toMatchObject({ target: 'cloud', baseUrl: 'https://staging.example' });
		expect(
			clientOptions(
				{
					NEHEMIAH_API_KEY: 'env-key',
					NEHEMIAH_URL: 'https://self-hosted.example',
					NEHEMIAH_TARGET: 'self-hosted'
				},
				{}
			)
		).toMatchObject({ target: 'self-hosted' });
	});

	it('canonicalizes only credential-safe HTTPS and loopback origins', () => {
		expect(canonicalCredentialOrigin('https://API.Example.COM:443/')).toBe(
			'https://api.example.com'
		);
		expect(canonicalCredentialOrigin('https://api.example.com/v1')).toBeUndefined();
		expect(canonicalCredentialOrigin('http://localhost:8080/')).toBe('http://localhost:8080');
		expect(canonicalCredentialOrigin('http://localhost:8080/v1')).toBeUndefined();
		expect(canonicalCredentialOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
		for (const value of [
			'http://api.example.com',
			'https://user:secret@api.example.com',
			'https://api.example.com/v1?next=attacker',
			'https://api.example.com/#fragment',
			'not-a-url'
		]) {
			expect(canonicalCredentialOrigin(value)).toBeUndefined();
		}
	});

	it('never exposes a stored API key through client options after origin substitution', () => {
		const config = {
			apiKey: 'stored-key',
			authMode: 'api_key' as const,
			baseUrl: 'https://api.example.com',
			credentialOrigin: 'https://api.example.com'
		};
		expect(clientOptions({}, config)).toMatchObject({ apiKey: 'stored-key' });
		expect(clientOptions({}, config, { url: 'https://attacker.invalid' })).not.toHaveProperty(
			'apiKey'
		);
		expect(clientOptions({ NEHEMIAH_URL: 'https://attacker.invalid' }, config)).not.toHaveProperty(
			'apiKey'
		);
		expect(
			clientOptions({}, { ...config, baseUrl: 'https://attacker.invalid' })
		).not.toHaveProperty('apiKey');
	});

	it.each([
		{ name: '--target', env: {}, flags: { target: 'self-hosted' } },
		{ name: 'NEHEMIAH_TARGET', env: { NEHEMIAH_TARGET: 'self-hosted' }, flags: {} }
	])('pins a bound stored API key to its origin across a $name default', (testCase) => {
		expect(
			clientOptions(
				testCase.env,
				{
					apiKey: 'stored-key',
					authMode: 'api_key',
					credentialOrigin: new URL(CLOUD_BASE_URL).origin
				},
				testCase.flags
			)
		).toMatchObject({
			target: 'self-hosted',
			baseUrl: CLOUD_BASE_URL,
			apiKey: 'stored-key'
		});
	});

	it('does not pin an explicit invocation key to an unused stored-key origin', () => {
		const options = clientOptions(
			{ NEHEMIAH_API_KEY: 'explicit-key', NEHEMIAH_TARGET: 'self-hosted' },
			{
				apiKey: 'stored-key',
				authMode: 'api_key',
				credentialOrigin: new URL(CLOUD_BASE_URL).origin
			}
		);
		expect(options).toMatchObject({ target: 'self-hosted', apiKey: 'explicit-key' });
		expect(options).not.toHaveProperty('baseUrl');
	});

	it('allows an explicitly supplied environment key to pair with that invocation URL', () => {
		expect(
			clientOptions(
				{
					NEHEMIAH_API_KEY: 'explicit-key',
					NEHEMIAH_URL: 'https://selected.example'
				},
				{
					apiKey: 'stored-key',
					authMode: 'api_key',
					baseUrl: 'https://api.example.com',
					credentialOrigin: 'https://api.example.com'
				}
			)
		).toMatchObject({ apiKey: 'explicit-key', baseUrl: 'https://selected.example' });
	});

	it.each([
		{
			name: '--url override',
			argv: ['--url', 'https://attacker.invalid'],
			env: {},
			configuredBaseUrl: 'https://api.example.com'
		},
		{
			name: 'NEHEMIAH_URL override',
			argv: [],
			env: { NEHEMIAH_URL: 'https://attacker.invalid' },
			configuredBaseUrl: 'https://api.example.com'
		},
		{
			name: 'config URL substitution',
			argv: [],
			env: {},
			configuredBaseUrl: 'https://attacker.invalid'
		}
	])('sends no stored API-key bearer after $name', async (testCase) => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-api-key-origin-'));
		const path = join(directory, 'config.json');
		await writeConfig(
			{
				apiKey: 'stored-secret',
				authMode: 'api_key',
				baseUrl: testCase.configuredBaseUrl,
				credentialOrigin: 'https://api.example.com',
				target: 'cloud'
			},
			path
		);
		const requests = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ machines: [], metadata: {} }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', requests);
		const errors: string[] = [];
		try {
			const code = await runCli(['machines', 'list', ...testCase.argv, '--json'], {
				env: testCase.env,
				configFile: path,
				io: { out: () => undefined, error: (line) => errors.push(line) }
			});
			expect(code).toBe(1);
			expect(JSON.parse(errors[0]!)).toMatchObject({
				error: { code: 'credential_origin_mismatch' }
			});
			expect(requests).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('requires an explicit re-set for a legacy unbound stored API key', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-api-key-legacy-'));
		const path = join(directory, 'config.json');
		await writeConfig(
			{
				apiKey: 'stored-secret',
				authMode: 'api_key',
				baseUrl: 'https://api.example.com',
				target: 'cloud'
			},
			path
		);
		const requests = vi.fn();
		vi.stubGlobal('fetch', requests);
		const errors: string[] = [];
		try {
			const code = await runCli(['machines', 'list', '--json'], {
				env: {},
				configFile: path,
				io: { out: () => undefined, error: (line) => errors.push(line) }
			});
			expect(code).toBe(1);
			expect(JSON.parse(errors[0]!)).toMatchObject({
				error: { code: 'credential_origin_required' }
			});
			expect(requests).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('binds a newly configured API key to the selected canonical origin', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-api-key-bind-'));
		const path = join(directory, 'config.json');
		const code = await runCli(
			['config', 'set-key', 'new-secret', '--url', 'https://API.NEW.EXAMPLE:443/', '--json'],
			{
				env: {},
				configFile: path,
				io: { out: () => undefined, error: () => undefined }
			}
		);
		expect(code).toBe(0);
		expect(await readConfig(path)).toEqual({
			apiKey: 'new-secret',
			authMode: 'api_key',
			credentialOrigin: 'https://api.new.example',
			baseUrl: 'https://API.NEW.EXAMPLE:443/'
		});
	});

	it.each([
		'http://api.example.com',
		'https://user:secret@api.example.com',
		'https://api.example.com/v1',
		'https://api.example.com/?redirect=attacker'
	])('does not persist an API key for unsafe endpoint %s', async (url) => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-api-key-unsafe-'));
		const path = join(directory, 'config.json');
		const errors: string[] = [];

		const code = await runCli(['config', 'set-key', 'new-secret', '--url', url, '--json'], {
			env: {},
			configFile: path,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(code).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'unsafe_credential_origin' }
		});
		expect(await readConfig(path)).toEqual({});
	});

	it('does not persist a non-root API URL through ordinary config set', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-config-url-path-'));
		const path = join(directory, 'config.json');
		const errors: string[] = [];

		const code = await runCli(['config', 'set', '--url', 'https://api.example.com/v1', '--json'], {
			env: {},
			configFile: path,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(code).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'unsafe_credential_origin' }
		});
		expect(await readConfig(path)).toEqual({});
	});

	it('requires an explicit endpoint when re-setting an unbound legacy API key', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-api-key-reset-legacy-'));
		const path = join(directory, 'config.json');
		await writeConfig(
			{
				apiKey: 'legacy-secret',
				authMode: 'api_key',
				baseUrl: 'https://possibly-substituted.invalid'
			},
			path
		);
		const errors: string[] = [];

		const code = await runCli(['config', 'set-key', 'replacement', '--json'], {
			env: {},
			configFile: path,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(code).toBe(2);
		expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: 'usage_error' } });
		expect(await readConfig(path)).toEqual({
			apiKey: 'legacy-secret',
			authMode: 'api_key',
			baseUrl: 'https://possibly-substituted.invalid'
		});
	});

	it.each([
		{
			name: 'API key',
			config: {
				apiKey: 'stored-secret',
				authMode: 'api_key' as const,
				credentialOrigin: 'https://api.example.com',
				baseUrl: 'https://api.example.com'
			}
		},
		{
			name: 'device login',
			config: {
				authMode: 'device' as const,
				credentialAccount: '44444444-4444-4444-8444-444444444444',
				credentialOrigin: 'https://api.example.com',
				baseUrl: 'https://api.example.com'
			}
		}
	])('refuses config set --url while a stored $name is active', async (testCase) => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-config-origin-'));
		const path = join(directory, 'config.json');
		await writeConfig(testCase.config, path);
		const errors: string[] = [];
		const code = await runCli(['config', 'set', '--url', 'https://attacker.invalid', '--json'], {
			env: {},
			configFile: path,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});
		expect(code).toBe(2);
		expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: 'usage_error' } });
		expect(await readConfig(path)).toEqual(testCase.config);
	});

	it('writes config with mode 0600', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-cli-'));
		const path = join(directory, 'nested', 'config.json');
		await writeConfig(
			{
				apiKey: 'bc_secret',
				credentialOrigin: 'https://api.example.com',
				project: 'p_1'
			},
			path
		);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readConfig(path)).toEqual({
			apiKey: 'bc_secret',
			credentialOrigin: 'https://api.example.com',
			project: 'p_1'
		});
	});

	it('returns a typed unavailable error when device endpoint is absent', async () => {
		await expect(
			beginDeviceLogin(
				'https://api.example',
				vi.fn().mockResolvedValue(new Response('', { status: 404 }))
			)
		).rejects.toBeInstanceOf(DeviceLoginUnavailable);
	});

	it('renders structured JSON errors', async () => {
		const errors: string[] = [];
		const code = await runCli(['machines', 'fork', 'm_1', '--json'], {
			client: client({
				branchMachines: () =>
					Effect.fail(
						new NotSupported({
							operation: 'branchMachines',
							target: 'cloud',
							detail: 'fork route absent',
							status: 404
						})
					)
			}),
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});
		expect(code).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'not_supported', status: 404 }
		});
	});

	it('prints the exact idempotency key for ambiguous durable failures', async () => {
		for (const failure of [
			new ResponseError({
				status: 503,
				body: 'unknown',
				idempotencyKey: 'cli-response-recovery'
			}),
			new RequestError({
				method: 'POST',
				path: '/v1/machines',
				cause: 'response lost',
				idempotencyKey: 'cli-request-recovery'
			})
		]) {
			const errors: string[] = [];
			const code = await runCli(['machines', 'create', '--json'], {
				client: client({ createMachine: () => Effect.fail(failure) }),
				io: { out: () => undefined, error: (line) => errors.push(line) }
			});

			expect(code).toBe(1);
			const output = JSON.parse(errors[0]!) as {
				error: { idempotency_key: string; message: string };
			};
			expect(output.error.idempotency_key).toBe(failure.idempotencyKey);
			expect(output.error.message).toContain(`--idempotency-key ${failure.idempotencyKey}`);
		}
	});
});

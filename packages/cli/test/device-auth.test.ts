import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_BASE_URL } from 'nehemiah-sdk';
import {
	CredentialStoreUnavailable,
	decodeDeviceCredential,
	encodeDeviceSession,
	type CredentialStore,
	type StoredDeviceSession
} from '../src/credential-store.js';
import {
	DeviceAuthError,
	openVerificationPage,
	pollDeviceToken,
	requestDeviceCode,
	type DeviceCodeResponse
} from '../src/device-auth.js';
import { runCli } from '../src/index.js';
import { readConfig, writeConfig } from '../src/config.js';

const codeResponse: DeviceCodeResponse = {
	device_code: `bc_device_11111111-1111-4111-8111-111111111111_${'a'.repeat(43)}`,
	user_code: 'ABCD-EFGH',
	verification_uri: 'https://example.com/dashboard/device',
	verification_uri_complete: 'https://example.com/dashboard/device?user_code=ABCD-EFGH',
	expires_in: 600,
	interval: 5,
	scopes: ['machines:read']
};

const tokenResponse = {
	token_type: 'Bearer',
	access_token: `bc_access_22222222-2222-4222-8222-222222222222_${'b'.repeat(43)}`,
	expires_in: 900,
	refresh_token: `bc_refresh_33333333-3333-4333-8333-333333333333_${'c'.repeat(43)}`,
	refresh_expires_in: 2_592_000,
	organization_id: '11111111-1111-4111-8111-111111111111',
	project_id: '22222222-2222-4222-8222-222222222222',
	scopes: ['machines:read']
} as const;

class MemoryCredentialStore implements CredentialStore {
	readonly values = new Map<string, string>();
	readonly getCalls: string[] = [];
	readonly setCalls: string[] = [];
	readonly deleteCalls: string[] = [];
	async get(account: string): Promise<string | undefined> {
		this.getCalls.push(account);
		return this.values.get(account);
	}
	async set(account: string, secret: string): Promise<void> {
		this.setCalls.push(account);
		this.values.set(account, secret);
	}
	async delete(account: string): Promise<void> {
		this.deleteCalls.push(account);
		this.values.delete(account);
	}
}

const credentialAccount = '44444444-4444-4444-8444-444444444444';
const legitimateBaseUrl = 'https://api.example.com';
const attackerBaseUrl = 'https://attacker.invalid';

const storedSession = (overrides: Partial<StoredDeviceSession> = {}): StoredDeviceSession => ({
	version: 1,
	account: credentialAccount,
	origin: legitimateBaseUrl,
	refreshToken: `bc_refresh_55555555-5555-4555-8555-555555555555_${'d'.repeat(43)}`,
	refreshExpiresAt: 3_000_000,
	accessToken: `bc_access_66666666-6666-4666-8666-666666666666_${'e'.repeat(43)}`,
	accessExpiresAt: 1_900_000,
	organizationId: tokenResponse.organization_id,
	projectId: tokenResponse.project_id,
	scopes: ['machines:read'],
	...overrides
});

const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

afterEach(() => vi.unstubAllGlobals());

describe('CLI device authorization', () => {
	it('polls with slow_down, stores the bounded session only in the OS store, and emits JSON events', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-login-'));
		const configFile = join(directory, 'config.json');
		const store = new MemoryCredentialStore();
		const requests: Array<{ url: URL; body: Record<string, unknown> }> = [];
		let tokenPolls = 0;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.pathname === '/v1/auth/device/code') return response(codeResponse, 201);
			if (url.pathname === '/v1/auth/device/token') {
				tokenPolls += 1;
				return tokenPolls === 1
					? response(
							{ title: 'slow_down', detail: 'slow down', error: 'slow_down', interval: 10 },
							400,
							{ 'retry-after': '10' }
						)
					: response(tokenResponse);
			}
			throw new Error(`unexpected ${url.pathname}`);
		});
		const lines: string[] = [];
		const browser = vi.fn(async () => undefined);
		const sleeps: number[] = [];
		const exit = await runCli(['login', '--json', '--scopes', 'machines:read'], {
			env: { NEHEMIAH_URL: 'https://api.example.com' },
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			sleep: async (milliseconds) => void sleeps.push(milliseconds),
			now: () => 0,
			openBrowser: browser,
			io: { out: (line) => lines.push(line), error: (line) => lines.push(line) }
		});

		expect(exit).toBe(0);
		expect(browser).not.toHaveBeenCalled();
		expect(sleeps).toEqual([5_000, 10_000]);
		expect(lines.map((line) => JSON.parse(line))).toMatchObject([
			{ status: 'authorization_required', user_code: 'ABCD-EFGH' },
			{ status: 'authenticated', credential_store: 'os' }
		]);
		const config = await readConfig(configFile);
		expect(config).toMatchObject({
			authMode: 'device',
			project: tokenResponse.project_id,
			baseUrl: legitimateBaseUrl,
			credentialOrigin: legitimateBaseUrl
		});
		expect(config.credentialAccount).toMatch(/^[0-9a-f-]{36}$/);
		expect(decodeDeviceCredential(store.values.get(config.credentialAccount!)!)).toMatchObject({
			kind: 'session',
			session: {
				account: config.credentialAccount,
				origin: legitimateBaseUrl,
				refreshToken: tokenResponse.refresh_token,
				accessToken: tokenResponse.access_token,
				projectId: tokenResponse.project_id,
				scopes: tokenResponse.scopes
			}
		});
		const disk = await readFile(configFile, 'utf8');
		expect(disk).not.toContain('bc_access_');
		expect(disk).not.toContain('bc_refresh_');
		expect(requests.find(({ url }) => url.pathname.endsWith('/token'))?.url.search).toBe('');
		expect(requests.find(({ url }) => url.pathname.endsWith('/token'))?.body).toEqual({
			device_code: codeResponse.device_code
		});
	});

	it('revokes remotely before deleting the local refresh credential', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-logout-'));
		const configFile = join(directory, 'config.json');
		const store = new MemoryCredentialStore();
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			if (url.pathname.endsWith('/code')) return response(codeResponse, 201);
			if (url.pathname.endsWith('/token')) return response(tokenResponse);
			if (url.pathname.endsWith('/revoke')) return response({}, 204);
			throw new Error('unexpected request');
		});
		await runCli(['login', '--no-browser', '--scopes', 'machines:read'], {
			env: { NEHEMIAH_URL: 'https://api.example.com' },
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			sleep: async () => undefined,
			io: { out: () => undefined, error: () => undefined }
		});
		expect(
			await runCli(['logout'], {
				env: { NEHEMIAH_URL: 'https://api.example.com' },
				configFile,
				credentialStore: store,
				fetch: fetch as typeof globalThis.fetch,
				io: { out: () => undefined, error: () => undefined }
			})
		).toBe(0);
		expect(store.values.size).toBe(0);
		const config = await readConfig(configFile);
		expect(config.baseUrl).toBe(legitimateBaseUrl);
		expect(config.authMode).toBeUndefined();
		expect(config.credentialOrigin).toBeUndefined();
		expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/revoke'))).toBe(true);
	});

	it('reuses the cached access token for immediate and repeated post-login commands', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-access-cache-'));
		const configFile = join(directory, 'config.json');
		const store = new MemoryCredentialStore();
		const paths: string[] = [];
		const authorizations: string[] = [];
		const errors: string[] = [];
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			paths.push(url.pathname);
			if (url.pathname.endsWith('/code')) return response(codeResponse, 201);
			if (url.pathname.endsWith('/token')) return response(tokenResponse);
			if (url.pathname === '/v1/machines') {
				authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
				return response({ machines: [] });
			}
			throw new Error(`unexpected ${url.pathname}`);
		});
		const dependencies = {
			env: { NEHEMIAH_URL: legitimateBaseUrl },
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			now: () => 1_000_000,
			sleep: async () => undefined,
			io: { out: () => undefined, error: (line: string) => errors.push(line) }
		};
		vi.stubGlobal('fetch', fetch);

		expect(await runCli(['login', '--no-browser', '--scopes', 'machines:read'], dependencies)).toBe(
			0
		);
		expect(await runCli(['machines', 'list'], dependencies), errors.join('\n')).toBe(0);
		expect(await runCli(['machines', 'list'], dependencies), errors.join('\n')).toBe(0);

		expect(paths.filter((path) => path.endsWith('/refresh'))).toEqual([]);
		expect(authorizations).toEqual([
			`Bearer ${tokenResponse.access_token}`,
			`Bearer ${tokenResponse.access_token}`
		]);
	});

	it('serializes concurrent refreshes and makes both commands reuse the winning session', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-refresh-lock-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: legitimateBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const store = new MemoryCredentialStore();
		store.values.set(
			credentialAccount,
			encodeDeviceSession(storedSession({ accessExpiresAt: 1_030_000 }))
		);
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let signalRefresh!: () => void;
		const refreshEntered = new Promise<void>((resolve) => {
			signalRefresh = resolve;
		});
		let refreshCalls = 0;
		let listCalls = 0;
		const errors: string[] = [];
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			if (url.pathname.endsWith('/refresh')) {
				refreshCalls += 1;
				signalRefresh();
				await refreshGate;
				return response(tokenResponse);
			}
			if (url.pathname === '/v1/machines') {
				listCalls += 1;
				expect(new Headers(init?.headers).get('authorization')).toBe(
					`Bearer ${tokenResponse.access_token}`
				);
				return response({ machines: [] });
			}
			throw new Error(`unexpected ${url.pathname}`);
		});
		const dependencies = {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			now: () => 1_000_000,
			io: { out: () => undefined, error: (line: string) => errors.push(line) }
		};
		vi.stubGlobal('fetch', fetch);

		const first = runCli(['machines', 'list'], { ...dependencies });
		const second = runCli(['machines', 'list'], { ...dependencies });
		await refreshEntered;
		releaseRefresh();
		expect(await Promise.all([first, second]), errors.join('\n')).toEqual([0, 0]);

		expect(refreshCalls).toBe(1);
		expect(listCalls).toBe(2);
		expect(decodeDeviceCredential(store.values.get(credentialAccount)!)).toMatchObject({
			kind: 'session',
			session: {
				refreshToken: tokenResponse.refresh_token,
				accessToken: tokenResponse.access_token
			}
		});
	});

	it('serializes logout behind refresh and revokes the winning replacement token', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-logout-lock-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: legitimateBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const store = new MemoryCredentialStore();
		store.values.set(
			credentialAccount,
			encodeDeviceSession(storedSession({ accessExpiresAt: 1_030_000 }))
		);
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let signalRefresh!: () => void;
		const refreshEntered = new Promise<void>((resolve) => {
			signalRefresh = resolve;
		});
		const revoked: string[] = [];
		let refreshCalls = 0;
		const errors: string[] = [];
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			if (url.pathname.endsWith('/refresh')) {
				refreshCalls += 1;
				signalRefresh();
				await refreshGate;
				return response(tokenResponse);
			}
			if (url.pathname.endsWith('/revoke')) {
				revoked.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
				return response({}, 204);
			}
			if (url.pathname === '/v1/machines') return response({ machines: [] });
			throw new Error(`unexpected ${url.pathname}`);
		});
		const dependencies = {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			now: () => 1_000_000,
			io: { out: () => undefined, error: (line: string) => errors.push(line) }
		};
		vi.stubGlobal('fetch', fetch);

		const command = runCli(['machines', 'list'], { ...dependencies });
		await refreshEntered;
		const logout = runCli(['logout'], { ...dependencies });
		releaseRefresh();
		expect(await Promise.all([command, logout]), errors.join('\n')).toEqual([0, 0]);

		expect(refreshCalls).toBe(1);
		expect(revoked).toEqual([tokenResponse.refresh_token]);
		expect(store.values.has(credentialAccount)).toBe(false);
		expect(await readConfig(configFile)).toMatchObject({ baseUrl: legitimateBaseUrl });
		expect((await readConfig(configFile)).authMode).toBeUndefined();
	});

	it.each([
		{
			name: '--url override',
			argv: ['--url', attackerBaseUrl],
			env: {},
			configuredBaseUrl: legitimateBaseUrl
		},
		{
			name: 'NEHEMIAH_URL override',
			argv: [],
			env: { NEHEMIAH_URL: attackerBaseUrl },
			configuredBaseUrl: legitimateBaseUrl
		},
		{
			name: 'config URL substitution',
			argv: [],
			env: {},
			configuredBaseUrl: attackerBaseUrl
		}
	])('does not retrieve or send a device refresh after $name', async (testCase) => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-origin-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: testCase.configuredBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, tokenResponse.refresh_token);
		const fetch = vi.fn(async () => {
			throw new Error('refresh credential reached the network');
		});
		const errors: string[] = [];

		const exit = await runCli(['machines', 'list', ...testCase.argv, '--json'], {
			env: testCase.env,
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(exit).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'credential_origin_mismatch' }
		});
		expect(store.getCalls).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ name: 'logout', argv: ['logout', '--url', attackerBaseUrl, '--json'] },
		{
			name: 're-login',
			argv: ['login', '--url', attackerBaseUrl, '--no-browser', '--json']
		}
	])('rejects a mismatched device $name before keyring or network access', async (testCase) => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-entrypoint-origin-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: legitimateBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, tokenResponse.refresh_token);
		const fetch = vi.fn();
		const errors: string[] = [];

		const exit = await runCli(testCase.argv, {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(exit).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'credential_origin_mismatch' }
		});
		expect(store.getCalls).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('re-login revokes an old refresh only against its bound root endpoint', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-relogin-origin-'));
		const configFile = join(directory, 'config.json');
		const oldBaseUrl = legitimateBaseUrl;
		const newBaseUrl = legitimateBaseUrl;
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: oldBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const oldRefresh = `bc_refresh_55555555-5555-4555-8555-555555555555_${'d'.repeat(43)}`;
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, oldRefresh);
		const requests: Array<{ url: URL; body: Record<string, unknown> }> = [];
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.pathname === '/v1/auth/device/code') return response(codeResponse, 201);
			if (url.pathname === '/v1/auth/device/token') return response(tokenResponse);
			if (url.pathname === '/v1/auth/device/revoke') return response({}, 204);
			throw new Error(`unexpected ${url.pathname}`);
		});

		const exit = await runCli(
			['login', '--url', newBaseUrl, '--no-browser', '--scopes', 'machines:read'],
			{
				env: {},
				configFile,
				credentialStore: store,
				fetch: fetch as typeof globalThis.fetch,
				sleep: async () => undefined,
				io: { out: () => undefined, error: () => undefined }
			}
		);

		expect(exit).toBe(0);
		expect(store.getCalls).toEqual([credentialAccount]);
		expect(decodeDeviceCredential(store.values.get(credentialAccount)!)).toMatchObject({
			kind: 'session',
			session: { refreshToken: tokenResponse.refresh_token }
		});
		expect(requests.find(({ url }) => url.pathname.endsWith('/revoke'))).toMatchObject({
			url: expect.objectContaining({
				origin: legitimateBaseUrl,
				pathname: '/v1/auth/device/revoke'
			}),
			body: { refresh_token: oldRefresh }
		});
		expect(await readConfig(configFile)).toMatchObject({
			credentialOrigin: legitimateBaseUrl,
			baseUrl: newBaseUrl
		});
	});

	it('rolls back a published login session before releasing its account lock', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-login-rollback-'));
		const configFile = join(directory, 'config.json');
		const lockDirectory = join(directory, `.credential-${credentialAccount}.lock`);
		await writeConfig(
			{
				authMode: 'device',
				credentialAccount,
				credentialOrigin: legitimateBaseUrl,
				baseUrl: legitimateBaseUrl,
				target: 'cloud'
			},
			configFile
		);
		const previous = storedSession();
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, encodeDeviceSession(previous));
		let releaseRollback!: () => void;
		const rollbackGate = new Promise<void>((resolve) => {
			releaseRollback = resolve;
		});
		let signalRollback!: () => void;
		const rollbackEntered = new Promise<void>((resolve) => {
			signalRollback = resolve;
		});
		const revoked: string[] = [];
		let machineRequests = 0;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			if (url.pathname.endsWith('/code')) return response(codeResponse, 201);
			if (url.pathname.endsWith('/token')) return response(tokenResponse);
			if (url.pathname.endsWith('/revoke')) {
				const refresh = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token;
				revoked.push(refresh);
				if (refresh === tokenResponse.refresh_token) {
					signalRollback();
					await rollbackGate;
				}
				return response({}, 204);
			}
			if (url.pathname === '/v1/machines') {
				machineRequests += 1;
				return response({ machines: [] });
			}
			throw new Error(`unexpected ${url.pathname}`);
		});
		const errors: string[] = [];
		const dependencies = {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			sleep: async () => undefined,
			writeConfig: async () => {
				throw new Error('forced config persistence failure');
			},
			io: { out: () => undefined, error: (line: string) => errors.push(line) }
		};
		vi.stubGlobal('fetch', fetch);

		const login = runCli(['login', '--no-browser', '--scopes', 'machines:read'], dependencies);
		await rollbackEntered;
		expect((await stat(lockDirectory)).isDirectory()).toBe(true);

		const contender = runCli(['machines', 'list'], dependencies);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(store.getCalls).toEqual([credentialAccount]);
		expect(machineRequests).toBe(0);

		releaseRollback();
		expect(await Promise.all([login, contender])).toEqual([1, 1]);
		expect(revoked).toEqual([previous.refreshToken, tokenResponse.refresh_token]);
		expect(store.deleteCalls).toEqual([credentialAccount]);
		expect(store.values.has(credentialAccount)).toBe(false);
		expect(machineRequests).toBe(0);
		expect(errors).toHaveLength(2);
	});

	it('requires re-login for an unbound custom legacy refresh without reading it', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-legacy-origin-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{ authMode: 'device', credentialAccount, baseUrl: legitimateBaseUrl, target: 'cloud' },
			configFile
		);
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, tokenResponse.refresh_token);
		const fetch = vi.fn();
		const errors: string[] = [];

		const exit = await runCli(['machines', 'list', '--json'], {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});

		expect(exit).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'credential_origin_required' }
		});
		expect(store.getCalls).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('re-login replaces an unbound legacy refresh without reading or revoking it', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-legacy-relogin-'));
		const configFile = join(directory, 'config.json');
		await writeConfig(
			{ authMode: 'device', credentialAccount, baseUrl: legitimateBaseUrl, target: 'cloud' },
			configFile
		);
		const oldRefresh = `bc_refresh_66666666-6666-4666-8666-666666666666_${'e'.repeat(43)}`;
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, oldRefresh);
		const paths: string[] = [];
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			paths.push(url.pathname);
			if (url.pathname.endsWith('/code')) return response(codeResponse, 201);
			if (url.pathname.endsWith('/token')) return response(tokenResponse);
			throw new Error(`unexpected ${url.pathname}`);
		});

		const exit = await runCli(['login', '--no-browser', '--scopes', 'machines:read'], {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			sleep: async () => undefined,
			io: { out: () => undefined, error: () => undefined }
		});

		expect(exit).toBe(0);
		expect(store.getCalls).toEqual([]);
		expect(decodeDeviceCredential(store.values.get(credentialAccount)!)).toMatchObject({
			kind: 'session',
			session: { refreshToken: tokenResponse.refresh_token }
		});
		expect(paths).toEqual(['/v1/auth/device/code', '/v1/auth/device/token']);
		expect(await readConfig(configFile)).toMatchObject({
			credentialOrigin: legitimateBaseUrl,
			baseUrl: legitimateBaseUrl
		});
	});

	it('safely migrates only a legacy device login at the known cloud default', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-default-migration-'));
		const configFile = join(directory, 'config.json');
		await writeConfig({ authMode: 'device', credentialAccount, target: 'cloud' }, configFile);
		const store = new MemoryCredentialStore();
		store.values.set(credentialAccount, tokenResponse.refresh_token);
		const urls: URL[] = [];
		const fetch = vi.fn(async (input: string | URL | Request) => {
			urls.push(
				new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
			);
			return response({}, 204);
		});

		const exit = await runCli(['logout'], {
			env: {},
			configFile,
			credentialStore: store,
			fetch: fetch as typeof globalThis.fetch,
			io: { out: () => undefined, error: () => undefined }
		});

		expect(exit).toBe(0);
		expect(store.getCalls).toEqual([credentialAccount]);
		expect(urls).toHaveLength(1);
		expect(urls[0]!.origin).toBe(new URL(CLOUD_BASE_URL).origin);
	});

	it('fails typed instead of writing a plaintext fallback when the credential store is unavailable', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-device-no-keyring-'));
		const configFile = join(directory, 'config.json');
		const errors: string[] = [];
		const unavailable: CredentialStore = {
			get: async () => undefined,
			set: async () => {
				throw new CredentialStoreUnavailable();
			},
			delete: async () => undefined
		};
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input : input.url
			);
			if (url.pathname.endsWith('/code')) return response(codeResponse, 201);
			if (url.pathname.endsWith('/token')) return response(tokenResponse);
			if (url.pathname.endsWith('/revoke')) return response({}, 204);
			throw new Error('unexpected request');
		});
		const exit = await runCli(['login', '--json', '--scopes', 'machines:read'], {
			env: { NEHEMIAH_URL: 'https://api.example.com' },
			configFile,
			credentialStore: unavailable,
			fetch: fetch as typeof globalThis.fetch,
			sleep: async () => undefined,
			io: { out: () => undefined, error: (line) => errors.push(line) }
		});
		expect(exit).toBe(1);
		expect(JSON.parse(errors[0]!)).toMatchObject({
			error: { code: 'credential_store_unavailable' }
		});
		await expect(readFile(configFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/revoke'))).toBe(true);
	});

	it('refuses a verification URL containing any credential-like extra parameter', async () => {
		const fetch = vi.fn().mockResolvedValue(
			response(
				{
					...codeResponse,
					verification_uri_complete: `${codeResponse.verification_uri_complete}&token=secret`
				},
				201
			)
		);
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], fetch)
		).rejects.toMatchObject({ code: 'invalid_response' } satisfies Partial<DeviceAuthError>);
	});

	it('rejects a device response that changes the explicitly requested scopes', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(response({ ...codeResponse, scopes: ['machines:write'] }, 201));
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], fetch)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('stops polling at the declared expiry boundary', async () => {
		await expect(
			pollDeviceToken({
				baseUrl: 'https://api.example.com',
				code: { ...codeResponse, expires_in: 4, interval: 5 },
				fetch: vi.fn(),
				now: () => 0,
				sleep: vi.fn()
			})
		).rejects.toMatchObject({ code: 'expired_token' });
	});

	it.each([
		'file:///tmp/capture',
		'javascript:alert(1)',
		'http://example.com/device',
		'https://user:password@example.com/device',
		'https://unrelated.invalid/device'
	])('rejects the untrusted verification origin %s before browser launch', async (verification) => {
		const fetch = vi.fn().mockResolvedValue(
			response(
				{
					...codeResponse,
					verification_uri: verification,
					verification_uri_complete: `${verification}?user_code=ABCD-EFGH`
				},
				201
			)
		);
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], fetch)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('revalidates the URL at the native browser-launch boundary', async () => {
		await expect(
			openVerificationPage('file:///tmp/capture?user_code=ABCD-EFGH', 'https://api.example.com')
		).rejects.toMatchObject({ code: 'invalid_response' });
		await expect(
			openVerificationPage(
				'https://unrelated.invalid/device?user_code=ABCD-EFGH',
				'https://api.example.com'
			)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('allows only the exact documented api-to-dashboard host relation', async () => {
		const publicSuffix = vi.fn().mockResolvedValue(
			response(
				{
					...codeResponse,
					verification_uri: 'https://co.uk/device',
					verification_uri_complete: 'https://co.uk/device?user_code=ABCD-EFGH'
				},
				201
			)
		);
		await expect(
			requestDeviceCode('https://api.evil.co.uk', ['machines:read'], publicSuffix)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('cancels a streaming response as soon as it crosses the byte bound', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(32_768));
				controller.enqueue(new Uint8Array(32_769));
			},
			cancel() {
				cancelled = true;
			}
		});
		const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 201 }));
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], fetch)
		).rejects.toMatchObject({ code: 'invalid_response' });
		expect(cancelled).toBe(true);
	});

	it('times out a hung fetch and a hung response body', async () => {
		const hungFetch = vi.fn(() => new Promise<Response>(() => undefined));
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], hungFetch, {
				timeoutMs: 5
			})
		).rejects.toMatchObject({ code: 'request_timeout' });

		let hungBodyCancelled = false;
		const hungBody = vi.fn().mockResolvedValue(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{'));
					},
					cancel() {
						hungBodyCancelled = true;
					}
				}),
				{ status: 201 }
			)
		);
		await expect(
			requestDeviceCode('https://api.example.com', ['machines:read'], hungBody, {
				timeoutMs: 5
			})
		).rejects.toMatchObject({ code: 'request_timeout' });
		expect(hungBodyCancelled).toBe(true);
	});
});

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TargetMode } from 'nehemiah-sdk';

export interface CliConfig {
	readonly apiKey?: string;
	readonly authMode?: 'api_key' | 'device';
	readonly credentialAccount?: string;
	readonly credentialOrigin?: string;
	readonly project?: string;
	readonly region?: string;
	readonly baseUrl?: string;
	readonly target?: TargetMode;
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Canonical origin accepted for persisted credentials; paths are deliberately not retained. */
export function canonicalCredentialOrigin(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		const safeProtocol =
			url.protocol === 'https:' ||
			(url.protocol === 'http:' && loopbackHostnames.has(url.hostname));
		if (
			!safeProtocol ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash ||
			url.origin === 'null'
		) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
}

export interface ConfigPathOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly userHome?: string;
}

/** Always resolves to the operating system's per-user config directory. */
export function configPath(options: ConfigPathOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const userHome = options.userHome ?? homedir();
	if (platform === 'win32') {
		return join(env.APPDATA ?? join(userHome, 'AppData', 'Roaming'), 'nehemiah', 'config.json');
	}
	if (platform === 'darwin') {
		return join(userHome, 'Library', 'Application Support', 'nehemiah', 'config.json');
	}
	return join(env.XDG_CONFIG_HOME ?? join(userHome, '.config'), 'nehemiah', 'config.json');
}

export async function readConfig(path = configPath()): Promise<CliConfig> {
	try {
		const handle = await open(path, 'r');
		try {
			const body = await handle.readFile({ encoding: 'utf8' });
			const value = JSON.parse(body) as Record<string, unknown>;
			return sanitizeConfig(value);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
}

/** Atomic user-only write. The final file is explicitly chmodded to 0600. */
export async function writeConfig(config: CliConfig, path = configPath()): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.config-${randomUUID()}.tmp`);
	const handle = await open(temporary, 'wx', 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function sanitizeConfig(value: Record<string, unknown>): CliConfig {
	const target = value.target;
	const credentialOrigin =
		typeof value.credentialOrigin === 'string'
			? canonicalCredentialOrigin(value.credentialOrigin)
			: undefined;
	return {
		...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
		...(value.authMode === 'api_key' || value.authMode === 'device'
			? { authMode: value.authMode }
			: {}),
		...(typeof value.credentialAccount === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value.credentialAccount
		)
			? { credentialAccount: value.credentialAccount }
			: {}),
		...(credentialOrigin === value.credentialOrigin ? { credentialOrigin } : {}),
		...(typeof value.project === 'string' ? { project: value.project } : {}),
		...(typeof value.region === 'string' ? { region: value.region } : {}),
		...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
		...(target === 'local' || target === 'self-hosted' || target === 'cloud' ? { target } : {})
	};
}

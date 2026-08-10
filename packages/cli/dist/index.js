#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { stdin, stderr, stdout } from 'node:process';
import { Effect, Stream } from 'effect';
import { CLOUD_BASE_URL, NotSupported, RequestError, ResponseError, make } from 'nehemiah-sdk';
import { parseArgs, runMachineCommand, UsageError } from './commands/machines.js';
import { runTemplateCommand } from './commands/templates.js';
import { CredentialLockError, withCredentialLock } from './credential-lock.js';
import { canonicalCredentialOrigin, configPath, readConfig, writeConfig } from './config.js';
import { cliDeviceScopes, DeviceAuthError, openVerificationPage, pollDeviceToken, refreshDeviceToken, requestDeviceCode, revokeDeviceToken } from './device-auth.js';
import { CredentialStoreUnavailable, decodeDeviceCredential, encodeDeviceSession, SystemCredentialStore } from './credential-store.js';
export class DeviceLoginUnavailable extends Error {
    code = 'device_login_unavailable';
    status;
    constructor(status) {
        super('This endpoint does not currently offer device login. Configure NEHEMIAH_API_KEY or run `bc config set-key`.');
        this.status = status;
    }
}
export class CredentialOriginError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export async function runCli(argv, dependencies = {}) {
    const env = dependencies.env ?? process.env;
    const io = dependencies.io ?? {
        out: (text) => stdout.write(`${text}\n`),
        error: (text) => stderr.write(`${text}\n`)
    };
    const parsed = parseArgs(argv);
    const json = parsed.flags.json === true;
    const [noun, rawCommand, ...rest] = parsed.positionals;
    try {
        if (noun === undefined || noun === 'help' || parsed.flags.help === true) {
            io.out(HELP);
            return 0;
        }
        const configFile = dependencies.configFile ?? configPath({ env });
        if (noun === 'config') {
            return await runConfig(rawCommand, rest, parsed.flags, env, configFile, io, json);
        }
        if (noun === 'login' || noun === 'device-login') {
            return await runDeviceLogin({
                env,
                flags: parsed.flags,
                configFile,
                io,
                json,
                dependencies
            });
        }
        if (noun === 'logout') {
            return await runDeviceLogout({
                env,
                flags: parsed.flags,
                configFile,
                io,
                json,
                dependencies
            });
        }
        if (noun === 'template' || noun === 'templates') {
            const client = dependencies.client ??
                make(await authenticatedClientOptions(env, configFile, parsed.flags, dependencies));
            const result = await runTemplateCommand(client, rawCommand, {
                positionals: rest,
                flags: parsed.flags
            });
            emit(result.value, result.human ?? '', io, json);
            return 0;
        }
        const machineCommand = noun === 'machine' || noun === 'machines' ? rawCommand : noun;
        const machineArgs = noun === 'machine' || noun === 'machines'
            ? rest
            : [rawCommand, ...rest].filter(Boolean);
        if (machineCommand === 'tty') {
            const id = machineArgs[0];
            if (!id)
                throw new UsageError('Missing machine id.');
            const client = dependencies.client ??
                make(await authenticatedClientOptions(env, configFile, parsed.flags, dependencies));
            await runTty(client, id);
            return 0;
        }
        const client = dependencies.client ??
            make(await authenticatedClientOptions(env, configFile, parsed.flags, dependencies));
        const commandArgs = { positionals: machineArgs, flags: parsed.flags };
        const result = await runMachineCommand(client, machineCommand, commandArgs);
        emit(result.value, result.human ?? '', io, json);
        return 0;
    }
    catch (error) {
        const formatted = formatError(error);
        io.error(json ? JSON.stringify({ error: formatted }) : `Error: ${formatted.message}`);
        return formatted.code === 'usage_error' ? 2 : 1;
    }
}
export function clientOptions(env, config, flags = {}) {
    const flagUrl = flagString(flags, 'url');
    const baseUrl = flagUrl ?? env.NEHEMIAH_URL ?? config.baseUrl;
    const targetValue = flagString(flags, 'target') ?? env.NEHEMIAH_TARGET ?? config.target;
    const explicitCredential = env.NEHEMIAH_API_KEY;
    const storedCredential = config.authMode === 'device' ? undefined : config.apiKey;
    const selectedOrigin = canonicalCredentialOrigin(baseUrl ?? CLOUD_BASE_URL);
    const configuredOrigin = canonicalCredentialOrigin(config.baseUrl ?? CLOUD_BASE_URL);
    const storedCredentialIsBound = storedCredential !== undefined &&
        config.credentialOrigin !== undefined &&
        selectedOrigin === config.credentialOrigin &&
        configuredOrigin === config.credentialOrigin;
    const cloudCredential = explicitCredential ?? (storedCredentialIsBound ? storedCredential : undefined);
    const effectiveBaseUrl = baseUrl ??
        (explicitCredential === undefined && storedCredentialIsBound
            ? (config.baseUrl ?? CLOUD_BASE_URL)
            : undefined);
    const cloudProject = flagString(flags, 'project') ?? env.NEHEMIAH_PROJECT ?? config.project;
    const target = validTarget(targetValue)
        ? targetValue
        : cloudCredential || cloudProject
            ? 'cloud'
            : baseUrl !== undefined && baseUrl !== CLOUD_BASE_URL
                ? 'self-hosted'
                : 'cloud';
    return {
        target,
        ...(effectiveBaseUrl !== undefined ? { baseUrl: effectiveBaseUrl } : {}),
        ...(cloudCredential ? { apiKey: cloudCredential } : {}),
        ...(cloudProject ? { project: cloudProject } : {}),
        ...((flagString(flags, 'region') ?? env.NEHEMIAH_REGION ?? config.region)
            ? { region: flagString(flags, 'region') ?? env.NEHEMIAH_REGION ?? config.region }
            : {})
    };
}
const credentialStore = (dependencies) => dependencies.credentialStore ?? new SystemCredentialStore();
const selectedBaseUrl = (env, config, flags) => flagString(flags, 'url') ?? env.NEHEMIAH_URL ?? config.baseUrl ?? CLOUD_BASE_URL;
const safeCredentialOrigin = (baseUrl) => {
    const origin = canonicalCredentialOrigin(baseUrl);
    if (!origin) {
        throw new CredentialOriginError('unsafe_credential_origin', 'Stored credentials require an HTTPS API origin (loopback HTTP is allowed for local development).');
    }
    return origin;
};
async function requireCredentialBinding(input) {
    const selectedOrigin = safeCredentialOrigin(input.selectedBaseUrl);
    let config = input.config;
    let credentialOrigin = config.credentialOrigin;
    const defaultOrigin = safeCredentialOrigin(CLOUD_BASE_URL);
    if (!credentialOrigin) {
        if (input.kind === 'device' &&
            config.baseUrl === undefined &&
            selectedOrigin === defaultOrigin) {
            credentialOrigin = defaultOrigin;
            config = { ...config, credentialOrigin };
            await writeConfig(config, input.configFile);
        }
        else {
            throw new CredentialOriginError('credential_origin_required', input.kind === 'device'
                ? 'This legacy device login is not bound to an API origin. Run `bc login` again before using it.'
                : 'This saved API key is not bound to an API origin. Run `bc config set-key KEY --url URL` again.');
        }
    }
    const boundBaseUrl = config.baseUrl ?? CLOUD_BASE_URL;
    const configuredOrigin = canonicalCredentialOrigin(boundBaseUrl);
    if (configuredOrigin !== credentialOrigin || selectedOrigin !== credentialOrigin) {
        throw new CredentialOriginError('credential_origin_mismatch', 'The selected API origin does not match the origin bound to this stored credential. Remove URL overrides or authenticate explicitly for the selected origin.');
    }
    return { config, credentialOrigin, boundBaseUrl };
}
const requestedScopes = (flags) => {
    const value = flagString(flags, 'scopes');
    if (value === undefined)
        return cliDeviceScopes;
    const scopes = [
        ...new Set(value
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean))
    ];
    const allowed = new Set([...cliDeviceScopes, 'billing:read']);
    if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
        throw new UsageError('--scopes must be a comma-separated list of supported API scopes.');
    }
    return scopes;
};
const accessTokenRefreshSkewMs = 60_000;
const clock = (dependencies) => {
    const value = dependencies.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new DeviceAuthError('invalid_clock', 'The system clock is not valid for device login.');
    }
    return value;
};
const storedSessionFromToken = (input) => ({
    version: 1,
    account: input.account,
    origin: input.origin,
    refreshToken: input.token.refresh_token,
    refreshExpiresAt: input.now + input.token.refresh_expires_in * 1_000,
    accessToken: input.token.access_token,
    accessExpiresAt: input.now + input.token.expires_in * 1_000,
    organizationId: input.token.organization_id,
    projectId: input.token.project_id,
    scopes: [...input.token.scopes]
});
const refreshFromStoredCredential = (secret) => {
    const decoded = decodeDeviceCredential(secret);
    return decoded?.kind === 'legacy'
        ? decoded.refreshToken
        : decoded?.kind === 'session'
            ? decoded.session.refreshToken
            : undefined;
};
async function authenticatedClientOptions(env, configFile, flags, dependencies) {
    const config = await readConfig(configFile);
    const options = clientOptions(env, config, flags);
    if (env.NEHEMIAH_API_KEY)
        return options;
    if (config.authMode !== 'device' && config.apiKey) {
        await requireCredentialBinding({
            kind: 'api_key',
            config,
            configFile,
            selectedBaseUrl: selectedBaseUrl(env, config, flags)
        });
        return options;
    }
    if (options.apiKey || config.authMode !== 'device' || !config.credentialAccount)
        return options;
    const account = config.credentialAccount;
    const store = credentialStore(dependencies);
    return withCredentialLock(configFile, account, async () => {
        const currentConfig = await readConfig(configFile);
        if (currentConfig.authMode !== 'device' || currentConfig.credentialAccount !== account) {
            throw new DeviceAuthError('device_login_required', 'This device login changed in another process. Retry the command.');
        }
        const currentBinding = await requireCredentialBinding({
            kind: 'device',
            config: currentConfig,
            configFile,
            selectedBaseUrl: selectedBaseUrl(env, currentConfig, flags)
        });
        const secret = await store.get(account);
        if (!secret) {
            throw new DeviceAuthError('device_login_required', 'This device login is missing from the operating-system credential store. Run `bc login` again.');
        }
        const decoded = decodeDeviceCredential(secret);
        if (decoded?.kind === 'legacy') {
            throw new DeviceAuthError('device_session_upgrade_required', 'This login predates safe access-token caching. Run `bc login` again.');
        }
        if (decoded?.kind !== 'session' ||
            decoded.session.account !== account ||
            decoded.session.origin !== currentBinding.credentialOrigin) {
            throw new DeviceAuthError('device_credential_invalid', 'The stored device session is invalid. Run `bc login` again.');
        }
        const now = clock(dependencies);
        if (decoded.session.refreshExpiresAt <= now) {
            await store.delete(account);
            throw new DeviceAuthError('device_login_required', 'This device login expired. Run `bc login` again.');
        }
        if (decoded.session.accessExpiresAt - now > accessTokenRefreshSkewMs) {
            return {
                ...options,
                target: 'cloud',
                apiKey: decoded.session.accessToken,
                project: decoded.session.projectId
            };
        }
        let token;
        try {
            token = await refreshDeviceToken(currentBinding.boundBaseUrl, decoded.session.refreshToken, dependencies.fetch ?? globalThis.fetch);
        }
        catch (error) {
            if (error instanceof DeviceAuthError &&
                ['invalid_grant', 'refresh_reuse_detected'].includes(error.code)) {
                await store.delete(account).catch(() => undefined);
            }
            throw error;
        }
        const next = storedSessionFromToken({
            token,
            account,
            origin: currentBinding.credentialOrigin,
            now: clock(dependencies)
        });
        try {
            await store.set(account, encodeDeviceSession(next));
        }
        catch (error) {
            await revokeDeviceToken(currentBinding.boundBaseUrl, token.refresh_token, dependencies.fetch ?? globalThis.fetch).catch(() => undefined);
            throw error;
        }
        return {
            ...options,
            target: 'cloud',
            apiKey: next.accessToken,
            project: next.projectId
        };
    });
}
async function runDeviceLogin(input) {
    let config = await readConfig(input.configFile);
    const baseUrl = selectedBaseUrl(input.env, config, input.flags);
    const credentialOrigin = safeCredentialOrigin(baseUrl);
    let previousBaseUrl;
    if (config.authMode === 'device' && config.credentialAccount) {
        try {
            const binding = await requireCredentialBinding({
                kind: 'device',
                config,
                configFile: input.configFile,
                selectedBaseUrl: baseUrl
            });
            config = binding.config;
            previousBaseUrl = binding.boundBaseUrl;
        }
        catch (error) {
            // Re-login is the recovery path for an unbound legacy entry. Never read
            // or revoke that old refresh credential because its origin is unknown.
            if (!(error instanceof CredentialOriginError) ||
                error.code !== 'credential_origin_required') {
                throw error;
            }
        }
    }
    const fetchImplementation = input.dependencies.fetch ?? globalThis.fetch;
    const code = await requestDeviceCode(baseUrl, requestedScopes(input.flags), fetchImplementation);
    const display = {
        status: 'authorization_required',
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        verification_uri_complete: code.verification_uri_complete,
        expires_in: code.expires_in,
        interval: code.interval,
        scopes: code.scopes
    };
    emit(display, `Open ${code.verification_uri_complete} (code ${code.user_code}) to approve this login.`, input.io, input.json);
    if (!input.json && input.flags['no-browser'] !== true) {
        await (input.dependencies.openBrowser
            ? input.dependencies.openBrowser(code.verification_uri_complete)
            : openVerificationPage(code.verification_uri_complete, baseUrl)).catch(() => undefined);
    }
    const token = await pollDeviceToken({
        baseUrl,
        code,
        fetch: fetchImplementation,
        sleep: input.dependencies.sleep,
        now: input.dependencies.now
    });
    const store = credentialStore(input.dependencies);
    const account = config.credentialAccount ?? randomUUID();
    const session = storedSessionFromToken({
        token,
        account,
        origin: credentialOrigin,
        now: clock(input.dependencies)
    });
    let enteredCredentialLock = false;
    try {
        await withCredentialLock(input.configFile, account, async () => {
            enteredCredentialLock = true;
            let storedNewSession = false;
            try {
                const previous = config.authMode === 'device' && config.credentialAccount && previousBaseUrl
                    ? await store.get(config.credentialAccount)
                    : undefined;
                if (previous && previousBaseUrl) {
                    const previousRefresh = refreshFromStoredCredential(previous);
                    if (!previousRefresh) {
                        throw new DeviceAuthError('device_credential_invalid', 'The previous device session is invalid and could not be revoked.');
                    }
                    await revokeDeviceToken(previousBaseUrl, previousRefresh, fetchImplementation);
                }
                // Treat a failed keyring write as potentially committed: native stores can
                // persist before reporting an IPC failure, so rollback must still delete it.
                storedNewSession = true;
                await store.set(account, encodeDeviceSession(session));
                await (input.dependencies.writeConfig ?? writeConfig)({
                    ...config,
                    apiKey: undefined,
                    authMode: 'device',
                    credentialAccount: account,
                    credentialOrigin,
                    project: token.project_id,
                    target: 'cloud',
                    baseUrl
                }, input.configFile);
            }
            catch (error) {
                await revokeDeviceToken(baseUrl, token.refresh_token, fetchImplementation).catch(() => undefined);
                if (storedNewSession)
                    await store.delete(account).catch(() => undefined);
                throw error;
            }
        });
    }
    catch (error) {
        if (!enteredCredentialLock) {
            await revokeDeviceToken(baseUrl, token.refresh_token, fetchImplementation).catch(() => undefined);
        }
        throw error;
    }
    emit({
        status: 'authenticated',
        organization_id: token.organization_id,
        project_id: token.project_id,
        scopes: token.scopes,
        credential_store: 'os'
    }, `Signed in for project ${token.project_id}. The bounded device session is in your OS credential store.`, input.io, input.json);
    return 0;
}
async function runDeviceLogout(input) {
    const config = await readConfig(input.configFile);
    if (config.authMode !== 'device' || !config.credentialAccount) {
        throw new DeviceAuthError('device_login_required', 'There is no device login to revoke.');
    }
    const store = credentialStore(input.dependencies);
    const account = config.credentialAccount;
    await withCredentialLock(input.configFile, account, async () => {
        const currentConfig = await readConfig(input.configFile);
        if (currentConfig.authMode !== 'device' || currentConfig.credentialAccount !== account) {
            throw new DeviceAuthError('device_login_required', 'This device login changed in another process. Retry logout.');
        }
        const binding = await requireCredentialBinding({
            kind: 'device',
            config: currentConfig,
            configFile: input.configFile,
            selectedBaseUrl: selectedBaseUrl(input.env, currentConfig, input.flags)
        });
        const secret = await store.get(account);
        if (secret) {
            const refresh = refreshFromStoredCredential(secret);
            if (!refresh) {
                throw new DeviceAuthError('device_credential_invalid', 'The stored device session is invalid and could not be revoked.');
            }
            await revokeDeviceToken(binding.boundBaseUrl, refresh, input.dependencies.fetch ?? globalThis.fetch);
        }
        await store.delete(account);
        await writeConfig({
            ...binding.config,
            authMode: undefined,
            credentialAccount: undefined,
            credentialOrigin: undefined,
            project: undefined
        }, input.configFile);
    });
    emit({ revoked: true }, 'Device login revoked.', input.io, input.json);
    return 0;
}
async function runConfig(command, positionals, flags, env, path, io, json) {
    const current = await readConfig(path);
    if (command === 'show') {
        const safe = {
            ...current,
            ...(current.apiKey ? { apiKey: '<configured>' } : {}),
            ...(current.credentialAccount ? { credentialAccount: '<os-credential-store>' } : {})
        };
        emit(safe, JSON.stringify(safe, null, 2), io, json);
        return 0;
    }
    if (command === 'set-key') {
        if (current.authMode === 'device' && current.credentialAccount) {
            throw new UsageError('Run `bc logout` before switching from device login to an API key.');
        }
        const key = positionals[0] ?? flagString(flags, 'api-key');
        if (!key)
            throw new UsageError('Missing API key. Pass it as an argument or --api-key.');
        const invocationUrl = flagString(flags, 'url') ?? env.NEHEMIAH_URL;
        if (current.apiKey !== undefined &&
            (current.credentialOrigin === undefined ||
                canonicalCredentialOrigin(current.baseUrl ?? CLOUD_BASE_URL) !==
                    current.credentialOrigin) &&
            invocationUrl === undefined) {
            throw new UsageError('This saved API key has no trustworthy origin. Re-run `bc config set-key KEY --url URL` with the endpoint explicitly selected.');
        }
        const baseUrl = selectedBaseUrl(env, current, flags);
        const credentialOrigin = safeCredentialOrigin(baseUrl);
        await writeConfig({
            ...current,
            apiKey: key,
            authMode: 'api_key',
            credentialAccount: undefined,
            credentialOrigin,
            baseUrl
        }, path);
        emit({ configured: true, path }, `Saved API key in ${path} (mode 0600).`, io, json);
        return 0;
    }
    if (command === 'set') {
        const requestedUrl = flagString(flags, 'url');
        if (requestedUrl !== undefined)
            safeCredentialOrigin(requestedUrl);
        if (requestedUrl !== undefined &&
            (current.apiKey !== undefined ||
                (current.authMode === 'device' && current.credentialAccount !== undefined))) {
            throw new UsageError('Cannot change --url while a stored credential is active. For an API key, run `bc config set-key KEY --url URL`; for device login, run `bc logout` at its bound endpoint and then `bc login --url URL`.');
        }
        const targetValue = flagString(flags, 'target');
        if (targetValue !== undefined && !validTarget(targetValue)) {
            throw new UsageError('--target must be local, self-hosted, or cloud.');
        }
        const next = {
            ...current,
            ...(requestedUrl !== undefined ? { baseUrl: requestedUrl } : {}),
            ...(flagString(flags, 'project') ? { project: flagString(flags, 'project') } : {}),
            ...(flagString(flags, 'region') ? { region: flagString(flags, 'region') } : {}),
            ...(targetValue ? { target: targetValue } : {})
        };
        await writeConfig(next, path);
        emit({ configured: true, path }, `Saved configuration in ${path} (mode 0600).`, io, json);
        return 0;
    }
    throw new UsageError('Use `bc config set-key`, `bc config set`, or `bc config show`.');
}
export async function beginDeviceLogin(baseUrl, fetchImplementation) {
    try {
        return await requestDeviceCode(baseUrl, cliDeviceScopes, fetchImplementation);
    }
    catch (error) {
        if (error instanceof DeviceAuthError && (error.status === 404 || error.status === 501)) {
            throw new DeviceLoginUnavailable(error.status);
        }
        throw error;
    }
}
async function runTty(client, id) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const channel = yield* client.connectTty(id);
        const handler = (chunk) => {
            void Effect.runPromise(channel.send(typeof chunk === 'string' ? chunk : new Uint8Array(chunk))).catch(() => undefined);
        };
        yield* Effect.acquireRelease(Effect.sync(() => {
            stdin.on('data', handler);
            if (stdin.isTTY)
                stdin.setRawMode(true);
            stdin.resume();
        }), () => Effect.sync(() => {
            stdin.off('data', handler);
            if (stdin.isTTY)
                stdin.setRawMode(false);
        }));
        yield* Stream.runForEach(channel.output, (bytes) => Effect.sync(() => stdout.write(Buffer.from(bytes))));
    })));
}
function emit(value, human, io, json) {
    io.out(json ? JSON.stringify(value ?? null) : human);
}
function formatError(error) {
    if (error instanceof DeviceLoginUnavailable) {
        return { code: error.code, message: error.message, status: error.status };
    }
    if (error instanceof DeviceAuthError) {
        return { code: error.code, message: error.message, status: error.status };
    }
    if (error instanceof CredentialOriginError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof CredentialStoreUnavailable) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof CredentialLockError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error && 'code' in error && error.code === 'unsafe_local_path') {
        return { code: 'unsafe_local_path', message: error.message };
    }
    if (error instanceof UsageError)
        return { code: error.code, message: error.message };
    if (error instanceof NotSupported) {
        return {
            code: 'not_supported',
            message: error.detail,
            status: error.status,
            request_id: error.problem?.requestId
        };
    }
    if (error instanceof ResponseError) {
        const retry = error.idempotencyKey
            ? ` Retry the unchanged operation with --idempotency-key ${error.idempotencyKey}.`
            : '';
        return {
            code: error.problem?.title ?? 'response_error',
            message: `${error.problem?.detail ?? `API request failed (${error.status}).`}${retry}`,
            status: error.status,
            request_id: error.problem?.requestId ?? error.metadata?.requestId,
            idempotency_key: error.idempotencyKey
        };
    }
    if (error instanceof RequestError) {
        return {
            code: 'request_error',
            message: `Request failed: ${error.method} ${error.path}.${error.idempotencyKey
                ? ` Retry the unchanged operation with --idempotency-key ${error.idempotencyKey}.`
                : ''}`,
            idempotency_key: error.idempotencyKey
        };
    }
    return { code: 'error', message: error instanceof Error ? error.message : String(error) };
}
function flagString(flags, name) {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
}
function validTarget(value) {
    return value === 'local' || value === 'self-hosted' || value === 'cloud';
}
const HELP = `bc — Boring Computers command line

Usage:
	  bc machines create [--template NAME | --template-id UUID] [--region REGION] [--size small|medium|large]
  bc machines list [--cursor CURSOR] [--limit N]
  bc machines get ID
  bc machines exec ID COMMAND [--timeout SECONDS]
	bc machines upload ID LOCAL_PATH [--name REMOTE_NAME] [--max-bytes N] [--timeout-ms N]
	bc machines download ID REMOTE_PATH LOCAL_PATH [--max-bytes N] [--timeout-ms N]
  bc machines tty ID
  bc machines stop ID
  bc machines fork ID [--count N]
  bc templates list [--project ID]
  bc templates delete TEMPLATE_ID [--project ID]
  bc config set-key KEY [--url URL]
  bc config set [--project ID] [--region REGION] [--url URL] [--target MODE]
  bc login [--scopes SCOPE,...] [--no-browser]
  bc logout

Global flags: --json, --project ID, --region REGION, --url URL, --target MODE
Environment: NEHEMIAH_API_KEY, NEHEMIAH_PROJECT, NEHEMIAH_REGION, NEHEMIAH_URL`;
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    process.exitCode = await runCli(process.argv.slice(2));
}
//# sourceMappingURL=index.js.map
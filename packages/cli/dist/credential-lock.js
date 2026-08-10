import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
export class CredentialLockError extends Error {
    code = 'credential_lock_unavailable';
    constructor() {
        super('Another CLI process is updating this device login. Wait for it to finish, then retry.');
    }
}
const maximumWaitMs = 30_000;
const retryDelayMs = 25;
const maximumOwnerBytes = 512;
const initializationGraceMs = 5_000;
const maximumLeaseAgeMs = 5 * 60_000;
const heartbeatIntervalMs = 5_000;
/** Serializes refresh-token rotation across CLI processes without storing a secret on disk. */
export async function withCredentialLock(configFile, account, operation) {
    const parent = dirname(configFile);
    const lockDirectory = join(parent, `.credential-${account}.lock`);
    const reaperDirectory = `${lockDirectory}.reaper`;
    const owner = {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        createdAt: Date.now()
    };
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + maximumWaitMs;
    for (;;) {
        try {
            await mkdir(lockDirectory, { mode: 0o700 });
            try {
                await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify(owner), {
                    encoding: 'utf8',
                    flag: 'wx',
                    mode: 0o600
                });
            }
            catch (error) {
                await rm(lockDirectory, { recursive: true, force: true });
                throw error;
            }
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            await reapDeadOwner(lockDirectory, reaperDirectory);
            if (Date.now() >= deadline)
                throw new CredentialLockError();
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
    }
    const heartbeat = setInterval(() => {
        const timestamp = new Date();
        void utimes(lockDirectory, timestamp, timestamp).catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref();
    try {
        return await operation();
    }
    finally {
        clearInterval(heartbeat);
        const current = await readOwner(lockDirectory);
        if (current?.token === owner.token && current.pid === owner.pid) {
            await rm(lockDirectory, { recursive: true, force: true });
        }
    }
}
async function reapDeadOwner(lockDirectory, reaperDirectory) {
    await removeAbandonedDirectory(reaperDirectory);
    let ownsReaper = false;
    try {
        await mkdir(reaperDirectory, { mode: 0o700 });
        ownsReaper = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        return;
    }
    try {
        const owner = await readOwner(lockDirectory);
        if ((owner &&
            (!processExists(owner.pid) ||
                (await directoryOlderThan(lockDirectory, maximumLeaseAgeMs)))) ||
            (!owner && (await directoryOlderThan(lockDirectory, initializationGraceMs)))) {
            await rm(lockDirectory, { recursive: true, force: true });
        }
    }
    finally {
        if (ownsReaper)
            await rm(reaperDirectory, { recursive: true, force: true });
    }
}
async function readOwner(lockDirectory) {
    const path = join(lockDirectory, 'owner.json');
    try {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumOwnerBytes)
            return undefined;
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value.version === 1 &&
            Number.isSafeInteger(value.pid) &&
            Number(value.pid) > 0 &&
            typeof value.token === 'string' &&
            /^[0-9a-f-]{36}$/i.test(value.token) &&
            Number.isSafeInteger(value.createdAt) &&
            Number(value.createdAt) > 0
            ? {
                version: 1,
                pid: Number(value.pid),
                token: value.token,
                createdAt: Number(value.createdAt)
            }
            : undefined;
    }
    catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}
async function removeAbandonedDirectory(path) {
    if (await directoryOlderThan(path, initializationGraceMs)) {
        await rm(path, { recursive: true, force: true });
    }
}
async function directoryOlderThan(path, milliseconds) {
    try {
        const metadata = await stat(path);
        return metadata.isDirectory() && Date.now() - metadata.mtimeMs > milliseconds;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
//# sourceMappingURL=credential-lock.js.map
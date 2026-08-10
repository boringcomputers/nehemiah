import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { MAX_FILE_TRANSFER_BYTES } from 'nehemiah-sdk';
export class UnsafeLocalPath extends Error {
    code = 'unsafe_local_path';
}
const absolutePath = (value) => {
    if (!value || value.includes('\0'))
        throw new UnsafeLocalPath('A valid local path is required.');
    return resolve(value);
};
/** Read one stable regular file without following a final-component symlink. */
export async function readBoundedLocalFile(path, maximumBytes = MAX_FILE_TRANSFER_BYTES) {
    const absolute = absolutePath(path);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new UnsafeLocalPath('The upload source must be a regular file, not a symlink.');
    }
    if (before.size > maximumBytes) {
        throw new UnsafeLocalPath(`The upload source exceeds ${maximumBytes} bytes.`);
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.size > maximumBytes) {
            throw new UnsafeLocalPath('The upload source changed while it was being opened.');
        }
        // Allocate at most one byte beyond the observed size. That byte detects a
        // concurrently growing source without allowing readFile to allocate from
        // an attacker-controlled new size.
        const data = new Uint8Array(opened.size + 1);
        let bytesRead = 0;
        while (bytesRead < data.byteLength) {
            const read = await handle.read(data, bytesRead, data.byteLength - bytesRead, bytesRead);
            if (read.bytesRead === 0)
                break;
            bytesRead += read.bytesRead;
        }
        const after = await handle.stat();
        if (bytesRead !== opened.size ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            bytesRead > maximumBytes) {
            throw new UnsafeLocalPath('The upload source changed while it was being read.');
        }
        return data.slice(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
/** Atomically replace one explicit destination with a user-only regular file. */
export async function writePrivateAtomic(path, data) {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_FILE_TRANSFER_BYTES) {
        throw new UnsafeLocalPath('The download exceeds the local file bound.');
    }
    const absolute = absolutePath(path);
    const requestedDirectory = dirname(absolute);
    const directory = await realpath(requestedDirectory);
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory()) {
        throw new UnsafeLocalPath('The download destination directory does not exist.');
    }
    const name = basename(absolute);
    const destination = join(directory, name);
    try {
        const existing = await lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new UnsafeLocalPath('The download destination must be a regular file or not exist.');
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let renamed = false;
    try {
        await handle.writeFile(data);
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        await rename(temporary, destination);
        renamed = true;
        const directoryHandle = await open(directory, 'r');
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
        return destination;
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        if (!renamed)
            await unlink(temporary).catch(() => undefined);
        throw error;
    }
}
//# sourceMappingURL=files.js.map
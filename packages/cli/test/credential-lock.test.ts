import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withCredentialLock } from '../src/credential-lock.js';

const account = '44444444-4444-4444-8444-444444444444';

const pathsFor = (configFile: string) => {
	const lock = join(dirname(configFile), `.credential-${account}.lock`);
	return { lock, reaper: `${lock}.reaper` };
};

describe('credential refresh lock', () => {
	it('recovers old empty lock and reaper directories left by a crashed process', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-credential-lock-crash-'));
		const configFile = join(directory, 'config.json');
		const { lock, reaper } = pathsFor(configFile);
		await mkdir(lock, { mode: 0o700 });
		await mkdir(reaper, { mode: 0o700 });
		const old = new Date(Date.now() - 10_000);
		await utimes(lock, old, old);
		await utimes(reaper, old, old);

		let entered = false;
		await withCredentialLock(configFile, account, async () => {
			entered = true;
		});

		expect(entered).toBe(true);
		await expect(rm(lock)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('does not steal a fresh lock while its owner file is being initialized', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nehemiah-credential-lock-init-'));
		const configFile = join(directory, 'config.json');
		const { lock } = pathsFor(configFile);
		await mkdir(lock, { mode: 0o700 });
		let entered = false;
		const contender = withCredentialLock(configFile, account, async () => {
			entered = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(entered).toBe(false);
		await writeFile(
			join(lock, 'owner.json'),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				token: '11111111-1111-4111-8111-111111111111',
				createdAt: Date.now()
			}),
			{ mode: 0o600 }
		);
		await rm(lock, { recursive: true });
		await contender;
		expect(entered).toBe(true);
	});
});

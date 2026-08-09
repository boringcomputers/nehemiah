// Dev launcher. If NEHEMIAH_TUNNEL (an SSH host) is set in apps/web/.env, opens an
// SSH tunnel to a remote nehemiahd first, then runs `vite dev`, and closes the
// tunnel on exit. With no NEHEMIAH_TUNNEL set (e.g. a fresh fork), it just runs
// vite — so `npm run dev` is one command either way.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

function readEnv(path) {
	const out = {};
	try {
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
			if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {
		/* no .env — fine */
	}
	return out;
}

const env = { ...readEnv(envPath), ...process.env };
const tunnelHost = env.NEHEMIAH_TUNNEL;
const url = env.NEHEMIAH_URL || '';

let tunnel = null;
if (tunnelHost && url) {
	let localPort = '8080';
	try {
		localPort = new URL(url).port || '8080';
	} catch {
		/* keep default */
	}
	const remote = env.NEHEMIAH_TUNNEL_REMOTE || 'localhost:8080';
	console.log(`\x1b[2m[dev] ssh tunnel localhost:${localPort} -> ${tunnelHost}:${remote}\x1b[0m`);
	tunnel = spawn(
		'ssh',
		[
			'-N',
			'-o',
			'ExitOnForwardFailure=yes',
			'-o',
			'ServerAliveInterval=30',
			'-L',
			`${localPort}:${remote}`,
			tunnelHost
		],
		{ stdio: ['ignore', 'ignore', 'inherit'] }
	);
	tunnel.on('exit', (code) => {
		if (code) {
			console.log(
				`\x1b[2m[dev] tunnel exited (code ${code}) — the port may already be forwarded; continuing\x1b[0m`
			);
		}
	});
	tunnel.on('error', (e) =>
		console.log(`\x1b[2m[dev] tunnel error: ${e.message} — continuing\x1b[0m`)
	);
}

const vite = spawn('vite', ['dev'], { stdio: 'inherit', shell: true });

function shutdown(code = 0) {
	try {
		tunnel?.kill();
	} catch {
		/* ignore */
	}
	try {
		vite?.kill();
	} catch {
		/* ignore */
	}
	process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
vite.on('exit', (code) => shutdown(code ?? 0));

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { regressions, summarize } from './stats.mjs';

const rawBaseUrl = process.env.NEHEMIAH_URL || '';
const apiKey = process.env.NEHEMIAH_API_KEY;
const project = process.env.NEHEMIAH_PROJECT;
const iterations = Number(process.env.NEHEMIAH_BENCH_ITERATIONS || 5);
const batchSize = Number(process.env.NEHEMIAH_BENCH_FORK_BATCH_SIZE || 4);
const headlessTemplate = process.env.NEHEMIAH_BENCH_TEMPLATE || 'python';
const displayTemplate = process.env.NEHEMIAH_BENCH_DISPLAY_TEMPLATE || 'desktop';
const restoreTemplateId = process.env.NEHEMIAH_BENCH_RESTORE_TEMPLATE_ID;
const skipDisplay = process.env.NEHEMIAH_BENCH_SKIP_DISPLAY === '1';
const requireComplete = process.env.NEHEMIAH_BENCH_REQUIRE_COMPLETE === '1';

if (!rawBaseUrl || !apiKey || !project) {
	throw new Error('NEHEMIAH_URL, NEHEMIAH_API_KEY, and NEHEMIAH_PROJECT are required');
}
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) {
	throw new Error('NEHEMIAH_BENCH_ITERATIONS must be 1-100');
}
if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 8) {
	throw new Error('NEHEMIAH_BENCH_FORK_BATCH_SIZE must be 2-8');
}
let base;
try {
	base = new URL(rawBaseUrl);
} catch {
	throw new Error('NEHEMIAH_URL must be an absolute HTTP(S) origin');
}
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(base.hostname);
if (
	!['http:', 'https:'].includes(base.protocol) ||
	base.username ||
	base.password ||
	(base.pathname !== '/' && base.pathname !== '') ||
	base.search ||
	base.hash ||
	(base.protocol !== 'https:' && !loopback)
) {
	throw new Error('NEHEMIAH_URL must be an HTTPS origin (HTTP is allowed only on loopback)');
}
const baseUrl = base.origin;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class ApiError extends Error {
	constructor(status, method, path) {
		super(`${method} ${path} returned ${status}`);
		this.status = status;
	}
}

const requestDetailed = async (path, init = {}) => {
	const { timeoutMs = 35_000, ...fetchInit } = init;
	const response = await fetch(`${baseUrl}${path}`, {
		...fetchInit,
		signal: fetchInit.signal || AbortSignal.timeout(timeoutMs),
		redirect: 'error',
		headers: {
			authorization: `Bearer ${apiKey}`,
			...(fetchInit.body === undefined ? {} : { 'content-type': 'application/json' }),
			...fetchInit.headers
		}
	});
	const text = await response.text();
	let value;
	if (text) {
		try {
			value = JSON.parse(text);
		} catch {
			value = text;
		}
	}
	if (!response.ok) throw new ApiError(response.status, fetchInit.method || 'GET', path);
	return { status: response.status, headers: response.headers, value };
};

const request = async (path, init = {}) => (await requestDetailed(path, init)).value;

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const measurements = new Map();
const measurement = (name) => {
	if (!measurements.has(name)) {
		measurements.set(name, { values: [], attempts: 0, failures: 0, timeouts: 0 });
	}
	return measurements.get(name);
};

const timed = async (name, operation) => {
	const result = measurement(name);
	result.attempts += 1;
	const started = performance.now();
	try {
		const value = await operation();
		result.values.push(performance.now() - started);
		return { ok: true, value };
	} catch (error) {
		result.failures += 1;
		if (error?.name === 'AbortError' || error?.name === 'TimeoutError') result.timeouts += 1;
		return { ok: false, error };
	}
};

const waitReady = async (id, deadline = Date.now() + 120_000) => {
	while (Date.now() < deadline) {
		const machine = await request(`/v1/machines/${encodeURIComponent(id)}`);
		if (machine?.ready === true) return machine;
		if (['failed', 'lost', 'stopped'].includes(machine?.state)) {
			throw new Error('machine entered a terminal state before readiness');
		}
		await delay(250);
	}
	throw new DOMException('machine did not become ready', 'TimeoutError');
};

const createMachine = async ({ template, templateId, vcpus, memoryMb, diskMb }) =>
	request('/v1/machines', {
		method: 'POST',
		headers: { 'idempotency-key': `benchmark-create-${randomUUID()}` },
		body: JSON.stringify({
			project_id: project,
			...(templateId ? { template_id: templateId } : { template }),
			vcpus,
			memory_mb: memoryMb,
			disk_mb: diskMb,
			ttl_seconds: 900,
			network_policy: { mode: 'off' }
		}),
		timeoutMs: 45_000
	});

const destroyMachine = async (id) => {
	await request(`/v1/machines/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		timeoutMs: 45_000
	});
};

const exec = async (id, command, timeoutSeconds = 30) => {
	const execution = await request(`/v1/machines/${encodeURIComponent(id)}/exec`, {
		method: 'POST',
		body: JSON.stringify({ command, timeout_seconds: timeoutSeconds }),
		timeoutMs: (timeoutSeconds + 10) * 1_000
	});
	assert(execution?.exit_code === 0, 'guest command failed');
	return execution;
};

const forkMachines = async (sourceId, count) => {
	const key = `benchmark-fork-${randomUUID()}`;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const response = await requestDetailed(`/v1/machines/${encodeURIComponent(sourceId)}/fork`, {
			method: 'POST',
			headers: { 'idempotency-key': key },
			body: JSON.stringify({ count }),
			timeoutMs: 45_000
		});
		if (response.status === 202) {
			assert(response.value?.operation?.idempotency_key === key, 'fork recovery identity changed');
			await delay(250);
			continue;
		}
		const children = count === 1 ? [response.value] : response.value?.machines;
		assert(
			Array.isArray(children) && children.length === count,
			'fork returned an incomplete batch'
		);
		assert(
			children.every((child) => child?.ready === true),
			'fork returned before all children were ready'
		);
		return children;
	}
	throw new DOMException('fork did not become ready', 'TimeoutError');
};

const session = (id, capabilities, port) =>
	request(`/v1/machines/${encodeURIComponent(id)}/sessions`, {
		method: 'POST',
		body: JSON.stringify({ capabilities, ...(port ? { port } : {}), ttl_seconds: 120 })
	});

const socketUrl = (issued, id, capability) => {
	const url = new URL(issued.gateway_url);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/v1/machines/${encodeURIComponent(id)}/${capability}`;
	url.search = '';
	url.hash = '';
	assert(!url.href.includes(issued.token), 'capability leaked into WebSocket URL');
	return url;
};

const openSocket = async (issued, id, capability) => {
	assert(typeof WebSocket === 'function', 'Node WebSocket support is required');
	const socket = new WebSocket(
		socketUrl(issued, id, capability),
		`nehemiah.capability.${issued.token}`
	);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.close();
			reject(new DOMException('WebSocket setup timed out', 'TimeoutError'));
		}, 15_000);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener('open', opened);
			socket.removeEventListener('error', failed);
		};
		const opened = () => {
			cleanup();
			resolve();
		};
		const failed = () => {
			cleanup();
			reject(new Error('WebSocket setup failed'));
		};
		socket.addEventListener('open', opened, { once: true });
		socket.addEventListener('error', failed, { once: true });
	});
	return socket;
};

const closeSocket = async (socket) => {
	if (!socket || socket.readyState === WebSocket.CLOSED) return;
	const closed = new Promise((resolve) =>
		socket.addEventListener('close', resolve, { once: true })
	);
	socket.close(1000, 'benchmark complete');
	await Promise.race([closed, delay(5_000)]);
};

const measureSocket = async (name, machineId, capability) => {
	let socket;
	const result = await timed(name, async () => {
		const issued = await session(machineId, [capability]);
		socket = await openSocket(issued, machineId, capability);
	});
	await closeSocket(socket);
	return result;
};

const measurePreview = async (machineId) => {
	return timed('preview_gateway_roundtrip_ms', async () => {
		await exec(
			machineId,
			'node -e \'require("http").createServer((_,r)=>r.end("nehemiah-benchmark-preview")).listen(3000,"0.0.0.0")\' >/tmp/nehemiah-benchmark-preview.log 2>&1 &'
		);
		const issued = await session(machineId, ['preview'], 3000);
		const preview = new URL(issued.preview_url);
		assert(preview.hash.startsWith('#token='), 'preview URL omitted fragment capability');
		assert(!preview.search, 'preview capability leaked into query parameters');
		const exchange = await fetch(new URL('/v1/capability/exchange', preview.origin), {
			method: 'POST',
			redirect: 'error',
			headers: { authorization: `Bearer ${issued.token}` },
			signal: AbortSignal.timeout(15_000)
		});
		assert(exchange.status === 204, 'preview capability exchange failed');
		const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
		assert(cookie, 'preview capability exchange omitted its cookie');
		preview.hash = '';
		const response = await fetch(preview, {
			redirect: 'error',
			headers: { cookie },
			signal: AbortSignal.timeout(15_000)
		});
		assert(response.ok, 'preview gateway request failed');
		assert((await response.text()) === 'nehemiah-benchmark-preview', 'preview body changed');
	});
};

const requiredMetrics = [
	'cold_boot_to_ready_ms',
	'first_exec_ms',
	'cpu_sha256_roundtrip_ms',
	'sequential_disk_fsync_roundtrip_ms',
	'random_disk_fsync_roundtrip_ms',
	'single_fork_all_ready_ms',
	'batch_fork_all_ready_ms',
	'tty_setup_ms',
	'cleanup_ms'
];
if (!skipDisplay)
	requiredMetrics.push('desktop_boot_to_ready_ms', 'vnc_setup_ms', 'preview_gateway_roundtrip_ms');
if (restoreTemplateId) requiredMetrics.push('snapshot_restore_to_ready_ms');

for (let index = 0; index < iterations; index += 1) {
	let machine;
	let display;
	let restored;
	const forked = [];
	try {
		const created = await timed('cold_boot_to_ready_ms', async () => {
			const candidate = await createMachine({
				template: headlessTemplate,
				vcpus: 1,
				memoryMb: 512,
				diskMb: 5_120
			});
			machine = candidate;
			machine = await waitReady(candidate.id);
			return machine;
		});
		if (!created.ok) continue;

		await timed('first_exec_ms', () => exec(machine.id, 'printf nehemiah-benchmark', 10));
		await timed('cpu_sha256_roundtrip_ms', () =>
			exec(
				machine.id,
				'node -e \'const c=require("crypto"),b=Buffer.alloc(1048576,7);for(let i=0;i<128;i++)c.createHash("sha256").update(b).digest()\'',
				30
			)
		);
		await timed('sequential_disk_fsync_roundtrip_ms', () =>
			exec(
				machine.id,
				'dd if=/dev/zero of=/tmp/nehemiah-benchmark.bin bs=1M count=64 conv=fsync status=none && rm -f /tmp/nehemiah-benchmark.bin',
				60
			)
		);
		await timed('random_disk_fsync_roundtrip_ms', () =>
			exec(
				machine.id,
				'node -e \'const f=require("fs"),p="/tmp/nehemiah-random-disk.bin",b=Buffer.alloc(4096,1),h=f.openSync(p,"w+");f.ftruncateSync(h,67108864);for(let i=0;i<4096;i++)f.writeSync(h,b,0,b.length,((i*8191)%16384)*4096);f.fsyncSync(h);f.closeSync(h);f.unlinkSync(p)\'',
				60
			)
		);
		await measureSocket('tty_setup_ms', machine.id, 'tty');

		const single = await timed('single_fork_all_ready_ms', () => forkMachines(machine.id, 1));
		if (single.ok) forked.push(...single.value);
		const batch = await timed('batch_fork_all_ready_ms', () => forkMachines(machine.id, batchSize));
		if (batch.ok) forked.push(...batch.value);

		if (restoreTemplateId) {
			const restore = await timed('snapshot_restore_to_ready_ms', async () => {
				const candidate = await createMachine({
					templateId: restoreTemplateId,
					vcpus: 1,
					memoryMb: 512,
					diskMb: 5_120
				});
				restored = candidate;
				restored = await waitReady(candidate.id);
				return restored;
			});
			if (!restore.ok) restored = undefined;
		}

		if (!skipDisplay) {
			const desktop = await timed('desktop_boot_to_ready_ms', async () => {
				const candidate = await createMachine({
					template: displayTemplate,
					vcpus: 2,
					memoryMb: 2_560,
					diskMb: 5_120
				});
				display = candidate;
				display = await waitReady(candidate.id);
				return display;
			});
			if (desktop.ok) {
				await measureSocket('vnc_setup_ms', display.id, 'vnc');
				await measurePreview(display.id);
			}
		}
	} finally {
		for (const child of forked) await destroyMachine(child.id).catch(() => undefined);
		if (restored?.id) await destroyMachine(restored.id).catch(() => undefined);
		if (display?.id) await destroyMachine(display.id).catch(() => undefined);
		if (machine?.id) {
			await timed('cleanup_ms', () => destroyMachine(machine.id));
		}
	}
}

const metrics = Object.fromEntries(
	[...measurements.entries()].map(([name, result]) => [
		name,
		{
			...(result.values.length ? summarize(result.values) : { samples: 0 }),
			attempts: result.attempts,
			failures: result.failures,
			timeouts: result.timeouts
		}
	])
);
const missing = requiredMetrics.filter(
	(name) => !metrics[name] || metrics[name].samples !== iterations
);
const failures = Object.entries(metrics)
	.filter(([, summary]) => summary.failures > 0)
	.map(([metric, summary]) => ({ metric, failures: summary.failures, timeouts: summary.timeouts }));
const report = {
	schema_version: 2,
	measured_at: new Date().toISOString(),
	target: base.host,
	iterations,
	cohort: {
		headless_template: headlessTemplate,
		display_template: skipDisplay ? null : displayTemplate,
		restore_template_id: restoreTemplateId || null,
		fork_batch_size: batchSize,
		network_policy: 'off',
		host_type: process.env.NEHEMIAH_BENCH_HOST_TYPE || null,
		image_digest: process.env.NEHEMIAH_BENCH_IMAGE_DIGEST || null,
		build_commit: process.env.NEHEMIAH_BENCH_COMMIT || null
	},
	metrics,
	missing_required_samples: missing,
	failures,
	limitations: [
		...(restoreTemplateId ? [] : ['snapshot restore requires NEHEMIAH_BENCH_RESTORE_TEMPLATE_ID']),
		'managed egress is hard-disabled; DNS and HTTPS egress are not measured by this release cohort',
		'preview overhead requires a separate trusted private-host baseline and is reported as gateway round trip only',
		'guest CPU and disk probes include the bounded exec transport round trip'
	]
};
const output = process.env.NEHEMIAH_BENCH_OUTPUT || 'nehemiah-benchmark.json';
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (process.env.NEHEMIAH_BENCH_BASELINE) {
	const baseline = JSON.parse(await readFile(process.env.NEHEMIAH_BENCH_BASELINE, 'utf8'));
	const regressionFailures = regressions(
		metrics,
		baseline.metrics,
		Number(process.env.NEHEMIAH_BENCH_MAX_REGRESSION || 0.15)
	);
	if (regressionFailures.length) {
		process.stderr.write(`benchmark regressions: ${JSON.stringify(regressionFailures, null, 2)}\n`);
		process.exitCode = 1;
	}
}
if (failures.length || (requireComplete && missing.length)) process.exitCode = 1;

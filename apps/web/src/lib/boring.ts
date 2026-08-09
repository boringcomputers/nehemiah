import { env } from '$env/dynamic/public';

// In production, set PUBLIC_NEHEMIAH_URL to your own nehemiahd endpoint so the
// browser talks to it directly. In dev it's unset and requests go through the
// Vite `/boring` proxy (default target http://localhost:8080).
const PUB = env.PUBLIC_NEHEMIAH_URL ?? env.PUBLIC_BORING_URL ?? '';

/** Base for REST calls: the public endpoint in prod, the `/boring` proxy in dev. */
export const apiBase = PUB || '/boring';

/** Build a ws(s):// URL for a nehemiahd WebSocket path (e.g. /v1/machines/ID/tty). */
export function wsUrl(path: string): string {
	if (PUB) return PUB.replace(/^http/, 'ws') + path;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.host}/boring${path}`;
}

/** Create a persistent volume; returns its id. */
export async function createVolume(ttlSeconds = 604800): Promise<{ id: string }> {
	const res = await fetch(`${apiBase}/v1/volumes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ttl_seconds: ttlSeconds })
	});
	if (!res.ok) throw new Error('storage is unavailable right now');
	return (await res.json()) as { id: string };
}

/** Save a machine's /root into a volume. */
export async function saveMachine(id: string, volume: string): Promise<void> {
	const res = await fetch(
		`${apiBase}/v1/machines/${id}/save?volume=${encodeURIComponent(volume)}`,
		{
			method: 'POST'
		}
	);
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		throw new Error(j.error ?? 'save failed');
	}
}

/** Reset a machine's TTL ("+5 min"). Returns the machine with its new expiry. */
export async function extendMachine(id: string, ttlSeconds: number): Promise<Machine> {
	const res = await fetch(`${apiBase}/v1/machines/${id}/extend`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ttl_seconds: ttlSeconds })
	});
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		throw new Error(j.error ?? `extend failed (${res.status})`);
	}
	return (await res.json()) as Machine;
}

/** Freeze a machine's current state as a named template (boots in ms later). */
export async function publishMachine(
	id: string,
	name: string
): Promise<{ name: string; size_mb?: number }> {
	const res = await fetch(`${apiBase}/v1/machines/${id}/publish`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name })
	});
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		throw new Error(j.error ?? `publish failed (${res.status})`);
	}
	return (await res.json()) as { name: string; size_mb?: number };
}

/** Fork a running machine: clones its live state into a new machine. */
export async function branchMachine(id: string): Promise<Machine> {
	const res = await fetch(`${apiBase}/v1/machines/${id}/branch`, { method: 'POST' });
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		throw new Error(j.error ?? `fork failed (${res.status})`);
	}
	return (await res.json()) as Machine;
}

/**
 * Browser-openable URL for a port running inside a machine, reverse-proxied by
 * nehemiahd. Path-based (not a subdomain), so it works over the dev tunnel and on
 * public deployments without wildcard DNS.
 */
export function previewUrl(id: string, port: number): string {
	return `${apiBase}/v1/machines/${id}/web/${port}/`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a machine, retrying transient failures (network errors, timeouts, 5xx)
 * up to a few times with backoff. Client errors (401/404/429) fail fast with a
 * friendly message. Returns the parsed machine, or throws an Error whose message
 * is safe to show a visitor.
 */
export async function createMachine(
	template: string,
	ttlSeconds: number,
	net = false,
	volume?: string,
	persistent = false
): Promise<Machine> {
	const attempts = 3;
	let last = 'the datacenter is busy — try again in a moment';
	for (let i = 0; i < attempts; i++) {
		let res: Response | null = null;
		try {
			const ctrl = new AbortController();
			// A connected machine cold-boots (~a few seconds); restoring a volume
			// adds more, so allow longer still.
			const timer = setTimeout(() => ctrl.abort(), volume ? 30000 : net ? 20000 : 12000);
			try {
				res = await fetch(`${apiBase}/v1/machines`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ template, ttl_seconds: ttlSeconds, net, volume, persistent }),
					signal: ctrl.signal
				});
			} finally {
				clearTimeout(timer);
			}
		} catch {
			last = "couldn't reach the datacenter"; // network/timeout → retryable
		}
		if (res) {
			if (res.ok) return (await res.json()) as Machine;
			if (res.status === 429)
				throw new Error('a lot of people are trying this right now — wait a few seconds and retry');
			if (res.status === 401) throw new Error('the datacenter rejected the request');
			if (res.status < 500) throw new Error(`the datacenter returned ${res.status}`);
			last = `the datacenter is busy (${res.status})`; // 5xx → retryable
		}
		if (i < attempts - 1) await sleep(500 * (i + 1));
	}
	throw new Error(last);
}

export type Machine = {
	id: string;
	mode: string;
	boot_ms: number;
	template?: string;
	expires_at?: string;
	display?: boolean;
	persistent?: boolean;
	parent?: string;
};

/** List every running machine. Returns [] on any error. */
export async function listMachines(): Promise<Machine[]> {
	try {
		const res = await fetch(`${apiBase}/v1/machines`);
		if (!res.ok) return [];
		const j = await res.json();
		return Array.isArray(j?.machines) ? (j.machines as Machine[]) : [];
	} catch {
		return [];
	}
}

/** Destroy a machine by id (204 or 404 are both fine — it's gone either way). */
export async function destroyMachine(id: string): Promise<void> {
	const res = await fetch(`${apiBase}/v1/machines/${encodeURIComponent(id)}`, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) throw new Error(`couldn't stop ${id} (${res.status})`);
}

/** Fetch an existing machine by id (for reconnecting to a shared session). */
export async function getMachine(id: string): Promise<Machine> {
	const res = await fetch(`${apiBase}/v1/machines/${encodeURIComponent(id)}`);
	if (res.status === 404) throw new Error('this computer has expired');
	if (!res.ok) throw new Error(`the datacenter returned ${res.status}`);
	return (await res.json()) as Machine;
}

/** How many computers are running right now (from /healthz). 0 on any error. */
export async function fleetCount(): Promise<number> {
	try {
		const res = await fetch(`${apiBase}/healthz`);
		const j = await res.json();
		return typeof j?.machines === 'number' ? j.machines : 0;
	} catch {
		return 0;
	}
}

/**
 * Edge Worker in front of the Cloudflare Containers that run the managed
 * cloud (apps/web/alchemy.run.ts, `prod` stage):
 *
 * - `api.<site>`              → the control plane (apps/nehemiah)
 * - `gateway.<site>`          → the public gateway (gateway/)
 * - `*.<preview base domain>` → the public gateway (machine previews)
 *
 * Requests are forwarded byte-for-byte, WebSocket upgrades included. Cloudflare
 * Access guards `api.<site>/internal/*` at the edge before this code runs, so
 * host and gateway traffic to internal routes always carries a service token.
 *
 * Client identity. Inside a container the TCP peer is always this Worker's
 * runtime, so the services cannot learn a caller's address from the socket.
 * The gateway already trusts `CF-Connecting-IP` from a configured edge. The
 * control plane trusts only an address signed with the gateway token
 * (apps/nehemiah/src/http/client-identity.ts), so for `api.<site>` this Worker
 * signs `CF-Connecting-IP` the way the gateway does when it proxies. A request
 * that already carries a valid, fresh signature (the gateway calling the
 * control plane through this same edge) is passed through unchanged, so the
 * end user's address, not the gateway container's egress, reaches admission.
 *
 * Each class is a Durable Object that owns one container instance. Both are
 * addressed by a fixed name, so the beta runs exactly one control plane and
 * one gateway; host heartbeats and open streams keep them awake.
 */
import { Container, getContainer } from '@cloudflare/containers';

export class ControlPlane extends Container {
	defaultPort = 8081;
	sleepAfter = '2h';
	enableInternet = true;
}

export class Gateway extends Container {
	defaultPort = 8082;
	sleepAfter = '2h';
	enableInternet = true;
}

interface Env {
	readonly CONTROL_PLANE: DurableObjectNamespace<ControlPlane>;
	readonly GATEWAY: DurableObjectNamespace<Gateway>;
	readonly API_HOSTNAME: string;
	/** The private gateway credential; also the key for signed client addresses. */
	readonly NEHEMIAH_GATEWAY_TOKEN: string;
}

const clientAddressHeader = 'x-nehemiah-client-address';
const clientTimestampHeader = 'x-nehemiah-client-timestamp';
const clientSignatureHeader = 'x-nehemiah-client-signature';
/** Matches the control plane's acceptance window for a signed timestamp. */
const signatureMaxSkewSeconds = 30;

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

const signClientAddress = async (
	token: string,
	address: string,
	timestamp: string
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(token),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const payload = `nehemiah-client-address-v1\n${timestamp}\n${address}`;
	return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
};

/** True when the request already carries a fresh signature made with our token. */
const carriesValidSignature = async (headers: Headers, token: string): Promise<boolean> => {
	const address = headers.get(clientAddressHeader)?.trim();
	const timestamp = headers.get(clientTimestampHeader)?.trim();
	const signature = headers.get(clientSignatureHeader)?.trim().toLowerCase();
	if (!address || !timestamp || !signature) return false;
	if (!/^[0-9]{1,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
	const skew = Math.abs(Math.floor(Date.now() / 1_000) - Number(timestamp));
	if (skew > signatureMaxSkewSeconds) return false;
	return constantTimeEqual(await signClientAddress(token, address, timestamp), signature);
};

/** Forward to the control plane with the caller's address signed for admission. */
const toControlPlane = async (request: Request, env: Env): Promise<Response> => {
	const headers = new Headers(request.headers);
	if (!(await carriesValidSignature(headers, env.NEHEMIAH_GATEWAY_TOKEN))) {
		headers.delete(clientAddressHeader);
		headers.delete(clientTimestampHeader);
		headers.delete(clientSignatureHeader);
		const address = request.headers.get('cf-connecting-ip')?.trim();
		if (address) {
			const timestamp = Math.floor(Date.now() / 1_000).toString();
			headers.set(clientAddressHeader, address);
			headers.set(clientTimestampHeader, timestamp);
			headers.set(
				clientSignatureHeader,
				await signClientAddress(env.NEHEMIAH_GATEWAY_TOKEN, address, timestamp)
			);
		}
	}
	return getContainer(env.CONTROL_PLANE, 'primary').fetch(new Request(request, { headers }));
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const hostname = new URL(request.url).hostname.toLowerCase();
		if (hostname === env.API_HOSTNAME) return toControlPlane(request, env);
		// The gateway reads the caller from CF-Connecting-IP itself
		// (NEHEMIAH_GATEWAY_TRUSTED_EDGE_CIDRS covers this Worker's runtime).
		return getContainer(env.GATEWAY, 'primary').fetch(request);
	}
} satisfies ExportedHandler<Env>;

import { isIP } from 'node:net';
import { Redacted } from 'effect';

/**
 * How the control plane reaches a host's internal API.
 *
 * - `overlay` dials the host's stored WireGuard address directly (ADR 0002).
 * - `cloudflare-tunnel` keeps that address as the host's identity but reaches
 *   it through the host's own Cloudflare Tunnel, published under a hostname
 *   derived from the address and guarded by a Cloudflare Access service token
 *   (ADR 0005). Nothing about how hosts are stored or validated changes.
 */
export type HostTransport =
	| { readonly kind: 'overlay'; readonly port: number }
	| {
			readonly kind: 'cloudflare-tunnel';
			/** DNS suffix hosts publish their tunnels under, e.g. `hosts.example.com`. */
			readonly domain: string;
			readonly accessClientId: string;
			readonly accessClientSecret: Redacted.Redacted<string>;
	  };

export const overlayTransport = (port = 8080): HostTransport => ({ kind: 'overlay', port });

export class HostTransportError extends Error {}

const dnsName = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** Access service-token credentials are opaque; require printable, unpadded ASCII. */
const accessCredential = /^[\x21-\x7e]{8,512}$/;

export const validateHostTransport = (transport: HostTransport): HostTransport => {
	if (transport.kind === 'overlay') {
		if (!Number.isSafeInteger(transport.port) || transport.port < 1 || transport.port > 65_535) {
			throw new HostTransportError('host port must be between 1 and 65535');
		}
		return transport;
	}
	if (
		!dnsName.test(transport.domain) ||
		!transport.domain.includes('.') ||
		transport.domain.includes('..')
	) {
		throw new HostTransportError(
			'host tunnel domain must be a DNS suffix such as hosts.example.com'
		);
	}
	if (
		!accessCredential.test(transport.accessClientId) ||
		!accessCredential.test(Redacted.value(transport.accessClientSecret))
	) {
		throw new HostTransportError('host tunnel transport requires an Access service token');
	}
	return transport;
};

/** Strip the IPv4-mapped prefix so both address families map like the gateway does. */
const unmap = (address: string): string => {
	const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return mapped ? mapped[1] : address.toLowerCase();
};

/** Expand an IPv6 address to eight zero-padded four-digit groups. */
const expandIPv6 = (address: string): string[] => {
	let value = address;
	const embedded = value.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (embedded) {
		const [, head, a, b, c, d] = embedded;
		const octets = [a, b, c, d].map(Number);
		value = `${head}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
	}
	const [left = '', right] = value.split('::');
	const head = left ? left.split(':') : [];
	const tail = right ? right.split(':') : [];
	const groups =
		right === undefined
			? head
			: [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail];
	return groups.map((group) => group.padStart(4, '0'));
};

/**
 * The DNS label a host's tunnel is published under: dotted IPv4 with dashes
 * (`10.64.0.7` → `10-64-0-7`), or the fully expanded IPv6 groups joined with
 * dashes. Identical to the gateway's `hostTunnelLabel` and to what operators
 * configure in cloudflared on the host, so the three never disagree.
 */
export const hostTunnelLabel = (address: string): string => {
	const value = unmap(address);
	const version = isIP(value);
	if (version === 4) return value.replaceAll('.', '-');
	if (version === 6) return expandIPv6(value).join('-');
	throw new HostTransportError('invalid host address');
};

/** Origin (no trailing slash) for a host's internal API under the transport. */
export const hostBaseUrl = (address: string, transport: HostTransport): string => {
	const version = isIP(address);
	if (version === 0) throw new HostTransportError('invalid host address');
	if (transport.kind === 'overlay') {
		return `http://${version === 6 ? `[${address}]` : address}:${transport.port}`;
	}
	return `https://${hostTunnelLabel(address)}.${transport.domain}`;
};

/** Extra request headers the transport needs; empty for the overlay. */
export const hostTransportHeaders = (transport: HostTransport): ReadonlyArray<[string, string]> =>
	transport.kind === 'cloudflare-tunnel'
		? [
				['cf-access-client-id', transport.accessClientId],
				['cf-access-client-secret', Redacted.value(transport.accessClientSecret)]
			]
		: [];

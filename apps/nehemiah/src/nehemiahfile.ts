import { parse } from 'yaml';
import { EgressPolicy, type NetworkPolicyDeclaration } from './domain/network-policy.js';

export interface Nehemiahfile {
	readonly version: 1;
	readonly image: { readonly template: string } | { readonly oci: string };
	readonly resources: {
		readonly vcpus: number;
		readonly memory_mb: number;
		readonly disk_mb: number;
	};
	readonly network: NetworkPolicyDeclaration;
	readonly ports: ReadonlyArray<number>;
	readonly setup: ReadonlyArray<string>;
	readonly persistence?: { readonly volume: string; readonly mount: string };
	readonly forkable: boolean;
	readonly readiness?: { readonly tcp_port?: number; readonly http_path?: string };
}

const object = (value: unknown, name: string): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
};

const positive = (value: unknown, name: string): number => {
	if (!Number.isSafeInteger(value) || Number(value) <= 0)
		throw new Error(`${name} must be a positive integer`);
	return Number(value);
};

const stringArray = (value: unknown, name: string): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
		throw new Error(`${name} must be a string array`);
	}
	return value;
};

export const parseNehemiahfile = (source: string): Nehemiahfile => {
	if (Buffer.byteLength(source) > 256 * 1024) throw new Error('Nehemiahfile exceeds 256 KiB');
	const root = object(parse(source), 'Nehemiahfile');
	if (root.version !== 1) throw new Error('Nehemiahfile version must be 1');
	const image = object(root.image, 'image');
	const template = typeof image.template === 'string' ? image.template : undefined;
	const oci = typeof image.oci === 'string' ? image.oci : undefined;
	if ((!template && !oci) || (template && oci))
		throw new Error('image needs exactly one template or oci');
	if (oci && !/^[a-z0-9][a-z0-9._/-]+(?:@sha256:[0-9a-f]{64}|:[A-Za-z0-9._-]+)$/.test(oci)) {
		throw new Error('OCI image reference is invalid');
	}
	const resources = object(root.resources, 'resources');
	const networkInput =
		root.network === undefined ? { mode: 'off' } : object(root.network, 'network');
	if (
		networkInput.mode !== undefined &&
		!['off', 'allowlist'].includes(String(networkInput.mode))
	) {
		throw new Error('network.mode must be off or allowlist');
	}
	const network: NetworkPolicyDeclaration = {
		mode: networkInput.mode === 'allowlist' ? 'allowlist' : 'off',
		hostnames: stringArray(networkInput.hostnames, 'network.hostnames'),
		cidrs: stringArray(networkInput.cidrs, 'network.cidrs')
	};
	const normalizedNetwork = new EgressPolicy(network).declaration;
	const ports = root.ports === undefined ? [] : (root.ports as unknown[]);
	if (
		!Array.isArray(ports) ||
		ports.some((port) => !Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535)
	) {
		throw new Error('ports must contain valid TCP ports');
	}
	const persistenceInput = root.persistence ? object(root.persistence, 'persistence') : undefined;
	const readinessInput = root.readiness ? object(root.readiness, 'readiness') : undefined;
	return {
		version: 1,
		image: template ? { template } : { oci: oci! },
		resources: {
			vcpus: positive(resources.vcpus, 'resources.vcpus'),
			memory_mb: positive(resources.memory_mb, 'resources.memory_mb'),
			disk_mb: positive(resources.disk_mb, 'resources.disk_mb')
		},
		network: normalizedNetwork,
		ports: [...new Set(ports.map(Number))],
		setup: stringArray(root.setup, 'setup'),
		persistence: persistenceInput
			? {
					volume: String(persistenceInput.volume ?? ''),
					mount: String(persistenceInput.mount ?? '')
				}
			: undefined,
		forkable: root.forkable === true,
		readiness: readinessInput
			? {
					tcp_port:
						readinessInput.tcp_port === undefined
							? undefined
							: positive(readinessInput.tcp_port, 'readiness.tcp_port'),
					http_path:
						typeof readinessInput.http_path === 'string' ? readinessInput.http_path : undefined
				}
			: undefined
	};
};

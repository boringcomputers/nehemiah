import { describe, expect, it } from 'vitest';
import { parseNehemiahfile } from '../src/nehemiahfile.js';

describe('Nehemiahfile', () => {
	it('parses a portable provider-neutral declaration', () => {
		const file = parseNehemiahfile(`
version: 1
image:
  oci: ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
resources:
  vcpus: 2
  memory_mb: 2048
  disk_mb: 10240
network:
  mode: allowlist
  hostnames: [api.github.com]
ports: [3000]
setup:
  - npm ci
forkable: true
readiness:
  tcp_port: 3000
`);
		expect(file).toMatchObject({
			version: 1,
			resources: { vcpus: 2, memory_mb: 2048 },
			network: { mode: 'allowlist', hostnames: ['api.github.com'] },
			forkable: true
		});
	});

	it('rejects ambiguous image sources and unsafe policy syntax', () => {
		expect(() =>
			parseNehemiahfile(`
version: 1
image: { template: python, oci: example/image:latest }
resources: { vcpus: 1, memory_mb: 512, disk_mb: 1024 }
`)
		).toThrow('exactly one');
		expect(() =>
			parseNehemiahfile(`
version: 1
image: { template: python }
resources: { vcpus: 1, memory_mb: 512, disk_mb: 1024 }
network: { mode: unrestricted }
`)
		).toThrow('network.mode');
	});
});

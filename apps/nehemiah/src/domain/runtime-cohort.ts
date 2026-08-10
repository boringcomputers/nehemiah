import { createHash, timingSafeEqual } from 'node:crypto';

export type RuntimeArchitecture = 'amd64' | 'arm64';

export interface RuntimeCohort {
	readonly id: string;
	readonly contractVersion: 4;
	readonly arch: RuntimeArchitecture;
	readonly kernelSha256: string;
	readonly firecrackerSha256: string;
	readonly jailerSha256: string;
	readonly pythonRootfsSha256: string;
	readonly desktopRootfsSha256: string;
}

export interface RuntimeCohortWire {
	readonly id: string;
	readonly contract_version: number;
	readonly arch: string;
	readonly kernel_sha256: string;
	readonly firecracker_sha256: string;
	readonly jailer_sha256: string;
	readonly python_rootfs_sha256: string;
	readonly desktop_rootfs_sha256: string;
}

export class InvalidRuntimeCohort extends Error {
	readonly code = 'invalid_runtime_cohort';
}

const digestPattern = /^[0-9a-f]{64}$/;
const fields = new Set([
	'id',
	'contract_version',
	'arch',
	'kernel_sha256',
	'firecracker_sha256',
	'jailer_sha256',
	'python_rootfs_sha256',
	'desktop_rootfs_sha256'
]);

export const databaseRuntimeArchitecture = (
	architecture: 'x86_64' | 'aarch64'
): RuntimeArchitecture => (architecture === 'x86_64' ? 'amd64' : 'arm64');

export const canonicalRuntimeCohort = (cohort: Omit<RuntimeCohort, 'id'>): string =>
	[
		`contract_version=${cohort.contractVersion}`,
		`arch=${cohort.arch}`,
		`python=${cohort.pythonRootfsSha256}`,
		`desktop=${cohort.desktopRootfsSha256}`,
		`kernel=${cohort.kernelSha256}`,
		`firecracker=${cohort.firecrackerSha256}`,
		`jailer=${cohort.jailerSha256}`,
		''
	].join('\n');

export const runtimeCohortId = (cohort: Omit<RuntimeCohort, 'id'>): string =>
	createHash('sha256').update(canonicalRuntimeCohort(cohort), 'ascii').digest('hex');

const equalDigest = (left: string, right: string): boolean => {
	const a = Buffer.from(left, 'ascii');
	const b = Buffer.from(right, 'ascii');
	return a.length === b.length && timingSafeEqual(a, b);
};

export const parseRuntimeCohort = (
	value: unknown,
	expectedArchitecture?: 'x86_64' | 'aarch64'
): RuntimeCohort => {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== fields.size ||
		Object.keys(value).some((key) => !fields.has(key))
	) {
		throw new InvalidRuntimeCohort('runtime_cohort must contain the exact signed cohort fields');
	}
	const input = value as Record<string, unknown>;
	const digestKeys = [
		'kernel_sha256',
		'firecracker_sha256',
		'jailer_sha256',
		'python_rootfs_sha256',
		'desktop_rootfs_sha256'
	] as const;
	if (
		input.contract_version !== 4 ||
		!['amd64', 'arm64'].includes(String(input.arch)) ||
		typeof input.id !== 'string' ||
		!digestPattern.test(input.id) ||
		digestKeys.some(
			(key) => typeof input[key] !== 'string' || !digestPattern.test(input[key] as string)
		)
	) {
		throw new InvalidRuntimeCohort('runtime_cohort contains an invalid contract, arch, or digest');
	}
	const cohortWithoutId: Omit<RuntimeCohort, 'id'> = {
		contractVersion: 4,
		arch: input.arch as RuntimeArchitecture,
		kernelSha256: input.kernel_sha256 as string,
		firecrackerSha256: input.firecracker_sha256 as string,
		jailerSha256: input.jailer_sha256 as string,
		pythonRootfsSha256: input.python_rootfs_sha256 as string,
		desktopRootfsSha256: input.desktop_rootfs_sha256 as string
	};
	if (
		expectedArchitecture &&
		cohortWithoutId.arch !== databaseRuntimeArchitecture(expectedArchitecture)
	) {
		throw new InvalidRuntimeCohort('runtime_cohort architecture does not match the host');
	}
	const expectedId = runtimeCohortId(cohortWithoutId);
	if (!equalDigest(input.id, expectedId)) {
		throw new InvalidRuntimeCohort('runtime_cohort id does not match its canonical digest set');
	}
	return { id: input.id, ...cohortWithoutId };
};

export const runtimeCohortWire = (cohort: RuntimeCohort): RuntimeCohortWire => ({
	id: cohort.id,
	contract_version: cohort.contractVersion,
	arch: cohort.arch,
	kernel_sha256: cohort.kernelSha256,
	firecracker_sha256: cohort.firecrackerSha256,
	jailer_sha256: cohort.jailerSha256,
	python_rootfs_sha256: cohort.pythonRootfsSha256,
	desktop_rootfs_sha256: cohort.desktopRootfsSha256
});

export const runtimeSourceSha256 = (
	cohort: RuntimeCohort,
	template: 'python' | 'desktop'
): string => (template === 'python' ? cohort.pythonRootfsSha256 : cohort.desktopRootfsSha256);

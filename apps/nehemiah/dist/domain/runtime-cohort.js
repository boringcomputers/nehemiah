import { createHash, timingSafeEqual } from 'node:crypto';
export class InvalidRuntimeCohort extends Error {
    code = 'invalid_runtime_cohort';
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
export const databaseRuntimeArchitecture = (architecture) => (architecture === 'x86_64' ? 'amd64' : 'arm64');
export const canonicalRuntimeCohort = (cohort) => [
    `contract_version=${cohort.contractVersion}`,
    `arch=${cohort.arch}`,
    `python=${cohort.pythonRootfsSha256}`,
    `desktop=${cohort.desktopRootfsSha256}`,
    `kernel=${cohort.kernelSha256}`,
    `firecracker=${cohort.firecrackerSha256}`,
    `jailer=${cohort.jailerSha256}`,
    ''
].join('\n');
export const runtimeCohortId = (cohort) => createHash('sha256').update(canonicalRuntimeCohort(cohort), 'ascii').digest('hex');
const equalDigest = (left, right) => {
    const a = Buffer.from(left, 'ascii');
    const b = Buffer.from(right, 'ascii');
    return a.length === b.length && timingSafeEqual(a, b);
};
export const parseRuntimeCohort = (value, expectedArchitecture) => {
    if (typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length !== fields.size ||
        Object.keys(value).some((key) => !fields.has(key))) {
        throw new InvalidRuntimeCohort('runtime_cohort must contain the exact signed cohort fields');
    }
    const input = value;
    const digestKeys = [
        'kernel_sha256',
        'firecracker_sha256',
        'jailer_sha256',
        'python_rootfs_sha256',
        'desktop_rootfs_sha256'
    ];
    if (input.contract_version !== 4 ||
        !['amd64', 'arm64'].includes(String(input.arch)) ||
        typeof input.id !== 'string' ||
        !digestPattern.test(input.id) ||
        digestKeys.some((key) => typeof input[key] !== 'string' || !digestPattern.test(input[key]))) {
        throw new InvalidRuntimeCohort('runtime_cohort contains an invalid contract, arch, or digest');
    }
    const cohortWithoutId = {
        contractVersion: 4,
        arch: input.arch,
        kernelSha256: input.kernel_sha256,
        firecrackerSha256: input.firecracker_sha256,
        jailerSha256: input.jailer_sha256,
        pythonRootfsSha256: input.python_rootfs_sha256,
        desktopRootfsSha256: input.desktop_rootfs_sha256
    };
    if (expectedArchitecture &&
        cohortWithoutId.arch !== databaseRuntimeArchitecture(expectedArchitecture)) {
        throw new InvalidRuntimeCohort('runtime_cohort architecture does not match the host');
    }
    const expectedId = runtimeCohortId(cohortWithoutId);
    if (!equalDigest(input.id, expectedId)) {
        throw new InvalidRuntimeCohort('runtime_cohort id does not match its canonical digest set');
    }
    return { id: input.id, ...cohortWithoutId };
};
export const runtimeCohortWire = (cohort) => ({
    id: cohort.id,
    contract_version: cohort.contractVersion,
    arch: cohort.arch,
    kernel_sha256: cohort.kernelSha256,
    firecracker_sha256: cohort.firecrackerSha256,
    jailer_sha256: cohort.jailerSha256,
    python_rootfs_sha256: cohort.pythonRootfsSha256,
    desktop_rootfs_sha256: cohort.desktopRootfsSha256
});
export const runtimeSourceSha256 = (cohort, template) => (template === 'python' ? cohort.pythonRootfsSha256 : cohort.desktopRootfsSha256);
//# sourceMappingURL=runtime-cohort.js.map
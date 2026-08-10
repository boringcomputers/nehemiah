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
export declare class InvalidRuntimeCohort extends Error {
    readonly code = "invalid_runtime_cohort";
}
export declare const databaseRuntimeArchitecture: (architecture: "x86_64" | "aarch64") => RuntimeArchitecture;
export declare const canonicalRuntimeCohort: (cohort: Omit<RuntimeCohort, "id">) => string;
export declare const runtimeCohortId: (cohort: Omit<RuntimeCohort, "id">) => string;
export declare const parseRuntimeCohort: (value: unknown, expectedArchitecture?: "x86_64" | "aarch64") => RuntimeCohort;
export declare const runtimeCohortWire: (cohort: RuntimeCohort) => RuntimeCohortWire;
export declare const runtimeSourceSha256: (cohort: RuntimeCohort, template: "python" | "desktop") => string;

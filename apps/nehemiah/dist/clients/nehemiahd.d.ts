import type { HostCredentialResolver } from '../domain/host-credentials.js';
import { type NetworkPolicyDeclaration } from '../domain/network-policy.js';
export interface HostMachine {
    readonly id: string;
    readonly status: string;
    readonly lease_id?: string;
    readonly lease_generation?: number;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly ready?: boolean;
    readonly started_at?: string;
    readonly ready_at?: string;
    readonly expires_at?: string;
    readonly resources?: {
        readonly vcpus: number;
        readonly memory_mb: number;
        readonly disk_mb: number;
    };
    readonly network_policy?: NetworkPolicyDeclaration;
    readonly runtime_cohort_id?: string;
    readonly source_sha256?: string;
}
export interface HostExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exit_code: number | null;
    readonly timed_out: boolean;
    readonly duration_ms: number;
}
export interface CreateOnHostRequest {
    readonly leaseId: string;
    readonly leaseGeneration?: number;
    readonly idempotencyKey: string;
    readonly template?: string;
    readonly ociReference?: string;
    readonly ttlSeconds: number;
    readonly resources: {
        readonly vcpus: number;
        readonly memoryMb: number;
        readonly diskMb: number;
    };
    readonly networkPolicy: NetworkPolicyDeclaration;
    readonly metadata: Readonly<Record<string, string>>;
    readonly runtimeCohortId?: string;
    readonly sourceSha256?: string;
}
export interface ForkOnHostChild {
    readonly leaseId: string;
    readonly leaseGeneration?: number;
    readonly expiresAt: Date;
    readonly networkPolicy: NetworkPolicyDeclaration;
    readonly resources: {
        readonly vcpus: number;
        readonly memoryMb: number;
        readonly diskMb: number;
    };
    readonly metadata: Readonly<Record<string, string>>;
    readonly runtimeCohortId?: string;
    readonly sourceSha256?: string;
}
export interface HostClient {
    create(address: string, request: CreateOnHostRequest): Promise<HostMachine>;
    get(address: string, hostMachineId: string): Promise<HostMachine | undefined>;
    destroy(address: string, hostMachineId: string, leaseId: string): Promise<void>;
    extend(address: string, hostMachineId: string, leaseId: string, idempotencyKey: string, targetExpiresAt: Date): Promise<HostMachine>;
    fork(address: string, sourceHostMachineId: string, sourceLeaseId: string, idempotencyKey: string, children: ReadonlyArray<ForkOnHostChild>): Promise<ReadonlyArray<HostMachine>>;
    exec(address: string, hostMachineId: string, leaseId: string, command: string, timeoutSeconds: number): Promise<HostExecResult>;
}
export declare class HostRequestError extends Error {
    readonly status: number | undefined;
    readonly ambiguous: boolean;
    readonly code?: string | undefined;
    constructor(status: number | undefined, message: string, ambiguous: boolean, code?: string | undefined);
}
export declare class HostForkContractError extends HostRequestError {
    readonly observed: ReadonlyArray<HostMachine>;
    constructor(message: string, observed: ReadonlyArray<HostMachine>);
}
export declare class NehemiahdClient implements HostClient {
    private readonly credentials;
    private readonly fetcher;
    private readonly requestTimeoutMs;
    private readonly hostPort;
    constructor(credentials: string | HostCredentialResolver, fetcher?: typeof fetch, requestTimeoutMs?: number, hostPort?: number);
    create(address: string, request: CreateOnHostRequest): Promise<HostMachine>;
    get(address: string, hostMachineId: string): Promise<HostMachine | undefined>;
    destroy(address: string, hostMachineId: string, leaseId: string): Promise<void>;
    extend(address: string, hostMachineId: string, leaseId: string, idempotencyKey: string, targetExpiresAt: Date): Promise<HostMachine>;
    fork(address: string, sourceHostMachineId: string, sourceLeaseId: string, idempotencyKey: string, children: ReadonlyArray<ForkOnHostChild>): Promise<ReadonlyArray<HostMachine>>;
    exec(address: string, hostMachineId: string, leaseId: string, command: string, timeoutSeconds: number): Promise<HostExecResult>;
    private request;
}

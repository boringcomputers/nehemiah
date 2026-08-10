export interface HostMachine {
    readonly id: string;
    readonly status: string;
    readonly ready?: boolean;
    readonly started_at?: string;
    readonly ready_at?: string;
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
    readonly idempotencyKey: string;
    readonly template?: string;
    readonly ociReference?: string;
    readonly ttlSeconds: number;
    readonly resources: {
        readonly vcpus: number;
        readonly memoryMb: number;
        readonly diskMb: number;
    };
    readonly metadata: Readonly<Record<string, string>>;
}
export interface HostClient {
    create(address: string, request: CreateOnHostRequest): Promise<HostMachine>;
    get(address: string, hostMachineId: string): Promise<HostMachine | undefined>;
    destroy(address: string, hostMachineId: string, leaseId: string): Promise<void>;
    extend(address: string, hostMachineId: string, ttlSeconds: number): Promise<HostMachine>;
    exec(address: string, hostMachineId: string, command: string, timeoutSeconds: number): Promise<HostExecResult>;
}
export declare class HostRequestError extends Error {
    readonly status: number | undefined;
    readonly ambiguous: boolean;
    constructor(status: number | undefined, message: string, ambiguous: boolean);
}
export declare class NehemiahdClient implements HostClient {
    private readonly internalToken;
    private readonly fetcher;
    private readonly requestTimeoutMs;
    constructor(internalToken: string, fetcher?: typeof fetch, requestTimeoutMs?: number);
    create(address: string, request: CreateOnHostRequest): Promise<HostMachine>;
    get(address: string, hostMachineId: string): Promise<HostMachine | undefined>;
    destroy(address: string, hostMachineId: string, leaseId: string): Promise<void>;
    extend(address: string, hostMachineId: string, ttlSeconds: number): Promise<HostMachine>;
    exec(address: string, hostMachineId: string, command: string, timeoutSeconds: number): Promise<HostExecResult>;
    private request;
}

import type { HostClient, HostExecResult, HostMachine } from '../clients/nehemiahd.js';
import { BillingAdmissionPolicy } from '../billing/admission.js';
import type { UsageLedger } from '../billing/usage.js';
import { Database } from '../db/client.js';
import type { MachineState } from '../db/schema.js';
import { type NetworkPolicyDeclaration } from './network-policy.js';
import { type Resources } from '../scheduler/capacity.js';
import { type Reservation, type ScheduleRequest } from '../scheduler/scheduler.js';
export interface Machine {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly hostId?: string;
    readonly hostAddress?: string;
    readonly hostMachineId?: string;
    readonly runtimeCohortId?: string;
    readonly sourceSha256?: string;
    readonly leaseId: string;
    readonly leaseGeneration?: number;
    readonly state: MachineState;
    readonly stateReason?: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly networkPolicy?: NetworkPolicyDeclaration;
    readonly template?: string;
    readonly templateId?: string;
    readonly hostTemplateName?: string;
    readonly ociReference?: string;
    readonly requestedTtlSeconds?: number;
    readonly ready: boolean;
    readonly createdAt: Date;
    readonly startedAt?: Date;
    readonly readyAt?: Date;
    readonly stoppedAt?: Date;
    readonly expiresAt: Date;
    readonly idempotencyRequestHash?: string;
    readonly createFailureStatus?: number;
    readonly createFailureCode?: string;
    readonly createFailureMessage?: string;
    readonly parentId?: string;
    readonly forkOperationId?: string;
}
export interface CreateMachine {
    readonly organizationId: string;
    readonly projectId: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly template?: string;
    readonly templateId?: string;
    readonly ociReference?: string;
    readonly networkPolicy?: NetworkPolicyDeclaration;
    readonly ttlSeconds: number;
    readonly idempotencyKey: string;
}
export interface ExtendOperation {
    readonly id: string;
    readonly requestHash: string;
    readonly targetExpiresAt: Date;
    readonly resultExpiresAt?: Date;
    readonly replayed: boolean;
}
export interface ExtendMachineResult {
    readonly machine?: Machine;
    readonly replayed: boolean;
    readonly applied: boolean;
}
export type ForkOperationState = 'pending' | 'succeeded' | 'failed';
export interface ForkOperation {
    readonly id: string;
    readonly auditOperationId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly state: ForkOperationState;
    readonly replayed: boolean;
    readonly sourceMachineId: string;
    readonly sourceHostId: string;
    readonly sourceHostAddress: string;
    readonly sourceHostMachineId: string;
    readonly sourceLeaseId: string;
    readonly children: ReadonlyArray<Machine>;
    readonly failureStatus?: number;
    readonly failureCode?: string;
    readonly failureMessage?: string;
    readonly reconcileClaimToken?: string;
    readonly cleanupRequested: boolean;
    readonly cleanupClaimToken?: string;
    readonly cleanupFailureStatus?: number;
    readonly cleanupFailureCode?: string;
    readonly cleanupFailureMessage?: string;
    readonly expired: boolean;
    readonly deadlineReached: boolean;
}
export interface ForkMachineResult {
    readonly operationId: string;
    readonly auditOperationId: string;
    readonly idempotencyKey: string;
    readonly machines: ReadonlyArray<Machine>;
    readonly replayed: boolean;
    readonly pending: boolean;
    readonly cleanupPending: boolean;
}
export interface MachineRepository {
    find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    findByIdempotency(organizationId: string, projectId: string, key: string): Promise<Machine | undefined>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    insertRequested(machine: Machine, idempotencyKey: string): Promise<void>;
    claimCreate(machineId: string): Promise<string | undefined>;
    releaseCreateClaim(machineId: string, claimToken: string): Promise<void>;
    failCreate(machineId: string, claimToken: string, status: number, code: string, message: string): Promise<boolean>;
    assign(machineId: string, reservation: Reservation): Promise<void>;
    observeHost(machineId: string, hostMachine: {
        id: string;
        ready?: boolean;
        started_at?: string;
        ready_at?: string;
    }): Promise<void>;
    transition(machineId: string, from: ReadonlyArray<MachineState>, to: MachineState, reason?: string): Promise<boolean>;
    beginExtend(machineId: string, organizationId: string, projectId: string, idempotencyKey: string, requestHash: string, ttlSeconds: number): Promise<ExtendOperation | undefined>;
    completeExtend(operationId: string, machineId: string, organizationId: string, resultExpiresAt: Date): Promise<Date>;
    beginFork(sourceMachineId: string, organizationId: string, projectId: string, idempotencyKey: string, requestHash: string, count: number, auditOperationId: string): Promise<ForkOperation | undefined>;
    completeFork(operationId: string, observed: ReadonlyArray<HostMachine>): Promise<ForkOperation>;
    failFork(operationId: string, status: number, code: string, message: string): Promise<ForkOperation>;
    requestForkCleanup(operationId: string, status: number, code: string, message: string): Promise<ForkOperation>;
    completeForkCleanup(operationId: string, cleanupClaimToken: string): Promise<ForkOperation>;
    releaseForkCleanupClaim(operationId: string, cleanupClaimToken: string): Promise<void>;
    claimPendingForks(limit?: number): Promise<ReadonlyArray<ForkOperation>>;
    releaseForkClaim(operationId: string, claimToken: string, failed: boolean): Promise<void>;
}
export declare class PostgresMachineRepository implements MachineRepository {
    private readonly database;
    private readonly billingAdmission;
    constructor(database: Database, billingAdmission?: BillingAdmissionPolicy);
    find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    findByIdempotency(organizationId: string, projectId: string, key: string): Promise<Machine | undefined>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    insertRequested(machine: Machine, idempotencyKey: string): Promise<void>;
    claimCreate(machineId: string): Promise<string | undefined>;
    releaseCreateClaim(machineId: string, claimToken: string): Promise<void>;
    failCreate(machineId: string, claimToken: string, status: number, code: string, message: string): Promise<boolean>;
    assign(machineId: string, reservation: Reservation): Promise<void>;
    observeHost(machineId: string, hostMachine: {
        id: string;
        ready?: boolean;
        started_at?: string;
        ready_at?: string;
    }): Promise<void>;
    transition(machineId: string, from: ReadonlyArray<MachineState>, to: MachineState, reason?: string): Promise<boolean>;
    beginExtend(machineId: string, organizationId: string, projectId: string, idempotencyKey: string, requestHash: string, ttlSeconds: number): Promise<ExtendOperation | undefined>;
    completeExtend(operationId: string, machineId: string, organizationId: string, resultExpiresAt: Date): Promise<Date>;
    beginFork(sourceMachineId: string, organizationId: string, projectId: string, idempotencyKey: string, requestHash: string, count: number, auditOperationId: string): Promise<ForkOperation | undefined>;
    completeFork(operationId: string, observed: ReadonlyArray<HostMachine>): Promise<ForkOperation>;
    failFork(operationId: string, status: number, code: string, message: string): Promise<ForkOperation>;
    requestForkCleanup(operationId: string, status: number, code: string, message: string): Promise<ForkOperation>;
    releaseForkCleanupClaim(operationId: string, cleanupClaimToken: string): Promise<void>;
    completeForkCleanup(operationId: string, cleanupClaimToken: string): Promise<ForkOperation>;
    claimPendingForks(limit?: number): Promise<ReadonlyArray<ForkOperation>>;
    releaseForkClaim(operationId: string, claimToken: string, failed: boolean): Promise<void>;
    private recordForkTerminalAudit;
    private loadForkOperation;
    private event;
}
export interface MachineScheduler {
    reserve(request: ScheduleRequest): Promise<Reservation>;
    release(hostId: string, resources: Resources, machineId?: string): Promise<void>;
}
export declare class IdempotencyConflict extends Error {
    readonly code = "idempotency_conflict";
}
export declare class InvalidMachineRequest extends Error {
    readonly code = "invalid_request";
}
export declare class ManagedNetworkEgressUnavailable extends Error {
    readonly code = "not_supported";
}
export declare class MachineNotForkable extends Error {
    readonly code = "machine_not_forkable";
}
export declare class ReplayedCreateFailure extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export declare class ReplayedForkFailure extends Error {
    readonly status: number;
    readonly code: string;
    readonly auditOperationId?: string | undefined;
    constructor(status: number, code: string, message: string, auditOperationId?: string | undefined);
}
export declare class MachineService {
    private readonly repository;
    private readonly scheduler;
    private readonly host;
    private readonly usage?;
    constructor(repository: MachineRepository, scheduler: MachineScheduler, host: HostClient, usage?: UsageLedger | undefined);
    create(input: CreateMachine): Promise<{
        machine: Machine;
        replayed: boolean;
    }>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    get(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    destroy(id: string, organizationId: string, projectId?: string): Promise<boolean>;
    extend(id: string, organizationId: string, projectId: string | undefined, ttlSeconds: number, idempotencyKey: string): Promise<ExtendMachineResult>;
    fork(id: string, organizationId: string, projectId: string | undefined, count: number, idempotencyKey: string, auditOperationId?: `${string}-${string}-${string}-${string}-${string}`): Promise<ForkMachineResult>;
    private finishForkCleanup;
    private cleanupForkObservations;
    exec(id: string, organizationId: string, projectId: string | undefined, command: string, timeoutSeconds: number): Promise<HostExecResult | undefined>;
}
export declare const machineJson: (machine: Machine) => {
    id: string;
    project_id: string;
    state: "requested" | "failed" | "stopping" | "stopped" | "lost" | "running" | "placing" | "starting";
    status: "requested" | "failed" | "stopping" | "stopped" | "lost" | "running" | "placing" | "starting";
    ready: boolean;
    region: string;
    architecture: "x86_64" | "aarch64";
    runtime_cohort_id: string | undefined;
    source_sha256: string | undefined;
    resources: {
        vcpus: number;
        memory_mb: number;
        disk_mb: number;
    };
    template: string | undefined;
    template_id: string | undefined;
    oci_reference: string | undefined;
    network_policy: NetworkPolicyDeclaration;
    parent_id: string | undefined;
    created_at: string;
    started_at: string | undefined;
    ready_at: string | undefined;
    stopped_at: string | undefined;
    expires_at: string;
    failure_reason: string | undefined;
};

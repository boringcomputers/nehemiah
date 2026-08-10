import type { HostClient, HostExecResult } from '../clients/nehemiahd.js';
import type { Queryable } from '../db/client.js';
import type { MachineState } from '../db/schema.js';
import type { Resources } from '../scheduler/capacity.js';
import type { Reservation, ScheduleRequest } from '../scheduler/scheduler.js';
export interface Machine {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly hostId?: string;
    readonly hostAddress?: string;
    readonly hostMachineId?: string;
    readonly leaseId: string;
    readonly state: MachineState;
    readonly stateReason?: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly templateId?: string;
    readonly ociReference?: string;
    readonly ready: boolean;
    readonly createdAt: Date;
    readonly startedAt?: Date;
    readonly readyAt?: Date;
    readonly stoppedAt?: Date;
    readonly expiresAt: Date;
}
export interface CreateMachine {
    readonly organizationId: string;
    readonly projectId: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly templateId?: string;
    readonly ociReference?: string;
    readonly ttlSeconds: number;
    readonly idempotencyKey: string;
}
export interface MachineRepository {
    find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    findByIdempotency(organizationId: string, key: string): Promise<Machine | undefined>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    insertRequested(machine: Machine, idempotencyKey: string): Promise<void>;
    assign(machineId: string, reservation: Reservation): Promise<void>;
    observeHost(machineId: string, hostMachine: {
        id: string;
        ready?: boolean;
        started_at?: string;
        ready_at?: string;
    }): Promise<void>;
    transition(machineId: string, from: ReadonlyArray<MachineState>, to: MachineState, reason?: string): Promise<boolean>;
}
export declare class PostgresMachineRepository implements MachineRepository {
    private readonly database;
    constructor(database: Queryable);
    find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    findByIdempotency(organizationId: string, key: string): Promise<Machine | undefined>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    insertRequested(machine: Machine, idempotencyKey: string): Promise<void>;
    assign(machineId: string, reservation: Reservation): Promise<void>;
    observeHost(machineId: string, hostMachine: {
        id: string;
        ready?: boolean;
        started_at?: string;
        ready_at?: string;
    }): Promise<void>;
    transition(machineId: string, from: ReadonlyArray<MachineState>, to: MachineState, reason?: string): Promise<boolean>;
    private event;
}
export interface MachineScheduler {
    reserve(request: ScheduleRequest): Promise<Reservation>;
    release(hostId: string, resources: Resources): Promise<void>;
}
export declare class MachineService {
    private readonly repository;
    private readonly scheduler;
    private readonly host;
    constructor(repository: MachineRepository, scheduler: MachineScheduler, host: HostClient);
    create(input: CreateMachine): Promise<{
        machine: Machine;
        replayed: boolean;
    }>;
    list(organizationId: string, projectId?: string, cursor?: string, limit?: number): Promise<Machine[]>;
    get(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined>;
    destroy(id: string, organizationId: string, projectId?: string): Promise<boolean>;
    extend(id: string, organizationId: string, projectId: string | undefined, ttlSeconds: number): Promise<Machine | undefined>;
    exec(id: string, organizationId: string, projectId: string | undefined, command: string, timeoutSeconds: number): Promise<HostExecResult | undefined>;
}
export declare const machineJson: (machine: Machine) => {
    id: string;
    project_id: string;
    state: "requested" | "placing" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    status: "requested" | "placing" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    ready: boolean;
    region: string;
    architecture: "x86_64" | "aarch64";
    resources: {
        vcpus: number;
        memory_mb: number;
        disk_mb: number;
    };
    template_id: string | undefined;
    oci_reference: string | undefined;
    created_at: string;
    started_at: string | undefined;
    ready_at: string | undefined;
    stopped_at: string | undefined;
    expires_at: string;
    failure_reason: string | undefined;
};

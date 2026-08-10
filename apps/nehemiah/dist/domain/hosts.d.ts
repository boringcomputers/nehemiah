import type { Queryable } from '../db/client.js';
import type { HostState } from '../db/schema.js';
import { HostCredentialCipher } from './host-credentials.js';
import { type RuntimeCohort } from './runtime-cohort.js';
export interface HostHeartbeat {
    readonly state: Exclude<HostState, 'stale'>;
    readonly availableVcpus: number;
    readonly availableMemoryMb: number;
    readonly availableDiskMb: number;
    readonly machineCount: number;
    readonly kvmAvailable: boolean;
    readonly daemonVersion: string;
    readonly runtimeCohort: RuntimeCohort;
}
export interface RegisterHost {
    readonly providerId: string;
    readonly regionId: string;
    readonly address: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly totalVcpus: number;
    readonly totalMemoryMb: number;
    readonly totalDiskMb: number;
    readonly controlToken: string;
    readonly gatewayToken: string;
    readonly runtimeCohort: RuntimeCohort;
}
export interface IssueHostEnrollment {
    readonly providerId: string;
    readonly regionId: string;
    readonly address: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly totalVcpus: number;
    readonly totalMemoryMb: number;
    readonly totalDiskMb: number;
    readonly ttlSeconds: number;
    readonly issuedByOrganizationId: string;
    readonly issuedByUserId: string;
    readonly runtimeCohort: RuntimeCohort;
}
export interface HostEnrollmentGrant {
    readonly id: string;
    readonly hostId: string;
    readonly token: string;
    readonly expiresAt: Date;
}
export declare class HostEnrollmentError extends Error {
    readonly code: 'invalid_host_enrollment' | 'host_not_enrollable' | 'invalid_enrollment_grant';
    constructor(code: 'invalid_host_enrollment' | 'host_not_enrollable' | 'invalid_enrollment_grant', message: string);
}
export declare class HostHeartbeatError extends Error {
    readonly code: 'invalid_host_heartbeat' | 'host_heartbeat_rate_limited';
    readonly retryAfterSeconds?: number | undefined;
    constructor(code: 'invalid_host_heartbeat' | 'host_heartbeat_rate_limited', message: string, retryAfterSeconds?: number | undefined);
}
export type HostDesiredState = 'active' | 'draining' | 'quarantined' | 'revoked';
export type HostCredentialStatus = 'active' | 'revoked';
export interface HostLifecycle {
    readonly id: string;
    readonly desiredState: HostDesiredState;
    readonly credentialGeneration: number;
    readonly credentialStatus: HostCredentialStatus;
    readonly credentialRotatedAt: Date;
    readonly credentialRevokedAt?: Date;
    readonly lifecycleReason?: string;
}
export declare class HostService {
    #private;
    private readonly database;
    private readonly credentialCipher;
    private readonly expectedDaemonVersion?;
    constructor(database: Queryable, credentialCipher?: HostCredentialCipher, allowedCidrs?: ReadonlyArray<string>, expectedDaemonVersion?: string | undefined);
    register(enrollmentToken: string, input: RegisterHost): Promise<{
        id: string;
        grantId: string;
        credential: string;
        credentialGeneration: number;
    }>;
    issueEnrollment(input: IssueHostEnrollment): Promise<HostEnrollmentGrant>;
    revokeEnrollment(grantId: string): Promise<boolean>;
    gatewayCredential(hostId: string): Promise<string | undefined>;
    authenticate(hostId: string, credential: string): Promise<boolean>;
    authenticateGeneration(hostId: string, credential: string): Promise<number | undefined>;
    heartbeat(hostId: string, heartbeat: HostHeartbeat, credentialGeneration: number): Promise<boolean>;
    markStale(staleAfterMs: number): Promise<ReadonlyArray<string>>;
    setDraining(hostId: string, draining: boolean): Promise<boolean>;
    isOperatorOrganization(organizationId: string): Promise<boolean>;
    drain(hostId: string, reason?: string): Promise<HostLifecycle | undefined>;
    activate(hostId: string, reason?: string): Promise<HostLifecycle | undefined>;
    quarantine(hostId: string, reason?: string): Promise<HostLifecycle | undefined>;
    revoke(hostId: string, reason?: string): Promise<HostLifecycle | undefined>;
    rotateCredentials(hostId: string, input: Pick<RegisterHost, 'controlToken' | 'gatewayToken'>, reason?: string): Promise<(HostLifecycle & {
        readonly credential: string;
    }) | undefined>;
}

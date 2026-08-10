// Code generated from Nehemiah OpenAPI 1.0.0-beta.1 by scripts/openapi-models.mjs. DO NOT EDIT.

export interface Problem {
	readonly "type": string;
	readonly "title": string;
	readonly "status": number;
	readonly "detail": string;
	readonly "request_id"?: string;
	readonly "operation_may_have_completed"?: boolean;
	readonly [key: string]: unknown;
}

export interface DataPlaneError {
	readonly "error": string;
	readonly "feature"?: string;
}

export interface Organization {
	readonly "id": string;
	readonly "slug": string;
	readonly "name": string;
}

export interface OrganizationList {
	readonly "organizations": ReadonlyArray<Organization>;
}

export interface Project {
	readonly "id": string;
	readonly "organization_id": string;
	readonly "slug": string;
	readonly "name": string;
	readonly "max_machines": number;
	readonly "max_vcpus": number;
	readonly "max_memory_mb": number;
	readonly "max_disk_mb": number;
	readonly "max_storage_mb": number;
}

export interface ProjectList {
	readonly "projects": ReadonlyArray<Project>;
}

export interface CreateProjectRequest {
	readonly "slug": string;
	readonly "name": string;
}

export type ApiKeyScope = "machines:read" | "machines:write" | "templates:read" | "templates:write" | "volumes:read" | "volumes:write" | "billing:read";

export interface ApiKey {
	readonly "id": string;
	readonly "project_id"?: string;
	readonly "name": string;
	readonly "prefix": string;
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
	readonly "created_at"?: string;
	readonly "last_used_at"?: string;
	readonly "expires_at"?: string;
	readonly "disabled_at"?: string;
	readonly "revoked_at"?: string;
}

export interface ApiKeyList {
	readonly "api_keys": ReadonlyArray<ApiKey>;
}

export interface CreateApiKeyRequest {
	readonly "name": string;
	readonly "project_id"?: string;
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
	readonly "expires_at"?: string;
}

export interface CreateApiKeyResponse {
	readonly "id": string;
	readonly "key": string;
	readonly "prefix": string;
	readonly "secret_displayed_once": true;
}

export interface RotateApiKeyResponse {
	readonly "id": string;
	readonly "key": string;
	readonly "prefix": string;
	readonly "rotated_from_id": string;
	readonly "secret_displayed_once": true;
}

export interface IdentityLifecycleRequest {
	readonly "reason": string;
}

export interface IdentityLifecycleState {
	readonly "id": string;
	readonly "disabled_at"?: string;
}

export interface UserIdentityLifecycleResponse {
	readonly "user": IdentityLifecycleState;
	readonly "changed": boolean;
}

export interface OrganizationIdentityLifecycleResponse {
	readonly "organization": IdentityLifecycleState;
	readonly "changed": boolean;
}

export type IdentityProviderSyncEventType = "user.disabled" | "user.deleted" | "membership.upserted" | "membership.removed";

export type IdentityProviderMembershipRole = "owner" | "admin" | "member" | "billing";

export interface IdentityProviderSyncRequest {
	readonly "provider": "clerk";
	readonly "event_id": string;
	readonly "source_version": number;
	readonly "event_type": IdentityProviderSyncEventType;
	readonly "clerk_user_id": string;
	readonly "organization_id"?: string;
	readonly "role"?: IdentityProviderMembershipRole;
	readonly "reason": string;
}

export interface IdentityProviderSyncResponse {
	readonly "provider": "clerk";
	readonly "event_id": string;
	readonly "source_version": number;
	readonly "result": "applied" | "stale" | "replayed";
	readonly "changed": boolean;
	readonly "user_id": string;
	readonly "organization_id"?: string;
}

export interface DeviceCodeRequest {
	readonly "client_id": "nehemiah-cli";
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
}

export interface DeviceCodeResponse {
	readonly "device_code": string;
	readonly "user_code": string;
	readonly "verification_uri": string;
	readonly "verification_uri_complete": string;
	readonly "expires_in": number;
	readonly "interval": number;
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
}

export interface InspectDeviceCodeRequest {
	readonly "user_code": string;
}

export interface DeviceAuthorizationRequest {
	readonly "client_id": "nehemiah-cli";
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
	readonly "expires_at": string;
	readonly "status": "pending";
}

export interface AuthorizeDeviceRequest {
	readonly "user_code": string;
	readonly "decision": "approve" | "deny";
	readonly "project_id"?: string;
	readonly "scopes"?: ReadonlyArray<ApiKeyScope>;
}

export interface DeviceAuthorizationDecision {
	readonly "decision": "approve" | "deny";
	readonly "authorized": boolean;
	readonly "denied": boolean;
}

export interface ExchangeDeviceCodeRequest {
	readonly "device_code": string;
}

export interface RefreshDeviceTokenRequest {
	readonly "refresh_token": string;
}

export interface DeviceTokenResponse {
	readonly "token_type": "Bearer";
	readonly "access_token": string;
	readonly "expires_in": number;
	readonly "refresh_token": string;
	readonly "refresh_expires_in": number;
	readonly "organization_id": string;
	readonly "project_id": string;
	readonly "scopes": ReadonlyArray<ApiKeyScope>;
}

export type MachineState = "requested" | "placing" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";

export type Architecture = "x86_64" | "aarch64";

export interface RuntimeCohort {
	readonly "id": string;
	readonly "contract_version": 4;
	readonly "arch": "amd64" | "arm64";
	readonly "kernel_sha256": string;
	readonly "firecracker_sha256": string;
	readonly "jailer_sha256": string;
	readonly "python_rootfs_sha256": string;
	readonly "desktop_rootfs_sha256": string;
}

export interface MachineResources {
	readonly "vcpus": number;
	readonly "memory_mb": number;
	readonly "disk_mb": number;
}

export interface NetworkPolicy {
	readonly "mode": "off" | "allowlist";
	readonly "hostnames": ReadonlyArray<string>;
	readonly "cidrs": ReadonlyArray<string>;
}

export interface NetworkPolicyDeclaration {
	readonly "mode": "off";
	readonly "hostnames"?: ReadonlyArray<string>;
	readonly "cidrs"?: ReadonlyArray<string>;
}

export interface Machine {
	readonly "id": string;
	readonly "project_id": string;
	readonly "state": MachineState;
	readonly "status": MachineState;
	readonly "ready": boolean;
	readonly "region": string;
	readonly "architecture": Architecture;
	readonly "runtime_cohort_id"?: string;
	readonly "source_sha256"?: string;
	readonly "resources": MachineResources;
	readonly "template"?: string;
	readonly "template_id"?: string;
	readonly "oci_reference"?: string;
	readonly "network_policy": NetworkPolicy;
	readonly "parent_id"?: string;
	readonly "created_at": string;
	readonly "started_at"?: string;
	readonly "ready_at"?: string;
	readonly "stopped_at"?: string;
	readonly "expires_at": string;
	readonly "failure_reason"?: string;
}

export interface MachineList {
	readonly "machines": ReadonlyArray<Machine>;
	readonly "next_cursor"?: string;
}

export interface CreateMachineRequest {
	readonly "project_id"?: string;
	readonly "region"?: string;
	readonly "architecture"?: Architecture;
	readonly "template"?: "python" | "desktop";
	readonly "template_id"?: string;
	readonly "oci_reference"?: string;
	readonly "ttl_seconds"?: number;
	readonly "vcpus"?: number;
	readonly "memory_mb"?: number;
	readonly "disk_mb"?: number;
	readonly "network_policy"?: NetworkPolicyDeclaration;
}

export interface ExtendMachineRequest {
	readonly "ttl_seconds"?: number;
}

export interface ForkMachineRequest {
	readonly "count"?: number;
}

export interface MachineBatch {
	readonly "machines": ReadonlyArray<Machine>;
	readonly "requested": number;
}

export interface PendingForkOperation {
	readonly "id": string;
	readonly "state": "pending" | "cleanup_pending";
	readonly "idempotency_key": string;
	readonly "source_machine_id": string;
	readonly "requested": number;
}

export interface PendingForkResponse {
	readonly "operation": PendingForkOperation;
	readonly "machines": ReadonlyArray<Machine>;
	readonly "requested": number;
}

export interface ExecMachineRequest {
	readonly "command": string;
	readonly "timeout_seconds"?: number;
}

export interface ExecResult {
	readonly "output"?: string;
	readonly "stdout"?: string;
	readonly "stderr"?: string;
	readonly "exit_code": number | null;
	readonly "timed_out": boolean;
	readonly "duration_ms": number;
}

export type GatewayCapability = "tty" | "vnc" | "agent" | "files" | "preview";

export interface CreateMachineSessionRequest {
	readonly "capabilities"?: ReadonlyArray<GatewayCapability>;
	readonly "port"?: number;
	readonly "ttl_seconds"?: number;
}

export interface MachineSession {
	readonly "id": string;
	readonly "token": string;
	readonly "expires_in": number;
	readonly "gateway_url": string;
	readonly "preview_url"?: string;
}

export interface FileUploadResult {
	readonly "ok": true;
	readonly "path": string;
	readonly "bytes": number;
	readonly "transport": "vsock";
}

export interface TemplateSource {
	readonly "machine_id": string;
}

export interface TemplateArtifact {
	readonly "object_key": string;
	readonly "checksum": string;
	readonly "size_bytes": number;
}

export interface ManagedTemplateManifest {
	readonly "schema_version": 1;
	readonly "format": "firecracker-snapshot-v1";
	readonly "architecture": Architecture;
	readonly "source": TemplateSource;
	readonly "artifact": TemplateArtifact;
}

export interface ManagedTemplate {
	readonly "id": string;
	readonly "project_id": string;
	readonly "name": string;
	readonly "version": string;
	readonly "manifest": ManagedTemplateManifest;
	readonly "checksum": string;
	readonly "size_bytes": number;
	readonly "source_machine_id": string;
	readonly "created_at": string;
}

export interface ManagedTemplateList {
	readonly "templates": ReadonlyArray<ManagedTemplate>;
}

export interface PublishTemplateRequest {
	readonly "project_id"?: string;
	readonly "machine_id": string;
	readonly "name": string;
	readonly "version": string;
}

export interface Volume {
	readonly "id": string;
	readonly "project_id": string;
	readonly "created_at": string;
	readonly "expires_at": string;
	readonly "quota_mb": number;
	readonly "used_bytes": number;
	readonly "deleted_at"?: string;
	readonly "delete_after"?: string;
}

export interface VolumeGrant {
	readonly "method": "GET" | "PUT";
	readonly "url": string;
	readonly "headers": Readonly<Record<string, string>>;
	readonly "expires_at": string;
	readonly "maximum_bytes"?: number;
}

export interface VolumeWithGrant {
	readonly "id": string;
	readonly "project_id": string;
	readonly "created_at": string;
	readonly "expires_at": string;
	readonly "quota_mb": number;
	readonly "used_bytes": number;
	readonly "grant": VolumeGrant;
}

export interface VolumeList {
	readonly "volumes": ReadonlyArray<Volume>;
}

export interface CreateVolumeRequest {
	readonly "project_id"?: string;
	readonly "size_limit_mb"?: number;
	readonly "ttl_seconds"?: number;
	readonly "grant_ttl_seconds"?: number;
}

export interface CreateVolumeGrantRequest {
	readonly "method": "GET" | "PUT";
	readonly "ttl_seconds"?: number;
}

export interface VolumeGrantResponse {
	readonly "volume": Volume;
	readonly "grant": VolumeGrant;
}

export interface CreateHostEnrollmentRequest {
	readonly "provider_id": string;
	readonly "region_id": string;
	readonly "address": string;
	readonly "architecture": "x86_64" | "aarch64";
	readonly "total_vcpus": number;
	readonly "total_memory_mb": number;
	readonly "total_disk_mb": number;
	readonly "ttl_seconds"?: number;
	readonly "runtime_cohort": RuntimeCohort;
}

export interface HostEnrollmentResponse {
	readonly "id": string;
	readonly "host_id": string;
	readonly "token": string;
	readonly "expires_at": string;
	readonly "secret_displayed_once": true;
}

export interface HostLifecycle {
	readonly "id": string;
	readonly "desired_state": "active" | "draining" | "quarantined" | "revoked";
	readonly "credential_generation": number;
	readonly "credential_status": "active" | "revoked";
	readonly "credential_rotated_at": string;
	readonly "credential_revoked_at"?: string;
	readonly "lifecycle_reason"?: string;
}

export interface HostLifecycleRequest {
	readonly "reason"?: string;
}

export interface HostLifecycleResponse {
	readonly "host": HostLifecycle;
}

export interface RotateHostCredentialsRequest {
	readonly "control_token": string;
	readonly "gateway_token": string;
	readonly "reason"?: string;
}

export interface RotateHostCredentialsResponse {
	readonly "host": HostLifecycle;
	readonly "credential": string;
	readonly "secret_displayed_once": true;
}

export interface BillingAccount {
	readonly "plan": string;
	readonly "spend_cap_cents"?: number | null;
	readonly "delinquent_at"?: string | null;
}

export type UsageDimension = "vcpu_seconds" | "gib_seconds" | "storage_gib_hours" | "egress_bytes" | "inference_units";

export interface UsageRecord {
	readonly "usage_date": string;
	readonly "project_id": string;
	readonly "dimension": UsageDimension;
	readonly "quantity": string;
}

export interface UsageResponse {
	readonly "account": BillingAccount;
	readonly "usage": ReadonlyArray<UsageRecord>;
}

export interface StripeWebhookResponse {
	readonly "received": true;
	readonly "replayed": boolean;
}

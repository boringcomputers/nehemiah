# Code generated from Nehemiah OpenAPI 1.0.0-beta.1 by scripts/openapi-models.mjs. DO NOT EDIT.
from __future__ import annotations

from typing import Literal, NotRequired, TypeAlias, TypedDict


class Problem(TypedDict):
    type: str
    title: str
    status: int
    detail: str
    request_id: NotRequired[str]
    operation_may_have_completed: NotRequired[bool]


class DataPlaneError(TypedDict):
    error: str
    feature: NotRequired[str]


class Organization(TypedDict):
    id: str
    slug: str
    name: str


class OrganizationList(TypedDict):
    organizations: list[Organization]


class Project(TypedDict):
    id: str
    organization_id: str
    slug: str
    name: str
    max_machines: int
    max_vcpus: int
    max_memory_mb: int
    max_disk_mb: int
    max_storage_mb: int


class ProjectList(TypedDict):
    projects: list[Project]


class CreateProjectRequest(TypedDict):
    slug: str
    name: str


ApiKeyScope: TypeAlias = Literal["machines:read", "machines:write", "templates:read", "templates:write", "volumes:read", "volumes:write", "billing:read"]


class ApiKey(TypedDict):
    id: str
    project_id: NotRequired[str]
    name: str
    prefix: str
    scopes: list[ApiKeyScope]
    created_at: NotRequired[str]
    last_used_at: NotRequired[str]
    expires_at: NotRequired[str]
    disabled_at: NotRequired[str]
    revoked_at: NotRequired[str]


class ApiKeyList(TypedDict):
    api_keys: list[ApiKey]


class CreateApiKeyRequest(TypedDict):
    name: str
    project_id: NotRequired[str]
    scopes: list[ApiKeyScope]
    expires_at: NotRequired[str]


class CreateApiKeyResponse(TypedDict):
    id: str
    key: str
    prefix: str
    secret_displayed_once: Literal[True]


class RotateApiKeyResponse(TypedDict):
    id: str
    key: str
    prefix: str
    rotated_from_id: str
    secret_displayed_once: Literal[True]


class IdentityLifecycleRequest(TypedDict):
    reason: str


class IdentityLifecycleState(TypedDict):
    id: str
    disabled_at: NotRequired[str]


class UserIdentityLifecycleResponse(TypedDict):
    user: IdentityLifecycleState
    changed: bool


class OrganizationIdentityLifecycleResponse(TypedDict):
    organization: IdentityLifecycleState
    changed: bool


IdentityProviderSyncEventType: TypeAlias = Literal["user.disabled", "user.deleted", "membership.upserted", "membership.removed"]


IdentityProviderMembershipRole: TypeAlias = Literal["owner", "admin", "member", "billing"]


class IdentityProviderSyncRequest(TypedDict):
    provider: Literal["clerk"]
    event_id: str
    source_version: int
    event_type: IdentityProviderSyncEventType
    clerk_user_id: str
    organization_id: NotRequired[str]
    role: NotRequired[IdentityProviderMembershipRole]
    reason: str


class IdentityProviderSyncResponse(TypedDict):
    provider: Literal["clerk"]
    event_id: str
    source_version: int
    result: Literal["applied", "stale", "replayed"]
    changed: bool
    user_id: str
    organization_id: NotRequired[str]


class DeviceCodeRequest(TypedDict):
    client_id: Literal["nehemiah-cli"]
    scopes: list[ApiKeyScope]


class DeviceCodeResponse(TypedDict):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    scopes: list[ApiKeyScope]


class InspectDeviceCodeRequest(TypedDict):
    user_code: str


class DeviceAuthorizationRequest(TypedDict):
    client_id: Literal["nehemiah-cli"]
    scopes: list[ApiKeyScope]
    expires_at: str
    status: Literal["pending"]


class AuthorizeDeviceRequest(TypedDict):
    user_code: str
    decision: Literal["approve", "deny"]
    project_id: NotRequired[str]
    scopes: NotRequired[list[ApiKeyScope]]


class DeviceAuthorizationDecision(TypedDict):
    decision: Literal["approve", "deny"]
    authorized: bool
    denied: bool


class ExchangeDeviceCodeRequest(TypedDict):
    device_code: str


class RefreshDeviceTokenRequest(TypedDict):
    refresh_token: str


class DeviceTokenResponse(TypedDict):
    token_type: Literal["Bearer"]
    access_token: str
    expires_in: int
    refresh_token: str
    refresh_expires_in: int
    organization_id: str
    project_id: str
    scopes: list[ApiKeyScope]


MachineState: TypeAlias = Literal["requested", "placing", "starting", "running", "stopping", "stopped", "failed", "lost"]


Architecture: TypeAlias = Literal["x86_64", "aarch64"]


class RuntimeCohort(TypedDict):
    id: str
    contract_version: Literal[4]
    arch: Literal["amd64", "arm64"]
    kernel_sha256: str
    firecracker_sha256: str
    jailer_sha256: str
    python_rootfs_sha256: str
    desktop_rootfs_sha256: str


class MachineResources(TypedDict):
    vcpus: int
    memory_mb: int
    disk_mb: int


class NetworkPolicy(TypedDict):
    mode: Literal["off", "allowlist"]
    hostnames: list[str]
    cidrs: list[str]


class NetworkPolicyDeclaration(TypedDict):
    mode: Literal["off"]
    hostnames: NotRequired[list[str]]
    cidrs: NotRequired[list[str]]


class Machine(TypedDict):
    id: str
    project_id: str
    state: MachineState
    status: MachineState
    ready: bool
    region: str
    architecture: Architecture
    runtime_cohort_id: NotRequired[str]
    source_sha256: NotRequired[str]
    resources: MachineResources
    template: NotRequired[str]
    template_id: NotRequired[str]
    oci_reference: NotRequired[str]
    network_policy: NetworkPolicy
    parent_id: NotRequired[str]
    created_at: str
    started_at: NotRequired[str]
    ready_at: NotRequired[str]
    stopped_at: NotRequired[str]
    expires_at: str
    failure_reason: NotRequired[str]


class MachineList(TypedDict):
    machines: list[Machine]
    next_cursor: NotRequired[str]


class CreateMachineRequest(TypedDict):
    project_id: NotRequired[str]
    region: NotRequired[str]
    architecture: NotRequired[Architecture]
    template: NotRequired[Literal["python", "desktop"]]
    template_id: NotRequired[str]
    oci_reference: NotRequired[str]
    ttl_seconds: NotRequired[int]
    vcpus: NotRequired[int]
    memory_mb: NotRequired[int]
    disk_mb: NotRequired[int]
    network_policy: NotRequired[NetworkPolicyDeclaration]


class ExtendMachineRequest(TypedDict):
    ttl_seconds: NotRequired[int]


class ForkMachineRequest(TypedDict):
    count: NotRequired[int]


class MachineBatch(TypedDict):
    machines: list[Machine]
    requested: int


class PendingForkOperation(TypedDict):
    id: str
    state: Literal["pending", "cleanup_pending"]
    idempotency_key: str
    source_machine_id: str
    requested: int


class PendingForkResponse(TypedDict):
    operation: PendingForkOperation
    machines: list[Machine]
    requested: int


class ExecMachineRequest(TypedDict):
    command: str
    timeout_seconds: NotRequired[int]


class ExecResult(TypedDict):
    output: NotRequired[str]
    stdout: NotRequired[str]
    stderr: NotRequired[str]
    exit_code: int | None
    timed_out: bool
    duration_ms: int


GatewayCapability: TypeAlias = Literal["tty", "vnc", "agent", "files", "preview"]


class CreateMachineSessionRequest(TypedDict):
    capabilities: NotRequired[list[GatewayCapability]]
    port: NotRequired[int]
    ttl_seconds: NotRequired[int]


class MachineSession(TypedDict):
    id: str
    token: str
    expires_in: int
    gateway_url: str
    preview_url: NotRequired[str]


class FileUploadResult(TypedDict):
    ok: Literal[True]
    path: str
    bytes: int
    transport: Literal["vsock"]


class TemplateSource(TypedDict):
    machine_id: str


class TemplateArtifact(TypedDict):
    object_key: str
    checksum: str
    size_bytes: int


class ManagedTemplateManifest(TypedDict):
    schema_version: Literal[1]
    format: Literal["firecracker-snapshot-v1"]
    architecture: Architecture
    source: TemplateSource
    artifact: TemplateArtifact


class ManagedTemplate(TypedDict):
    id: str
    project_id: str
    name: str
    version: str
    manifest: ManagedTemplateManifest
    checksum: str
    size_bytes: int
    source_machine_id: str
    created_at: str


class ManagedTemplateList(TypedDict):
    templates: list[ManagedTemplate]


class PublishTemplateRequest(TypedDict):
    project_id: NotRequired[str]
    machine_id: str
    name: str
    version: str


class Volume(TypedDict):
    id: str
    project_id: str
    created_at: str
    expires_at: str
    quota_mb: int
    used_bytes: int
    deleted_at: NotRequired[str]
    delete_after: NotRequired[str]


class VolumeGrant(TypedDict):
    method: Literal["GET", "PUT"]
    url: str
    headers: dict[str, str]
    expires_at: str
    maximum_bytes: NotRequired[int]


class VolumeWithGrant(TypedDict):
    id: str
    project_id: str
    created_at: str
    expires_at: str
    quota_mb: int
    used_bytes: int
    grant: VolumeGrant


class VolumeList(TypedDict):
    volumes: list[Volume]


class CreateVolumeRequest(TypedDict):
    project_id: NotRequired[str]
    size_limit_mb: NotRequired[int]
    ttl_seconds: NotRequired[int]
    grant_ttl_seconds: NotRequired[int]


class CreateVolumeGrantRequest(TypedDict):
    method: Literal["GET", "PUT"]
    ttl_seconds: NotRequired[int]


class VolumeGrantResponse(TypedDict):
    volume: Volume
    grant: VolumeGrant


class CreateHostEnrollmentRequest(TypedDict):
    provider_id: str
    region_id: str
    address: str
    architecture: Literal["x86_64", "aarch64"]
    total_vcpus: int
    total_memory_mb: int
    total_disk_mb: int
    ttl_seconds: NotRequired[int]
    runtime_cohort: RuntimeCohort


class HostEnrollmentResponse(TypedDict):
    id: str
    host_id: str
    token: str
    expires_at: str
    secret_displayed_once: Literal[True]


class HostLifecycle(TypedDict):
    id: str
    desired_state: Literal["active", "draining", "quarantined", "revoked"]
    credential_generation: int
    credential_status: Literal["active", "revoked"]
    credential_rotated_at: str
    credential_revoked_at: NotRequired[str]
    lifecycle_reason: NotRequired[str]


class HostLifecycleRequest(TypedDict):
    reason: NotRequired[str]


class HostLifecycleResponse(TypedDict):
    host: HostLifecycle


class RotateHostCredentialsRequest(TypedDict):
    control_token: str
    gateway_token: str
    reason: NotRequired[str]


class RotateHostCredentialsResponse(TypedDict):
    host: HostLifecycle
    credential: str
    secret_displayed_once: Literal[True]


class BillingAccount(TypedDict):
    plan: str
    spend_cap_cents: NotRequired[int | None]
    delinquent_at: NotRequired[str | None]


UsageDimension: TypeAlias = Literal["vcpu_seconds", "gib_seconds", "storage_gib_hours", "egress_bytes", "inference_units"]


class UsageRecord(TypedDict):
    usage_date: str
    project_id: str
    dimension: UsageDimension
    quantity: str


class UsageResponse(TypedDict):
    account: BillingAccount
    usage: list[UsageRecord]


class StripeWebhookResponse(TypedDict):
    received: Literal[True]
    replayed: bool

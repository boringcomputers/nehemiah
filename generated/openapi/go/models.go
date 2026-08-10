// Code generated from Nehemiah OpenAPI 1.0.0-beta.1 by scripts/openapi-models.mjs. DO NOT EDIT.
package openapimodels

type Problem struct {
	Type                      string  `json:"type"`
	Title                     string  `json:"title"`
	Status                    int64   `json:"status"`
	Detail                    string  `json:"detail"`
	RequestId                 *string `json:"request_id,omitempty"`
	OperationMayHaveCompleted *bool   `json:"operation_may_have_completed,omitempty"`
}

type DataPlaneError struct {
	Error   string  `json:"error"`
	Feature *string `json:"feature,omitempty"`
}

type Organization struct {
	Id   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type OrganizationList struct {
	Organizations []Organization `json:"organizations"`
}

type Project struct {
	Id             string `json:"id"`
	OrganizationId string `json:"organization_id"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	MaxMachines    int64  `json:"max_machines"`
	MaxVcpus       int64  `json:"max_vcpus"`
	MaxMemoryMb    int64  `json:"max_memory_mb"`
	MaxDiskMb      int64  `json:"max_disk_mb"`
	MaxStorageMb   int64  `json:"max_storage_mb"`
}

type ProjectList struct {
	Projects []Project `json:"projects"`
}

type CreateProjectRequest struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type ApiKeyScope string

const (
	ApiKeyScopeMachinesRead   ApiKeyScope = "machines:read"
	ApiKeyScopeMachinesWrite  ApiKeyScope = "machines:write"
	ApiKeyScopeTemplatesRead  ApiKeyScope = "templates:read"
	ApiKeyScopeTemplatesWrite ApiKeyScope = "templates:write"
	ApiKeyScopeVolumesRead    ApiKeyScope = "volumes:read"
	ApiKeyScopeVolumesWrite   ApiKeyScope = "volumes:write"
	ApiKeyScopeBillingRead    ApiKeyScope = "billing:read"
)

type ApiKey struct {
	Id         string        `json:"id"`
	ProjectId  *string       `json:"project_id,omitempty"`
	Name       string        `json:"name"`
	Prefix     string        `json:"prefix"`
	Scopes     []ApiKeyScope `json:"scopes"`
	CreatedAt  *string       `json:"created_at,omitempty"`
	LastUsedAt *string       `json:"last_used_at,omitempty"`
	ExpiresAt  *string       `json:"expires_at,omitempty"`
	DisabledAt *string       `json:"disabled_at,omitempty"`
	RevokedAt  *string       `json:"revoked_at,omitempty"`
}

type ApiKeyList struct {
	ApiKeys []ApiKey `json:"api_keys"`
}

type CreateApiKeyRequest struct {
	Name      string        `json:"name"`
	ProjectId *string       `json:"project_id,omitempty"`
	Scopes    []ApiKeyScope `json:"scopes"`
	ExpiresAt *string       `json:"expires_at,omitempty"`
}

type CreateApiKeyResponse struct {
	Id                  string `json:"id"`
	Key                 string `json:"key"`
	Prefix              string `json:"prefix"`
	SecretDisplayedOnce bool   `json:"secret_displayed_once"`
}

type RotateApiKeyResponse struct {
	Id                  string `json:"id"`
	Key                 string `json:"key"`
	Prefix              string `json:"prefix"`
	RotatedFromId       string `json:"rotated_from_id"`
	SecretDisplayedOnce bool   `json:"secret_displayed_once"`
}

type IdentityLifecycleRequest struct {
	Reason string `json:"reason"`
}

type IdentityLifecycleState struct {
	Id         string  `json:"id"`
	DisabledAt *string `json:"disabled_at,omitempty"`
}

type UserIdentityLifecycleResponse struct {
	User    IdentityLifecycleState `json:"user"`
	Changed bool                   `json:"changed"`
}

type OrganizationIdentityLifecycleResponse struct {
	Organization IdentityLifecycleState `json:"organization"`
	Changed      bool                   `json:"changed"`
}

type IdentityProviderSyncEventType string

const (
	IdentityProviderSyncEventTypeUserDisabled       IdentityProviderSyncEventType = "user.disabled"
	IdentityProviderSyncEventTypeUserDeleted        IdentityProviderSyncEventType = "user.deleted"
	IdentityProviderSyncEventTypeMembershipUpserted IdentityProviderSyncEventType = "membership.upserted"
	IdentityProviderSyncEventTypeMembershipRemoved  IdentityProviderSyncEventType = "membership.removed"
)

type IdentityProviderMembershipRole string

const (
	IdentityProviderMembershipRoleOwner   IdentityProviderMembershipRole = "owner"
	IdentityProviderMembershipRoleAdmin   IdentityProviderMembershipRole = "admin"
	IdentityProviderMembershipRoleMember  IdentityProviderMembershipRole = "member"
	IdentityProviderMembershipRoleBilling IdentityProviderMembershipRole = "billing"
)

type IdentityProviderSyncRequest struct {
	Provider       string                          `json:"provider"`
	EventId        string                          `json:"event_id"`
	SourceVersion  int64                           `json:"source_version"`
	EventType      IdentityProviderSyncEventType   `json:"event_type"`
	ClerkUserId    string                          `json:"clerk_user_id"`
	OrganizationId *string                         `json:"organization_id,omitempty"`
	Role           *IdentityProviderMembershipRole `json:"role,omitempty"`
	Reason         string                          `json:"reason"`
}

type IdentityProviderSyncResponse struct {
	Provider       string  `json:"provider"`
	EventId        string  `json:"event_id"`
	SourceVersion  int64   `json:"source_version"`
	Result         string  `json:"result"`
	Changed        bool    `json:"changed"`
	UserId         string  `json:"user_id"`
	OrganizationId *string `json:"organization_id,omitempty"`
}

type DeviceCodeRequest struct {
	ClientId string        `json:"client_id"`
	Scopes   []ApiKeyScope `json:"scopes"`
}

type DeviceCodeResponse struct {
	DeviceCode              string        `json:"device_code"`
	UserCode                string        `json:"user_code"`
	VerificationUri         string        `json:"verification_uri"`
	VerificationUriComplete string        `json:"verification_uri_complete"`
	ExpiresIn               int64         `json:"expires_in"`
	Interval                int64         `json:"interval"`
	Scopes                  []ApiKeyScope `json:"scopes"`
}

type InspectDeviceCodeRequest struct {
	UserCode string `json:"user_code"`
}

type DeviceAuthorizationRequest struct {
	ClientId  string        `json:"client_id"`
	Scopes    []ApiKeyScope `json:"scopes"`
	ExpiresAt string        `json:"expires_at"`
	Status    string        `json:"status"`
}

type AuthorizeDeviceRequest struct {
	UserCode  string        `json:"user_code"`
	Decision  string        `json:"decision"`
	ProjectId *string       `json:"project_id,omitempty"`
	Scopes    []ApiKeyScope `json:"scopes,omitempty"`
}

type DeviceAuthorizationDecision struct {
	Decision   string `json:"decision"`
	Authorized bool   `json:"authorized"`
	Denied     bool   `json:"denied"`
}

type ExchangeDeviceCodeRequest struct {
	DeviceCode string `json:"device_code"`
}

type RefreshDeviceTokenRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type DeviceTokenResponse struct {
	TokenType        string        `json:"token_type"`
	AccessToken      string        `json:"access_token"`
	ExpiresIn        int64         `json:"expires_in"`
	RefreshToken     string        `json:"refresh_token"`
	RefreshExpiresIn int64         `json:"refresh_expires_in"`
	OrganizationId   string        `json:"organization_id"`
	ProjectId        string        `json:"project_id"`
	Scopes           []ApiKeyScope `json:"scopes"`
}

type MachineState string

const (
	MachineStateRequested MachineState = "requested"
	MachineStatePlacing   MachineState = "placing"
	MachineStateStarting  MachineState = "starting"
	MachineStateRunning   MachineState = "running"
	MachineStateStopping  MachineState = "stopping"
	MachineStateStopped   MachineState = "stopped"
	MachineStateFailed    MachineState = "failed"
	MachineStateLost      MachineState = "lost"
)

type Architecture string

const (
	ArchitectureX8664   Architecture = "x86_64"
	ArchitectureAarch64 Architecture = "aarch64"
)

type RuntimeCohort struct {
	Id                  string `json:"id"`
	ContractVersion     int64  `json:"contract_version"`
	Arch                string `json:"arch"`
	KernelSha256        string `json:"kernel_sha256"`
	FirecrackerSha256   string `json:"firecracker_sha256"`
	JailerSha256        string `json:"jailer_sha256"`
	PythonRootfsSha256  string `json:"python_rootfs_sha256"`
	DesktopRootfsSha256 string `json:"desktop_rootfs_sha256"`
}

type MachineResources struct {
	Vcpus    int64 `json:"vcpus"`
	MemoryMb int64 `json:"memory_mb"`
	DiskMb   int64 `json:"disk_mb"`
}

type NetworkPolicy struct {
	Mode      string   `json:"mode"`
	Hostnames []string `json:"hostnames"`
	Cidrs     []string `json:"cidrs"`
}

type NetworkPolicyDeclaration struct {
	Mode      string   `json:"mode"`
	Hostnames []string `json:"hostnames,omitempty"`
	Cidrs     []string `json:"cidrs,omitempty"`
}

type Machine struct {
	Id              string           `json:"id"`
	ProjectId       string           `json:"project_id"`
	State           MachineState     `json:"state"`
	Status          MachineState     `json:"status"`
	Ready           bool             `json:"ready"`
	Region          string           `json:"region"`
	Architecture    Architecture     `json:"architecture"`
	RuntimeCohortId *string          `json:"runtime_cohort_id,omitempty"`
	SourceSha256    *string          `json:"source_sha256,omitempty"`
	Resources       MachineResources `json:"resources"`
	Template        *string          `json:"template,omitempty"`
	TemplateId      *string          `json:"template_id,omitempty"`
	OciReference    *string          `json:"oci_reference,omitempty"`
	NetworkPolicy   NetworkPolicy    `json:"network_policy"`
	ParentId        *string          `json:"parent_id,omitempty"`
	CreatedAt       string           `json:"created_at"`
	StartedAt       *string          `json:"started_at,omitempty"`
	ReadyAt         *string          `json:"ready_at,omitempty"`
	StoppedAt       *string          `json:"stopped_at,omitempty"`
	ExpiresAt       string           `json:"expires_at"`
	FailureReason   *string          `json:"failure_reason,omitempty"`
}

type MachineList struct {
	Machines   []Machine `json:"machines"`
	NextCursor *string   `json:"next_cursor,omitempty"`
}

type CreateMachineRequest struct {
	ProjectId     *string                   `json:"project_id,omitempty"`
	Region        *string                   `json:"region,omitempty"`
	Architecture  *Architecture             `json:"architecture,omitempty"`
	Template      *string                   `json:"template,omitempty"`
	TemplateId    *string                   `json:"template_id,omitempty"`
	OciReference  *string                   `json:"oci_reference,omitempty"`
	TtlSeconds    *int64                    `json:"ttl_seconds,omitempty"`
	Vcpus         *int64                    `json:"vcpus,omitempty"`
	MemoryMb      *int64                    `json:"memory_mb,omitempty"`
	DiskMb        *int64                    `json:"disk_mb,omitempty"`
	NetworkPolicy *NetworkPolicyDeclaration `json:"network_policy,omitempty"`
}

type ExtendMachineRequest struct {
	TtlSeconds *int64 `json:"ttl_seconds,omitempty"`
}

type ForkMachineRequest struct {
	Count *int64 `json:"count,omitempty"`
}

type MachineBatch struct {
	Machines  []Machine `json:"machines"`
	Requested int64     `json:"requested"`
}

type PendingForkOperation struct {
	Id              string `json:"id"`
	State           string `json:"state"`
	IdempotencyKey  string `json:"idempotency_key"`
	SourceMachineId string `json:"source_machine_id"`
	Requested       int64  `json:"requested"`
}

type PendingForkResponse struct {
	Operation PendingForkOperation `json:"operation"`
	Machines  []Machine            `json:"machines"`
	Requested int64                `json:"requested"`
}

type ExecMachineRequest struct {
	Command        string `json:"command"`
	TimeoutSeconds *int64 `json:"timeout_seconds,omitempty"`
}

type ExecResult struct {
	Output     *string `json:"output,omitempty"`
	Stdout     *string `json:"stdout,omitempty"`
	Stderr     *string `json:"stderr,omitempty"`
	ExitCode   *int64  `json:"exit_code"`
	TimedOut   bool    `json:"timed_out"`
	DurationMs int64   `json:"duration_ms"`
}

type GatewayCapability string

const (
	GatewayCapabilityTty     GatewayCapability = "tty"
	GatewayCapabilityVnc     GatewayCapability = "vnc"
	GatewayCapabilityAgent   GatewayCapability = "agent"
	GatewayCapabilityFiles   GatewayCapability = "files"
	GatewayCapabilityPreview GatewayCapability = "preview"
)

type CreateMachineSessionRequest struct {
	Capabilities []GatewayCapability `json:"capabilities,omitempty"`
	Port         *int64              `json:"port,omitempty"`
	TtlSeconds   *int64              `json:"ttl_seconds,omitempty"`
}

type MachineSession struct {
	Id         string  `json:"id"`
	Token      string  `json:"token"`
	ExpiresIn  int64   `json:"expires_in"`
	GatewayUrl string  `json:"gateway_url"`
	PreviewUrl *string `json:"preview_url,omitempty"`
}

type FileUploadResult struct {
	Ok        bool   `json:"ok"`
	Path      string `json:"path"`
	Bytes     int64  `json:"bytes"`
	Transport string `json:"transport"`
}

type TemplateSource struct {
	MachineId string `json:"machine_id"`
}

type TemplateArtifact struct {
	ObjectKey string `json:"object_key"`
	Checksum  string `json:"checksum"`
	SizeBytes int64  `json:"size_bytes"`
}

type ManagedTemplateManifest struct {
	SchemaVersion int64            `json:"schema_version"`
	Format        string           `json:"format"`
	Architecture  Architecture     `json:"architecture"`
	Source        TemplateSource   `json:"source"`
	Artifact      TemplateArtifact `json:"artifact"`
}

type ManagedTemplate struct {
	Id              string                  `json:"id"`
	ProjectId       string                  `json:"project_id"`
	Name            string                  `json:"name"`
	Version         string                  `json:"version"`
	Manifest        ManagedTemplateManifest `json:"manifest"`
	Checksum        string                  `json:"checksum"`
	SizeBytes       int64                   `json:"size_bytes"`
	SourceMachineId string                  `json:"source_machine_id"`
	CreatedAt       string                  `json:"created_at"`
}

type ManagedTemplateList struct {
	Templates []ManagedTemplate `json:"templates"`
}

type PublishTemplateRequest struct {
	ProjectId *string `json:"project_id,omitempty"`
	MachineId string  `json:"machine_id"`
	Name      string  `json:"name"`
	Version   string  `json:"version"`
}

type Volume struct {
	Id          string  `json:"id"`
	ProjectId   string  `json:"project_id"`
	CreatedAt   string  `json:"created_at"`
	ExpiresAt   string  `json:"expires_at"`
	QuotaMb     int64   `json:"quota_mb"`
	UsedBytes   int64   `json:"used_bytes"`
	DeletedAt   *string `json:"deleted_at,omitempty"`
	DeleteAfter *string `json:"delete_after,omitempty"`
}

type VolumeGrant struct {
	Method       string            `json:"method"`
	Url          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	ExpiresAt    string            `json:"expires_at"`
	MaximumBytes *int64            `json:"maximum_bytes,omitempty"`
}

type VolumeWithGrant struct {
	Id        string      `json:"id"`
	ProjectId string      `json:"project_id"`
	CreatedAt string      `json:"created_at"`
	ExpiresAt string      `json:"expires_at"`
	QuotaMb   int64       `json:"quota_mb"`
	UsedBytes int64       `json:"used_bytes"`
	Grant     VolumeGrant `json:"grant"`
}

type VolumeList struct {
	Volumes []Volume `json:"volumes"`
}

type CreateVolumeRequest struct {
	ProjectId       *string `json:"project_id,omitempty"`
	SizeLimitMb     *int64  `json:"size_limit_mb,omitempty"`
	TtlSeconds      *int64  `json:"ttl_seconds,omitempty"`
	GrantTtlSeconds *int64  `json:"grant_ttl_seconds,omitempty"`
}

type CreateVolumeGrantRequest struct {
	Method     string `json:"method"`
	TtlSeconds *int64 `json:"ttl_seconds,omitempty"`
}

type VolumeGrantResponse struct {
	Volume Volume      `json:"volume"`
	Grant  VolumeGrant `json:"grant"`
}

type CreateHostEnrollmentRequest struct {
	ProviderId    string        `json:"provider_id"`
	RegionId      string        `json:"region_id"`
	Address       string        `json:"address"`
	Architecture  string        `json:"architecture"`
	TotalVcpus    int64         `json:"total_vcpus"`
	TotalMemoryMb int64         `json:"total_memory_mb"`
	TotalDiskMb   int64         `json:"total_disk_mb"`
	TtlSeconds    *int64        `json:"ttl_seconds,omitempty"`
	RuntimeCohort RuntimeCohort `json:"runtime_cohort"`
}

type HostEnrollmentResponse struct {
	Id                  string `json:"id"`
	HostId              string `json:"host_id"`
	Token               string `json:"token"`
	ExpiresAt           string `json:"expires_at"`
	SecretDisplayedOnce bool   `json:"secret_displayed_once"`
}

type HostLifecycle struct {
	Id                   string  `json:"id"`
	DesiredState         string  `json:"desired_state"`
	CredentialGeneration int64   `json:"credential_generation"`
	CredentialStatus     string  `json:"credential_status"`
	CredentialRotatedAt  string  `json:"credential_rotated_at"`
	CredentialRevokedAt  *string `json:"credential_revoked_at,omitempty"`
	LifecycleReason      *string `json:"lifecycle_reason,omitempty"`
}

type HostLifecycleRequest struct {
	Reason *string `json:"reason,omitempty"`
}

type HostLifecycleResponse struct {
	Host HostLifecycle `json:"host"`
}

type RotateHostCredentialsRequest struct {
	ControlToken string  `json:"control_token"`
	GatewayToken string  `json:"gateway_token"`
	Reason       *string `json:"reason,omitempty"`
}

type RotateHostCredentialsResponse struct {
	Host                HostLifecycle `json:"host"`
	Credential          string        `json:"credential"`
	SecretDisplayedOnce bool          `json:"secret_displayed_once"`
}

type BillingAccount struct {
	Plan          string  `json:"plan"`
	SpendCapCents *int64  `json:"spend_cap_cents,omitempty"`
	DelinquentAt  *string `json:"delinquent_at,omitempty"`
}

type UsageDimension string

const (
	UsageDimensionVcpuSeconds     UsageDimension = "vcpu_seconds"
	UsageDimensionGibSeconds      UsageDimension = "gib_seconds"
	UsageDimensionStorageGibHours UsageDimension = "storage_gib_hours"
	UsageDimensionEgressBytes     UsageDimension = "egress_bytes"
	UsageDimensionInferenceUnits  UsageDimension = "inference_units"
)

type UsageRecord struct {
	UsageDate string         `json:"usage_date"`
	ProjectId string         `json:"project_id"`
	Dimension UsageDimension `json:"dimension"`
	Quantity  string         `json:"quantity"`
}

type UsageResponse struct {
	Account BillingAccount `json:"account"`
	Usage   []UsageRecord  `json:"usage"`
}

type StripeWebhookResponse struct {
	Received bool `json:"received"`
	Replayed bool `json:"replayed"`
}

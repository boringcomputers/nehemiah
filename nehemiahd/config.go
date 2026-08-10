package main

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	hostIdentityPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	bearerCredentialPattern = regexp.MustCompile(`^[-A-Za-z0-9._~+/=]+$`)
	enrollmentGrantPattern  = regexp.MustCompile(`^nhe_[A-Za-z0-9_-]{43}$`)
)

// Config holds all runtime configuration for nehemiahd. Values come from env with
// the fixed defaults described in the Nehemiah contract. Legacy BORING_* names
// are still honored — see getenv.
type Config struct {
	// Nehemiah host-agent identity and trust-boundary settings. InternalToken is
	// deliberately separate from Token: it authenticates only the private
	// control-plane API and is never accepted in a URL query string.
	NehemiahMode  bool
	HostID        string
	Region        string
	Draining      bool
	InternalToken string
	StatePath     string

	// Managed-fleet enrollment uses a short-lived, one-use, identity-bound grant
	// to obtain a unique heartbeat credential. InternalToken is also unique per host and is
	// sent at enrollment so the control plane can authenticate calls into this
	// daemon without sharing a fleet-wide inbound secret.
	ControlPlaneURL     string
	FleetBootstrapToken string
	AdvertiseAddress    string
	ProviderID          string
	EnrollmentPath      string
	EnvironmentFile     string
	HeartbeatInterval   time.Duration
	ControlPlaneHTTP    bool
	Telemetry           TelemetryConfig

	// Listen address for the HTTP/WS server.
	Addr string

	// Token, if non-empty, requires "Authorization: Bearer <token>" on /v1/*
	// routes. Local mode retains legacy ?token= WebSocket compatibility; managed
	// hosts reject URL credentials. /healthz is always open.
	Token string

	// CORSOrigin is sent as Access-Control-Allow-Origin so a browser on another
	// origin (the deployed site) can call the public endpoint. "" disables CORS.
	CORSOrigin string

	// MaxMachines caps the number of live machines; creation returns 429 when full.
	MaxMachines int

	// MaxTemplates caps user-published templates (POST /v1/machines/{id}/publish);
	// 0 disables publishing entirely. Built-in templates don't count.
	MaxTemplates int

	// MaxForks caps ?count on POST /v1/machines/{id}/branch (fleet fork).
	MaxForks int

	// MaxForkOperations bounds durable managed-fork idempotency history. Entries
	// are never evicted before the host's full maximum lease window has elapsed.
	MaxForkOperations int

	// MemReserveMB is host RAM kept free — boot is refused if a new VM would eat
	// into it, so the box gracefully hits capacity instead of OOMing. 0 disables.
	MemReserveMB int

	// Fixed host paths (created by bootstrap).
	FirecrackerBin string // /opt/boring/bin/firecracker
	SystemdRunBin  string // /usr/bin/systemd-run (managed sibling scopes)
	SystemctlBin   string // /usr/bin/systemctl (scope lifecycle/reconciliation)
	KernelPath     string // /opt/boring/kernel/vmlinux
	BaseRootfs     string // /opt/boring/rootfs/rootfs.ext4
	DesktopRootfs  string // /opt/boring/rootfs/desktop.ext4
	TemplatesDir   string // /opt/boring/templates
	RunDir         string // /opt/boring/run

	// RuntimeCohort binds every managed host to the exact signed built-in VM
	// bytes installed by the release. It is recomputed locally at startup and
	// before every heartbeat; these values are never operator-supplied on a
	// managed host.
	RuntimeCohort managedRuntimeCohort

	// Durable managed-template transfers accept presigned capabilities only for
	// this exact object-store origin. Empty disables export upload/activation.
	// Plain HTTP exists solely for explicit local integration tests.
	TemplateObjectOrigin    string
	TemplateObjectAllowHTTP bool

	// TTL clamp bounds (seconds) and default.
	DefaultTTL int
	MinTTL     int
	MaxTTL     int

	// AllowPersistent lets a request opt out of the TTL entirely (a machine that
	// runs until explicitly stopped). Off by default so a public instance can't be
	// drained by never-expiring machines; self-hosters set NEHEMIAH_ALLOW_PERSISTENT=1.
	AllowPersistent bool

	// Guest machine sizing.
	VCPUs                 int
	MemSizeMB             int
	MaxVCPUsPerMachine    int
	MaxMemoryMBPerMachine int

	// Public-facing abuse controls.
	PerIPMax         int  // max concurrent machines per client IP
	CreateRatePerMin int  // max creations per minute per client IP
	TrustProxy       bool // read client IP from X-Forwarded-For (behind Caddy)

	// Per-VM cgroup v2 caps (0 disables that limit).
	CgroupEnable   bool
	CPUMaxPercent  int   // host CPU % cap per declared vCPU (100 = one core per vCPU)
	PidsMax        int   // max host-visible pids for the firecracker child
	IOReadBPS      int64 // per-VM host block-device read throttle
	IOWriteBPS     int64 // per-VM host block-device write throttle
	OverlayQuotaMB int   // maximum logical size of a per-machine rootfs overlay

	// Guest internet: attach a NIC per cold-booted VM, NAT out via the host. The
	// host side (bridge, dnsmasq, egress firewall) is set up by net-setup.sh.
	NetEnable bool   // NEHEMIAH_NET=="1"
	NetBridge string // bridge to attach taps to (default boring0)
	NetSubnet string // guest /24 prefix, e.g. 10.200.0 (gateway .1)
	// Managed guests send DNS to the bridge gateway. The daemon validates
	// answers before installing short-lived egress entries; additional deployment
	// control/peer ranges extend (but can never weaken) the built-in deny floor.
	EgressDNSListen   string   // NEHEMIAH_EGRESS_DNS_LISTEN (default <gateway>:53)
	EgressDNSUpstream string   // NEHEMIAH_EGRESS_DNS_UPSTREAM (literal IP:port)
	EgressDenyCIDRs   []string // NEHEMIAH_EGRESS_DENY_CIDRS (comma-separated)

	// Preview: expose a guest port at <id>--<port>.<PreviewBase>.
	PreviewBase string // NEHEMIAH_PREVIEW_BASE, e.g. previews.example.com ("" disables previews)
	LeasesPath  string // dnsmasq lease file, for guest IP lookup

	// Local/self-hosted storage: persistent volumes on an S3-compatible store.
	// Enabled when S3Endpoint is set; managed release validation forbids it.
	S3Endpoint       string // NEHEMIAH_S3_ENDPOINT host:port (no scheme)
	S3Key            string // NEHEMIAH_S3_KEY
	S3Secret         string // NEHEMIAH_S3_SECRET
	S3Bucket         string // NEHEMIAH_S3_BUCKET (default boring-volumes)
	S3Region         string // NEHEMIAH_S3_REGION (SigV4 signing region)
	S3UseSSL         bool   // NEHEMIAH_S3_SSL=="1"
	VolumeQuotaMB    int    // per-volume size cap
	VolumeTTLDefault int    // default volume lifetime (seconds)
	VolumeTTLMax     int    // max volume lifetime (seconds)
	VolumeRatePerMin int    // per-IP volume creations/min

	// Warm pool: keep this many desktops pre-booted so a request is instant.
	DesktopPool int

	// Inference gateway: an OpenAI-compatible /v1/chat/completions that routes
	// Claude models to Anthropic natively and everything else to OpenRouter.
	// Enabled when either key is set. Both may be set at once.
	OpenRouterKey       string // NEHEMIAH_OPENROUTER_KEY
	InferenceMaxTokens  int    // hard cap on max_tokens per request (cost guard)
	InferenceRatePerMin int    // per-IP requests/min (cost guard)

	// Global daily circuit breakers on the shared Anthropic key (0 disables).
	DailyAgentMax int // agent runs (computer-use + terminal) per UTC day
	DailyInferMax int // inference requests per UTC day

	// Computer-use agent: an AI driving the GUI desktop, streamed to the browser.
	// AnthropicKey also backs the gateway's Claude path.
	AnthropicKey       string // NEHEMIAH_ANTHROPIC_KEY; empty disables the agent
	AgentModel         string // model id (default claude-opus-4-8)
	AgentMaxSteps      int    // hard cap on model turns per run (cost guard)
	AgentMaxConcurrent int    // hard cap on simultaneous agent runs (cost guard)

	// Jailer: run firecracker chrooted + unprivileged (defense-in-depth).
	JailerEnable bool
	JailerBin    string // /opt/boring/bin/jailer
	JailerUID    int
	JailerGID    int
	ChrootBase   string // /srv/jailer

	// Established only by ValidateRuntime after hashing the exact managed
	// release assets. It is intentionally not environment- or wire-controlled.
	runtimeAssetGuard managedRuntimeAssetGuard
}

// LoadConfig builds a Config from the environment, applying the fixed defaults.
func LoadConfig() Config {
	nehemiahMode := getenv("NEHEMIAH_MODE") == "1"
	maxTTLDefault := 900
	overlayQuotaDefault := 8192
	cpuMaxPercentDefault := 150
	if nehemiahMode {
		maxTTLDefault = 86400
		overlayQuotaDefault = 20480
		// A managed vCPU is an exact schedulable/billable core. Local mode keeps
		// the historical burst allowance, but both modes scale the quota by the
		// machine's declared vCPU count.
		cpuMaxPercentDefault = 100
	}
	c := Config{
		NehemiahMode:            nehemiahMode,
		HostID:                  getenv("NEHEMIAH_HOST_ID"),
		Region:                  getenv("NEHEMIAH_REGION"),
		Draining:                getenv("NEHEMIAH_DRAINING") == "1",
		InternalToken:           credentialEnv(nehemiahMode, "NEHEMIAH_INTERNAL_TOKEN"),
		StatePath:               envStr("NEHEMIAH_STATE_PATH", "/var/lib/nehemiahd/state.json"),
		ControlPlaneURL:         getenv("NEHEMIAH_CONTROL_PLANE_URL"),
		FleetBootstrapToken:     credentialEnv(nehemiahMode, "NEHEMIAH_FLEET_BOOTSTRAP_TOKEN"),
		AdvertiseAddress:        getenv("NEHEMIAH_ADVERTISE_ADDRESS"),
		ProviderID:              getenv("NEHEMIAH_PROVIDER_ID"),
		EnrollmentPath:          envStr("NEHEMIAH_ENROLLMENT_PATH", "/var/lib/nehemiahd/enrollment.json"),
		EnvironmentFile:         envStr("NEHEMIAH_ENV_FILE", "/etc/boring/nehemiahd.env"),
		HeartbeatInterval:       time.Duration(envInt("NEHEMIAH_HEARTBEAT_SECONDS", 10)) * time.Second,
		ControlPlaneHTTP:        getenv("NEHEMIAH_CONTROL_PLANE_ALLOW_HTTP") == "1",
		Addr:                    envStr("NEHEMIAH_ADDR", "0.0.0.0:8080"),
		Token:                   credentialEnv(nehemiahMode, "NEHEMIAH_TOKEN"),
		CORSOrigin:              getenv("NEHEMIAH_CORS_ORIGIN"),
		MaxMachines:             envInt("NEHEMIAH_MAX", 20),
		MaxTemplates:            envInt("NEHEMIAH_MAX_TEMPLATES", 10),
		MaxForks:                envInt("NEHEMIAH_MAX_FORKS", 8),
		MaxForkOperations:       envInt("NEHEMIAH_MAX_FORK_OPERATIONS", 4096),
		AllowPersistent:         getenv("NEHEMIAH_ALLOW_PERSISTENT") == "1",
		MemReserveMB:            envInt("NEHEMIAH_MEM_RESERVE_MB", 3072),
		FirecrackerBin:          envStr("NEHEMIAH_FIRECRACKER_BIN", "/opt/boring/bin/firecracker"),
		SystemdRunBin:           envStr("NEHEMIAH_SYSTEMD_RUN_BIN", "/usr/bin/systemd-run"),
		SystemctlBin:            envStr("NEHEMIAH_SYSTEMCTL_BIN", "/usr/bin/systemctl"),
		KernelPath:              envStr("NEHEMIAH_KERNEL", "/opt/boring/kernel/vmlinux"),
		BaseRootfs:              envStr("NEHEMIAH_ROOTFS", "/opt/boring/rootfs/rootfs.ext4"),
		DesktopRootfs:           envStr("NEHEMIAH_DESKTOP_ROOTFS", "/opt/boring/rootfs/desktop.ext4"),
		TemplatesDir:            envStr("NEHEMIAH_TEMPLATES", "/opt/boring/templates"),
		RunDir:                  envStr("NEHEMIAH_RUN", "/opt/boring/run"),
		TemplateObjectOrigin:    getenv("NEHEMIAH_TEMPLATE_OBJECT_ORIGIN"),
		TemplateObjectAllowHTTP: getenv("NEHEMIAH_TEMPLATE_OBJECT_ALLOW_HTTP") == "1",
		DefaultTTL:              120,
		MinTTL:                  15,
		MaxTTL:                  envInt("NEHEMIAH_MAX_TTL", maxTTLDefault),
		VCPUs:                   1,
		MemSizeMB:               256,
		MaxVCPUsPerMachine:      envInt("NEHEMIAH_MAX_VCPUS_PER_MACHINE", 4),
		MaxMemoryMBPerMachine:   envInt("NEHEMIAH_MAX_MEMORY_MB_PER_MACHINE", 4096),
		PerIPMax:                envInt("NEHEMIAH_PER_IP_MAX", 2),
		CreateRatePerMin:        envInt("NEHEMIAH_CREATE_RATE", 8),
		TrustProxy:              getenv("NEHEMIAH_TRUST_PROXY") == "1",
		CgroupEnable:            getenv("NEHEMIAH_CGROUP") != "0",
		CPUMaxPercent:           envInt("NEHEMIAH_CPU_MAX_PCT", cpuMaxPercentDefault),
		PidsMax:                 envInt("NEHEMIAH_PIDS_MAX", 512),
		IOReadBPS:               envInt64("NEHEMIAH_IO_READ_BPS", 64*1024*1024),
		IOWriteBPS:              envInt64("NEHEMIAH_IO_WRITE_BPS", 64*1024*1024),
		OverlayQuotaMB:          envInt("NEHEMIAH_OVERLAY_QUOTA_MB", overlayQuotaDefault),
		NetEnable:               getenv("NEHEMIAH_NET") == "1",
		NetBridge:               envStr("NEHEMIAH_NET_BRIDGE", "boring0"),
		NetSubnet:               envStr("NEHEMIAH_NET_SUBNET", "10.200.0"),
		EgressDNSUpstream:       envStr("NEHEMIAH_EGRESS_DNS_UPSTREAM", "1.1.1.1:53"),
		EgressDenyCIDRs:         envCSV("NEHEMIAH_EGRESS_DENY_CIDRS"),
		PreviewBase:             getenv("NEHEMIAH_PREVIEW_BASE"), // deployment-specific; unset disables previews
		LeasesPath:              envStr("NEHEMIAH_LEASES", "/var/lib/misc/dnsmasq.leases"),
		S3Endpoint:              getenv("NEHEMIAH_S3_ENDPOINT"),
		S3Key:                   getenv("NEHEMIAH_S3_KEY"),
		S3Secret:                getenv("NEHEMIAH_S3_SECRET"),
		S3Bucket:                envStr("NEHEMIAH_S3_BUCKET", "boring-volumes"),
		S3Region:                getenv("NEHEMIAH_S3_REGION"),
		S3UseSSL:                getenv("NEHEMIAH_S3_SSL") == "1",
		VolumeQuotaMB:           envInt("NEHEMIAH_VOLUME_QUOTA_MB", 256),
		VolumeTTLDefault:        envInt("NEHEMIAH_VOLUME_TTL", 86400),
		VolumeTTLMax:            envInt("NEHEMIAH_VOLUME_TTL_MAX", 604800),
		VolumeRatePerMin:        envInt("NEHEMIAH_VOLUME_RATE", 10),
		DesktopPool:             envInt("NEHEMIAH_DESKTOP_POOL", 1),
		OpenRouterKey:           getenv("NEHEMIAH_OPENROUTER_KEY"),
		InferenceMaxTokens:      envInt("NEHEMIAH_INFER_MAX_TOKENS", 1024),
		InferenceRatePerMin:     envInt("NEHEMIAH_INFER_RATE", 20),
		DailyAgentMax:           envInt("NEHEMIAH_DAILY_AGENT_MAX", 200),
		DailyInferMax:           envInt("NEHEMIAH_DAILY_INFER_MAX", 3000),
		AnthropicKey:            getenv("NEHEMIAH_ANTHROPIC_KEY"),
		AgentModel:              envStr("NEHEMIAH_AGENT_MODEL", "claude-opus-4-8"),
		AgentMaxSteps:           envInt("NEHEMIAH_AGENT_MAX_STEPS", 30),
		AgentMaxConcurrent:      envInt("NEHEMIAH_AGENT_MAX_CONCURRENT", 2),
		JailerEnable:            getenv("NEHEMIAH_JAILER") == "1",
		JailerBin:               envStr("NEHEMIAH_JAILER_BIN", "/opt/boring/bin/jailer"),
		JailerUID:               envInt("NEHEMIAH_JAILER_UID", 30000),
		JailerGID:               envInt("NEHEMIAH_JAILER_GID", 30000),
		ChrootBase:              envStr("NEHEMIAH_CHROOT_BASE", "/srv/jailer"),
		RuntimeCohort: managedRuntimeCohort{
			ID:                  getenv("NEHEMIAH_RUNTIME_COHORT_ID"),
			ContractVersion:     envInt("NEHEMIAH_RUNTIME_CONTRACT_VERSION", 0),
			Arch:                getenv("NEHEMIAH_RUNTIME_ARCH"),
			PythonRootfsSHA256:  getenv("NEHEMIAH_RUNTIME_PYTHON_SHA256"),
			DesktopRootfsSHA256: getenv("NEHEMIAH_RUNTIME_DESKTOP_SHA256"),
			KernelSHA256:        getenv("NEHEMIAH_RUNTIME_KERNEL_SHA256"),
			FirecrackerSHA256:   getenv("NEHEMIAH_RUNTIME_FIRECRACKER_SHA256"),
			JailerSHA256:        getenv("NEHEMIAH_RUNTIME_JAILER_SHA256"),
		},
	}
	if c.EgressDNSListen = getenv("NEHEMIAH_EGRESS_DNS_LISTEN"); c.EgressDNSListen == "" {
		c.EgressDNSListen = net.JoinHostPort(c.NetSubnet+".1", "53")
	}
	if c.MaxMachines < 1 {
		c.MaxMachines = 1
	}
	if c.ProviderID == "" {
		c.ProviderID = c.HostID
	}
	c.Telemetry = loadTelemetryConfig(os.LookupEnv)
	return c
}

// Validate rejects configurations which would make a Nehemiah data-plane host
// unsafe or ambiguous. Local/self-hosted mode remains intentionally permissive,
// but values that are dangerous in every mode are still rejected.
func (c Config) Validate() error {
	if err := c.Telemetry.Validate(c.NehemiahMode,
		c.InternalToken, c.Token, c.FleetBootstrapToken, c.S3Secret, c.OpenRouterKey, c.AnthropicKey); err != nil {
		return err
	}
	if c.Telemetry.Enabled() && (!hostIdentityPattern.MatchString(c.Region) || net.ParseIP(c.Region) != nil) {
		return fmt.Errorf("NEHEMIAH_REGION is required and must be a bounded non-IP region identifier when telemetry is enabled")
	}
	if c.StatePath != "" && !filepath.IsAbs(c.StatePath) {
		return fmt.Errorf("NEHEMIAH_STATE_PATH must be absolute")
	}
	if c.TemplateObjectOrigin != "" {
		objectOrigin, err := url.Parse(c.TemplateObjectOrigin)
		if err != nil || objectOrigin.Host == "" || (objectOrigin.Scheme != "https" && objectOrigin.Scheme != "http") {
			return fmt.Errorf("NEHEMIAH_TEMPLATE_OBJECT_ORIGIN must be an absolute HTTPS origin")
		}
		if objectOrigin.User != nil || objectOrigin.Path != "" && objectOrigin.Path != "/" || objectOrigin.RawQuery != "" || objectOrigin.Fragment != "" {
			return fmt.Errorf("NEHEMIAH_TEMPLATE_OBJECT_ORIGIN must not contain credentials, a path, query, or fragment")
		}
		if objectOrigin.Scheme != "https" && (!c.TemplateObjectAllowHTTP || c.NehemiahMode) {
			return fmt.Errorf("NEHEMIAH_TEMPLATE_OBJECT_ORIGIN must use HTTPS")
		}
	}
	if c.TemplateObjectAllowHTTP && (c.TemplateObjectOrigin == "" || c.NehemiahMode) {
		return fmt.Errorf("NEHEMIAH_TEMPLATE_OBJECT_ALLOW_HTTP is limited to configured local test origins")
	}
	if c.CPUMaxPercent <= 0 {
		return fmt.Errorf("NEHEMIAH_CPU_MAX_PCT must be positive")
	}
	if c.PidsMax <= 0 {
		return fmt.Errorf("NEHEMIAH_PIDS_MAX must be positive")
	}
	if c.OverlayQuotaMB <= 0 {
		return fmt.Errorf("NEHEMIAH_OVERLAY_QUOTA_MB must be positive")
	}
	if c.MaxVCPUsPerMachine <= 0 || c.MaxMemoryMBPerMachine <= 0 {
		return fmt.Errorf("per-machine CPU and memory maxima must be positive")
	}
	if c.MaxForkOperations <= 0 || c.MaxForkOperations > maxDurableForkOperations {
		return fmt.Errorf("NEHEMIAH_MAX_FORK_OPERATIONS must be between 1 and %d", maxDurableForkOperations)
	}
	if c.IOReadBPS < 0 || c.IOWriteBPS < 0 {
		return fmt.Errorf("I/O limits cannot be negative")
	}
	if c.NetEnable {
		if !networkInterfacePattern.MatchString(c.NetBridge) {
			return fmt.Errorf("NEHEMIAH_NET_BRIDGE is invalid")
		}
		ip := net.ParseIP(c.NetSubnet + ".1")
		if ip == nil || ip.To4() == nil || !ip.IsPrivate() {
			return fmt.Errorf("NEHEMIAH_NET_SUBNET must be a private IPv4 /24 prefix such as 10.200.0")
		}
		listenHost, listenPort, err := net.SplitHostPort(c.egressDNSListen())
		if err != nil || listenHost != c.NetSubnet+".1" || listenPort != "53" {
			return fmt.Errorf("NEHEMIAH_EGRESS_DNS_LISTEN must be the managed bridge gateway %s.1:53", c.NetSubnet)
		}
		upstream, err := netip.ParseAddrPort(c.egressDNSUpstream())
		upstreamIP := upstream.Addr().Unmap()
		if err != nil || upstream.Addr().Zone() != "" || upstream.Port() == 0 || !upstreamIP.IsValid() || addressDeniedByPrefixes(upstreamIP, configuredHardDenyPrefixes(c)) {
			return fmt.Errorf("NEHEMIAH_EGRESS_DNS_UPSTREAM must be a public literal IP:port")
		}
		if len(c.EgressDenyCIDRs) > maxEgressRules {
			return fmt.Errorf("NEHEMIAH_EGRESS_DENY_CIDRS is limited to %d entries", maxEgressRules)
		}
		for _, raw := range c.EgressDenyCIDRs {
			prefix, prefixErr := netip.ParsePrefix(raw)
			if _, ok := canonicalEgressPrefix(prefix); prefixErr != nil || !ok {
				return fmt.Errorf("invalid NEHEMIAH_EGRESS_DENY_CIDRS entry %q", raw)
			}
		}
	}
	if !c.NehemiahMode {
		return nil
	}
	if err := c.validateManagedReleasePolicy(); err != nil {
		return err
	}
	if c.MaxMachines > maxManagedMeteredMachines {
		return fmt.Errorf("NEHEMIAH_MAX cannot exceed the durable metering state bound of %d", maxManagedMeteredMachines)
	}
	if c.AgentMaxSteps < 1 || c.AgentMaxSteps > shellAgentStepLimit {
		return fmt.Errorf("NEHEMIAH_AGENT_MAX_STEPS must be between 1 and %d in Nehemiah mode", shellAgentStepLimit)
	}
	if c.AgentMaxConcurrent < 1 || c.AgentMaxConcurrent > 32 {
		return fmt.Errorf("NEHEMIAH_AGENT_MAX_CONCURRENT must be between 1 and 32 in Nehemiah mode")
	}
	if c.DailyAgentMax < 1 || c.DailyAgentMax > 10_000 {
		return fmt.Errorf("NEHEMIAH_DAILY_AGENT_MAX must be between 1 and 10000 in Nehemiah mode")
	}
	if !hostIdentityPattern.MatchString(c.HostID) {
		return fmt.Errorf("NEHEMIAH_HOST_ID is required and must contain only letters, digits, dot, underscore, or dash")
	}
	if !hostIdentityPattern.MatchString(c.Region) {
		return fmt.Errorf("NEHEMIAH_REGION is required and must contain only letters, digits, dot, underscore, or dash")
	}
	if !validBearerCredential(c.InternalToken) {
		return fmt.Errorf("NEHEMIAH_INTERNAL_TOKEN must contain 32-4096 printable non-whitespace characters in Nehemiah mode")
	}
	if !validBearerCredential(c.Token) {
		return fmt.Errorf("NEHEMIAH_TOKEN must be a unique 32-4096 character managed-host gateway credential")
	}
	if c.InternalToken == c.Token {
		return fmt.Errorf("NEHEMIAH_INTERNAL_TOKEN must differ from NEHEMIAH_TOKEN")
	}
	if c.FleetBootstrapToken != "" {
		if !enrollmentGrantPattern.MatchString(c.FleetBootstrapToken) {
			return fmt.Errorf("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN must be a 256-bit nhe_ enrollment grant")
		}
		if c.FleetBootstrapToken == c.InternalToken {
			return fmt.Errorf("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN must differ from NEHEMIAH_INTERNAL_TOKEN")
		}
		if c.FleetBootstrapToken == c.Token {
			return fmt.Errorf("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN must differ from NEHEMIAH_TOKEN")
		}
	}
	if c.ControlPlaneURL == "" {
		return fmt.Errorf("NEHEMIAH_CONTROL_PLANE_URL is required in Nehemiah mode")
	}
	controlURL, err := url.Parse(c.ControlPlaneURL)
	if err != nil || controlURL.Host == "" || (controlURL.Scheme != "https" && controlURL.Scheme != "http") {
		return fmt.Errorf("NEHEMIAH_CONTROL_PLANE_URL must be an absolute http or https URL")
	}
	if controlURL.User != nil || controlURL.RawQuery != "" || controlURL.Fragment != "" || (controlURL.Path != "" && controlURL.Path != "/") {
		return fmt.Errorf("NEHEMIAH_CONTROL_PLANE_URL cannot contain credentials, a path, query, or fragment")
	}
	if controlURL.Scheme != "https" && !c.ControlPlaneHTTP {
		return fmt.Errorf("NEHEMIAH_CONTROL_PLANE_URL must use https (set NEHEMIAH_CONTROL_PLANE_ALLOW_HTTP=1 only on a private development network)")
	}
	advertiseIP := net.ParseIP(c.AdvertiseAddress)
	if advertiseIP == nil || !advertiseIP.IsPrivate() || advertiseIP.IsLoopback() || advertiseIP.IsUnspecified() {
		return fmt.Errorf("NEHEMIAH_ADVERTISE_ADDRESS must be a literal private WireGuard IP address")
	}
	if !hostIdentityPattern.MatchString(c.ProviderID) {
		return fmt.Errorf("NEHEMIAH_PROVIDER_ID is required and must contain only letters, digits, dot, underscore, or dash")
	}
	if c.EnrollmentPath == "" || !filepath.IsAbs(c.EnrollmentPath) {
		return fmt.Errorf("NEHEMIAH_ENROLLMENT_PATH must be absolute")
	}
	if c.EnvironmentFile != "" && !filepath.IsAbs(c.EnvironmentFile) {
		return fmt.Errorf("NEHEMIAH_ENV_FILE must be absolute")
	}
	if c.HeartbeatInterval < 5*time.Second || c.HeartbeatInterval > 20*time.Second {
		return fmt.Errorf("NEHEMIAH_HEARTBEAT_SECONDS must be between 5 and 20")
	}
	listenHost, listenPort, err := net.SplitHostPort(c.Addr)
	if err != nil || listenPort != "8080" {
		return fmt.Errorf("NEHEMIAH_ADDR must listen on port 8080 in Nehemiah mode")
	}
	listenIP := net.ParseIP(listenHost)
	if listenIP == nil || !listenIP.Equal(advertiseIP) {
		return fmt.Errorf("NEHEMIAH_ADDR must bind the exact private NEHEMIAH_ADVERTISE_ADDRESS in Nehemiah mode")
	}
	if !c.JailerEnable {
		return fmt.Errorf("NEHEMIAH_JAILER=1 is mandatory in Nehemiah mode")
	}
	if !c.CgroupEnable {
		return fmt.Errorf("NEHEMIAH_CGROUP=1 is mandatory in Nehemiah mode")
	}
	if !c.NetEnable {
		return fmt.Errorf("NEHEMIAH_NET=1 is mandatory in Nehemiah mode so private preview routing is available")
	}
	if c.JailerUID <= 0 || c.JailerGID <= 0 {
		return fmt.Errorf("jailer uid and gid must be unprivileged in Nehemiah mode")
	}
	if c.JailerUID > 60000-c.MaxMachines+1 || c.JailerGID > 60000-c.MaxMachines+1 {
		return fmt.Errorf("managed jailer uid/gid ranges must fit below 60001")
	}
	if err := c.RuntimeCohort.Validate(); err != nil {
		return fmt.Errorf("managed runtime cohort is invalid: %w", err)
	}
	if c.IOReadBPS == 0 || c.IOWriteBPS == 0 {
		return fmt.Errorf("per-machine I/O throttles are mandatory in Nehemiah mode")
	}
	for name, path := range map[string]string{
		"NEHEMIAH_FIRECRACKER_BIN": c.FirecrackerBin,
		"NEHEMIAH_SYSTEMD_RUN_BIN": c.SystemdRunBin,
		"NEHEMIAH_SYSTEMCTL_BIN":   c.SystemctlBin,
		"NEHEMIAH_KERNEL":          c.KernelPath,
		"NEHEMIAH_ROOTFS":          c.BaseRootfs,
		"NEHEMIAH_DESKTOP_ROOTFS":  c.DesktopRootfs,
		"NEHEMIAH_TEMPLATES":       c.TemplatesDir,
		"NEHEMIAH_RUN":             c.RunDir,
		"NEHEMIAH_JAILER_BIN":      c.JailerBin,
		"NEHEMIAH_CHROOT_BASE":     c.ChrootBase,
	} {
		if !managedScopeSafePath(path) {
			return fmt.Errorf("%s must be a clean absolute path containing only letters, digits, slash, dot, underscore, or dash", name)
		}
	}
	return nil
}

// validateManagedReleasePolicy makes the private-beta host contract a build
// invariant instead of an operator-tunable profile. These values affect the
// isolation boundary, schedulable capacity, or externally reachable surface.
// A managed host whose root-owned environment drifts from the signed release
// is therefore rejected at startup. Local/self-hosted mode remains tunable.
func (c Config) validateManagedReleasePolicy() error {
	type policyCheck struct {
		name string
		ok   bool
	}
	checks := []policyCheck{
		{"NEHEMIAH_STATE_PATH", c.StatePath == "/var/lib/nehemiahd/state.json"},
		{"NEHEMIAH_ENROLLMENT_PATH", c.EnrollmentPath == "/var/lib/nehemiahd/enrollment.json"},
		{"NEHEMIAH_ENV_FILE", c.EnvironmentFile == "/etc/boring/nehemiahd.env"},
		{"NEHEMIAH_HEARTBEAT_SECONDS", c.HeartbeatInterval == 10*time.Second},
		{"NEHEMIAH_CONTROL_PLANE_ALLOW_HTTP", !c.ControlPlaneHTTP},
		{"NEHEMIAH_CORS_ORIGIN", c.CORSOrigin == ""},
		{"NEHEMIAH_MAX", c.MaxMachines == 20},
		{"NEHEMIAH_MAX_TEMPLATES", c.MaxTemplates == 10},
		{"NEHEMIAH_MAX_FORKS", c.MaxForks == 8},
		{"NEHEMIAH_MAX_FORK_OPERATIONS", c.MaxForkOperations == maxDurableForkOperations},
		{"NEHEMIAH_MEM_RESERVE_MB", c.MemReserveMB == 3072},
		{"NEHEMIAH_FIRECRACKER_BIN", c.FirecrackerBin == "/opt/boring/bin/firecracker"},
		{"NEHEMIAH_SYSTEMD_RUN_BIN", c.SystemdRunBin == "/usr/bin/systemd-run"},
		{"NEHEMIAH_SYSTEMCTL_BIN", c.SystemctlBin == "/usr/bin/systemctl"},
		{"NEHEMIAH_KERNEL", c.KernelPath == "/opt/boring/kernel/vmlinux"},
		{"NEHEMIAH_ROOTFS", c.BaseRootfs == "/opt/boring/rootfs/rootfs.ext4"},
		{"NEHEMIAH_DESKTOP_ROOTFS", c.DesktopRootfs == "/opt/boring/rootfs/desktop.ext4"},
		{"NEHEMIAH_TEMPLATES", c.TemplatesDir == "/opt/boring/templates"},
		{"NEHEMIAH_RUN", c.RunDir == "/opt/boring/run"},
		{"NEHEMIAH_DEFAULT_TTL", c.DefaultTTL == 120},
		{"NEHEMIAH_MIN_TTL", c.MinTTL == 15},
		{"NEHEMIAH_MAX_TTL", c.MaxTTL == 86400},
		{"NEHEMIAH_ALLOW_PERSISTENT", !c.AllowPersistent},
		{"NEHEMIAH_VCPUS", c.VCPUs == 1},
		{"NEHEMIAH_MEMORY_MB", c.MemSizeMB == 256},
		{"NEHEMIAH_MAX_VCPUS_PER_MACHINE", c.MaxVCPUsPerMachine == 4},
		{"NEHEMIAH_MAX_MEMORY_MB_PER_MACHINE", c.MaxMemoryMBPerMachine == 4096},
		{"NEHEMIAH_PER_IP_MAX", c.PerIPMax == 2},
		{"NEHEMIAH_CREATE_RATE", c.CreateRatePerMin == 8},
		{"NEHEMIAH_TRUST_PROXY", !c.TrustProxy},
		{"NEHEMIAH_CGROUP", c.CgroupEnable},
		{"NEHEMIAH_CPU_MAX_PCT", c.CPUMaxPercent == 100},
		{"NEHEMIAH_PIDS_MAX", c.PidsMax == 512},
		{"NEHEMIAH_IO_READ_BPS", c.IOReadBPS == 64*1024*1024},
		{"NEHEMIAH_IO_WRITE_BPS", c.IOWriteBPS == 64*1024*1024},
		{"NEHEMIAH_OVERLAY_QUOTA_MB", c.OverlayQuotaMB == 20480},
		{"NEHEMIAH_NET", c.NetEnable},
		{"NEHEMIAH_NET_BRIDGE", c.NetBridge == "boring0"},
		{"NEHEMIAH_NET_SUBNET", c.NetSubnet == "10.200.0"},
		{"NEHEMIAH_EGRESS_DNS_LISTEN", c.EgressDNSListen == "10.200.0.1:53"},
		{"NEHEMIAH_EGRESS_DNS_UPSTREAM", c.EgressDNSUpstream == "1.1.1.1:53"},
		{"NEHEMIAH_EGRESS_DENY_CIDRS", len(c.EgressDenyCIDRs) == 0},
		{"NEHEMIAH_PREVIEW_BASE", c.PreviewBase == ""},
		{"NEHEMIAH_LEASES", c.LeasesPath == "/var/lib/misc/dnsmasq.leases"},
		{"NEHEMIAH_S3_ENDPOINT", c.S3Endpoint == ""},
		{"NEHEMIAH_S3_KEY", c.S3Key == ""},
		{"NEHEMIAH_S3_SECRET", c.S3Secret == ""},
		{"NEHEMIAH_S3_BUCKET", c.S3Bucket == "boring-volumes"},
		{"NEHEMIAH_S3_REGION", c.S3Region == ""},
		{"NEHEMIAH_S3_SSL", !c.S3UseSSL},
		{"NEHEMIAH_VOLUME_QUOTA_MB", c.VolumeQuotaMB == 256},
		{"NEHEMIAH_VOLUME_TTL", c.VolumeTTLDefault == 86400},
		{"NEHEMIAH_VOLUME_TTL_MAX", c.VolumeTTLMax == 604800},
		{"NEHEMIAH_VOLUME_RATE", c.VolumeRatePerMin == 10},
		{"NEHEMIAH_DESKTOP_POOL", c.DesktopPool == 1},
		{"NEHEMIAH_OPENROUTER_KEY", c.OpenRouterKey == ""},
		{"NEHEMIAH_INFER_MAX_TOKENS", c.InferenceMaxTokens == 1024},
		{"NEHEMIAH_INFER_RATE", c.InferenceRatePerMin == 20},
		{"NEHEMIAH_DAILY_AGENT_MAX", c.DailyAgentMax == 200},
		{"NEHEMIAH_DAILY_INFER_MAX", c.DailyInferMax == 3000},
		{"NEHEMIAH_ANTHROPIC_KEY", c.AnthropicKey == ""},
		{"NEHEMIAH_AGENT_MODEL", c.AgentModel == "claude-opus-4-8"},
		{"NEHEMIAH_AGENT_MAX_STEPS", c.AgentMaxSteps == shellAgentStepLimit},
		{"NEHEMIAH_AGENT_MAX_CONCURRENT", c.AgentMaxConcurrent == 2},
		{"NEHEMIAH_JAILER", c.JailerEnable},
		{"NEHEMIAH_JAILER_BIN", c.JailerBin == "/opt/boring/bin/jailer"},
		{"NEHEMIAH_JAILER_UID", c.JailerUID == 30000},
		{"NEHEMIAH_JAILER_GID", c.JailerGID == 30000},
		{"NEHEMIAH_CHROOT_BASE", c.ChrootBase == "/srv/jailer"},
		{"NEHEMIAH_TEMPLATE_OBJECT_ALLOW_HTTP", !c.TemplateObjectAllowHTTP},
	}
	for _, check := range checks {
		if !check.ok {
			return fmt.Errorf("%s differs from the signed managed-host release policy", check.name)
		}
	}
	return nil
}

// ValidateRuntime checks host files which cannot be validated from values
// alone. It is called before the daemon starts accepting traffic.
func (c *Config) ValidateRuntime() (result error) {
	if !c.NehemiahMode {
		return nil
	}
	networkOps := defaultManagedNetworkRuntimeOps()
	defer func() {
		if result != nil {
			result = errors.Join(result, wrapError("isolate managed guest network", isolateManagedNetworkRuntime(networkOps)))
		}
	}()
	if err := validateManagedRuntimeAssets(*c, true); err != nil {
		return fmt.Errorf("managed runtime assets unavailable: %w", err)
	}
	runtimeAssetGuard, err := initializeManagedRuntimeAssetGuard(*c)
	if err != nil {
		return fmt.Errorf("managed runtime cohort mismatch: %w", err)
	}
	c.runtimeAssetGuard = runtimeAssetGuard
	for name, path := range map[string]string{
		"firecracker": c.FirecrackerBin,
		"jailer":      c.JailerBin,
		"kernel":      c.KernelPath,
		"systemd-run": c.SystemdRunBin,
		"systemctl":   c.SystemctlBin,
	} {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("%s unavailable at %s: %w", name, path, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%s path %s is not a regular file", name, path)
		}
		if name != "kernel" && info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("%s path %s is not executable", name, path)
		}
	}
	if err := probeManagedScopeRuntime(*c); err != nil {
		return fmt.Errorf("managed systemd scope runtime unavailable: %w", err)
	}
	if _, err := os.Stat("/dev/kvm"); err != nil {
		return fmt.Errorf("KVM unavailable: %w", err)
	}
	if _, err := exec.LookPath("resize2fs"); err != nil {
		return fmt.Errorf("resize2fs is required for per-machine disk sizing: %w", err)
	}
	if c.NetEnable {
		if _, err := os.Stat(filepath.Join("/sys/class/net", c.NetBridge)); err != nil {
			return fmt.Errorf("guest bridge %s unavailable: %w", c.NetBridge, err)
		}
		if _, err := exec.LookPath("bridge"); err != nil {
			return fmt.Errorf("bridge is required for managed guest L2 isolation: %w", err)
		}
		if _, err := exec.LookPath("iptables"); err != nil {
			return fmt.Errorf("iptables is required for managed guest egress isolation: %w", err)
		}
		if _, err := exec.LookPath("ipset"); err != nil {
			return fmt.Errorf("ipset is required for managed guest egress allowlists: %w", err)
		}
		if err := validateManagedNetworkRuntime(*c, networkOps); err != nil {
			return fmt.Errorf("managed guest network policy is unavailable: %w", err)
		}
	}
	return nil
}

// ClampTTL applies the default when ttl <= 0 and clamps into [MinTTL, MaxTTL].
func (c Config) ClampTTL(ttl int) int {
	if ttl <= 0 {
		ttl = c.DefaultTTL
	}
	if ttl < c.MinTTL {
		ttl = c.MinTTL
	}
	if ttl > c.MaxTTL {
		ttl = c.MaxTTL
	}
	return ttl
}

func (c Config) egressDNSListen() string {
	if c.EgressDNSListen != "" {
		return c.EgressDNSListen
	}
	return net.JoinHostPort(c.NetSubnet+".1", "53")
}

func (c Config) egressDNSUpstream() string {
	if c.EgressDNSUpstream != "" {
		return c.EgressDNSUpstream
	}
	return "1.1.1.1:53"
}

// getenv reads a NEHEMIAH_* variable, falling back to the BORING_* name it
// replaced in the Nehemiah rename. Hosts provisioned before the rename still
// export the old names, so both spellings keep working; the new one wins when
// both are set.
func getenv(key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	if legacy, ok := strings.CutPrefix(key, "NEHEMIAH_"); ok {
		return os.Getenv("BORING_" + legacy)
	}
	return ""
}

// credentialEnv deliberately disables BORING_* fallback in managed mode. A
// pre-rename fleet-global token must never silently become a host's control or
// gateway identity; managed cloud-init provisions explicit per-host values.
func credentialEnv(managed bool, key string) string {
	if managed {
		return os.Getenv(key)
	}
	return getenv(key)
}

func envStr(key, def string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envCSV(key string) []string {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			values = append(values, value)
		}
	}
	return values
}

package main

import (
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration for nehemiahd. Values come from env with
// the fixed defaults described in the Nehemiah contract. Legacy BORING_* names
// are still honored — see getenv.
type Config struct {
	// Listen address for the HTTP/WS server.
	Addr string

	// Token, if non-empty, requires "Authorization: Bearer <token>" on /v1/*
	// routes (and ?token= on the WebSocket route). /healthz is always open.
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

	// MemReserveMB is host RAM kept free — boot is refused if a new VM would eat
	// into it, so the box gracefully hits capacity instead of OOMing. 0 disables.
	MemReserveMB int

	// Fixed host paths (created by bootstrap).
	FirecrackerBin string // /opt/boring/bin/firecracker
	KernelPath     string // /opt/boring/kernel/vmlinux
	BaseRootfs     string // /opt/boring/rootfs/rootfs.ext4
	DesktopRootfs  string // /opt/boring/rootfs/desktop.ext4
	TemplatesDir   string // /opt/boring/templates
	RunDir         string // /opt/boring/run

	// TTL clamp bounds (seconds) and default.
	DefaultTTL int
	MinTTL     int
	MaxTTL     int

	// AllowPersistent lets a request opt out of the TTL entirely (a machine that
	// runs until explicitly stopped). Off by default so a public instance can't be
	// drained by never-expiring machines; self-hosters set NEHEMIAH_ALLOW_PERSISTENT=1.
	AllowPersistent bool

	// Guest machine sizing.
	VCPUs     int
	MemSizeMB int

	// Public-facing abuse controls.
	PerIPMax         int  // max concurrent machines per client IP
	CreateRatePerMin int  // max creations per minute per client IP
	TrustProxy       bool // read client IP from X-Forwarded-For (behind Caddy)

	// Per-VM cgroup v2 caps (0 disables that limit).
	CgroupEnable  bool
	CPUMaxPercent int // host CPU % cap per VM (e.g. 100 = 1 core)
	PidsMax       int // max host-visible pids for the firecracker child

	// Guest internet: attach a NIC per cold-booted VM, NAT out via the host. The
	// host side (bridge, dnsmasq, egress firewall) is set up by net-setup.sh.
	NetEnable bool   // NEHEMIAH_NET=="1"
	NetBridge string // bridge to attach taps to (default boring0)
	NetSubnet string // guest /24 prefix, e.g. 10.200.0 (gateway .1)

	// Preview: expose a guest port at <id>--<port>.<PreviewBase>.
	PreviewBase string // NEHEMIAH_PREVIEW_BASE, e.g. previews.example.com ("" disables previews)
	LeasesPath  string // dnsmasq lease file, for guest IP lookup

	// Storage: persistent volumes on an S3-compatible store (MinIO / Latitude).
	// Enabled when S3Endpoint is set.
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
}

// LoadConfig builds a Config from the environment, applying the fixed defaults.
func LoadConfig() Config {
	c := Config{
		Addr:                envStr("NEHEMIAH_ADDR", "0.0.0.0:8080"),
		Token:               getenv("NEHEMIAH_TOKEN"),
		CORSOrigin:          getenv("NEHEMIAH_CORS_ORIGIN"),
		MaxMachines:         envInt("NEHEMIAH_MAX", 20),
		MaxTemplates:        envInt("NEHEMIAH_MAX_TEMPLATES", 10),
		MaxForks:            envInt("NEHEMIAH_MAX_FORKS", 8),
		AllowPersistent:     getenv("NEHEMIAH_ALLOW_PERSISTENT") == "1",
		MemReserveMB:        envInt("NEHEMIAH_MEM_RESERVE_MB", 3072),
		FirecrackerBin:      envStr("NEHEMIAH_FIRECRACKER_BIN", "/opt/boring/bin/firecracker"),
		KernelPath:          envStr("NEHEMIAH_KERNEL", "/opt/boring/kernel/vmlinux"),
		BaseRootfs:          envStr("NEHEMIAH_ROOTFS", "/opt/boring/rootfs/rootfs.ext4"),
		DesktopRootfs:       envStr("NEHEMIAH_DESKTOP_ROOTFS", "/opt/boring/rootfs/desktop.ext4"),
		TemplatesDir:        envStr("NEHEMIAH_TEMPLATES", "/opt/boring/templates"),
		RunDir:              envStr("NEHEMIAH_RUN", "/opt/boring/run"),
		DefaultTTL:          120,
		MinTTL:              15,
		MaxTTL:              900,
		VCPUs:               1,
		MemSizeMB:           256,
		PerIPMax:            envInt("NEHEMIAH_PER_IP_MAX", 2),
		CreateRatePerMin:    envInt("NEHEMIAH_CREATE_RATE", 8),
		TrustProxy:          getenv("NEHEMIAH_TRUST_PROXY") == "1",
		CgroupEnable:        getenv("NEHEMIAH_CGROUP") != "0",
		CPUMaxPercent:       envInt("NEHEMIAH_CPU_MAX_PCT", 150),
		PidsMax:             envInt("NEHEMIAH_PIDS_MAX", 512),
		NetEnable:           getenv("NEHEMIAH_NET") == "1",
		NetBridge:           envStr("NEHEMIAH_NET_BRIDGE", "boring0"),
		NetSubnet:           envStr("NEHEMIAH_NET_SUBNET", "10.200.0"),
		PreviewBase:         getenv("NEHEMIAH_PREVIEW_BASE"), // deployment-specific; unset disables previews
		LeasesPath:          envStr("NEHEMIAH_LEASES", "/var/lib/misc/dnsmasq.leases"),
		S3Endpoint:          getenv("NEHEMIAH_S3_ENDPOINT"),
		S3Key:               getenv("NEHEMIAH_S3_KEY"),
		S3Secret:            getenv("NEHEMIAH_S3_SECRET"),
		S3Bucket:            envStr("NEHEMIAH_S3_BUCKET", "boring-volumes"),
		S3Region:            getenv("NEHEMIAH_S3_REGION"),
		S3UseSSL:            getenv("NEHEMIAH_S3_SSL") == "1",
		VolumeQuotaMB:       envInt("NEHEMIAH_VOLUME_QUOTA_MB", 256),
		VolumeTTLDefault:    envInt("NEHEMIAH_VOLUME_TTL", 86400),
		VolumeTTLMax:        envInt("NEHEMIAH_VOLUME_TTL_MAX", 604800),
		VolumeRatePerMin:    envInt("NEHEMIAH_VOLUME_RATE", 10),
		DesktopPool:         envInt("NEHEMIAH_DESKTOP_POOL", 1),
		OpenRouterKey:       getenv("NEHEMIAH_OPENROUTER_KEY"),
		InferenceMaxTokens:  envInt("NEHEMIAH_INFER_MAX_TOKENS", 1024),
		InferenceRatePerMin: envInt("NEHEMIAH_INFER_RATE", 20),
		DailyAgentMax:       envInt("NEHEMIAH_DAILY_AGENT_MAX", 200),
		DailyInferMax:       envInt("NEHEMIAH_DAILY_INFER_MAX", 3000),
		AnthropicKey:        getenv("NEHEMIAH_ANTHROPIC_KEY"),
		AgentModel:          envStr("NEHEMIAH_AGENT_MODEL", "claude-opus-4-8"),
		AgentMaxSteps:       envInt("NEHEMIAH_AGENT_MAX_STEPS", 30),
		AgentMaxConcurrent:  envInt("NEHEMIAH_AGENT_MAX_CONCURRENT", 2),
		JailerEnable:        getenv("NEHEMIAH_JAILER") == "1",
		JailerBin:           envStr("NEHEMIAH_JAILER_BIN", "/opt/boring/bin/jailer"),
		JailerUID:           envInt("NEHEMIAH_JAILER_UID", 30000),
		JailerGID:           envInt("NEHEMIAH_JAILER_GID", 991),
		ChrootBase:          envStr("NEHEMIAH_CHROOT_BASE", "/srv/jailer"),
	}
	if c.MaxMachines < 1 {
		c.MaxMachines = 1
	}
	return c
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

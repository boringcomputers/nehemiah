package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func validNehemiahConfig(t *testing.T) Config {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.JailerEnable = true
	cfg.CgroupEnable = true
	cfg.JailerBin = "/opt/boring/bin/jailer"
	cfg.FirecrackerBin = "/opt/boring/bin/firecracker"
	cfg.SystemdRunBin = "/usr/bin/systemd-run"
	cfg.SystemctlBin = "/usr/bin/systemctl"
	cfg.KernelPath = "/opt/boring/kernel/vmlinux"
	cfg.BaseRootfs = "/opt/boring/rootfs/rootfs.ext4"
	cfg.DesktopRootfs = "/opt/boring/rootfs/desktop.ext4"
	cfg.TemplatesDir = "/opt/boring/templates"
	cfg.RunDir = "/opt/boring/run"
	cfg.ChrootBase = "/srv/jailer"
	cfg.StatePath = "/var/lib/nehemiahd/state.json"
	cfg.ControlPlaneURL = "https://control.example.test"
	cfg.AdvertiseAddress = "10.64.0.2"
	cfg.ProviderID = "latitude-host-test"
	cfg.EnrollmentPath = "/var/lib/nehemiahd/enrollment.json"
	cfg.EnvironmentFile = "/etc/boring/nehemiahd.env"
	cfg.HeartbeatInterval = 10 * time.Second
	cfg.Addr = "10.64.0.2:8080"
	cfg.MaxMachines = 20
	cfg.MaxTemplates = 10
	cfg.MaxForks = 8
	cfg.MaxForkOperations = maxDurableForkOperations
	cfg.MemReserveMB = 3072
	cfg.DefaultTTL = 120
	cfg.MinTTL = 15
	cfg.MaxTTL = 86400
	cfg.AllowPersistent = false
	cfg.VCPUs = 1
	cfg.MemSizeMB = 256
	cfg.MaxVCPUsPerMachine = 4
	cfg.MaxMemoryMBPerMachine = 4096
	cfg.PerIPMax = 2
	cfg.CreateRatePerMin = 8
	cfg.TrustProxy = false
	cfg.CPUMaxPercent = 100
	cfg.PidsMax = 512
	cfg.JailerUID = 30000
	cfg.JailerGID = 30000
	cfg.RuntimeCohort = testRuntimeCohort()
	cfg.IOReadBPS = 64 * 1024 * 1024
	cfg.IOWriteBPS = 64 * 1024 * 1024
	cfg.OverlayQuotaMB = 20480
	cfg.NetEnable = true
	cfg.NetBridge = "boring0"
	cfg.NetSubnet = "10.200.0"
	cfg.EgressDNSListen = "10.200.0.1:53"
	cfg.EgressDNSUpstream = "1.1.1.1:53"
	cfg.LeasesPath = "/var/lib/misc/dnsmasq.leases"
	cfg.S3Bucket = "boring-volumes"
	cfg.VolumeQuotaMB = 256
	cfg.VolumeTTLDefault = 86400
	cfg.VolumeTTLMax = 604800
	cfg.VolumeRatePerMin = 10
	cfg.DesktopPool = 1
	cfg.InferenceMaxTokens = 1024
	cfg.InferenceRatePerMin = 20
	cfg.DailyAgentMax = 200
	cfg.DailyInferMax = 3000
	cfg.AgentModel = "claude-opus-4-8"
	cfg.AgentMaxSteps = shellAgentStepLimit
	cfg.AgentMaxConcurrent = 2
	cfg.Telemetry = TelemetryConfig{
		EnabledSetting: "true", Endpoint: "https://otel.example.test",
		Authorization: "Bearer telemetry-secret-value", ServiceVersion: "2026.08.09",
		InstanceID: "host-ca-1-a", DeploymentEnv: "staging",
		ExportInterval: 15 * time.Second, ExportTimeout: 10 * time.Second, TraceSample: 0.1,
	}
	return cfg
}

func TestNehemiahConfigRequiresIsolationBoundary(t *testing.T) {
	valid := validNehemiahConfig(t)
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"missing host id", func(cfg *Config) { cfg.HostID = "" }},
		{"short internal token", func(cfg *Config) { cfg.InternalToken = "short" }},
		{"shared public token", func(cfg *Config) { cfg.Token = cfg.InternalToken }},
		{"missing gateway token", func(cfg *Config) { cfg.Token = "" }},
		{"shared fleet bootstrap token", func(cfg *Config) { cfg.FleetBootstrapToken = cfg.InternalToken }},
		{"jailer disabled", func(cfg *Config) { cfg.JailerEnable = false }},
		{"cgroups disabled", func(cfg *Config) { cfg.CgroupEnable = false }},
		{"guest network disabled", func(cfg *Config) { cfg.NetEnable = false }},
		{"root jailer uid", func(cfg *Config) { cfg.JailerUID = 0 }},
		{"I/O throttle disabled", func(cfg *Config) { cfg.IOReadBPS = 0 }},
		{"missing systemd scope launcher", func(cfg *Config) { cfg.SystemdRunBin = "" }},
		{"systemd argv expansion path", func(cfg *Config) { cfg.JailerBin = "/opt/${INJECT}/jailer" }},
		{"unbounded fork history", func(cfg *Config) { cfg.MaxForkOperations = maxDurableForkOperations + 1 }},
		{"machines exceed durable metering state bound", func(cfg *Config) { cfg.MaxMachines = maxManagedMeteredMachines + 1 }},
		{"relative state path", func(cfg *Config) { cfg.StatePath = "state.json" }},
		{"missing control plane", func(cfg *Config) { cfg.ControlPlaneURL = "" }},
		{"insecure control plane", func(cfg *Config) { cfg.ControlPlaneURL = "http://10.64.0.1:8081" }},
		{"public advertised address", func(cfg *Config) { cfg.AdvertiseAddress = "203.0.113.8" }},
		{"wildcard host bind", func(cfg *Config) { cfg.Addr = "0.0.0.0:8080" }},
		{"different private host bind", func(cfg *Config) { cfg.Addr = "10.64.0.99:8080" }},
		{"hostname host bind", func(cfg *Config) { cfg.Addr = "localhost:8080" }},
		{"wrong host port", func(cfg *Config) { cfg.Addr = "10.64.0.2:9090" }},
		{"relative enrollment path", func(cfg *Config) { cfg.EnrollmentPath = "enrollment.json" }},
		{"zero agent steps", func(cfg *Config) { cfg.AgentMaxSteps = 0 }},
		{"excessive agent steps", func(cfg *Config) { cfg.AgentMaxSteps = shellAgentStepLimit + 1 }},
		{"zero concurrent agents", func(cfg *Config) { cfg.AgentMaxConcurrent = 0 }},
		{"excessive concurrent agents", func(cfg *Config) { cfg.AgentMaxConcurrent = 33 }},
		{"zero daily agent budget", func(cfg *Config) { cfg.DailyAgentMax = 0 }},
		{"excessive daily agent budget", func(cfg *Config) { cfg.DailyAgentMax = 10_001 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := valid
			test.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("unsafe configuration was accepted")
			}
		})
	}
}

func TestManagedReleasePolicyRejectsOneFieldDrift(t *testing.T) {
	valid := validNehemiahConfig(t)
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"state path", func(c *Config) { c.StatePath = "/var/lib/nehemiahd/other-state.json" }},
		{"enrollment path", func(c *Config) { c.EnrollmentPath = "/var/lib/nehemiahd/other-enrollment.json" }},
		{"environment path", func(c *Config) { c.EnvironmentFile = "/etc/boring/other.env" }},
		{"heartbeat interval", func(c *Config) { c.HeartbeatInterval = 11 * time.Second }},
		{"control plane http", func(c *Config) { c.ControlPlaneHTTP = true }},
		{"cors origin", func(c *Config) { c.CORSOrigin = "https://example.test" }},
		{"machine capacity", func(c *Config) { c.MaxMachines++ }},
		{"template capacity", func(c *Config) { c.MaxTemplates++ }},
		{"fork capacity", func(c *Config) { c.MaxForks-- }},
		{"fork history capacity", func(c *Config) { c.MaxForkOperations-- }},
		{"memory reserve", func(c *Config) { c.MemReserveMB-- }},
		{"firecracker path", func(c *Config) { c.FirecrackerBin += ".other" }},
		{"systemd-run path", func(c *Config) { c.SystemdRunBin += ".other" }},
		{"systemctl path", func(c *Config) { c.SystemctlBin += ".other" }},
		{"kernel path", func(c *Config) { c.KernelPath += ".other" }},
		{"python rootfs path", func(c *Config) { c.BaseRootfs += ".other" }},
		{"desktop rootfs path", func(c *Config) { c.DesktopRootfs += ".other" }},
		{"templates path", func(c *Config) { c.TemplatesDir += ".other" }},
		{"run path", func(c *Config) { c.RunDir += ".other" }},
		{"default ttl", func(c *Config) { c.DefaultTTL++ }},
		{"minimum ttl", func(c *Config) { c.MinTTL++ }},
		{"maximum ttl", func(c *Config) { c.MaxTTL-- }},
		{"persistent machines", func(c *Config) { c.AllowPersistent = true }},
		{"default vcpus", func(c *Config) { c.VCPUs++ }},
		{"default memory", func(c *Config) { c.MemSizeMB++ }},
		{"machine vcpu maximum", func(c *Config) { c.MaxVCPUsPerMachine++ }},
		{"machine memory maximum", func(c *Config) { c.MaxMemoryMBPerMachine++ }},
		{"per ip capacity", func(c *Config) { c.PerIPMax++ }},
		{"create rate", func(c *Config) { c.CreateRatePerMin++ }},
		{"trusted proxy", func(c *Config) { c.TrustProxy = true }},
		{"cgroup disabled", func(c *Config) { c.CgroupEnable = false }},
		{"cpu quota", func(c *Config) { c.CPUMaxPercent++ }},
		{"pid quota", func(c *Config) { c.PidsMax++ }},
		{"read bandwidth", func(c *Config) { c.IOReadBPS++ }},
		{"write bandwidth", func(c *Config) { c.IOWriteBPS++ }},
		{"overlay quota", func(c *Config) { c.OverlayQuotaMB++ }},
		{"network disabled", func(c *Config) { c.NetEnable = false }},
		{"bridge", func(c *Config) { c.NetBridge = "boring1" }},
		{"subnet", func(c *Config) { c.NetSubnet = "10.201.0"; c.EgressDNSListen = "10.201.0.1:53" }},
		{"dns listener", func(c *Config) { c.EgressDNSListen = "10.200.0.2:53" }},
		{"dns upstream", func(c *Config) { c.EgressDNSUpstream = "9.9.9.9:53" }},
		{"extra deny range", func(c *Config) { c.EgressDenyCIDRs = []string{"203.0.113.0/24"} }},
		{"host preview", func(c *Config) { c.PreviewBase = "preview.example.test" }},
		{"dhcp lease path", func(c *Config) { c.LeasesPath += ".other" }},
		{"s3 endpoint", func(c *Config) { c.S3Endpoint = "storage.example.test" }},
		{"s3 key", func(c *Config) { c.S3Key = "unexpected-key" }},
		{"s3 secret", func(c *Config) { c.S3Secret = "unexpected-secret" }},
		{"s3 bucket", func(c *Config) { c.S3Bucket = "other" }},
		{"s3 region", func(c *Config) { c.S3Region = "other" }},
		{"s3 tls", func(c *Config) { c.S3UseSSL = true }},
		{"volume quota", func(c *Config) { c.VolumeQuotaMB++ }},
		{"volume default ttl", func(c *Config) { c.VolumeTTLDefault++ }},
		{"volume maximum ttl", func(c *Config) { c.VolumeTTLMax++ }},
		{"volume rate", func(c *Config) { c.VolumeRatePerMin++ }},
		{"desktop pool", func(c *Config) { c.DesktopPool++ }},
		{"openrouter credential", func(c *Config) { c.OpenRouterKey = "unexpected-openrouter-key" }},
		{"inference tokens", func(c *Config) { c.InferenceMaxTokens++ }},
		{"inference rate", func(c *Config) { c.InferenceRatePerMin++ }},
		{"daily agent budget", func(c *Config) { c.DailyAgentMax++ }},
		{"daily inference budget", func(c *Config) { c.DailyInferMax++ }},
		{"anthropic credential", func(c *Config) { c.AnthropicKey = "unexpected-anthropic-key" }},
		{"agent model", func(c *Config) { c.AgentModel = "other-model" }},
		{"agent steps", func(c *Config) { c.AgentMaxSteps-- }},
		{"agent concurrency", func(c *Config) { c.AgentMaxConcurrent++ }},
		{"jailer disabled", func(c *Config) { c.JailerEnable = false }},
		{"jailer path", func(c *Config) { c.JailerBin += ".other" }},
		{"jailer uid base", func(c *Config) { c.JailerUID++ }},
		{"jailer gid base", func(c *Config) { c.JailerGID++ }},
		{"jailer chroot", func(c *Config) { c.ChrootBase += ".other" }},
		{"template http", func(c *Config) { c.TemplateObjectAllowHTTP = true }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("managed release-policy drift was accepted")
			}
		})
	}
}

func TestLocalModeKeepsReleasePolicySettingsConfigurable(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.MaxMachines = 7
	cfg.MaxTemplates = 3
	cfg.MaxForks = 2
	cfg.MemReserveMB = 512
	cfg.NetBridge = "prototype0"
	cfg.NetSubnet = "10.211.0"
	cfg.CPUMaxPercent = 175
	cfg.PidsMax = 192
	cfg.IOReadBPS = 4 * 1024 * 1024
	cfg.IOWriteBPS = 8 * 1024 * 1024
	cfg.OverlayQuotaMB = 4096
	if err := cfg.Validate(); err != nil {
		t.Fatalf("local prototype configuration rejected: %v", err)
	}
}

func TestTemplateObjectOriginIsExplicitAndHTTPSInManagedMode(t *testing.T) {
	managed := validNehemiahConfig(t)
	managed.TemplateObjectOrigin = "https://tenant-artifacts.objects.example.test"
	if err := managed.Validate(); err != nil {
		t.Fatalf("valid template object origin rejected: %v", err)
	}
	for _, mutate := range []func(*Config){
		func(cfg *Config) { cfg.TemplateObjectOrigin = "https://objects.example.test/path" },
		func(cfg *Config) { cfg.TemplateObjectOrigin = "https://credential@objects.example.test" },
		func(cfg *Config) { cfg.TemplateObjectOrigin = "http://objects.example.test" },
		func(cfg *Config) {
			cfg.TemplateObjectOrigin = ""
			cfg.TemplateObjectAllowHTTP = true
		},
	} {
		candidate := managed
		mutate(&candidate)
		if err := candidate.Validate(); err == nil {
			t.Fatalf("unsafe template object configuration accepted: %+v", candidate)
		}
	}
	local := internalTestConfig(t)
	local.TemplateObjectOrigin = "http://127.0.0.1:9000"
	local.TemplateObjectAllowHTTP = true
	if err := local.Validate(); err != nil {
		t.Fatalf("explicit local integration origin rejected: %v", err)
	}
}

func TestManagedGatewayCredentialCannotAuthorizeControlPlaneIntent(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	server := NewServer(cfg, NewManager(cfg))
	for _, test := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/v1/machines"},
		{http.MethodGet, "/v1/machines"},
		{http.MethodPost, "/v1/chat/completions"},
		{http.MethodGet, "/v1/templates"},
	} {
		request := httptest.NewRequest(test.method, test.path, nil)
		request.Header.Set("Authorization", "Bearer "+cfg.Token)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d, want 404", test.method, test.path, response.Code)
		}
	}
}

func TestManagedHostRejectsGatewayCredentialsInURLs(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	server := NewServer(cfg, NewManager(cfg))
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/machines/m_public-machine-123/download?path=file&token="+cfg.Token,
		nil,
	)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("query credential status = %d, want 401", response.Code)
	}
}

func TestGuestPreviewNeverReceivesHostOrLeaseCredentials(t *testing.T) {
	headers := http.Header{
		"Authorization":            {"Bearer host-wide-gateway-secret"},
		"Proxy-Authorization":      {"Basic proxy-secret"},
		"Cookie":                   {"capability=secret"},
		"X-Api-Key":                {"customer-secret"},
		"X-Nehemiah-Lease-Id":      {"lease-secret"},
		"X-Nehemiah-Internal-Test": {"internal-secret"},
		"Forwarded":                {"for=192.0.2.10"},
		"X-Forwarded-For":          {"192.0.2.10"},
		"X-Forwarded-Host":         {"preview.example.test"},
		"X-Real-Ip":                {"192.0.2.10"},
		"X-Application-Header":     {"preserved"},
	}
	stripGuestRequestHeaders(headers)
	for _, name := range []string{
		"Authorization",
		"Proxy-Authorization",
		"Cookie",
		"X-Api-Key",
		"X-Nehemiah-Lease-Id",
		"X-Nehemiah-Internal-Test",
		"Forwarded",
		"X-Forwarded-Host",
		"X-Real-Ip",
	} {
		if value := headers.Get(name); value != "" {
			t.Fatalf("guest-bound %s = %q, want stripped", name, value)
		}
	}
	if values, exists := headers["X-Forwarded-For"]; !exists || values != nil {
		t.Fatalf("X-Forwarded-For sentinel = %#v, want present nil", values)
	}
	if got := headers.Get("X-Application-Header"); got != "preserved" {
		t.Fatalf("application header = %q, want preserved", got)
	}
}

func TestWebProxyStripsCredentialsBeforeGuestRoundTrip(t *testing.T) {
	received := make(chan http.Header, 1)
	guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer guest.Close()
	_, rawPort, err := net.SplitHostPort(guest.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}

	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	machineID := "m-0123abcd"
	mgr.machines[machineID] = &Machine{
		ID:     machineID,
		Status: "running",
		driver: &fcDriver{ip: "127.0.0.1"},
	}
	server := NewServer(cfg, mgr)
	request := httptest.NewRequest(http.MethodGet, "/ignored", nil)
	request.SetPathValue("id", machineID)
	request.SetPathValue("port", strconv.Itoa(port))
	request.SetPathValue("path", "probe")
	request.Header.Set("Authorization", "Bearer host-wide-gateway-secret")
	request.Header.Set("Cookie", "capability=secret")
	request.Header.Set("X-Nehemiah-Lease-ID", "lease-secret")
	request.Header.Set("X-Application-Header", "preserved")
	response := httptest.NewRecorder()

	server.handleWebProxy(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("proxy status = %d, want 204", response.Code)
	}
	guestHeaders := <-received
	for _, name := range []string{
		"Authorization",
		"Cookie",
		"X-Nehemiah-Lease-ID",
		"X-Forwarded-For",
	} {
		if value := guestHeaders.Get(name); value != "" {
			t.Fatalf("guest received %s = %q", name, value)
		}
	}
	if got := guestHeaders.Get("X-Application-Header"); got != "preserved" {
		t.Fatalf("guest application header = %q, want preserved", got)
	}
}

func TestManagedTapEgressRuleFailsClosed(t *testing.T) {
	insert, err := tapEgressRuleArgs("bt0123abcd", true)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(insert, " "), "-I NEHEMIAH_FWD 1 -i bt0123abcd -j DROP"; got != want {
		t.Fatalf("insert rule = %q, want %q", got, want)
	}
	remove, err := tapEgressRuleArgs("bt0123abcd", false)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(remove, " "), "-D NEHEMIAH_FWD -i bt0123abcd -j DROP"; got != want {
		t.Fatalf("remove rule = %q, want %q", got, want)
	}
	if _, err := tapEgressRuleArgs("../../eth0", true); err == nil {
		t.Fatal("unsafe interface was accepted")
	}
}

func TestJailerCommandHasMandatorySecurityControls(t *testing.T) {
	cfg := validNehemiahConfig(t)
	template := Template{MemSizeMB: 512, VCPUs: 2}
	args := buildJailerArgs(cfg, "m-1234abcd", template, "system.slice/nehemiahd.service", "8:0 rbps=1 wbps=2")
	joined := strings.Join(args, " ")
	for _, required := range []string{
		"--id m-1234abcd",
		"--exec-file /opt/boring/bin/firecracker",
		"--uid 30000",
		"--gid 30000",
		"--cgroup-version 2",
		"cpu.max=200000 100000",
		"pids.max=512",
		"memory.max=671088640",
		"io.max=8:0 rbps=1 wbps=2",
		"-- --api-sock /run/fc.sock",
	} {
		if !strings.Contains(joined, required) {
			t.Errorf("jailer args missing %q: %s", required, joined)
		}
	}
	if strings.Contains(joined, "--no-seccomp") {
		t.Fatalf("seccomp disabled in command: %s", joined)
	}
}

func TestCPUQuotaMatchesDeclaredVCPUs(t *testing.T) {
	cfg := validNehemiahConfig(t)
	cfg.CPUMaxPercent = 100
	for _, test := range []struct {
		vcpus int
		quota int
	}{
		{vcpus: 1, quota: 100000},
		{vcpus: 2, quota: 200000},
		{vcpus: 4, quota: 400000},
	} {
		t.Run(strconv.Itoa(test.vcpus)+" vCPU", func(t *testing.T) {
			template := Template{VCPUs: test.vcpus}
			if got := cpuQuotaMicros(cfg, template); got != test.quota {
				t.Fatalf("cpu quota = %d, want %d", got, test.quota)
			}
			args := strings.Join(buildJailerArgs(cfg, "m-quota", template, "system.slice/nehemiahd.service", ""), " ")
			want := fmt.Sprintf("cpu.max=%d 100000", test.quota)
			if !strings.Contains(args, want) {
				t.Fatalf("jailer args %q do not contain %q", args, want)
			}
		})
	}
}

func TestUnsafeMachineIDAndOverlayAreRejected(t *testing.T) {
	cfg := internalTestConfig(t)
	if _, _, _, err := bootMachine(cfg, "../../escape", Template{}, "", false, false, 0); err == nil {
		t.Fatal("unsafe machine id accepted")
	}
	rootfs := filepath.Join(t.TempDir(), "rootfs.ext4")
	if err := os.WriteFile(rootfs, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(rootfs, 2*1024*1024); err != nil {
		t.Fatal(err)
	}
	if err := enforceOverlayQuota(rootfs, 1, 0); err == nil {
		t.Fatal("rootfs larger than quota accepted")
	}
	if err := enforceOverlayQuota(rootfs, 8, 1); !errors.Is(err, ErrInvalidResources) {
		t.Fatalf("small requested disk error = %v, want ErrInvalidResources", err)
	}
}

func TestNetworkIsGrantedPerMachineNotPerHost(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NetEnable = true
	cfg.NetSubnet = "10.200.0"
	cfg.NetBridge = "boring0"
	cfg.JailerEnable = true
	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	requested := make([]bool, 0, 2)
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		requested = append(requested, network)
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, network: network}, "coldboot", 1, nil
	}
	if _, err := mgr.Create("python", 120, false, true, "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.Create("python", 120, true, true, "two"); err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 || requested[0] || !requested[1] {
		t.Fatalf("network boot intents = %v, want [false true]", requested)
	}
}

func TestSnapshotRestoreOverridesVsockSocket(t *testing.T) {
	temp := t.TempDir()
	for _, name := range []string{"snapshot_file", "mem_file"} {
		if err := os.WriteFile(filepath.Join(temp, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var load map[string]any
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/snapshot/load" {
			if err := json.NewDecoder(request.Body).Decode(&load); err != nil {
				t.Fatal(err)
			}
		}
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(bytes.NewReader(nil))}, nil
	})}
	driver := &fcDriver{
		apiClt:    client,
		apiRootfs: filepath.Join(temp, "overlay.ext4"),
		apiVsock:  filepath.Join(temp, "new-vsock.sock"),
		vsockUDS:  filepath.Join(temp, "new-vsock.sock"),
	}
	if err := driver.restoreSnapshot(temp, driver.apiRootfs); err != nil {
		t.Fatal(err)
	}
	override, ok := load["vsock_override"].(map[string]any)
	if !ok || override["uds_path"] != driver.apiVsock {
		t.Fatalf("snapshot load vsock_override = %#v", load["vsock_override"])
	}
}

func TestPersistedPathsCannotEscapeRuntimeRoots(t *testing.T) {
	root := t.TempDir()
	if pathWithin(filepath.Join(root, "../escape"), root) {
		t.Fatal("path traversal accepted")
	}
	if !pathWithin(filepath.Join(root, "machine.sock"), root) {
		t.Fatal("valid runtime path rejected")
	}
}

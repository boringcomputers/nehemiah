package main

import (
	"testing"
	"time"
)

// The Nehemiah rename moved every BORING_* variable to NEHEMIAH_*. Hosts
// provisioned before the rename still export the old names, so getenv falls
// back to them; these cover that contract.

func TestGetenvPrefersNewName(t *testing.T) {
	t.Setenv("NEHEMIAH_TOKEN", "new")
	t.Setenv("BORING_TOKEN", "old")
	if got := getenv("NEHEMIAH_TOKEN"); got != "new" {
		t.Fatalf("getenv = %q, want %q (new name must win when both are set)", got, "new")
	}
}

func TestGetenvFallsBackToLegacyName(t *testing.T) {
	t.Setenv("BORING_TOKEN", "old")
	if got := getenv("NEHEMIAH_TOKEN"); got != "old" {
		t.Fatalf("getenv = %q, want %q (legacy name must still work)", got, "old")
	}
}

func TestGetenvEmptyNewNameFallsBack(t *testing.T) {
	// An explicitly empty NEHEMIAH_* is treated as unset, matching envStr/envInt.
	t.Setenv("NEHEMIAH_TOKEN", "")
	t.Setenv("BORING_TOKEN", "old")
	if got := getenv("NEHEMIAH_TOKEN"); got != "old" {
		t.Fatalf("getenv = %q, want %q", got, "old")
	}
}

func TestGetenvUnprefixedKeyHasNoFallback(t *testing.T) {
	t.Setenv("BORING_TOKEN", "old")
	if got := getenv("TOKEN"); got != "" {
		t.Fatalf("getenv = %q, want empty (only NEHEMIAH_* keys map to BORING_*)", got)
	}
}

func TestLoadConfigReadsLegacyNames(t *testing.T) {
	t.Setenv("BORING_MAX", "7")
	t.Setenv("BORING_ADDR", "127.0.0.1:9999")
	t.Setenv("BORING_ALLOW_PERSISTENT", "1")

	c := LoadConfig()
	if c.MaxMachines != 7 {
		t.Errorf("MaxMachines = %d, want 7 (envInt must see BORING_MAX)", c.MaxMachines)
	}
	if c.Addr != "127.0.0.1:9999" {
		t.Errorf("Addr = %q, want 127.0.0.1:9999 (envStr must see BORING_ADDR)", c.Addr)
	}
	if !c.AllowPersistent {
		t.Error("AllowPersistent = false, want true (direct getenv must see BORING_ALLOW_PERSISTENT)")
	}
}

func TestManagedModeDoesNotReuseLegacyFleetCredentials(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "1")
	t.Setenv("NEHEMIAH_INTERNAL_TOKEN", "")
	t.Setenv("NEHEMIAH_TOKEN", "")
	t.Setenv("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN", "")
	t.Setenv("BORING_INTERNAL_TOKEN", "legacy-global-control-token-that-is-long-enough")
	t.Setenv("BORING_TOKEN", "legacy-global-gateway-token-that-is-long-enough")
	t.Setenv("BORING_FLEET_BOOTSTRAP_TOKEN", "legacy-fleet-bootstrap-token-that-is-long-enough")

	cfg := LoadConfig()
	if cfg.InternalToken != "" || cfg.Token != "" || cfg.FleetBootstrapToken != "" {
		t.Fatalf("managed mode reused legacy credentials: internal=%q gateway=%q bootstrap=%q", cfg.InternalToken, cfg.Token, cfg.FleetBootstrapToken)
	}
}

func TestLoadConfigReadsHostAgentIdentity(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "1")
	t.Setenv("NEHEMIAH_HOST_ID", "host-latitude-01")
	t.Setenv("NEHEMIAH_REGION", "tor1")
	t.Setenv("NEHEMIAH_DRAINING", "1")
	t.Setenv("NEHEMIAH_INTERNAL_TOKEN", "internal-token-value")
	t.Setenv("NEHEMIAH_STATE_PATH", "/tmp/nehemiahd-test-state.json")
	t.Setenv("NEHEMIAH_CONTROL_PLANE_URL", "https://control.example.test")
	t.Setenv("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN", "nhe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	t.Setenv("NEHEMIAH_ADVERTISE_ADDRESS", "10.64.0.12")
	t.Setenv("NEHEMIAH_PROVIDER_ID", "latitude-server-12")
	t.Setenv("NEHEMIAH_ENROLLMENT_PATH", "/tmp/nehemiahd-test-enrollment.json")
	t.Setenv("NEHEMIAH_HEARTBEAT_SECONDS", "15")

	cfg := LoadConfig()
	if !cfg.NehemiahMode || !cfg.Draining {
		t.Fatalf("mode/draining = %v/%v, want true/true", cfg.NehemiahMode, cfg.Draining)
	}
	if cfg.HostID != "host-latitude-01" || cfg.Region != "tor1" {
		t.Fatalf("identity = %q/%q", cfg.HostID, cfg.Region)
	}
	if cfg.InternalToken != "internal-token-value" || cfg.StatePath != "/tmp/nehemiahd-test-state.json" {
		t.Fatalf("internal config not loaded: token=%q state=%q", cfg.InternalToken, cfg.StatePath)
	}
	if cfg.ControlPlaneURL != "https://control.example.test" || cfg.AdvertiseAddress != "10.64.0.12" || cfg.ProviderID != "latitude-server-12" {
		t.Fatalf("fleet identity not loaded: URL=%q address=%q provider=%q", cfg.ControlPlaneURL, cfg.AdvertiseAddress, cfg.ProviderID)
	}
	if cfg.FleetBootstrapToken != "nhe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || cfg.EnrollmentPath != "/tmp/nehemiahd-test-enrollment.json" || cfg.HeartbeatInterval != 15*time.Second {
		t.Fatalf("fleet enrollment config not loaded: path=%q interval=%s", cfg.EnrollmentPath, cfg.HeartbeatInterval)
	}
}

func TestGuestNetworkIsOffByDefault(t *testing.T) {
	t.Setenv("NEHEMIAH_NET", "")
	t.Setenv("BORING_NET", "")
	if cfg := LoadConfig(); cfg.NetEnable {
		t.Fatal("guest network enabled by default")
	}
}

func TestManagedHostMaxTTLDefaultsToOneDayAndCanBeOverridden(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "1")
	t.Setenv("NEHEMIAH_MAX_TTL", "")
	t.Setenv("BORING_MAX_TTL", "")
	cfg := LoadConfig()
	if got := cfg.MaxTTL; got != 86400 {
		t.Fatalf("managed MaxTTL = %d, want 86400", got)
	}
	if got := cfg.ClampTTL(86400); got != 86400 {
		t.Fatalf("managed ClampTTL(86400) = %d, want 86400", got)
	}

	t.Setenv("NEHEMIAH_MAX_TTL", "3600")
	if got := LoadConfig().MaxTTL; got != 3600 {
		t.Fatalf("overridden managed MaxTTL = %d, want 3600", got)
	}
}

func TestLocalMaxTTLRetainsShortDefault(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "")
	t.Setenv("BORING_MODE", "")
	t.Setenv("NEHEMIAH_MAX_TTL", "")
	t.Setenv("BORING_MAX_TTL", "")
	if got := LoadConfig().MaxTTL; got != 900 {
		t.Fatalf("local MaxTTL = %d, want 900", got)
	}
}

func TestManagedOverlayQuotaMatchesCloudMachineLimit(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "1")
	t.Setenv("NEHEMIAH_OVERLAY_QUOTA_MB", "")
	t.Setenv("BORING_OVERLAY_QUOTA_MB", "")
	if got := LoadConfig().OverlayQuotaMB; got != 20480 {
		t.Fatalf("managed OverlayQuotaMB = %d, want 20480", got)
	}

	t.Setenv("NEHEMIAH_OVERLAY_QUOTA_MB", "12288")
	if got := LoadConfig().OverlayQuotaMB; got != 12288 {
		t.Fatalf("overridden managed OverlayQuotaMB = %d, want 12288", got)
	}
}

func TestManagedCPUQuotaDefaultsToOneCorePerVCPU(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "1")
	t.Setenv("NEHEMIAH_CPU_MAX_PCT", "")
	t.Setenv("BORING_CPU_MAX_PCT", "")
	if got := LoadConfig().CPUMaxPercent; got != 100 {
		t.Fatalf("managed CPUMaxPercent = %d, want 100", got)
	}
}

func TestLocalOverlayQuotaRetainsSmallerDefault(t *testing.T) {
	t.Setenv("NEHEMIAH_MODE", "")
	t.Setenv("BORING_MODE", "")
	t.Setenv("NEHEMIAH_OVERLAY_QUOTA_MB", "")
	t.Setenv("BORING_OVERLAY_QUOTA_MB", "")
	if got := LoadConfig().OverlayQuotaMB; got != 8192 {
		t.Fatalf("local OverlayQuotaMB = %d, want 8192", got)
	}
}

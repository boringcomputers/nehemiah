package main

import "testing"

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

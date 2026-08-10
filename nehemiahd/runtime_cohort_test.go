package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestManagedRuntimeCohortCanonicalContract(t *testing.T) {
	cohort := testRuntimeCohort()
	wantID := "b0f96f640446e25ca0a2f10de56fd25e363f67ec94742dd1d9efeadaa57f49ee"
	if runtime.GOARCH == "arm64" {
		wantID = "dba4412921dff22fdb93f88eac566062481e082a3367a1e9ba088b1e3d314db9"
	}
	if got := string(cohort.canonicalBytes()); got != "contract_version=4\narch="+runtime.GOARCH+"\npython="+strings.Repeat("1", 64)+"\ndesktop="+strings.Repeat("2", 64)+"\nkernel="+strings.Repeat("3", 64)+"\nfirecracker="+strings.Repeat("4", 64)+"\njailer="+strings.Repeat("5", 64)+"\n" {
		t.Fatalf("canonical bytes differ: %q", got)
	}
	if cohort.ID != wantID {
		t.Fatalf("cohort id=%s want=%s", cohort.ID, wantID)
	}
	if err := cohort.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestManagedRuntimeCohortRejectsNonCanonicalFields(t *testing.T) {
	valid := testRuntimeCohort()
	tests := []struct {
		name   string
		mutate func(*managedRuntimeCohort)
	}{
		{name: "contract", mutate: func(c *managedRuntimeCohort) { c.ContractVersion++ }},
		{name: "architecture", mutate: func(c *managedRuntimeCohort) { c.Arch = "x86_64" }},
		{name: "uppercase digest", mutate: func(c *managedRuntimeCohort) { c.KernelSHA256 = strings.Repeat("A", 64) }},
		{name: "short digest", mutate: func(c *managedRuntimeCohort) { c.JailerSHA256 = "abcd" }},
		{name: "derived id mismatch", mutate: func(c *managedRuntimeCohort) { c.ID = strings.Repeat("a", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("non-canonical runtime cohort was accepted")
			}
		})
	}
}

func rootOwnedRuntimeGuard(t *testing.T) (Config, managedRuntimeAssetGuard) {
	t.Helper()
	const assetPath = "/bin/bash"
	contents, err := os.ReadFile(assetPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	digestText := hex.EncodeToString(digest[:])
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.BaseRootfs = assetPath
	cfg.DesktopRootfs = assetPath
	cfg.KernelPath = assetPath
	cfg.FirecrackerBin = assetPath
	cfg.JailerBin = assetPath
	cfg.RuntimeCohort = managedRuntimeCohort{
		ContractVersion: managedRuntimeContractVersion, Arch: runtime.GOARCH,
		PythonRootfsSHA256: digestText, DesktopRootfsSHA256: digestText,
		KernelSHA256: digestText, FirecrackerSHA256: digestText, JailerSHA256: digestText,
	}
	cfg.RuntimeCohort.ID = cfg.RuntimeCohort.computedID()
	guard, err := initializeManagedRuntimeAssetGuard(cfg)
	if err != nil {
		t.Fatalf("initialize runtime asset guard: %v", err)
	}
	return cfg, guard
}

func TestManagedRuntimeAssetGuardUsesStartupSeal(t *testing.T) {
	cfg, guard := rootOwnedRuntimeGuard(t)
	if err := guard.ValidateMetadata(cfg); err != nil {
		t.Fatalf("unchanged startup seal rejected: %v", err)
	}
	if len(guard.Assets) != 5 {
		t.Fatalf("asset seals=%d want=5", len(guard.Assets))
	}
	changed := guard
	changed.Assets = append([]managedRuntimeAssetSeal(nil), guard.Assets...)
	changed.Assets[0].CTimeNsec++
	if err := changed.ValidateMetadata(cfg); err == nil || !strings.Contains(err.Error(), "metadata changed") {
		t.Fatalf("ctime drift error=%v", err)
	}
	changed = guard
	changed.Assets = append([]managedRuntimeAssetSeal(nil), guard.Assets...)
	changed.Assets[0].Mode ^= 0o100
	if err := changed.ValidateMetadata(cfg); err == nil {
		t.Fatal("mode drift was accepted")
	}
	if err := (managedRuntimeAssetGuard{}).ValidateMetadata(cfg); err == nil {
		t.Fatal("missing startup hash guard was accepted")
	}
}

func TestManagedRuntimeHashRejectsUserOwnedAndSymlinkAssets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "asset")
	if err := os.WriteFile(path, []byte("runtime"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := hashManagedRuntimeAsset(path, sha256.New()); err == nil || !strings.Contains(err.Error(), "root-owned") {
		t.Fatalf("user-owned asset error=%v", err)
	}
	link := filepath.Join(t.TempDir(), "asset-link")
	if err := os.Symlink("/bin/bash", link); err != nil {
		t.Fatal(err)
	}
	if _, err := hashManagedRuntimeAsset(link, sha256.New()); err == nil || !strings.Contains(err.Error(), "non-symlink") {
		t.Fatalf("symlink asset error=%v", err)
	}
}

func TestManagedRuntimeExpectationBindsExactBuiltInRootfs(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	mgr := NewManager(cfg)
	valid := managedRuntimeExpectation{CohortID: cfg.RuntimeCohort.ID, RootfsSHA256: cfg.RuntimeCohort.PythonRootfsSHA256}
	if err := mgr.validateManagedRuntimeExpectation("python", valid); err != nil {
		t.Fatal(err)
	}
	if err := mgr.validateManagedRuntimeExpectation("desktop", valid); err == nil {
		t.Fatal("python rootfs digest authorized a desktop runtime")
	}
	wrongCohort := valid
	wrongCohort.CohortID = strings.Repeat("f", 64)
	if err := mgr.validateManagedRuntimeExpectation("python", wrongCohort); err == nil {
		t.Fatal("wrong runtime cohort was accepted")
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func managedScopeTestConfig() Config {
	return Config{
		NehemiahMode:   true,
		SystemdRunBin:  "/usr/bin/systemd-run",
		SystemctlBin:   "/usr/bin/systemctl",
		JailerBin:      "/opt/boring/bin/jailer",
		FirecrackerBin: "/opt/boring/bin/firecracker",
		ChrootBase:     "/srv/jailer",
		MemSizeMB:      256,
		CPUMaxPercent:  100,
		PidsMax:        128,
		IOReadBPS:      64 << 20,
		IOWriteBPS:     32 << 20,
		JailerUID:      30000,
		JailerGID:      991,
	}
}

func TestManagedScopeIdentityIsDurableAndShutdownPreservesDriver(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	mgr := NewManager(cfg)
	mgr.stateSave = func(machineStateSnapshot) error { return nil }
	id := "m-1234abcd"
	driver := &fcDriver{id: id, pid: 4242, scopeUnit: "nehemiah-vmm-m-1234abcd.scope"}
	mgr.machines[id] = &Machine{
		ID: id, Status: "running", LeaseID: "lease-current", CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(time.Minute), driver: driver,
	}
	snapshot := mgr.snapshotLocked()
	if len(snapshot.Machines) != 1 || snapshot.Machines[0].Runtime == nil || snapshot.Machines[0].Runtime.ScopeUnit != driver.scopeUnit {
		t.Fatalf("durable runtime = %+v", snapshot.Machines)
	}
	mgr.ShutdownPreserve()
	if mgr.machines[id] == nil || mgr.machines[id].driver != driver || driver.scopeUnit == "" {
		t.Fatal("managed shutdown discarded scope ownership instead of preserving it for restart")
	}
	unitRaw, err := os.ReadFile("../infra/latitude/nehemiahd.service")
	if err != nil {
		t.Fatal(err)
	}
	if !bytesContainsLine(unitRaw, "KillMode=control-group") || bytesContainsLine(unitRaw, "KillMode=process") {
		t.Fatalf("daemon unit does not isolate sibling scope lifetime:\n%s", unitRaw)
	}
}

func bytesContainsLine(raw []byte, line string) bool {
	for _, candidate := range strings.Split(string(raw), "\n") {
		if candidate == line {
			return true
		}
	}
	return false
}

func TestManagedScopeCommandOwnsLifetimeAndResourceBoundary(t *testing.T) {
	cfg := managedScopeTestConfig()
	cmd, unit, err := buildManagedScopeCommand(cfg, "m-1234abcd", Template{VCPUs: 2, MemSizeMB: 512}, "/opt/boring/rootfs/rootfs.ext4")
	if err != nil {
		t.Fatal(err)
	}
	if unit != "nehemiah-vmm-m-1234abcd.scope" || cmd.Path != cfg.SystemdRunBin {
		t.Fatalf("command path=%q unit=%q", cmd.Path, unit)
	}
	joined := strings.Join(cmd.Args[1:], "\n")
	for _, exact := range []string{
		"--scope",
		"--unit=" + unit,
		"--slice=system.slice",
		"--collect",
		"--expand-environment=no",
		"--property=Delegate=yes",
		"--property=KillMode=control-group",
		"--property=CPUQuota=200%",
		"--property=MemoryMax=671088640",
		"--property=MemorySwapMax=0",
		"--property=TasksMax=128",
		"--property=IOReadBandwidthMax=/srv/jailer 67108864",
		"--property=IOWriteBandwidthMax=/srv/jailer 33554432",
		"/opt/boring/bin/jailer",
		"--exec-file",
		"/opt/boring/bin/firecracker",
	} {
		if !strings.Contains("\n"+joined+"\n", "\n"+exact+"\n") {
			t.Errorf("scope argv missing exact argument %q: %v", exact, cmd.Args)
		}
	}
	if strings.Contains(joined, "sh\n-c") || strings.Contains(joined, "--no-seccomp") || strings.Contains(joined, "--parent-cgroup") {
		t.Fatalf("unsafe scope command: %v", cmd.Args)
	}
}

func TestManagedScopeIdentifiersAndArgumentsRejectInjection(t *testing.T) {
	for _, id := range []string{"../../host", "m-1234abcd;reboot", "m-1234abcd.scope"} {
		if _, err := scopeUnitForMachine(id); err == nil {
			t.Errorf("unsafe id %q accepted", id)
		}
	}
	cfg := managedScopeTestConfig()
	cfg.JailerBin = "/opt/boring/bin/${INJECT}"
	if _, _, err := buildManagedScopeCommand(cfg, "m-1234abcd", Template{}, "/opt/boring/rootfs/rootfs.ext4"); err == nil {
		t.Fatal("systemd expansion syntax was accepted in managed argv")
	}
	if id, ok := machineIDForScopeUnit("nehemiah-vmm-m-1234abcd.scope"); !ok || id != "m-1234abcd" {
		t.Fatalf("scope identity = %q, %v", id, ok)
	}
	if _, ok := machineIDForScopeUnit("nehemiah-vmm-m-1234abcd.service"); ok {
		t.Fatal("non-scope unit accepted")
	}
}

func TestManagedScopeMembershipRequiresExactPathComponent(t *testing.T) {
	unit := "nehemiah-vmm-m-1234abcd.scope"
	for _, raw := range [][]byte{
		[]byte("0::/system.slice/" + unit + "/firecracker/m-1234abcd\n"),
		[]byte("11:memory:/system.slice/" + unit + "\n10:cpu:/other\n"),
	} {
		if !cgroupContainsScope(raw, unit) {
			t.Fatalf("exact scope not recognized in %q", raw)
		}
	}
	for _, raw := range [][]byte{
		[]byte("0::/system.slice/not-" + unit + "\n"),
		[]byte("0::/system.slice/" + unit + "-attacker\n"),
		[]byte("0::/system.slice/nehemiah-vmm-m-deadbeef.scope\n"),
	} {
		if cgroupContainsScope(raw, unit) {
			t.Fatalf("inexact scope accepted in %q", raw)
		}
	}
}

func TestStopManagedScopeUsesOnlyExactUnit(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls")
	toolPath := filepath.Join(dir, "systemctl")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NEHEMIAH_SCOPE_TEST_LOG\"\n"
	if err := os.WriteFile(toolPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEHEMIAH_SCOPE_TEST_LOG", logPath)
	cfg := Config{SystemctlBin: toolPath}
	stopManagedScope(cfg, "nehemiah-vmm-m-1234abcd.scope")
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 || lines[0] != "stop nehemiah-vmm-m-1234abcd.scope" || lines[1] != "reset-failed nehemiah-vmm-m-1234abcd.scope" {
		t.Fatalf("systemctl calls = %q", lines)
	}
	before := string(raw)
	stopManagedScope(cfg, "../../host.service")
	after, _ := os.ReadFile(logPath)
	if string(after) != before {
		t.Fatal("unsafe unit reached systemctl")
	}
}

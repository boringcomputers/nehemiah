package main

// Managed Firecracker lifetime ownership. Each VMM is launched in a transient
// scope directly below system.slice, rather than in nehemiahd.service's cgroup.
// Restarting the daemon can therefore kill its complete control group without
// killing customer VMs; the replacement daemon proves the exact scope, process,
// lease state, socket, and artifacts before reconnecting.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const managedScopePrefix = "nehemiah-vmm-"

var managedScopePathPattern = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)

func managedScopeSafePath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && managedScopePathPattern.MatchString(path)
}

func scopeUnitForMachine(id string) (string, error) {
	if !validMachineID(id) {
		return "", fmt.Errorf("unsafe machine id %q", id)
	}
	return managedScopePrefix + id + ".scope", nil
}

func machineIDForScopeUnit(unit string) (string, bool) {
	if !strings.HasPrefix(unit, managedScopePrefix) || !strings.HasSuffix(unit, ".scope") {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(unit, managedScopePrefix), ".scope")
	return id, validMachineID(id)
}

// buildManagedScopeCommand constructs argv only: no shell is involved and all
// variable fields are validated machine identifiers, integers, or clean
// administrator-owned absolute paths. --expand-environment=no also prevents
// systemd-run from interpreting '$' in the target argv.
func buildManagedScopeCommand(cfg Config, id string, tpl Template, baseRootfs string) (*exec.Cmd, string, error) {
	unit, err := scopeUnitForMachine(id)
	if err != nil {
		return nil, "", err
	}
	for name, path := range map[string]string{
		"systemd-run": cfg.SystemdRunBin,
		"jailer":      cfg.JailerBin,
		"firecracker": cfg.FirecrackerBin,
		"chroot":      cfg.ChrootBase,
		"rootfs":      baseRootfs,
	} {
		if !managedScopeSafePath(path) {
			return nil, "", fmt.Errorf("unsafe managed %s path %q", name, path)
		}
	}

	mem := tpl.MemSizeMB
	if mem <= 0 {
		mem = cfg.MemSizeMB
	}
	cpuPercent := cpuQuotaMicros(cfg, tpl) / 1000
	args := []string{
		"--scope",
		"--unit=" + unit,
		"--slice=system.slice",
		"--collect",
		"--quiet",
		"--no-ask-password",
		"--expand-environment=no",
		"--description=Nehemiah VMM " + id,
		"--property=Delegate=yes",
		"--property=KillMode=control-group",
		"--property=OOMPolicy=kill",
		"--property=CPUAccounting=yes",
		"--property=MemoryAccounting=yes",
		"--property=TasksAccounting=yes",
		"--property=IOAccounting=yes",
		"--property=CPUQuota=" + strconv.Itoa(cpuPercent) + "%",
		"--property=CPUQuotaPeriodSec=100ms",
		"--property=MemoryMax=" + strconv.Itoa((mem+128)*1024*1024),
		"--property=MemorySwapMax=0",
		"--property=TasksMax=" + strconv.Itoa(cfg.PidsMax),
	}
	if cfg.IOReadBPS > 0 {
		args = append(args, "--property=IOReadBandwidthMax="+cfg.ChrootBase+" "+strconv.FormatInt(cfg.IOReadBPS, 10))
	}
	if cfg.IOWriteBPS > 0 {
		args = append(args, "--property=IOWriteBandwidthMax="+cfg.ChrootBase+" "+strconv.FormatInt(cfg.IOWriteBPS, 10))
	}
	args = append(args, "--", cfg.JailerBin)
	// The scope is the single resource owner. Asking jailer to move the VMM
	// again would escape the sibling scope and break restart ownership; all four
	// required controllers are already enforced by systemd on this scope.
	args = append(args, buildJailerArgs(cfg, id, tpl, "", "")...)
	return exec.Command(cfg.SystemdRunBin, args...), unit, nil
}

// probeManagedScopeRuntime proves that PID 1 accepts the same critical
// transient-scope properties used for VMMs. Merely finding systemd-run on disk
// is insufficient on containers, chroots, or hosts with a broken system bus.
func probeManagedScopeRuntime(cfg Config) error {
	unit := "nehemiah-scope-probe-" + strconv.Itoa(os.Getpid()) + ".scope"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, cfg.SystemdRunBin,
		"--scope",
		"--unit="+unit,
		"--slice=system.slice",
		"--collect",
		"--quiet",
		"--no-ask-password",
		"--expand-environment=no",
		"--property=Delegate=yes",
		"--property=KillMode=control-group",
		"--property=OOMPolicy=kill",
		"--property=CPUQuota=100%",
		"--property=MemoryMax=67108864",
		"--property=MemorySwapMax=0",
		"--property=TasksMax=16",
		"--",
		"/usr/bin/true",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("transient scope probe: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func processInManagedScope(pid int, unit string) bool {
	if pid <= 1 {
		return false
	}
	if _, ok := machineIDForScopeUnit(unit); !ok {
		return false
	}
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return false
	}
	return cgroupContainsScope(raw, unit)
}

func cgroupContainsScope(raw []byte, unit string) bool {
	if _, ok := machineIDForScopeUnit(unit); !ok {
		return false
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		for _, component := range strings.Split(filepath.Clean(parts[2]), string(filepath.Separator)) {
			if component == unit {
				return true
			}
		}
	}
	return false
}

func findManagedScopePID(id, unit string) int {
	for _, name := range []string{"firecracker", "jailer"} {
		for _, pid := range pidsOf(name) {
			if processInManagedScope(pid, unit) && processMatchesMachine(pid, id) {
				return pid
			}
		}
	}
	return 0
}

func waitForManagedScopePID(id, unit string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for {
		if pid := findManagedScopePID(id, unit); pid > 1 {
			return pid, nil
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("scope %s has no verified VMM process", unit)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// stopManagedScope is idempotent. systemctl stop waits for the scope's cgroup
// to empty; the explicit kill fallback is restricted to the exact validated
// unit and covers a stuck guest during deterministic teardown.
func stopManagedScope(cfg Config, unit string) {
	if _, ok := machineIDForScopeUnit(unit); !ok || !managedScopeSafePath(cfg.SystemctlBin) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err := exec.CommandContext(ctx, cfg.SystemctlBin, "stop", unit).Run()
	cancel()
	if err != nil {
		killCtx, killCancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = exec.CommandContext(killCtx, cfg.SystemctlBin, "kill", "--kill-whom=all", "--signal=KILL", unit).Run()
		killCancel()
	}
	resetCtx, resetCancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = exec.CommandContext(resetCtx, cfg.SystemctlBin, "reset-failed", unit).Run()
	resetCancel()
}

// managedScopeUnits discovers only exact Nehemiah scope directories. The scope
// is deliberately placed directly under system.slice, making orphan discovery
// independent of human-readable systemctl output and locale.
func managedScopeUnits() []string {
	entries, err := os.ReadDir("/sys/fs/cgroup/system.slice")
	if err != nil {
		return nil
	}
	units := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, ok := machineIDForScopeUnit(entry.Name()); ok {
			units = append(units, entry.Name())
		}
	}
	return units
}

func killManagedScopePID(pid int, id, unit string) {
	if processMatchesMachine(pid, id) && processInManagedScope(pid, unit) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

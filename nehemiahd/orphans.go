package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// reapOrphans cleans up firecracker VMs and artifacts left behind by a previous
// nehemiahd that exited uncleanly (crash, OOM, SIGKILL). nehemiahd is the only thing
// on the host that runs firecracker, and its machine map starts empty, so at
// startup anything present is an orphan: kill the processes and remove the stale
// jailer chroots, sockets and overlays. This keeps restarts clean instead of
// leaking a VM + its disk each time (nehemiahd can't re-adopt in-memory state, so
// those machines are already unreachable).
//
// Runs once, before the server starts. Safe because nothing is tracked yet.
func reapOrphans(cfg Config) {
	_, _ = reapOrphansExcept(cfg, nil)
}

// reapOrphansExcept deterministically removes runtime resources which are not
// present in the reconciled state inventory. Matching on the machine id in the
// process command line avoids ever signalling an unrelated host process merely
// because a stale state file contained its PID.
func reapOrphansExcept(cfg Config, keep map[string]struct{}) (int, error) {
	if !cfg.NehemiahMode {
		return reapOrphansExceptBestEffort(cfg, keep), nil
	}
	return reapManagedOrphansExcept(cfg, keep, defaultManagedOrphanCleanupOps(cfg))
}

func (mgr *Manager) reapOrphansExcept(keep map[string]struct{}) (int, error) {
	if mgr == nil {
		return 0, errors.New("managed orphan cleanup manager is unavailable")
	}
	if !mgr.cfg.NehemiahMode {
		return reapOrphansExcept(mgr.cfg, keep)
	}
	return reapManagedOrphansExcept(mgr.cfg, keep, mgr.orphanCleanup)
}

type managedOrphanProcess struct {
	pid  int
	id   string
	name string
}

type managedOrphanCleanupOps struct {
	listScopes      func() ([]string, error)
	stopScope       func(string) error
	listProcesses   func() ([]managedOrphanProcess, error)
	killProcess     func(managedOrphanProcess) error
	cleanupChroots  func(map[string]struct{}) (int, error)
	cleanupRun      func(map[string]struct{}) (int, error)
	cleanupNetwork  func(map[string]struct{}) (int, error)
	processRetained func(managedOrphanProcess, map[string]struct{}) bool
}

func (ops managedOrphanCleanupOps) valid() bool {
	return ops.listScopes != nil && ops.stopScope != nil && ops.listProcesses != nil &&
		ops.killProcess != nil && ops.cleanupChroots != nil && ops.cleanupRun != nil &&
		ops.cleanupNetwork != nil && ops.processRetained != nil
}

func defaultManagedOrphanCleanupOps(cfg Config) managedOrphanCleanupOps {
	return managedOrphanCleanupOps{
		listScopes:    managedStateScopeUnits,
		stopScope:     func(unit string) error { return stopManagedScopeVerified(cfg, unit) },
		listProcesses: managedOrphanProcesses,
		killProcess:   killManagedOrphanProcessVerified,
		cleanupChroots: func(keep map[string]struct{}) (int, error) {
			return cleanupManagedOrphanChroots(cfg, keep)
		},
		cleanupRun: func(keep map[string]struct{}) (int, error) {
			return cleanupManagedOrphanRunArtifacts(cfg, keep)
		},
		cleanupNetwork: func(keep map[string]struct{}) (int, error) {
			return cleanupOrphanGuestNetworkStrict(cfg, keep)
		},
		processRetained: func(process managedOrphanProcess, keep map[string]struct{}) bool {
			if process.id == "" {
				return false
			}
			if _, retained := keep[process.id]; !retained {
				return false
			}
			unit, err := scopeUnitForMachine(process.id)
			return err == nil && processInManagedScope(process.pid, unit)
		},
	}
}

func reapManagedOrphansExcept(cfg Config, keep map[string]struct{}, ops managedOrphanCleanupOps) (int, error) {
	if !cfg.NehemiahMode || !ops.valid() {
		return 0, errors.New("managed orphan cleanup operations are unavailable")
	}
	removed := 0
	scopes, err := ops.listScopes()
	if err != nil {
		return 0, fmt.Errorf("list managed orphan scopes: %w", err)
	}
	for _, unit := range scopes {
		id, ok := machineIDForScopeUnit(unit)
		if !ok {
			return removed, errors.New("managed orphan inventory contains an unsafe scope")
		}
		if _, retained := keep[id]; retained {
			continue
		}
		if err := ops.stopScope(unit); err != nil {
			return removed, fmt.Errorf("stop managed orphan scope %s: %w", unit, err)
		}
		removed++
	}
	remainingScopes, err := ops.listScopes()
	if err != nil {
		return removed, fmt.Errorf("verify managed orphan scopes: %w", err)
	}
	for _, unit := range remainingScopes {
		id, ok := machineIDForScopeUnit(unit)
		if !ok {
			return removed, errors.New("managed scope verification contains an unsafe scope")
		}
		if _, retained := keep[id]; !retained {
			return removed, fmt.Errorf("managed orphan scope %s remains after cleanup", unit)
		}
	}

	processes, err := ops.listProcesses()
	if err != nil {
		return removed, fmt.Errorf("list managed orphan processes: %w", err)
	}
	for _, process := range processes {
		if process.pid <= 1 || process.name != "firecracker" && process.name != "jailer" {
			return removed, errors.New("managed orphan inventory contains an unsafe process")
		}
		if ops.processRetained(process, keep) {
			continue
		}
		if err := ops.killProcess(process); err != nil {
			return removed, fmt.Errorf("kill managed orphan process %d: %w", process.pid, err)
		}
		removed++
	}
	remainingProcesses, err := ops.listProcesses()
	if err != nil {
		return removed, fmt.Errorf("verify managed orphan processes: %w", err)
	}
	for _, process := range remainingProcesses {
		if !ops.processRetained(process, keep) {
			return removed, fmt.Errorf("managed orphan process %d remains after cleanup", process.pid)
		}
	}

	cleanups := []struct {
		name string
		run  func(map[string]struct{}) (int, error)
	}{
		{"jailer chroots", ops.cleanupChroots},
		{"run artifacts", ops.cleanupRun},
		{"guest network", ops.cleanupNetwork},
	}
	for _, cleanup := range cleanups {
		count, cleanupErr := cleanup.run(keep)
		removed += count
		if cleanupErr != nil {
			return removed, fmt.Errorf("clean managed orphan %s: %w", cleanup.name, cleanupErr)
		}
	}
	if removed > 0 {
		logManagedHostEvent(managedHostEventOrphansReaped, managedHostLogFields{Count: int64(removed)})
	}
	return removed, nil
}

func reapOrphansExceptBestEffort(cfg Config, keep map[string]struct{}) int {
	killed := 0
	for _, name := range []string{"firecracker", "jailer"} {
		for _, pid := range pidsOf(name) {
			id := machineIDForPID(pid)
			if _, retained := keep[id]; retained && id != "" {
				if !cfg.NehemiahMode {
					continue
				}
				unit, unitErr := scopeUnitForMachine(id)
				if unitErr == nil && processInManagedScope(pid, unit) {
					continue
				}
			}
			if syscall.Kill(pid, syscall.SIGKILL) == nil {
				killed++
			}
		}
	}
	if killed > 0 {
		time.Sleep(200 * time.Millisecond) // let the kernel release the pids/mounts
	}

	removed := 0
	// Stale jailer chroots (each holds a VM's rootfs overlay — the big disk cost).
	if cfg.ChrootBase != "" {
		dir := filepath.Join(cfg.ChrootBase, "firecracker")
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if _, ok := keep[e.Name()]; ok {
					continue
				}
				if os.RemoveAll(filepath.Join(dir, e.Name())) == nil {
					removed++
				}
			}
		}
	}
	// Stale run-dir artifacts (sockets, overlays, vsock UDS) for non-jailed runs.
	if cfg.RunDir != "" {
		if entries, err := os.ReadDir(cfg.RunDir); err == nil {
			for _, e := range entries {
				if artifactOwnedBy(e.Name(), keep) {
					continue
				}
				_ = os.RemoveAll(filepath.Join(cfg.RunDir, e.Name()))
			}
		}
	}
	removed += cleanupOrphanGuestNetwork(cfg, keep)

	if killed > 0 || removed > 0 {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventOrphansReaped, managedHostLogFields{Count: int64(killed), SecondaryCount: int64(removed)})
		} else {
			log.Printf("reaped %d orphan process(es) + %d stale chroot(s) from a previous run", killed, removed)
		}
	}
	return killed + removed
}

func managedOrphanProcesses() ([]managedOrphanProcess, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	processes := make([]managedOrphanProcess, 0)
	for _, entry := range entries {
		pid, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil || pid <= 1 {
			continue
		}
		commPath := filepath.Join("/proc", entry.Name(), "comm")
		comm, readErr := os.ReadFile(commPath)
		if readErr != nil {
			if errors.Is(readErr, os.ErrNotExist) {
				if _, existsErr := os.Lstat(filepath.Join("/proc", entry.Name())); errors.Is(existsErr, os.ErrNotExist) {
					continue
				} else if existsErr != nil {
					return nil, existsErr
				}
			}
			return nil, fmt.Errorf("read process %d name: %w", pid, readErr)
		}
		name := strings.TrimSpace(string(comm))
		if name != "firecracker" && name != "jailer" {
			continue
		}
		processes = append(processes, managedOrphanProcess{pid: pid, id: machineIDForPID(pid), name: name})
	}
	sort.Slice(processes, func(i, j int) bool { return processes[i].pid < processes[j].pid })
	return processes, nil
}

func killManagedOrphanProcessVerified(process managedOrphanProcess) error {
	if process.pid <= 1 || process.name != "firecracker" && process.name != "jailer" {
		return errors.New("unsafe managed orphan process")
	}
	comm, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(process.pid), "comm"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(comm)) != process.name {
		return errors.New("managed orphan pid identity changed before kill")
	}
	if err := syscall.Kill(process.pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := syscall.Kill(process.pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("managed orphan process survived SIGKILL")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func cleanupManagedOrphanChroots(cfg Config, keep map[string]struct{}) (int, error) {
	root := filepath.Join(cfg.ChrootBase, "firecracker")
	return cleanupManagedOrphanDirectory(root, keep, func(name string) bool {
		_, retained := keep[name]
		return retained
	})
}

func cleanupManagedOrphanRunArtifacts(cfg Config, keep map[string]struct{}) (int, error) {
	return cleanupManagedOrphanDirectory(cfg.RunDir, keep, func(name string) bool {
		return artifactOwnedBy(name, keep)
	})
}

func cleanupManagedOrphanDirectory(root string, keep map[string]struct{}, retained func(string) bool) (int, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return 0, errors.New("unsafe managed cleanup directory")
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if retained(entry.Name()) {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if err := os.RemoveAll(path); err != nil {
			return removed, err
		}
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return removed, err
			}
			return removed, fmt.Errorf("managed orphan artifact %s remains", entry.Name())
		}
		removed++
	}
	return removed, nil
}

func artifactOwnedBy(name string, keep map[string]struct{}) bool {
	for id := range keep {
		if name == id || strings.HasPrefix(name, id+".") || strings.HasPrefix(name, id+"-") {
			return true
		}
	}
	return false
}

func cleanupMachineArtifacts(cfg Config, id string) {
	if !validMachineID(id) {
		return
	}
	_ = os.RemoveAll(filepath.Join(cfg.ChrootBase, "firecracker", id))
	if entries, err := os.ReadDir(cfg.RunDir); err == nil {
		for _, entry := range entries {
			if artifactOwnedBy(entry.Name(), map[string]struct{}{id: {}}) {
				_ = os.RemoveAll(filepath.Join(cfg.RunDir, entry.Name()))
			}
		}
	}
}

// availableMemoryMB reads MemAvailable from /proc/meminfo (fails open large).
func availableMemoryMB() int {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 1 << 30
	}
	if available := memoryFieldMB(data, "MemAvailable:"); available > 0 {
		return available
	}
	return 1 << 30
}

func memoryFieldMB(data []byte, field string) int {
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, field) {
			values := strings.Fields(line)
			if len(values) >= 2 {
				if kb, err := strconv.Atoi(values[1]); err == nil {
					return kb / 1024
				}
			}
		}
	}
	return 0
}

// pidsOf returns the pids of processes whose comm exactly matches name, by
// reading /proc (no dependency on pgrep being installed).
func pidsOf(name string) []int {
	var pids []int
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return pids
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", e.Name(), "comm"))
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(comm)) == name {
			pids = append(pids, pid)
		}
	}
	return pids
}

func machineIDForPID(pid int) string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return ""
	}
	args := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
	for index, arg := range args {
		if arg == "--id" && index+1 < len(args) && validMachineID(args[index+1]) {
			return args[index+1]
		}
		if strings.HasPrefix(arg, "--id=") {
			id := strings.TrimPrefix(arg, "--id=")
			if validMachineID(id) {
				return id
			}
		}
	}
	// After jailer execs Firecracker, --id is no longer in argv. The jailer puts
	// the process in an id-named cgroup and chroots it below
	// <base>/firecracker/<id>/root; either kernel-owned path is a trustworthy
	// fallback for reconciliation.
	if cgroup, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cgroup")); err == nil {
		for _, component := range strings.FieldsFunc(string(cgroup), func(r rune) bool { return r == '/' || r == '\n' || r == ':' }) {
			if validMachineID(component) {
				return component
			}
		}
	}
	if root, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "root")); err == nil {
		for _, component := range strings.Split(filepath.Clean(root), string(filepath.Separator)) {
			if validMachineID(component) {
				return component
			}
		}
	}
	return ""
}

func processMatchesMachine(pid int, id string) bool {
	if pid <= 1 || !validMachineID(id) {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil && err != syscall.EPERM {
		return false
	}
	comm, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "comm"))
	if err != nil {
		return false
	}
	name := strings.TrimSpace(string(comm))
	if name != "firecracker" && name != "jailer" {
		return false
	}
	return machineIDForPID(pid) == id
}

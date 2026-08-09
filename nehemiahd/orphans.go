package main

import (
	"log"
	"os"
	"path/filepath"
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
	killed := 0
	for _, name := range []string{"firecracker", "jailer"} {
		for _, pid := range pidsOf(name) {
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
				_ = os.RemoveAll(filepath.Join(cfg.RunDir, e.Name()))
			}
		}
	}

	if killed > 0 || removed > 0 {
		log.Printf("reaped %d orphan process(es) + %d stale chroot(s) from a previous run", killed, removed)
	}
}

// availableMemoryMB reads MemAvailable from /proc/meminfo (fails open large).
func availableMemoryMB() int {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 1 << 30
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemAvailable:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				if kb, err := strconv.Atoi(f[1]); err == nil {
					return kb / 1024
				}
			}
		}
	}
	return 1 << 30
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

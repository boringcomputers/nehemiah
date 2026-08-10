package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Cgroups places each firecracker child in a cgroup v2 with CPU, memory and pids
// caps so untrusted guests can't starve the host (crypto miners, fork bombs,
// memory hogs). Requires the systemd unit to delegate its cgroup subtree
// (Delegate=yes); if setup fails it degrades to a no-op with a warning.
type Cgroups struct {
	cfg     Config
	base    string
	enabled bool
}

// NewCgroups prepares a delegated cgroup subtree for per-VM child cgroups.
func NewCgroups(cfg Config) *Cgroups {
	c := &Cgroups{cfg: cfg}
	if !cfg.CgroupEnable {
		return c
	}
	if err := c.setup(); err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventCgroupSetupFailed, managedHostLogFields{Err: err})
		} else {
			log.Printf("cgroups disabled (per-VM resource caps off): %v", err)
		}
		return c
	}
	c.enabled = true
	if cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventCgroupsEnabled, managedHostLogFields{
			Count: int64(cfg.CPUMaxPercent), Limit: int64(cfg.PidsMax),
		})
	} else {
		log.Printf("cgroups enabled: cpu<=%d%% per declared vCPU pids<=%d under %s",
			cfg.CPUMaxPercent, cfg.PidsMax, c.base)
	}
	return c
}

// Enabled reports whether the delegated cgroup v2 subtree was successfully
// prepared. Nehemiah mode treats false as an unhealthy host, never as a silent
// reduction in isolation.
func (c *Cgroups) Enabled() bool { return c != nil && c.enabled }

func (c *Cgroups) setup() error {
	// nehemiahd's own cgroup, e.g. "0::/system.slice/nehemiahd.service".
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return err
	}
	var rel string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.HasPrefix(line, "0::") {
			rel = strings.TrimPrefix(line, "0::")
			break
		}
	}
	if rel == "" {
		return fmt.Errorf("no cgroup v2 path in /proc/self/cgroup")
	}
	c.base = filepath.Join("/sys/fs/cgroup", rel)

	// A cgroup may either hold processes or enable controllers for children, not
	// both. Move ourselves into a leaf so the base can delegate controllers.
	leaf := filepath.Join(c.base, "main")
	if err := os.MkdirAll(leaf, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(leaf, "cgroup.procs"),
		[]byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return fmt.Errorf("move self to leaf: %w", err)
	}
	if err := os.WriteFile(filepath.Join(c.base, "cgroup.subtree_control"),
		[]byte("+cpu +memory +pids +io"), 0o644); err != nil {
		return fmt.Errorf("enable controllers (needs Delegate=yes): %w", err)
	}
	return nil
}

// Place moves the firecracker child pid into a capped per-VM cgroup.
func (c *Cgroups) Place(pid int, id string, tpl Template, overlay string) error {
	if !c.enabled {
		return fmt.Errorf("cgroup isolation is unavailable")
	}
	dir := filepath.Join(c.base, "vm-"+id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cgroup %s: mkdir: %w", id, err)
	}
	// cpu.max: "<quota_us> <period_us>". The cap scales with the exact
	// declared vCPU count so the host enforces the same resource that the
	// scheduler reserves and the usage ledger bills.
	quota := cpuQuotaMicros(c.cfg, tpl)
	if err := writeCG(dir, "cpu.max", fmt.Sprintf("%d 100000", quota)); err != nil {
		return err
	}
	// memory.max: guest RAM plus firecracker overhead headroom.
	mem := tpl.MemSizeMB
	if mem <= 0 {
		mem = c.cfg.MemSizeMB
	}
	if err := writeCG(dir, "memory.max", strconv.Itoa((mem+128)*1024*1024)); err != nil {
		return err
	}
	if err := writeCG(dir, "pids.max", strconv.Itoa(c.cfg.PidsMax)); err != nil {
		return err
	}
	if limit, err := cgroupIOMax(overlay, c.cfg); err != nil {
		return err
	} else if limit != "" {
		if err := writeCG(dir, "io.max", limit); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"),
		[]byte(strconv.Itoa(pid)), 0o644); err != nil {
		return fmt.Errorf("cgroup %s: place pid: %w", id, err)
	}
	return nil
}

func cpuQuotaMicros(cfg Config, tpl Template) int {
	vcpus := tpl.VCPUs
	if vcpus <= 0 {
		vcpus = cfg.VCPUs
	}
	if vcpus <= 0 {
		vcpus = 1
	}
	return vcpus * cfg.CPUMaxPercent * 1000
}

// Remove deletes a per-VM cgroup (call after the firecracker child has exited).
// Also removes the empty cgroup the jailer created for the VM, if any.
func (c *Cgroups) Remove(id string) {
	if !c.enabled {
		return
	}
	_ = os.Remove(filepath.Join(c.base, "vm-"+id))
	_ = os.Remove(filepath.Join(c.base, id))
	_ = os.Remove(filepath.Join(c.base, "firecracker", id))
}

// jailerParentCgroup returns the cgroup (relative to the cgroup v2 root) under
// which the jailer should create each microvm's cgroup: nehemiahd's own delegated
// cgroup, minus the "main" leaf we moved ourselves into. Empty if unavailable.
func jailerParentCgroup() string {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.HasPrefix(line, "0::") {
			rel := strings.TrimSuffix(strings.TrimPrefix(line, "0::"), "/main")
			return strings.TrimPrefix(rel, "/")
		}
	}
	return ""
}

func writeCG(dir, file, val string) error {
	if err := os.WriteFile(filepath.Join(dir, file), []byte(val), 0o644); err != nil {
		return fmt.Errorf("cgroup %s=%s: %w", file, val, err)
	}
	return nil
}

// cgroupIOMax returns an io.max value for the block device backing path. The
// overlay is fixed-size, so combining this throttle with OverlayQuotaMB bounds
// both I/O pressure and disk consumption per tenant VM.
func cgroupIOMax(path string, cfg Config) (string, error) {
	if cfg.IOReadBPS == 0 && cfg.IOWriteBPS == 0 {
		return "", nil
	}
	var stat syscall.Stat_t
	if err := syscall.Stat(path, &stat); err != nil {
		return "", fmt.Errorf("stat overlay device: %w", err)
	}
	major, minor := linuxDeviceNumbers(uint64(stat.Dev))
	parts := []string{fmt.Sprintf("%d:%d", major, minor)}
	if cfg.IOReadBPS > 0 {
		parts = append(parts, fmt.Sprintf("rbps=%d", cfg.IOReadBPS))
	}
	if cfg.IOWriteBPS > 0 {
		parts = append(parts, fmt.Sprintf("wbps=%d", cfg.IOWriteBPS))
	}
	return strings.Join(parts, " "), nil
}

// Linux encodes major/minor device numbers non-contiguously in dev_t.
func linuxDeviceNumbers(dev uint64) (uint64, uint64) {
	major := (dev >> 8) & 0xfff
	major |= (dev >> 32) & ^uint64(0xfff)
	minor := dev & 0xff
	minor |= (dev >> 12) & ^uint64(0xff)
	return major, minor
}

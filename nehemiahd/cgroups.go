package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
		log.Printf("cgroups disabled (per-VM resource caps off): %v", err)
		return c
	}
	c.enabled = true
	log.Printf("cgroups enabled: per-VM cpu<=%d%% pids<=%d under %s",
		cfg.CPUMaxPercent, cfg.PidsMax, c.base)
	return c
}

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
		[]byte("+cpu +memory +pids"), 0o644); err != nil {
		return fmt.Errorf("enable controllers (needs Delegate=yes): %w", err)
	}
	return nil
}

// Place moves the firecracker child pid into a capped per-VM cgroup.
func (c *Cgroups) Place(pid int, id string, tpl Template) {
	if !c.enabled {
		return
	}
	dir := filepath.Join(c.base, "vm-"+id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("cgroup %s: mkdir: %v", id, err)
		return
	}
	// cpu.max: "<quota_us> <period_us>"; quota = percent * period / 100.
	quota := c.cfg.CPUMaxPercent * 1000
	writeCG(dir, "cpu.max", fmt.Sprintf("%d 100000", quota))
	// memory.max: guest RAM plus firecracker overhead headroom.
	mem := tpl.MemSizeMB
	if mem <= 0 {
		mem = c.cfg.MemSizeMB
	}
	writeCG(dir, "memory.max", strconv.Itoa((mem+128)*1024*1024))
	writeCG(dir, "pids.max", strconv.Itoa(c.cfg.PidsMax))
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"),
		[]byte(strconv.Itoa(pid)), 0o644); err != nil {
		log.Printf("cgroup %s: place pid: %v", id, err)
	}
}

// Remove deletes a per-VM cgroup (call after the firecracker child has exited).
// Also removes the empty cgroup the jailer created for the VM, if any.
func (c *Cgroups) Remove(id string) {
	if !c.enabled {
		return
	}
	_ = os.Remove(filepath.Join(c.base, "vm-"+id))
	_ = os.Remove(filepath.Join(c.base, id))
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

func writeCG(dir, file, val string) {
	if err := os.WriteFile(filepath.Join(dir, file), []byte(val), 0o644); err != nil {
		log.Printf("cgroup %s=%s: %v", file, val, err)
	}
}

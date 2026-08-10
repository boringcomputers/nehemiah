package main

import (
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// Version is replaced at build time with -ldflags "-X main.Version=<version>".
var Version = "dev"

type hostMachineCounts struct {
	Total    int `json:"total"`
	Starting int `json:"starting"`
	Running  int `json:"running"`
	Stopping int `json:"stopping"`
}

// hostStatus is the stable heartbeat payload consumed by the control plane.
// Capacity values describe schedulable host resources, not tenant usage.
type hostStatus struct {
	HostID             string               `json:"host_id"`
	Region             string               `json:"region"`
	State              string               `json:"state"`
	Draining           bool                 `json:"draining"`
	Architecture       string               `json:"architecture"`
	KVM                bool                 `json:"kvm"`
	TotalCPU           int                  `json:"total_cpu"`
	AvailableCPU       int                  `json:"available_cpu"`
	TotalMemoryMB      int                  `json:"total_memory_mb"`
	AvailableMemoryMB  int                  `json:"available_memory_mb"`
	TotalDiskBytes     uint64               `json:"total_disk_bytes"`
	AvailableDiskBytes uint64               `json:"available_disk_bytes"`
	Version            string               `json:"version"`
	RuntimeCohort      managedRuntimeCohort `json:"runtime_cohort"`
	Machines           hostMachineCounts    `json:"machines"`
	ObservedAt         string               `json:"observed_at"`
	UnhealthyReasons   []string             `json:"unhealthy_reasons,omitempty"`
}

type hostResources struct {
	Architecture       string
	KVM                bool
	Jailer             bool
	TotalCPU           int
	TotalMemoryMB      int
	AvailableMemoryMB  int
	TotalDiskBytes     uint64
	AvailableDiskBytes uint64
	Errors             []string
}

type hostProbe interface {
	Inspect(Config) hostResources
}

type systemHostProbe struct{}

func (systemHostProbe) Inspect(cfg Config) hostResources {
	r := hostResources{
		Architecture:      nehemiahArchitecture(runtime.GOARCH),
		TotalCPU:          runtime.NumCPU(),
		TotalMemoryMB:     totalMemoryMB(),
		AvailableMemoryMB: availableMemoryMB(),
	}
	if _, err := os.Stat("/dev/kvm"); err == nil {
		r.KVM = true
	} else {
		r.Errors = append(r.Errors, "kvm_unavailable")
	}
	if err := validateManagedRuntimeAssets(cfg, true); err != nil {
		r.Errors = append(r.Errors, "runtime_assets_unavailable")
	}
	if info, err := os.Stat(cfg.JailerBin); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
		r.Jailer = true
	} else if cfg.NehemiahMode {
		r.Errors = append(r.Errors, "jailer_unavailable")
	}
	if total, available, err := filesystemCapacity(cfg.RunDir); err == nil {
		r.TotalDiskBytes = total
		r.AvailableDiskBytes = available
	} else {
		r.Errors = append(r.Errors, "disk_unavailable")
	}
	return r
}

func nehemiahArchitecture(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return goarch
	}
}

func (mgr *Manager) HostStatus(probe hostProbe) hostStatus {
	if probe == nil {
		probe = systemHostProbe{}
	}
	resources := probe.Inspect(mgr.cfg)

	mgr.mu.Lock()
	counts := hostMachineCounts{}
	reservedCPU := 0
	reservedMemoryMB := 0
	reservedDiskBytes := uint64(0)
	stateHealthy := mgr.stateHealthy
	meteringHealthy := mgr.meteringHealthy
	networkHealthy := mgr.networkHealthy
	runtimeCohortHealthy := mgr.runtimeCohortHealthy
	identityHealthy := mgr.identityHealthy
	for _, m := range mgr.machines {
		cpus := m.VCPUs
		if cpus <= 0 {
			tpl := mgr.cfg.Template(m.Template)
			cpus = tpl.VCPUs
			if cpus <= 0 {
				cpus = mgr.cfg.VCPUs
			}
		}
		reservedCPU += cpus
		memory := m.MemoryMB
		if memory <= 0 {
			tpl := mgr.cfg.Template(m.Template)
			memory = tpl.MemSizeMB
			if memory <= 0 {
				memory = mgr.cfg.MemSizeMB
			}
		}
		reservedMemoryMB += memory
		if m.DiskMB > 0 {
			reservedDiskBytes += uint64(m.DiskMB) * 1024 * 1024
		}
		if m.pooled {
			continue
		}
		counts.Total++
		switch m.Status {
		case "booting", "warming", "starting":
			counts.Starting++
		case "stopping":
			counts.Stopping++
		default:
			counts.Running++
		}
	}
	mgr.mu.Unlock()

	availableCPU := resources.TotalCPU - reservedCPU
	if availableCPU < 0 {
		availableCPU = 0
	}
	availableMemory := resources.AvailableMemoryMB - mgr.cfg.MemReserveMB
	configuredMemoryAvailable := resources.TotalMemoryMB - mgr.cfg.MemReserveMB - reservedMemoryMB
	if configuredMemoryAvailable < availableMemory {
		availableMemory = configuredMemoryAvailable
	}
	if availableMemory < 0 {
		availableMemory = 0
	}
	availableDisk := resources.AvailableDiskBytes
	if reservedDiskBytes >= availableDisk {
		availableDisk = 0
	} else {
		availableDisk -= reservedDiskBytes
	}
	state := "ready"
	reasons := append([]string(nil), resources.Errors...)
	if !stateHealthy {
		reasons = appendUnique(reasons, "state_persistence_unavailable")
	}
	if mgr.cfg.NehemiahMode && !meteringHealthy {
		reasons = appendUnique(reasons, "metering_persistence_unavailable")
	}
	if mgr.cfg.NehemiahMode && !networkHealthy {
		reasons = appendUnique(reasons, "managed_network_policy_drift")
	}
	if mgr.cfg.NehemiahMode && !runtimeCohortHealthy {
		reasons = appendUnique(reasons, "runtime_cohort_mismatch")
	}
	if mgr.cfg.NehemiahMode && !identityHealthy {
		reasons = appendUnique(reasons, "jailer_identity_teardown_unverified")
	}
	if !resources.KVM || (mgr.cfg.NehemiahMode && (!resources.Jailer || !mgr.cgroups.Enabled())) || len(reasons) > 0 {
		state = "unhealthy"
		if mgr.cfg.NehemiahMode && !mgr.cgroups.Enabled() {
			reasons = appendUnique(reasons, "cgroups_unavailable")
		}
	} else if mgr.cfg.Draining {
		state = "draining"
	}

	return hostStatus{
		HostID:             mgr.cfg.HostID,
		Region:             mgr.cfg.Region,
		State:              state,
		Draining:           mgr.cfg.Draining,
		Architecture:       resources.Architecture,
		KVM:                resources.KVM,
		TotalCPU:           resources.TotalCPU,
		AvailableCPU:       availableCPU,
		TotalMemoryMB:      resources.TotalMemoryMB,
		AvailableMemoryMB:  availableMemory,
		TotalDiskBytes:     resources.TotalDiskBytes,
		AvailableDiskBytes: availableDisk,
		Version:            Version,
		RuntimeCohort:      mgr.cfg.RuntimeCohort,
		Machines:           counts,
		ObservedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		UnhealthyReasons:   reasons,
	}
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func totalMemoryMB() int {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	return memoryFieldMB(data, "MemTotal:")
}

func filesystemCapacity(path string) (uint64, uint64, error) {
	for {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(path, &stat); err == nil {
			blockSize := uint64(stat.Bsize)
			return stat.Blocks * blockSize, stat.Bavail * blockSize, nil
		} else if parent := filepath.Dir(path); parent != path {
			path = parent
			continue
		} else {
			return 0, 0, err
		}
	}
}

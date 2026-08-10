package main

import (
	"testing"
	"time"
)

type staticHostProbe struct{ resources hostResources }

func (probe staticHostProbe) Inspect(Config) hostResources { return probe.resources }

func TestHostStatusReadyAndCapacity(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.MemReserveMB = 512
	mgr := NewManager(cfg)
	mgr.mu.Lock()
	mgr.machines["m-00000001"] = &Machine{ID: "m-00000001", Status: "running", Template: "python", CreatedAt: time.Now()}
	mgr.mu.Unlock()

	status := mgr.HostStatus(staticHostProbe{hostResources{
		Architecture:       "x86_64",
		KVM:                true,
		Jailer:             true,
		TotalCPU:           8,
		TotalMemoryMB:      16384,
		AvailableMemoryMB:  8192,
		TotalDiskBytes:     1_000_000,
		AvailableDiskBytes: 750_000,
	}})
	if status.State != "ready" {
		t.Fatalf("state = %q, want ready (%v)", status.State, status.UnhealthyReasons)
	}
	if status.AvailableCPU != 7 {
		t.Fatalf("available cpu = %d, want 7", status.AvailableCPU)
	}
	if status.AvailableMemoryMB != 7680 {
		t.Fatalf("available memory = %d, want 7680", status.AvailableMemoryMB)
	}
	if status.Machines.Total != 1 || status.Machines.Running != 1 {
		t.Fatalf("machine counts = %+v", status.Machines)
	}
}

func TestHostStatusDraining(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.Draining = true
	mgr := NewManager(cfg)
	status := mgr.HostStatus(staticHostProbe{hostResources{KVM: true, Jailer: true, TotalCPU: 4}})
	if status.State != "draining" || !status.Draining {
		t.Fatalf("status = %+v, want draining", status)
	}
}

func TestHostStatusUnhealthy(t *testing.T) {
	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	status := mgr.HostStatus(staticHostProbe{hostResources{TotalCPU: 4, Errors: []string{"kvm_unavailable"}}})
	if status.State != "unhealthy" {
		t.Fatalf("state = %q, want unhealthy", status.State)
	}
}

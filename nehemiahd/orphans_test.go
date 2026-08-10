package main

import (
	"errors"
	"path/filepath"
	"testing"
)

func managedOrphanTestOps() (managedOrphanCleanupOps, *[]string, *[]managedOrphanProcess) {
	scopes := []string{"nehemiah-vmm-m-01020304.scope"}
	processes := []managedOrphanProcess{{pid: 42, id: "m-01020305", name: "firecracker"}}
	ops := managedOrphanCleanupOps{
		listScopes: func() ([]string, error) { return append([]string(nil), scopes...), nil },
		stopScope: func(unit string) error {
			for index, candidate := range scopes {
				if candidate == unit {
					scopes = append(scopes[:index], scopes[index+1:]...)
					return nil
				}
			}
			return errors.New("unknown scope")
		},
		listProcesses: func() ([]managedOrphanProcess, error) {
			return append([]managedOrphanProcess(nil), processes...), nil
		},
		killProcess: func(process managedOrphanProcess) error {
			for index, candidate := range processes {
				if candidate.pid == process.pid {
					processes = append(processes[:index], processes[index+1:]...)
					return nil
				}
			}
			return errors.New("unknown process")
		},
		cleanupChroots: func(map[string]struct{}) (int, error) { return 1, nil },
		cleanupRun:     func(map[string]struct{}) (int, error) { return 1, nil },
		cleanupNetwork: func(map[string]struct{}) (int, error) { return 1, nil },
		processRetained: func(managedOrphanProcess, map[string]struct{}) bool {
			return false
		},
	}
	return ops, &scopes, &processes
}

func TestManagedOrphanCleanupProvesEveryBoundary(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	ops, _, _ := managedOrphanTestOps()
	removed, err := reapManagedOrphansExcept(cfg, nil, ops)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 5 {
		t.Fatalf("removed=%d, want one scope, process, jail, run artifact, and network object", removed)
	}
}

func TestManagedOrphanCleanupFailsClosedAtEveryBoundary(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	injected := errors.New("injected cleanup failure")
	tests := []struct {
		name   string
		mutate func(managedOrphanCleanupOps, *[]string, *[]managedOrphanProcess) managedOrphanCleanupOps
	}{
		{"scope stop", func(ops managedOrphanCleanupOps, _ *[]string, _ *[]managedOrphanProcess) managedOrphanCleanupOps {
			ops.stopScope = func(string) error { return injected }
			return ops
		}},
		{"scope absence proof", func(ops managedOrphanCleanupOps, _ *[]string, _ *[]managedOrphanProcess) managedOrphanCleanupOps {
			ops.stopScope = func(string) error { return nil }
			return ops
		}},
		{"process kill", func(ops managedOrphanCleanupOps, scopes *[]string, _ *[]managedOrphanProcess) managedOrphanCleanupOps {
			*scopes = nil
			ops.killProcess = func(managedOrphanProcess) error { return injected }
			return ops
		}},
		{"process absence proof", func(ops managedOrphanCleanupOps, scopes *[]string, _ *[]managedOrphanProcess) managedOrphanCleanupOps {
			*scopes = nil
			ops.killProcess = func(managedOrphanProcess) error { return nil }
			return ops
		}},
		{"jailer chroot", func(ops managedOrphanCleanupOps, scopes *[]string, processes *[]managedOrphanProcess) managedOrphanCleanupOps {
			*scopes, *processes = nil, nil
			ops.cleanupChroots = func(map[string]struct{}) (int, error) { return 0, injected }
			return ops
		}},
		{"run artifact", func(ops managedOrphanCleanupOps, scopes *[]string, processes *[]managedOrphanProcess) managedOrphanCleanupOps {
			*scopes, *processes = nil, nil
			ops.cleanupRun = func(map[string]struct{}) (int, error) { return 0, injected }
			return ops
		}},
		{"guest network", func(ops managedOrphanCleanupOps, scopes *[]string, processes *[]managedOrphanProcess) managedOrphanCleanupOps {
			*scopes, *processes = nil, nil
			ops.cleanupNetwork = func(map[string]struct{}) (int, error) { return 0, injected }
			return ops
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ops, scopes, processes := managedOrphanTestOps()
			ops = test.mutate(ops, scopes, processes)
			if _, err := reapManagedOrphansExcept(cfg, nil, ops); err == nil {
				t.Fatal("managed cleanup failure was hidden")
			}
		})
	}
}

func TestManagedReconcileCleanupFailureClosesAdmission(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	store := NewStateStore(cfg.StatePath)
	if err := store.Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: cfg.HostID,
		RuntimeCohort: cfg.RuntimeCohort, Machines: []persistedMachine{},
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(cfg)
	ops, scopes, processes := managedOrphanTestOps()
	*scopes, *processes = nil, nil
	ops.cleanupRun = func(map[string]struct{}) (int, error) {
		return 0, errors.New("injected run artifact removal failure")
	}
	mgr.orphanCleanup = ops
	if _, err := mgr.Reconcile(); err == nil {
		t.Fatal("managed reconcile ignored an orphan cleanup failure")
	}
	mgr.mu.Lock()
	healthy := mgr.stateHealthy
	mgr.mu.Unlock()
	if healthy {
		t.Fatal("managed admission remained healthy after orphan cleanup failure")
	}
	expectation := managedRuntimeExpectation{
		CohortID: cfg.RuntimeCohort.ID, RootfsSHA256: cfg.RuntimeCohort.PythonRootfsSHA256,
	}
	if _, _, err := mgr.CreateInternalWithRuntimeExpectation(
		"python", 120, false, false, "internal", "orphan-cleanup-create", "orphan-cleanup-lease", 1,
		nil, 0, 0, 0, networkPolicyDeclaration{}, expectation,
	); !errors.Is(err, ErrHostUnhealthy) {
		t.Fatalf("create error=%v, want ErrHostUnhealthy", err)
	}
}

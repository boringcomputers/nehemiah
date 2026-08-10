package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStateStoreClassifiesMalformedOversizedAndUnsupportedState(t *testing.T) {
	tests := []struct {
		name  string
		kind  string
		write func(*testing.T, string)
	}{
		{
			name: "malformed", kind: "malformed",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(`{"version":1,"machines":[`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "oversized", kind: "oversized",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(path, int64(maxMachineStateBytes)+1); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "unsupported", kind: "unsupported_version",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(`{"version":999,"machines":[]}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "trailing document", kind: "trailing_data",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte("{\"version\":1,\"machines\":[]}\n{}\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			test.write(t, path)
			_, err := NewStateStore(path).Load()
			kind, ok := invalidMachineStateKind(err)
			if !ok || kind != test.kind {
				t.Fatalf("state error = %v (kind %q, classified %v), want %q", err, kind, ok, test.kind)
			}
		})
	}
}

func TestManagedReconcileQuarantinesOnlyAfterScopeAndNetworkIsolation(t *testing.T) {
	tests := []struct {
		name  string
		kind  string
		write func(*testing.T, string)
	}{
		{
			name: "malformed", kind: "malformed",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(`{"version":1,"machines":[`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "oversized", kind: "oversized",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(path, int64(maxMachineStateBytes)+4096); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "unsupported", kind: "unsupported_version",
			write: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(`{"version":2,"machines":[]}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			temp := t.TempDir()
			cfg := internalTestConfig(t)
			cfg.NehemiahMode = true
			cfg.NetEnable = true
			cfg.StatePath = filepath.Join(temp, "state.json")
			cfg.RunDir = filepath.Join(temp, "run")
			cfg.ChrootBase = filepath.Join(temp, "jailer")
			if err := os.MkdirAll(cfg.RunDir, 0o700); err != nil {
				t.Fatal(err)
			}
			test.write(t, cfg.StatePath)

			mgr := NewManager(cfg)
			scopes := map[string]bool{"nehemiah-vmm-m-1234abcd.scope": true}
			taps := map[string]bool{"bt1234abcd": true}
			actions := make([]string, 0, 3)
			assertClosed := func() {
				mgr.mu.Lock()
				healthy := mgr.stateHealthy
				mgr.mu.Unlock()
				if healthy {
					t.Error("managed admission was open during invalid-state isolation")
				}
				if evidence, _ := filepath.Glob(cfg.StatePath + ".corrupt-*"); len(evidence) != 0 {
					t.Error("invalid state was quarantined before runtime isolation completed")
				}
				if _, err := os.Lstat(cfg.StatePath); err != nil {
					t.Errorf("invalid state moved before isolation completed: %v", err)
				}
			}
			mgr.stateRecovery = managedStateRecoveryOps{
				listScopes: func() ([]string, error) { return trueMapKeys(scopes), nil },
				stopScope: func(unit string) error {
					assertClosed()
					actions = append(actions, "scope:"+unit)
					delete(scopes, unit)
					return nil
				},
				listTaps: func() ([]string, error) { return trueMapKeys(taps), nil },
				isolateTap: func(tap string) error {
					assertClosed()
					actions = append(actions, "tap:"+tap)
					delete(taps, tap)
					return nil
				},
				cleanupArtifacts: func() (int, error) {
					assertClosed()
					actions = append(actions, "artifacts")
					return 1, nil
				},
			}

			report, err := mgr.Reconcile()
			if err != nil {
				t.Fatal(err)
			}
			if !report.StateQuarantined || report.Orphans != 3 || len(scopes) != 0 || len(taps) != 0 {
				t.Fatalf("recovery report=%+v scopes=%v taps=%v", report, scopes, taps)
			}
			wantActions := []string{"tap:bt1234abcd", "scope:nehemiah-vmm-m-1234abcd.scope", "artifacts"}
			if !reflect.DeepEqual(actions, wantActions) {
				t.Fatalf("recovery actions = %v, want %v", actions, wantActions)
			}
			evidence, err := filepath.Glob(cfg.StatePath + ".corrupt-" + test.kind + "-*")
			if err != nil || len(evidence) != 1 {
				t.Fatalf("quarantine evidence = %v, err=%v", evidence, err)
			}
			info, err := os.Stat(evidence[0])
			if err != nil {
				t.Fatal(err)
			}
			if info.Size() > maxStateQuarantineBytes || info.Mode().Perm() != 0o600 {
				t.Fatalf("quarantine size/mode = %d/%o", info.Size(), info.Mode().Perm())
			}
			fresh, err := mgr.stateStore.Load()
			if err != nil {
				t.Fatal(err)
			}
			if fresh.Version != machineStateVersion || len(fresh.Machines) != 0 || fresh.HostID != cfg.HostID {
				t.Fatalf("fresh state after recovery = %+v", fresh)
			}
			mgr.mu.Lock()
			healthy := mgr.stateHealthy
			mgr.mu.Unlock()
			if !healthy {
				t.Fatal("managed admission did not reopen after verified recovery")
			}
		})
	}
}

func TestManagedReconcileFailureKeepsStateAndAdmissionClosed(t *testing.T) {
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.NetEnable = true
	cfg.StatePath = filepath.Join(temp, "state.json")
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")
	invalid := []byte(`{"version":1,"machines":[`)
	if err := os.WriteFile(cfg.StatePath, invalid, 0o600); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(cfg)
	scopes := map[string]bool{"nehemiah-vmm-m-deadbeef.scope": true}
	taps := map[string]bool{"btdeadbeef": true}
	mgr.stateRecovery = managedStateRecoveryOps{
		listScopes: func() ([]string, error) { return trueMapKeys(scopes), nil },
		stopScope:  func(string) error { return errors.New("fake scope remains active") },
		listTaps:   func() ([]string, error) { return trueMapKeys(taps), nil },
		isolateTap: func(tap string) error {
			delete(taps, tap)
			return nil
		},
		cleanupArtifacts: func() (int, error) { return 0, nil },
	}
	if _, err := mgr.Reconcile(); err == nil {
		t.Fatal("recovery succeeded while a managed scope remained active")
	}
	contents, err := os.ReadFile(cfg.StatePath)
	if err != nil || !reflect.DeepEqual(contents, invalid) {
		t.Fatalf("invalid state was replaced after failed isolation: %q (%v)", contents, err)
	}
	if evidence, _ := filepath.Glob(cfg.StatePath + ".corrupt-*"); len(evidence) != 0 {
		t.Fatalf("failed isolation created quarantine evidence: %v", evidence)
	}
	if len(taps) != 0 || len(scopes) != 1 {
		t.Fatalf("failed recovery taps=%v scopes=%v", taps, scopes)
	}

	var boots atomic.Int32
	mgr.boot = func(Config, string, Template, string, bool, bool, int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		return nil, "", 0, errors.New("boot must not run")
	}
	_, _, err = mgr.CreateInternalWithPolicyGeneration(
		"python", 60, false, false, "internal", "state-recovery-admission", "lease-state-recovery", 1,
		map[string]string{"public_machine_id": "m_public_state_recovery"}, 1, 256, 1024, networkPolicyDeclaration{},
	)
	if !errors.Is(err, ErrHostUnhealthy) || boots.Load() != 0 {
		t.Fatalf("admission err=%v boots=%d, want host unhealthy without boot", err, boots.Load())
	}
}

func TestManagedInvalidStateArtifactCleanupFailurePreventsQuarantine(t *testing.T) {
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.StatePath = filepath.Join(temp, "state.json")
	invalid := []byte(`{"version":1,"machines":[`)
	if err := os.WriteFile(cfg.StatePath, invalid, 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(cfg)
	mgr.stateRecovery = managedStateRecoveryOps{
		listScopes:       func() ([]string, error) { return nil, nil },
		stopScope:        func(string) error { return nil },
		listTaps:         func() ([]string, error) { return nil, nil },
		isolateTap:       func(string) error { return nil },
		cleanupArtifacts: func() (int, error) { return 0, errors.New("injected artifact cleanup failure") },
	}
	if _, err := mgr.Reconcile(); err == nil {
		t.Fatal("invalid-state recovery ignored artifact cleanup failure")
	}
	contents, err := os.ReadFile(cfg.StatePath)
	if err != nil || !reflect.DeepEqual(contents, invalid) {
		t.Fatalf("invalid state changed after failed cleanup: %q (%v)", contents, err)
	}
	if evidence, _ := filepath.Glob(cfg.StatePath + ".corrupt-*"); len(evidence) != 0 {
		t.Fatalf("failed cleanup published quarantine evidence: %v", evidence)
	}
	mgr.mu.Lock()
	healthy := mgr.stateHealthy
	mgr.mu.Unlock()
	if healthy {
		t.Fatal("managed admission remained healthy after invalid-state cleanup failure")
	}
}

func TestManagedReconcileRawStateOpenErrorStillIsolatesAndFailsClosed(t *testing.T) {
	temp := t.TempDir()
	statePath := filepath.Join(temp, "state.json")
	if err := os.WriteFile(statePath, []byte("preserve this evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.NetEnable = false // stale managed network must still be discovered.
	cfg.StatePath = statePath
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")

	mgr := NewManager(cfg)
	stateOpenErr := errors.New("injected state open failure")
	mgr.stateStore.openFile = func(string) (*os.File, error) { return nil, stateOpenErr }
	scopes := map[string]bool{"nehemiah-vmm-m-feedface.scope": true}
	taps := map[string]bool{"btfeedface": true}
	mgr.stateRecovery = managedStateRecoveryOps{
		listScopes: func() ([]string, error) { return trueMapKeys(scopes), nil },
		stopScope: func(scope string) error {
			delete(scopes, scope)
			return nil
		},
		listTaps: func() ([]string, error) { return trueMapKeys(taps), nil },
		isolateTap: func(tap string) error {
			delete(taps, tap)
			return nil
		},
		cleanupArtifacts: func() (int, error) { return 0, nil },
	}
	report, err := mgr.Reconcile()
	if err == nil || !errors.Is(err, stateOpenErr) {
		t.Fatalf("raw state load error = %v, want preserved injected open error", err)
	}
	if len(scopes) != 0 || len(taps) != 0 || report.Orphans != 2 || report.StateQuarantined {
		t.Fatalf("raw-error recovery report=%+v scopes=%v taps=%v", report, scopes, taps)
	}
	contents, readErr := os.ReadFile(statePath)
	if readErr != nil || string(contents) != "preserve this evidence" {
		t.Fatalf("raw state evidence changed: %q (%v)", contents, readErr)
	}
	mgr.mu.Lock()
	healthy := mgr.stateHealthy
	mgr.mu.Unlock()
	if healthy {
		t.Fatal("managed admission reopened after an unreadable state file")
	}
}

func managedEmptyStateConfig(t *testing.T) Config {
	t.Helper()
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.StatePath = filepath.Join(temp, "state.json")
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")
	if err := os.MkdirAll(cfg.RunDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestManagedReconcileRequiresExactRuntimeCohortAndIdentityLedger(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*machineStateSnapshot)
	}{
		{name: "runtime cohort mismatch", mutate: func(snapshot *machineStateSnapshot) {
			snapshot.RuntimeCohort.ID = strings.Repeat("f", 64)
		}},
		{name: "duplicate jailer uid", mutate: func(snapshot *machineStateSnapshot) {
			snapshot.JailerIdentities = []persistedJailerIdentity{
				{MachineID: "m-01020304", UID: 30000, GID: 30000, ReservationID: strings.Repeat("a", 32)},
				{MachineID: "m-01020305", UID: 30000, GID: 30001, ReservationID: strings.Repeat("b", 32)},
			}
		}},
		{name: "machine missing identity", mutate: func(snapshot *machineStateSnapshot) {
			snapshot.Machines = []persistedMachine{{ID: "m-01020304"}}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := managedEmptyStateConfig(t)
			snapshot := machineStateSnapshot{
				Version: machineStateVersion, Generation: 1, HostID: cfg.HostID,
				RuntimeCohort: cfg.RuntimeCohort, UpdatedAt: time.Now().UTC(), Machines: []persistedMachine{},
			}
			test.mutate(&snapshot)
			if err := NewStateStore(cfg.StatePath).Save(snapshot); err != nil {
				t.Fatal(err)
			}
			mgr := NewManager(cfg)
			mgr.identityAvailable = func(int, int) error { return nil }
			mgr.stateRecovery = managedStateRecoveryOps{
				listScopes:       func() ([]string, error) { return nil, nil },
				stopScope:        func(string) error { return nil },
				listTaps:         func() ([]string, error) { return nil, nil },
				isolateTap:       func(string) error { return nil },
				cleanupArtifacts: func() (int, error) { return 0, nil },
			}
			report, err := mgr.Reconcile()
			if err != nil {
				t.Fatalf("safe invalid-state recovery: %v", err)
			}
			if !report.StateQuarantined || mgr.Count() != 0 {
				t.Fatalf("report=%+v count=%d, want quarantined empty host", report, mgr.Count())
			}
		})
	}
}

func TestManagedReconcileReleasesOnlyVerifiedHeldIdentity(t *testing.T) {
	for _, test := range []struct {
		name      string
		verifyErr error
		wantErr   bool
	}{
		{name: "verified release"},
		{name: "unverified held", verifyErr: errors.New("jail remains"), wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := managedEmptyStateConfig(t)
			if err := NewStateStore(cfg.StatePath).Save(machineStateSnapshot{
				Version: machineStateVersion, Generation: 1, HostID: cfg.HostID,
				RuntimeCohort: cfg.RuntimeCohort, UpdatedAt: time.Now().UTC(), Machines: []persistedMachine{},
				JailerIdentities: []persistedJailerIdentity{{
					MachineID: "m-01020304", UID: 30000, GID: 30000, ReservationID: strings.Repeat("a", 32),
				}},
			}); err != nil {
				t.Fatal(err)
			}
			mgr := NewManager(cfg)
			mgr.identityAvailable = func(int, int) error { return nil }
			var verified int
			mgr.verifyIdentityTeardown = func(Config, string, jailerIdentity) error {
				verified++
				return test.verifyErr
			}
			_, err := mgr.Reconcile()
			if (err != nil) != test.wantErr {
				t.Fatalf("reconcile error=%v wantErr=%t", err, test.wantErr)
			}
			if verified != 1 {
				t.Fatalf("teardown verification calls=%d want=1", verified)
			}
			_, held := mgr.jailerIdentities["m-01020304"]
			if held != test.wantErr {
				t.Fatalf("identity held=%t want=%t", held, test.wantErr)
			}
			if test.wantErr && mgr.identityHealthy {
				t.Fatal("identity health remained ready after unverified recovery teardown")
			}
		})
	}
}

func TestStateQuarantineEvidenceIsSizeAndCountBounded(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	store := NewStateStore(path)
	for iteration := 0; iteration < maxStateQuarantineFiles+2; iteration++ {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(path, int64(maxMachineStateBytes)+int64(iteration)+1); err != nil {
			t.Fatal(err)
		}
		evidence, err := store.QuarantineInvalid("oversized")
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(evidence)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() != maxStateQuarantineBytes || info.Mode().Perm() != 0o600 {
			t.Fatalf("evidence size/mode = %d/%o", info.Size(), info.Mode().Perm())
		}
	}
	evidence, err := filepath.Glob(path + ".corrupt-*")
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != maxStateQuarantineFiles {
		t.Fatalf("retained quarantine files = %d, want %d", len(evidence), maxStateQuarantineFiles)
	}
	for _, file := range evidence {
		if info, err := os.Stat(file); err != nil || info.Size() > maxStateQuarantineBytes {
			t.Fatalf("unbounded quarantine evidence %s: %+v (%v)", file, info, err)
		}
	}
}

func trueMapKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key, present := range values {
		if present {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStateStoreAtomicSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	store := NewStateStore(path)
	const saves = 40
	var wait sync.WaitGroup
	for generation := uint64(1); generation <= saves; generation++ {
		wait.Add(1)
		go func(generation uint64) {
			defer wait.Done()
			if err := store.Save(machineStateSnapshot{
				Version:    machineStateVersion,
				Generation: generation,
				UpdatedAt:  time.Now().UTC(),
				Machines:   []persistedMachine{},
			}); err != nil {
				t.Errorf("save generation %d: %v", generation, err)
			}
		}(generation)
	}
	wait.Wait()

	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Generation != saves {
		t.Fatalf("generation = %d, want %d", loaded.Generation, saves)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if permission := info.Mode().Perm(); permission != 0o600 {
		t.Fatalf("state permissions = %o, want 600", permission)
	}
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".state-*.tmp"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary files left after atomic save: %v (%v)", leftovers, err)
	}
}

func TestStateStoreRejectsCorruptAndFutureState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"version":999,"generation":1,"machines":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStateStore(path).Load(); err == nil {
		t.Fatal("future state version was accepted")
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"machines":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStateStore(path).Load(); err == nil {
		t.Fatal("truncated state was accepted")
	}
}

func TestStateStorePersistsManagedForkReplayState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store := NewStateStore(path)
	want := persistedForkOperation{
		SourceID:       "m-01020304",
		IdempotencyKey: "fork-durable",
		Fingerprint:    strings.Repeat("a", 64),
		ChildIDs:       []string{"m-11111111", "m-22222222"},
		State:          "failed",
		FailureCode:    "fork_batch_failed",
	}
	if err := store.Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, UpdatedAt: time.Now().UTC(),
		Machines: []persistedMachine{}, Forks: []persistedForkOperation{want},
	}); err != nil {
		t.Fatal(err)
	}
	loaded, err := NewStateStore(path).Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Forks) != 1 || !reflect.DeepEqual(loaded.Forks[0], want) {
		t.Fatalf("fork replay state = %+v, want %+v", loaded.Forks, want)
	}
}

func TestReconcileReattachesVerifiedRuntime(t *testing.T) {
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")
	cfg.StatePath = filepath.Join(temp, "state.json")
	if err := os.MkdirAll(cfg.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "m-1234abcd"
	process := startStateHelper(t, id)
	socket := filepath.Join(cfg.RunDir, id+".sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = process.Process.Kill()
		_, _ = process.Process.Wait()
	})
	overlay := filepath.Join(cfg.RunDir, id+".ext4")
	if err := os.WriteFile(overlay, []byte("overlay"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStateStore(cfg.StatePath)
	extendTarget := time.Now().UTC().Add(45 * time.Second).Truncate(time.Second)
	if err := store.Save(machineStateSnapshot{
		Version:    machineStateVersion,
		Generation: 7,
		HostID:     cfg.HostID,
		UpdatedAt:  time.Now().UTC(),
		Machines: []persistedMachine{{
			ID:                 id,
			Status:             "running",
			Template:           "python",
			CreatedAt:          time.Now().Add(-time.Minute),
			ExpiresAt:          time.Now().Add(time.Minute),
			LeaseID:            "lease-reconcile",
			IdempotencyKey:     "create-reconcile",
			RequestFingerprint: "fingerprint",
			ExtendOperations:   map[string]time.Time{"extend-reconcile": extendTarget},
			Runtime: &persistedRuntime{
				PID: process.Process.Pid, Socket: socket, Overlay: overlay,
			},
		}},
	}); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	report, err := mgr.Reconcile()
	if err != nil {
		t.Fatal(err)
	}
	if report.Reattached != 1 || report.Lost != 0 {
		t.Fatalf("report = %+v", report)
	}
	view, ok := mgr.InternalGet(id)
	if !ok || !view.Ready || view.StartedAt == "" || view.LeaseID != "lease-reconcile" {
		t.Fatalf("reattached view = %+v, ok=%v", view, ok)
	}
	if _, replayed, err := mgr.ExtendInternal(id, "lease-reconcile", "extend-reconcile", extendTarget); err != nil || !replayed {
		t.Fatalf("restored extend replay = %v, err=%v", replayed, err)
	}
	if !mgr.Destroy(id) {
		t.Fatal("destroy reattached machine failed")
	}
}

func TestReconcileTerminatesExpiredPersistedRuntime(t *testing.T) {
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")
	cfg.StatePath = filepath.Join(temp, "state.json")
	if err := os.MkdirAll(cfg.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "m-deadbeef"
	process := startStateHelper(t, id)
	overlay := filepath.Join(cfg.RunDir, id+".ext4")
	if err := os.WriteFile(overlay, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewStateStore(cfg.StatePath).Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: cfg.HostID, UpdatedAt: time.Now(),
		Machines: []persistedMachine{{
			ID: id, Status: "running", Template: "python", CreatedAt: time.Now().Add(-time.Hour),
			ExpiresAt: time.Now().Add(-time.Second), LeaseID: "expired-lease",
			Runtime: &persistedRuntime{PID: process.Process.Pid, Socket: filepath.Join(cfg.RunDir, id+".sock"), Overlay: overlay},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(cfg)
	report, err := mgr.Reconcile()
	if err != nil {
		t.Fatal(err)
	}
	if report.Lost != 1 || mgr.Count() != 0 {
		t.Fatalf("report=%+v count=%d", report, mgr.Count())
	}
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = process.Process.Kill()
		t.Fatal("expired runtime was not terminated")
	}
}

func TestReconcileCleansIncompleteSuccessfulForkAndCachesTerminalResult(t *testing.T) {
	cfg, sourceID, sourceLease, requested := restartForkFixture(t)
	childIDs := []string{"m-11111111", "m-22222222"}
	child := persistedForkChild(t, cfg, childIDs[0], sourceID, requested[0])
	now := time.Now().UTC()
	operation := persistedForkOperation{
		SourceID: sourceID, IdempotencyKey: "fork-restart-incomplete",
		Fingerprint: managedForkFingerprint(sourceID, sourceLease, requested), ChildIDs: childIDs,
		State: "succeeded", CreatedAt: now.Add(-time.Second), RetainUntil: now.Add(time.Duration(cfg.MaxTTL) * time.Second),
	}
	if err := NewStateStore(cfg.StatePath).Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: cfg.HostID, UpdatedAt: now,
		Machines: []persistedMachine{child}, Forks: []persistedForkOperation{operation},
	}); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	mgr.reconcileReadyTimeout = 10 * time.Millisecond
	report, err := mgr.Reconcile()
	if err != nil {
		t.Fatal(err)
	}
	if report.Reattached != 1 || mgr.Count() != 0 {
		t.Fatalf("report=%+v count=%d", report, mgr.Count())
	}
	if _, replayed, err := mgr.ForkInternal(sourceID, sourceLease, operation.IdempotencyKey, requested); !replayed || !errors.Is(err, ErrForkBatchCleaned) {
		t.Fatalf("incomplete restart replayed=%v err=%v", replayed, err)
	}
	durable, err := NewStateStore(cfg.StatePath).Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(durable.Machines) != 0 || len(durable.Forks) != 1 || durable.Forks[0].FailureCode != "fork_batch_cleaned" {
		t.Fatalf("reconciled state machines=%+v forks=%+v", durable.Machines, durable.Forks)
	}
}

func TestReconcileCleansInterruptedPendingFork(t *testing.T) {
	cfg, sourceID, sourceLease, requested := restartForkFixture(t)
	childIDs := []string{"m-33333333", "m-44444444"}
	machines := []persistedMachine{
		persistedForkChild(t, cfg, childIDs[0], sourceID, requested[0]),
		persistedForkChild(t, cfg, childIDs[1], sourceID, requested[1]),
	}
	now := time.Now().UTC()
	operation := persistedForkOperation{
		SourceID: sourceID, IdempotencyKey: "fork-restart-pending",
		Fingerprint: managedForkFingerprint(sourceID, sourceLease, requested), ChildIDs: childIDs,
		State: "pending", CreatedAt: now.Add(-time.Second), RetainUntil: now.Add(time.Duration(cfg.MaxTTL) * time.Second),
	}
	if err := NewStateStore(cfg.StatePath).Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: cfg.HostID, UpdatedAt: now,
		Machines: machines, Forks: []persistedForkOperation{operation},
	}); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	mgr.reconcileReadyTimeout = 10 * time.Millisecond
	if _, err := mgr.Reconcile(); err != nil {
		t.Fatal(err)
	}
	if mgr.Count() != 0 {
		t.Fatalf("interrupted fork left %d machines", mgr.Count())
	}
	if _, replayed, err := mgr.ForkInternal(sourceID, sourceLease, operation.IdempotencyKey, requested); !replayed || !errors.Is(err, ErrForkBatchCleaned) {
		t.Fatalf("pending restart replayed=%v err=%v", replayed, err)
	}
}

func TestReconcileSuccessfulForkStartingIsRetryableThenReplaysWithoutSource(t *testing.T) {
	cfg, sourceID, sourceLease, requested := restartForkFixture(t)
	childIDs := []string{"m-55555555", "m-66666666"}
	machines := []persistedMachine{
		persistedForkChild(t, cfg, childIDs[0], sourceID, requested[0]),
		persistedForkChild(t, cfg, childIDs[1], sourceID, requested[1]),
	}
	now := time.Now().UTC()
	operation := persistedForkOperation{
		SourceID: sourceID, IdempotencyKey: "fork-restart-starting",
		Fingerprint: managedForkFingerprint(sourceID, sourceLease, requested), ChildIDs: childIDs,
		State: "succeeded", CreatedAt: now.Add(-time.Second), RetainUntil: now.Add(time.Duration(cfg.MaxTTL) * time.Second),
	}
	if err := NewStateStore(cfg.StatePath).Save(machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: cfg.HostID, UpdatedAt: now,
		Machines: machines, Forks: []persistedForkOperation{operation},
	}); err != nil {
		t.Fatal(err)
	}

	var guestReady atomic.Bool
	mgr := NewManager(cfg)
	mgr.reconcileReadyTimeout = 10 * time.Millisecond
	mgr.readyProbe = func(context.Context, string) error {
		if guestReady.Load() {
			return nil
		}
		return errors.New("guest still starting")
	}
	if _, err := mgr.Reconcile(); err != nil {
		t.Fatal(err)
	}
	server := NewServer(cfg, mgr)
	payload, err := json.Marshal(internalForkRequest{Children: []internalForkChildRequest{
		{LeaseID: requested[0].LeaseID, ExpiresAt: requested[0].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[0].Metadata, VCPUs: requested[0].VCPUs, MemoryMB: requested[0].MemoryMB, DiskMB: requested[0].DiskMB},
		{LeaseID: requested[1].LeaseID, ExpiresAt: requested[1].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[1].Metadata, VCPUs: requested[1].VCPUs, MemoryMB: requested[1].MemoryMB, DiskMB: requested[1].DiskMB},
	}})
	if err != nil {
		t.Fatal(err)
	}
	call := func() *httptest.ResponseRecorder {
		request := internalRequest(http.MethodPost, "/internal/v1/machines/"+sourceID+"/fork", cfg.InternalToken, bytes.NewReader(payload))
		request.Header.Set("X-Nehemiah-Lease-ID", sourceLease)
		request.Header.Set("Idempotency-Key", operation.IdempotencyKey)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	pending := call()
	if pending.Code != http.StatusServiceUnavailable || pending.Header().Get("Retry-After") == "" || !bytes.Contains(pending.Body.Bytes(), []byte(`"fork_result_pending"`)) {
		t.Fatalf("pending response=%d headers=%v body=%s", pending.Code, pending.Header(), pending.Body.String())
	}

	guestReady.Store(true)
	for _, id := range childIDs {
		if !mgr.awaitReady(id, time.Second) {
			t.Fatalf("child %s did not become ready", id)
		}
	}
	replay := call()
	if replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || !bytes.Contains(replay.Body.Bytes(), []byte(`"machines"`)) {
		t.Fatalf("ready replay=%d headers=%v body=%s", replay.Code, replay.Header(), replay.Body.String())
	}
	for _, id := range childIDs {
		mgr.Destroy(id)
	}
}

func restartForkFixture(t *testing.T) (Config, string, string, []managedForkChild) {
	t.Helper()
	temp := t.TempDir()
	cfg := internalTestConfig(t)
	cfg.RunDir = filepath.Join(temp, "run")
	cfg.ChrootBase = filepath.Join(temp, "jailer")
	cfg.StatePath = filepath.Join(temp, "state.json")
	cfg.MaxForkOperations = 64
	if err := os.MkdirAll(cfg.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sourceID := "m-01020304"
	sourceLease := "source-restart-lease"
	expiresAt := time.Now().UTC().Add(45 * time.Second).Truncate(time.Millisecond)
	requested := []managedForkChild{
		{LeaseID: "restart-child-lease-1", ExpiresAt: expiresAt, VCPUs: 1, MemoryMB: 256, DiskMB: 5120, Metadata: map[string]string{
			"public_machine_id": "m_restart_child_0001", "parent_machine_id": "m_restart_source", "fork_operation_id": "22222222-2222-4222-8222-222222222222",
		}},
		{LeaseID: "restart-child-lease-2", ExpiresAt: expiresAt, VCPUs: 1, MemoryMB: 256, DiskMB: 5120, Metadata: map[string]string{
			"public_machine_id": "m_restart_child_0002", "parent_machine_id": "m_restart_source", "fork_operation_id": "22222222-2222-4222-8222-222222222222",
		}},
	}
	return cfg, sourceID, sourceLease, requested
}

func persistedForkChild(t *testing.T, cfg Config, id, sourceID string, descriptor managedForkChild) persistedMachine {
	t.Helper()
	process := startStateHelper(t, id)
	socket := filepath.Join(cfg.RunDir, id+".sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
	go func() { _ = server.Serve(listener) }()
	var cleanup sync.Once
	t.Cleanup(func() {
		cleanup.Do(func() {
			_ = server.Close()
			_ = process.Process.Kill()
			_, _ = process.Process.Wait()
		})
	})
	overlay := filepath.Join(cfg.RunDir, id+".ext4")
	if err := os.WriteFile(overlay, []byte("overlay"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	return persistedMachine{
		ID: id, Status: "running", Mode: "snapshot", Template: "python", CreatedAt: now.Add(-time.Minute), StartedAt: now.Add(-time.Minute),
		Ready: true, ReadyAt: now.Add(-time.Minute), ExpiresAt: descriptor.ExpiresAt, VCPUs: descriptor.VCPUs, MemoryMB: descriptor.MemoryMB,
		DiskMB: descriptor.DiskMB, ParentID: sourceID, LeaseID: descriptor.LeaseID, Metadata: cloneMetadata(descriptor.Metadata),
		Runtime: &persistedRuntime{PID: process.Process.Pid, Socket: socket, Overlay: overlay, StartedAt: now.Add(-time.Minute), DiskMB: descriptor.DiskMB},
	}
}

func startStateHelper(t *testing.T, id string) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=TestStateHelperProcess", "--", "--id", id)
	command.Env = append(os.Environ(), "GO_WANT_STATE_HELPER=1")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	// Give /proc/<pid>/cmdline a moment to become observable.
	deadline := time.Now().Add(time.Second)
	for !processMatchesMachine(command.Process.Pid, id) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !processMatchesMachine(command.Process.Pid, id) {
		_ = command.Process.Kill()
		t.Fatalf("helper process did not expose machine id in cmdline")
	}
	return command
}

func TestStateHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_STATE_HELPER") != "1" {
		return
	}
	_ = os.WriteFile("/proc/self/comm", []byte("firecracker\n"), 0o600)
	time.Sleep(time.Minute)
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func managedForkManager(t *testing.T, readyProbe func(context.Context, string) error) (*Manager, *Machine, []managedForkChild, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.JailerEnable = true
	cfg.MaxForks = 8
	cfg.MaxForkOperations = 64
	cfg.StatePath = t.TempDir() + "/state.json"
	mgr := NewManager(cfg)
	mgr.forkReadyTimeout = 30 * time.Millisecond
	mgr.readyProbe = readyProbe
	mgr.capacityProbe = staticHostProbe{hostResources{
		Architecture:       "x86_64",
		KVM:                true,
		Jailer:             true,
		TotalCPU:           64,
		TotalMemoryMB:      64 * 1024,
		AvailableMemoryMB:  64 * 1024,
		TotalDiskBytes:     1 << 40,
		AvailableDiskBytes: 1 << 40,
	}}
	snapshots := &atomic.Int32{}
	boots := &atomic.Int32{}
	mgr.createSnapshot = func(_ *fcDriver, _ string) (string, error) {
		snapshots.Add(1)
		return t.TempDir(), nil
	}
	mgr.boot = func(cfg Config, id string, template Template, _ string, _ bool, network bool, _ int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		return &fcDriver{
			cfg: cfg, id: id, tpl: template, jailed: true, network: network,
			apiClt: harmlessFirecrackerClient(), startedAt: time.Now().UTC(),
		}, "snapshot", 2, nil
	}
	expiresAt := time.Now().UTC().Add(45 * time.Second).Truncate(time.Millisecond)
	source := &Machine{
		ID: "m-01020304", Status: "running", Mode: "coldboot", Template: "python",
		CreatedAt: time.Now().UTC().Add(-time.Minute), StartedAt: time.Now().UTC().Add(-time.Minute),
		Ready: true, ReadyAt: time.Now().UTC().Add(-time.Minute), ExpiresAt: expiresAt,
		VCPUs: 1, MemoryMB: 256, DiskMB: 5120, LeaseID: "source-lease",
		Metadata: map[string]string{"public_machine_id": "m_source_public_12345"},
		driver:   &fcDriver{cfg: cfg, id: "m-01020304", tpl: cfg.Template("python"), apiClt: harmlessFirecrackerClient()},
	}
	mgr.mu.Lock()
	mgr.machines[source.ID] = source
	mgr.mu.Unlock()
	children := []managedForkChild{
		{
			LeaseID: "child-lease-1", ExpiresAt: expiresAt, VCPUs: 1, MemoryMB: 256, DiskMB: 5120,
			Metadata: map[string]string{
				"public_machine_id": "m_child_public_00001", "parent_machine_id": "m_source_public_12345",
				"fork_operation_id": "11111111-1111-4111-8111-111111111111",
			},
		},
		{
			LeaseID: "child-lease-2", ExpiresAt: expiresAt, VCPUs: 1, MemoryMB: 256, DiskMB: 5120,
			Metadata: map[string]string{
				"public_machine_id": "m_child_public_00002", "parent_machine_id": "m_source_public_12345",
				"fork_operation_id": "11111111-1111-4111-8111-111111111111",
			},
		},
	}
	return mgr, source, children, snapshots, boots
}

func TestManagedForkUsesOneSnapshotAndReplaysExactReadyBatch(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	first, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-one", requested)
	if err != nil || replayed {
		t.Fatalf("first fork replayed=%v err=%v", replayed, err)
	}
	if len(first) != 2 || snapshots.Load() != 1 || boots.Load() != 2 || mgr.Count() != 3 {
		t.Fatalf("children=%d snapshots=%d boots=%d count=%d", len(first), snapshots.Load(), boots.Load(), mgr.Count())
	}
	firstIDs := []string{first[0].ID, first[1].ID}
	for index, child := range first {
		if !child.Ready || child.Status != "running" || child.LeaseID != requested[index].LeaseID ||
			!reflect.DeepEqual(child.Metadata, requested[index].Metadata) {
			t.Fatalf("child %d = %+v", index, child)
		}
	}
	mgr.cfg.MaxForks = 1 // a lower runtime limit must not invalidate an exact replay
	replay, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-one", requested)
	if err != nil || !replayed || !reflect.DeepEqual(firstIDs, []string{replay[0].ID, replay[1].ID}) {
		t.Fatalf("replay=%v children=%v err=%v", replayed, replay, err)
	}
	if snapshots.Load() != 1 || boots.Load() != 2 {
		t.Fatalf("replay repeated work: snapshots=%d boots=%d", snapshots.Load(), boots.Load())
	}
	mgr.cfg.MaxForks = 8

	changed := append([]managedForkChild(nil), requested...)
	changed[1].Metadata = cloneMetadata(changed[1].Metadata)
	changed[1].Metadata["public_machine_id"] = "m_child_public_changed"
	if _, _, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-one", changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed replay error = %v", err)
	}
	if _, _, err := mgr.ForkInternal(source.ID, "wrong-source-lease", "fork-two", requested); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("wrong source lease error = %v", err)
	}
}

func TestManagedForkExactReplaySurvivesSourceDeletion(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	first, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-lost-response", requested)
	if err != nil || replayed || len(first) != len(requested) {
		t.Fatalf("first fork replayed=%v children=%d err=%v", replayed, len(first), err)
	}
	firstIDs := []string{first[0].ID, first[1].ID}
	if !mgr.Destroy(source.ID) {
		t.Fatal("source delete failed")
	}

	replay, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-lost-response", requested)
	if err != nil || !replayed || !reflect.DeepEqual(firstIDs, []string{replay[0].ID, replay[1].ID}) {
		t.Fatalf("source-gone replay=%v children=%v err=%v", replayed, replay, err)
	}
	if snapshots.Load() != 1 || boots.Load() != int32(len(requested)) {
		t.Fatalf("source-gone replay repeated work: snapshots=%d boots=%d", snapshots.Load(), boots.Load())
	}
}

func TestManagedForkIncompleteSuccessReplayCleansEverySurvivorDurably(t *testing.T) {
	mgr, source, requested, _, _ := managedForkManager(t, func(context.Context, string) error { return nil })
	children, _, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-malformed-response", requested)
	if err != nil {
		t.Fatal(err)
	}
	missing := children[0]
	mgr.mu.Lock()
	delete(mgr.machines, missing.ID)
	mgr.mu.Unlock()
	mgr.teardown(missing)

	payload, err := json.Marshal(internalForkRequest{Children: []internalForkChildRequest{
		{LeaseID: requested[0].LeaseID, ExpiresAt: requested[0].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[0].Metadata, VCPUs: requested[0].VCPUs, MemoryMB: requested[0].MemoryMB, DiskMB: requested[0].DiskMB},
		{LeaseID: requested[1].LeaseID, ExpiresAt: requested[1].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[1].Metadata, VCPUs: requested[1].VCPUs, MemoryMB: requested[1].MemoryMB, DiskMB: requested[1].DiskMB},
	}})
	if err != nil {
		t.Fatal(err)
	}
	request := internalRequest(http.MethodPost, "/internal/v1/machines/"+source.ID+"/fork", mgr.cfg.InternalToken, bytes.NewReader(payload))
	request.Header.Set("X-Nehemiah-Lease-ID", source.LeaseID)
	request.Header.Set("Idempotency-Key", "fork-malformed-response")
	response := httptest.NewRecorder()
	NewServer(mgr.cfg, mgr).ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || response.Header().Get("Idempotency-Replayed") != "true" || !bytes.Contains(response.Body.Bytes(), []byte(`"fork_batch_cleaned"`)) {
		t.Fatalf("incomplete replay response=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	for _, child := range children {
		if _, ok := mgr.InternalGet(child.ID); ok {
			t.Fatalf("surviving child %s was not removed", child.ID)
		}
	}
	if mgr.Count() != 1 {
		t.Fatalf("machine count=%d, want only source", mgr.Count())
	}

	snapshot, err := NewStateStore(mgr.cfg.StatePath).Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Forks) != 1 || snapshot.Forks[0].State != "failed" || snapshot.Forks[0].FailureCode != "fork_batch_cleaned" {
		t.Fatalf("durable fork cleanup = %+v", snapshot.Forks)
	}
	if _, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-malformed-response", requested); !replayed || !errors.Is(err, ErrForkBatchCleaned) {
		t.Fatalf("cleaned replay replayed=%v err=%v", replayed, err)
	}
}

func TestManagedForkReservationMustPersistBeforeSnapshot(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	realSave := mgr.stateSave
	var failed atomic.Bool
	mgr.stateSave = func(snapshot machineStateSnapshot) error {
		if !failed.Load() && len(snapshot.Forks) == 1 && snapshot.Forks[0].State == "pending" {
			failed.Store(true)
			return errors.New("injected reservation save failure")
		}
		return realSave(snapshot)
	}

	children, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-reserve-save", requested)
	if replayed || !errors.Is(err, ErrForkBatchCleaned) || len(children) != 0 {
		t.Fatalf("reservation save result replayed=%v children=%v err=%v", replayed, children, err)
	}
	if snapshots.Load() != 0 || boots.Load() != 0 || mgr.Count() != 1 {
		t.Fatalf("work escaped failed reservation: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
	}
	durable, loadErr := NewStateStore(mgr.cfg.StatePath).Load()
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(durable.Forks) != 1 || durable.Forks[0].State != "failed" || durable.Forks[0].FailureCode != "fork_batch_cleaned" || len(durable.Machines) != 1 {
		t.Fatalf("reservation cleanup was not durable: forks=%+v machines=%+v", durable.Forks, durable.Machines)
	}
}

func TestManagedForkRejectsNewWorkWhileStatePersistenceIsUnhealthy(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	mgr.mu.Lock()
	mgr.stateHealthy = false
	mgr.mu.Unlock()
	if _, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-unhealthy-state", requested); replayed || !errors.Is(err, ErrHostUnhealthy) {
		t.Fatalf("unhealthy state replayed=%v err=%v", replayed, err)
	}
	if snapshots.Load() != 0 || boots.Load() != 0 || mgr.Count() != 1 {
		t.Fatalf("unhealthy state started work: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
	}
}

func TestManagedForkSuccessRequiresTerminalPersistence(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	realSave := mgr.stateSave
	var failed atomic.Bool
	mgr.stateSave = func(snapshot machineStateSnapshot) error {
		if !failed.Load() && len(snapshot.Forks) == 1 && snapshot.Forks[0].State == "succeeded" {
			failed.Store(true)
			return errors.New("injected terminal save failure")
		}
		return realSave(snapshot)
	}

	children, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-terminal-save", requested)
	if replayed || !errors.Is(err, ErrForkBatchCleaned) || len(children) != 0 {
		t.Fatalf("terminal save result replayed=%v children=%v err=%v", replayed, children, err)
	}
	if snapshots.Load() != 1 || boots.Load() != int32(len(requested)) || mgr.Count() != 1 {
		t.Fatalf("failed terminal cleanup: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
	}
	durable, loadErr := NewStateStore(mgr.cfg.StatePath).Load()
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(durable.Forks) != 1 || durable.Forks[0].State != "failed" || durable.Forks[0].FailureCode != "fork_batch_cleaned" {
		t.Fatalf("terminal failure was not durable: %+v", durable.Forks)
	}
}

func TestManagedForkTerminalPersistenceOutagePreservesBatchAndStopsNewWork(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	realSave := mgr.stateSave
	mgr.stateSave = func(snapshot machineStateSnapshot) error {
		if len(snapshot.Forks) == 1 && snapshot.Forks[0].State != "pending" {
			return errors.New("injected sustained terminal save outage")
		}
		return realSave(snapshot)
	}

	if children, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-terminal-outage", requested); replayed || !errors.Is(err, ErrForkBatchCleaned) || len(children) != 0 {
		t.Fatalf("terminal outage replayed=%v children=%v err=%v", replayed, children, err)
	}
	// The children deliberately remain live: tearing their VMMs down before the
	// final observations and batch decision fsync would erase accountable time.
	if snapshots.Load() != 1 || boots.Load() != int32(len(requested)) || mgr.Count() != 1+len(requested) {
		t.Fatalf("terminal outage did not fail closed: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
	}
	if _, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-terminal-outage", requested); !replayed || !errors.Is(err, ErrForkBatchCleaned) {
		t.Fatalf("terminal outage exact replay replayed=%v err=%v", replayed, err)
	}
	if _, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-after-terminal-outage", requested); replayed || !errors.Is(err, ErrHostUnhealthy) {
		t.Fatalf("new work after state outage replayed=%v err=%v", replayed, err)
	}
}

func TestManagedForkHistoryRetainsFullWindowAndRejectsAtBound(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	mgr.cfg.MaxForkOperations = 1
	now := time.Now().UTC()
	done := make(chan struct{})
	close(done)
	mgr.mu.Lock()
	mgr.forkKeys["m-deadbeef\x00fork-retained"] = &forkReservation{
		sourceID: "m-deadbeef", fingerprint: strings.Repeat("a", 64), childIDs: []string{"m-11111111"},
		state: "failed", err: ErrForkBatchFailed, createdAt: now, retainUntil: now.Add(time.Duration(mgr.cfg.MaxTTL) * time.Second), done: done,
	}
	mgr.pruneForkReservationsLocked(now.Add(time.Duration(mgr.cfg.MaxTTL-1) * time.Second))
	retained := len(mgr.forkKeys)
	mgr.mu.Unlock()
	if retained != 1 {
		t.Fatal("history was pruned before the full maximum lease window")
	}
	if _, _, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-over-limit", requested); !errors.Is(err, ErrTooManyMachines) {
		t.Fatalf("history bound error=%v", err)
	}
	if snapshots.Load() != 0 || boots.Load() != 0 || mgr.Count() != 1 {
		t.Fatalf("history rejection started work: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
	}

	mgr.mu.Lock()
	mgr.pruneForkReservationsLocked(now.Add(time.Duration(mgr.cfg.MaxTTL) * time.Second))
	remaining := len(mgr.forkKeys)
	mgr.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expired history entries=%d, want 0", remaining)
	}
}

func TestManagedForkCleansEveryChildWhenReadinessIsPartial(t *testing.T) {
	var secondID atomic.Value
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(_ context.Context, id string) error {
		if failed, _ := secondID.Load().(string); failed == id {
			return errors.New("not ready")
		}
		return nil
	})
	originalBoot := mgr.boot
	var index atomic.Int32
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		if index.Add(1) == 2 {
			secondID.Store(id)
		}
		return originalBoot(cfg, id, template, snapshot, restoreNet, network, diskMB)
	}

	children, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-partial", requested)
	if !errors.Is(err, ErrForkBatchCleaned) || replayed || len(children) != 0 {
		t.Fatalf("partial result children=%v replayed=%v err=%v", children, replayed, err)
	}
	if mgr.Count() != 1 || snapshots.Load() != 1 || boots.Load() != 2 {
		t.Fatalf("cleanup count=%d snapshots=%d boots=%d", mgr.Count(), snapshots.Load(), boots.Load())
	}
	if _, replayed, err = mgr.ForkInternal(source.ID, source.LeaseID, "fork-partial", requested); !errors.Is(err, ErrForkBatchCleaned) || !replayed {
		t.Fatalf("failed replay replayed=%v err=%v", replayed, err)
	}
	if snapshots.Load() != 1 || boots.Load() != 2 || mgr.Count() != 1 {
		t.Fatalf("failed replay repeated work or leaked children")
	}
}

func TestInternalManagedForkRejectsWholeBatchBeforeSnapshotWhenHostResourcesAreInsufficient(t *testing.T) {
	const gib = uint64(1024 * 1024 * 1024)
	tests := []struct {
		name      string
		resources hostResources
	}{
		{
			name: "vcpus",
			resources: hostResources{
				TotalCPU: 2, TotalMemoryMB: 64 * 1024, AvailableMemoryMB: 64 * 1024,
				TotalDiskBytes: 1 << 40, AvailableDiskBytes: 1 << 40,
			},
		},
		{
			name: "memory",
			resources: hostResources{
				TotalCPU: 64, TotalMemoryMB: 700, AvailableMemoryMB: 700,
				TotalDiskBytes: 1 << 40, AvailableDiskBytes: 1 << 40,
			},
		},
		{
			name: "disk",
			resources: hostResources{
				TotalCPU: 64, TotalMemoryMB: 64 * 1024, AvailableMemoryMB: 64 * 1024,
				TotalDiskBytes: 14 * gib, AvailableDiskBytes: 14 * gib,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
			mgr.capacityProbe = staticHostProbe{resources: test.resources}
			server := NewServer(mgr.cfg, mgr)
			payload, err := json.Marshal(internalForkRequest{Children: []internalForkChildRequest{
				{LeaseID: requested[0].LeaseID, ExpiresAt: requested[0].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[0].Metadata, VCPUs: requested[0].VCPUs, MemoryMB: requested[0].MemoryMB, DiskMB: requested[0].DiskMB},
				{LeaseID: requested[1].LeaseID, ExpiresAt: requested[1].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[1].Metadata, VCPUs: requested[1].VCPUs, MemoryMB: requested[1].MemoryMB, DiskMB: requested[1].DiskMB},
			}})
			if err != nil {
				t.Fatal(err)
			}
			request := internalRequest(http.MethodPost, "/internal/v1/machines/"+source.ID+"/fork", mgr.cfg.InternalToken, bytes.NewReader(payload))
			request.Header.Set("X-Nehemiah-Lease-ID", source.LeaseID)
			request.Header.Set("Idempotency-Key", "fork-capacity-"+test.name)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)

			if response.Code != http.StatusTooManyRequests || !bytes.Contains(response.Body.Bytes(), []byte(`"host_capacity"`)) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if snapshots.Load() != 0 || boots.Load() != 0 || mgr.Count() != 1 {
				t.Fatalf("capacity rejection mutated host: snapshots=%d boots=%d count=%d", snapshots.Load(), boots.Load(), mgr.Count())
			}
		})
	}
}

func TestInternalManagedForkRouteReturnsOnlyFullReadyBatch(t *testing.T) {
	mgr, source, requested, _, _ := managedForkManager(t, func(context.Context, string) error { return nil })
	server := NewServer(mgr.cfg, mgr)
	payload, err := json.Marshal(internalForkRequest{Children: []internalForkChildRequest{
		{LeaseID: requested[0].LeaseID, ExpiresAt: requested[0].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[0].Metadata, VCPUs: requested[0].VCPUs, MemoryMB: requested[0].MemoryMB, DiskMB: requested[0].DiskMB},
		{LeaseID: requested[1].LeaseID, ExpiresAt: requested[1].ExpiresAt.Format(time.RFC3339Nano), Metadata: requested[1].Metadata, VCPUs: requested[1].VCPUs, MemoryMB: requested[1].MemoryMB, DiskMB: requested[1].DiskMB},
	}})
	if err != nil {
		t.Fatal(err)
	}
	call := func() *httptest.ResponseRecorder {
		request := internalRequest(http.MethodPost, "/internal/v1/machines/"+source.ID+"/fork", mgr.cfg.InternalToken, bytes.NewReader(payload))
		request.Header.Set("X-Nehemiah-Lease-ID", source.LeaseID)
		request.Header.Set("Idempotency-Key", "fork-route")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	first := call()
	if first.Code != http.StatusCreated || !bytes.Contains(first.Body.Bytes(), []byte(`"machines"`)) || !bytes.Contains(first.Body.Bytes(), []byte(`"ready":true`)) {
		t.Fatalf("first response = %d %s", first.Code, first.Body.String())
	}
	if !mgr.Destroy(source.ID) {
		t.Fatal("delete source before route replay")
	}
	replay := call()
	if replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay response = %d headers=%v body=%s", replay.Code, replay.Header(), replay.Body.String())
	}
}

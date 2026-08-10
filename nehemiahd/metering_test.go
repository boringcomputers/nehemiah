package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testHostBootID = "77777777-7777-4777-8777-777777777777"

func meteringTestManager(t *testing.T) *Manager {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	mgr := NewManager(cfg)
	mgr.hostBootID = testHostBootID
	mgr.meteringHealthy = true
	return mgr
}

func meteringTestMachine() *Machine {
	return &Machine{
		ID:              "m-1234abcd",
		Status:          "running",
		Template:        "python",
		CreatedAt:       time.Now().UTC().Add(-time.Minute),
		StartedAt:       time.Now().UTC().Add(-time.Minute),
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
		VCPUs:           2,
		MemoryMB:        1024,
		DiskMB:          5120,
		LeaseID:         "11111111-1111-4111-8111-111111111111",
		LeaseGeneration: 1,
		Metadata:        map[string]string{"public_machine_id": "m_metering_contract_01"},
		driver:          &fcDriver{pid: 4242, tap: tapName("m-1234abcd")},
	}
}

func iptablesCounter(bytes uint64) []byte {
	return []byte("Chain test (1 references)\n pkts bytes target prot opt in out source destination\n 1 " + strconv.FormatUint(bytes, 10) + " ACCEPT all -- * * 0.0.0.0/0 0.0.0.0/0\n 9 999 DROP all -- * * 0.0.0.0/0 0.0.0.0/0\n")
}

func TestMeteringStartCheckpointFinalAreDurableCumulativeAndSequenced(t *testing.T) {
	mgr := meteringTestManager(t)
	machine := meteringTestMachine()
	mgr.machines[machine.ID] = machine
	monotonic := uint64(100 * time.Second)
	mgr.monotonicNow = func() (uint64, error) { return monotonic, nil }
	raw := uint64(10)
	mgr.egress.run = func(string, ...string) ([]byte, error) { return iptablesCounter(raw), nil }

	mgr.mu.Lock()
	if err := mgr.recordMeterStartLocked(machine); err != nil {
		t.Fatal(err)
	}
	if err := mgr.persistRequiredLocked(); err != nil {
		t.Fatal(err)
	}
	mgr.mu.Unlock()

	monotonic = uint64(110 * time.Second)
	raw = 110
	if err := mgr.checkpointMetering(); err != nil {
		t.Fatal(err)
	}

	monotonic = uint64(125 * time.Second)
	raw = 150
	mgr.mu.Lock()
	if err := mgr.sampleMachineMeteringLocked(machine, true); err != nil {
		t.Fatal(err)
	}
	if err := mgr.persistRequiredLocked(); err != nil {
		t.Fatal(err)
	}
	mgr.mu.Unlock()

	if got := len(mgr.meteringOutbox); got != 3 {
		t.Fatalf("outbox length = %d, want 3", got)
	}
	for index, want := range []struct {
		kind    string
		seq     string
		runtime string
		egress  string
	}{{"start", "1", "0", "0"}, {"checkpoint", "2", "10000000000", "100"}, {"final", "3", "25000000000", "140"}} {
		got := mgr.meteringOutbox[index]
		if got.Kind != want.kind || got.Sequence != want.seq || got.RuntimeNS != want.runtime || got.EgressBytes != want.egress {
			t.Fatalf("observation %d = %+v, want kind=%s seq=%s runtime=%s egress=%s", index, got, want.kind, want.seq, want.runtime, want.egress)
		}
		if got.Quality != meterQualityExact || got.QualityReason != meterQualityReasonNone {
			t.Fatalf("observation %d quality = %s/%s, want exact/none", index, got.Quality, got.QualityReason)
		}
		if got.HostBootID != testHostBootID || got.LeaseGeneration != "1" || got.VCPUs != 2 || got.MemoryBytes != "1073741824" {
			t.Fatalf("observation identity/resources = %+v", got)
		}
	}
	loaded, err := mgr.stateStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.MeteringOutbox) != 3 || len(loaded.Machines) != 1 || !loaded.Machines[0].Metering.Final {
		t.Fatalf("durable metering snapshot = %+v", loaded)
	}
}

func TestTerminalReadFailureIsDurablyMarkedLastDefensible(t *testing.T) {
	tests := []struct {
		name        string
		monotonic   func() (uint64, error)
		egress      egressCommandRunner
		wantReason  string
		wantRuntime string
	}{
		{
			name:       "monotonic unavailable",
			monotonic:  func() (uint64, error) { return 0, errors.New("clock unavailable") },
			egress:     func(string, ...string) ([]byte, error) { return iptablesCounter(0), nil },
			wantReason: "terminal_monotonic_unavailable", wantRuntime: "0",
		},
		{
			name:       "egress unavailable",
			monotonic:  func() (uint64, error) { return 110, nil },
			egress:     func(string, ...string) ([]byte, error) { return nil, errors.New("iptables unavailable") },
			wantReason: "terminal_egress_unavailable", wantRuntime: "10",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mgr := meteringTestManager(t)
			machine := meteringTestMachine()
			machine.Metering = machineMeteringState{
				HostBootID: testHostBootID, LeaseGeneration: 1, Sequence: 1,
				StartMonotonicNS: 100, LastMonotonicNS: 100, EgressCounterEpoch: 1,
			}
			mgr.monotonicNow = test.monotonic
			mgr.egress.run = test.egress
			if err := mgr.sampleMachineMeteringLocked(machine, true); err != nil {
				t.Fatal(err)
			}
			final := mgr.meteringOutbox[0]
			if final.Quality != meterQualityDefensible || final.QualityReason != test.wantReason || final.RuntimeNS != test.wantRuntime {
				t.Fatalf("degraded final = %+v", final)
			}
		})
	}
}

func TestMeteringCheckpointRollsBackWhenPersistenceFails(t *testing.T) {
	mgr := meteringTestManager(t)
	machine := meteringTestMachine()
	machine.Metering = machineMeteringState{
		HostBootID: testHostBootID, LeaseGeneration: 1, Sequence: 1,
		StartMonotonicNS: 100, LastMonotonicNS: 100, EgressCounterEpoch: 1,
	}
	mgr.machines[machine.ID] = machine
	mgr.meteringOutbox = []hostUsageObservation{{Sequence: "1"}}
	mgr.monotonicNow = func() (uint64, error) { return 200, nil }
	mgr.egress.run = func(string, ...string) ([]byte, error) { return iptablesCounter(0), nil }
	mgr.stateSave = func(machineStateSnapshot) error { return errors.New("disk full") }

	if err := mgr.checkpointMetering(); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("checkpoint error = %v", err)
	}
	if machine.Metering.Sequence != 1 || len(mgr.meteringOutbox) != 1 || mgr.meteringHealthy {
		t.Fatalf("undurable checkpoint escaped rollback: state=%+v backlog=%d healthy=%v", machine.Metering, len(mgr.meteringOutbox), mgr.meteringHealthy)
	}
}

func TestMeteringOutboxReservesTerminalCapacityWithoutEviction(t *testing.T) {
	mgr := meteringTestManager(t)
	mgr.meteringOutbox = make([]hostUsageObservation, maxMeteringOutbox-meteringTerminalHeadroom)
	first := mgr.meteringOutbox[0]
	if mgr.meteringCanStartLocked() {
		t.Fatal("new lease admitted at the terminal reserve boundary")
	}
	if err := mgr.appendMeteringLocked(hostUsageObservation{Sequence: "checkpoint"}, false); err == nil {
		t.Fatal("non-terminal observation consumed terminal reserve")
	}
	if err := mgr.appendMeteringLocked(hostUsageObservation{Sequence: "final"}, true); err != nil {
		t.Fatalf("terminal observation rejected at reserve boundary: %v", err)
	}
	if len(mgr.meteringOutbox) != maxMeteringOutbox-meteringTerminalHeadroom+1 || mgr.meteringOutbox[0] != first {
		t.Fatal("terminal append evicted or overwrote prior evidence")
	}
}

func TestReservedConcurrentStartSurvivesAdmissionBoundary(t *testing.T) {
	mgr := meteringTestManager(t)
	machine := meteringTestMachine()
	machine.meteringReserved = true
	mgr.machines[machine.ID] = machine
	mgr.meteringOutbox = make([]hostUsageObservation, maxMeteringOutbox-meteringTerminalHeadroom)
	mgr.meteringHealthy = false
	mgr.monotonicNow = func() (uint64, error) { return 100, nil }
	mgr.egress.run = func(string, ...string) ([]byte, error) { return iptablesCounter(0), nil }
	if err := mgr.recordMeterStartLocked(machine); err != nil {
		t.Fatalf("already-reserved VMM start lost at admission boundary: %v", err)
	}
	if machine.meteringReserved || machine.Metering.Sequence != 1 || len(mgr.meteringOutbox) != maxMeteringOutbox-meteringTerminalHeadroom+1 {
		t.Fatalf("reserved start state=%+v reserved=%v backlog=%d", machine.Metering, machine.meteringReserved, len(mgr.meteringOutbox))
	}
	if mgr.meteringCanStartLocked() {
		t.Fatal("new work admitted after reserved start consumed terminal headroom")
	}
}

func TestRestartFoldsPreResetAllowedEgressCounterDurably(t *testing.T) {
	mgr := meteringTestManager(t)
	machine := meteringTestMachine()
	machine.NetworkPolicy = networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.8/32"}}
	snapshot := machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: mgr.cfg.HostID, UpdatedAt: time.Now().UTC(),
		Machines: []persistedMachine{{
			ID: machine.ID, VCPUs: machine.VCPUs, MemoryMB: machine.MemoryMB,
			LeaseID: machine.LeaseID, LeaseGeneration: 1, Metadata: machine.Metadata,
			NetworkPolicy: machine.NetworkPolicy,
			Metering: machineMeteringState{
				HostBootID: testHostBootID, LeaseGeneration: 1, Sequence: 2,
				EgressBytes: 20, EgressRawBytes: 10, EgressCounterBase: 20, EgressCounterEpoch: 1,
			},
			Runtime: &persistedRuntime{PID: 4242, Tap: machine.driver.tap},
		}},
	}
	if err := mgr.stateStore.Save(snapshot); err != nil {
		t.Fatal(err)
	}
	mgr.egress.run = func(string, ...string) ([]byte, error) { return iptablesCounter(35), nil }
	if err := mgr.foldPersistedEgressCounter(&snapshot, 0); err != nil {
		t.Fatal(err)
	}
	state := snapshot.Machines[0].Metering
	if state.EgressBytes != 45 || state.EgressCounterBase != 45 || state.EgressRawBytes != 0 || state.EgressCounterEpoch != 1 {
		t.Fatalf("folded counter = %+v", state)
	}
	loaded, err := mgr.stateStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.Machines[0].Metering; got.EgressBytes != 45 || got.EgressRawBytes != 0 || got.EgressCounterEpoch != 1 {
		t.Fatalf("durable folded counter = %+v", got)
	}
}

func TestRecoveredFinalUsesLastDefensibleHighWater(t *testing.T) {
	mgr := meteringTestManager(t)
	observedAt := "2026-08-08T12:00:10Z"
	snapshot := machineStateSnapshot{
		Version: machineStateVersion, Generation: 1, HostID: mgr.cfg.HostID,
		UpdatedAt: time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC),
		Machines: []persistedMachine{{
			ID: "m-1234abcd", VCPUs: 2, MemoryMB: 1024,
			LeaseID: "11111111-1111-4111-8111-111111111111", LeaseGeneration: 1,
			Metadata: map[string]string{"public_machine_id": "m_metering_contract_01"},
			Metering: machineMeteringState{
				HostBootID: testHostBootID, LeaseGeneration: 1, Sequence: 2,
				StartMonotonicNS: 100, LastMonotonicNS: 110, LastRuntimeNS: 10,
				EgressBytes: 55, EgressCounterEpoch: 1, LastObservedAt: observedAt,
			},
		}},
	}
	if err := mgr.finalizePersistedMachine(&snapshot, 0, "runtime_unavailable"); err != nil {
		t.Fatal(err)
	}
	final := snapshot.MeteringOutbox[0]
	if final.Kind != "final" || final.Quality != meterQualityDefensible || final.QualityReason != "runtime_unavailable" || final.Sequence != "3" || final.RuntimeNS != "10" || final.EgressBytes != "55" || final.ObservedAt != observedAt {
		t.Fatalf("recovered final extended beyond accepted evidence: %+v", final)
	}
}

func TestAllowedEgressCounterIncludesOnlyAcceptRules(t *testing.T) {
	run := func(string, ...string) ([]byte, error) {
		return []byte("pkts bytes target prot opt in out source destination\n1 100 ACCEPT all -- * * 0/0 0/0\n2 900 DROP all -- * * 0/0 0/0\n3 25 ACCEPT tcp -- * * 0/0 0/0\n"), nil
	}
	got, err := allowedEgressBytesForTap(tapName("m-1234abcd"), run)
	if err != nil || got != 125 {
		t.Fatalf("allowed bytes = %d, %v; want 125", got, err)
	}
}

func TestMeteringDeliveryUsesHeartbeatCredentialAndDurableAck(t *testing.T) {
	const credential = "host_heartbeat_abcdefghijklmnopqrstuvwxyz0123456789"
	mgr := meteringTestManager(t)
	mgr.meteringOutbox = []hostUsageObservation{{
		MachineID: "m_metering_contract_01", HostMachineID: "m-1234abcd",
		LeaseID: "11111111-1111-4111-8111-111111111111", LeaseGeneration: "1",
		HostBootID: testHostBootID, Sequence: "9", Kind: "checkpoint",
	}}
	mgr.mu.Lock()
	if err := mgr.persistRequiredLocked(); err != nil {
		t.Fatal(err)
	}
	mgr.mu.Unlock()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+credential {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		var payload struct {
			Observations []hostUsageObservation `json:"observations"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil || len(payload.Observations) != 1 {
			t.Errorf("usage payload = %+v, %v", payload, err)
		}
		_ = json.NewEncoder(response).Encode(hostUsageObservationResponse{Receipts: []hostUsageObservationReceipt{{
			LeaseID: "11111111-1111-4111-8111-111111111111", LeaseGeneration: "1",
			HostBootID: testHostBootID, Sequence: "9", Outcome: "accepted", Acknowledged: true,
		}}})
	}))
	defer server.Close()
	client := newControlPlaneClient(Config{ControlPlaneURL: server.URL, ControlPlaneHTTP: true}, mgr)
	if err := client.submitMetering(t.Context(), hostEnrollment{HostID: "host-1", HeartbeatCredential: credential}); err != nil {
		t.Fatal(err)
	}
	if len(mgr.meteringOutbox) != 0 {
		t.Fatalf("acknowledged backlog = %d, want 0", len(mgr.meteringOutbox))
	}
	loaded, err := mgr.stateStore.Load()
	if err != nil || len(loaded.MeteringOutbox) != 0 {
		t.Fatalf("durable acknowledged backlog = %d, %v", len(loaded.MeteringOutbox), err)
	}
}

func TestMeteringAckBindsTheExactBootLeaseAndSequence(t *testing.T) {
	mgr := meteringTestManager(t)
	sent := hostUsageObservation{
		LeaseID: "11111111-1111-4111-8111-111111111111", LeaseGeneration: "2",
		HostBootID: testHostBootID, Sequence: "7",
	}
	mgr.meteringOutbox = []hostUsageObservation{sent}
	receipt := hostUsageObservationReceipt{
		LeaseID: sent.LeaseID, LeaseGeneration: sent.LeaseGeneration,
		HostBootID: "88888888-8888-4888-8888-888888888888",
		Sequence:   sent.Sequence, Outcome: "accepted", Acknowledged: true,
	}
	if err := mgr.acknowledgeMeteringBatch([]hostUsageObservation{sent}, []hostUsageObservationReceipt{receipt}); err == nil {
		t.Fatal("receipt for a different host boot acknowledged durable evidence")
	}
	if len(mgr.meteringOutbox) != 1 {
		t.Fatal("invalid exact-key receipt removed durable evidence")
	}
}

func TestForkCleanupPersistenceFailureLeavesRuntimeAndMeterEvidenceIntact(t *testing.T) {
	mgr := meteringTestManager(t)
	child := meteringTestMachine()
	child.ParentID = "m-aabbccdd"
	child.Metering = machineMeteringState{
		HostBootID: testHostBootID, LeaseGeneration: 1, Sequence: 1,
		StartMonotonicNS: 100, LastMonotonicNS: 100, EgressCounterEpoch: 1,
	}
	mgr.machines[child.ID] = child
	mgr.meteringOutbox = []hostUsageObservation{{Sequence: "1"}}
	mgr.monotonicNow = func() (uint64, error) { return 200, nil }
	mgr.egress.run = func(string, ...string) ([]byte, error) { return iptablesCounter(0), nil }
	mgr.stateSave = func(machineStateSnapshot) error { return errors.New("read only filesystem") }

	mgr.rollbackForkChildren([]*Machine{child})
	if mgr.machines[child.ID] != child || child.Metering.Final || child.Metering.Sequence != 1 || len(mgr.meteringOutbox) != 1 {
		t.Fatalf("fork runtime was cleaned before terminal durability: machine=%p meter=%+v backlog=%d", mgr.machines[child.ID], child.Metering, len(mgr.meteringOutbox))
	}
}

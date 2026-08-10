package main

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	maxMeteringOutbox         = 65536
	meteringTerminalHeadroom  = 4096
	maxMeteringBatch          = 256
	maxManagedMeteredMachines = 256
	meterQualityExact         = "exact"
	meterQualityDefensible    = "last_defensible"
	meterQualityReasonNone    = "none"
)

var bootIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var publicMachineIDPattern = regexp.MustCompile(`^m_[A-Za-z0-9_-]{12,}$`)

type machineMeteringState struct {
	HostBootID         string `json:"host_boot_id"`
	LeaseGeneration    uint64 `json:"lease_generation"`
	Sequence           uint64 `json:"sequence"`
	StartMonotonicNS   uint64 `json:"start_monotonic_ns"`
	LastMonotonicNS    uint64 `json:"last_monotonic_ns"`
	LastRuntimeNS      uint64 `json:"last_runtime_ns"`
	EgressBytes        uint64 `json:"egress_bytes"`
	EgressCounterBase  uint64 `json:"egress_counter_base"`
	EgressRawBytes     uint64 `json:"egress_raw_bytes"`
	EgressCounterEpoch uint64 `json:"egress_counter_epoch"`
	LastObservedAt     string `json:"last_observed_at"`
	Final              bool   `json:"final"`
}

type hostUsageObservation struct {
	MachineID           string `json:"machine_id"`
	HostMachineID       string `json:"host_machine_id"`
	LeaseID             string `json:"lease_id"`
	LeaseGeneration     string `json:"lease_generation"`
	HostBootID          string `json:"host_boot_id"`
	Sequence            string `json:"sequence"`
	Kind                string `json:"kind"`
	Quality             string `json:"quality"`
	QualityReason       string `json:"quality_reason"`
	RuntimeNS           string `json:"runtime_ns"`
	EgressBytes         string `json:"egress_bytes"`
	EgressCounterEpoch  string `json:"egress_counter_epoch"`
	ObservedMonotonicNS string `json:"observed_monotonic_ns"`
	ObservedAt          string `json:"observed_at"`
	VCPUs               int    `json:"vcpus"`
	MemoryBytes         string `json:"memory_bytes"`
	ProcessID           int    `json:"process_id"`
}

type hostUsageObservationReceipt struct {
	LeaseID         string `json:"lease_id"`
	LeaseGeneration string `json:"lease_generation"`
	HostBootID      string `json:"host_boot_id"`
	Sequence        string `json:"sequence"`
	Outcome         string `json:"outcome"`
	Acknowledged    bool   `json:"acknowledged"`
}

type hostUsageObservationResponse struct {
	Receipts []hostUsageObservationReceipt `json:"receipts"`
}

func readHostBootID() (string, error) {
	contents, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", fmt.Errorf("read host boot id: %w", err)
	}
	id := strings.ToLower(strings.TrimSpace(string(contents)))
	if !bootIDPattern.MatchString(id) {
		return "", errors.New("host boot id is not a valid UUID")
	}
	return id, nil
}

func hostMonotonicNS() (uint64, error) {
	var value unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &value); err != nil {
		return 0, fmt.Errorf("read CLOCK_BOOTTIME: %w", err)
	}
	if value.Sec < 0 || value.Nsec < 0 {
		return 0, errors.New("CLOCK_BOOTTIME returned a negative value")
	}
	seconds := uint64(value.Sec)
	if seconds > (^uint64(0)-uint64(value.Nsec))/uint64(time.Second) {
		return 0, errors.New("CLOCK_BOOTTIME overflow")
	}
	return seconds*uint64(time.Second) + uint64(value.Nsec), nil
}

func (mgr *Manager) meteringCanStartLocked() bool {
	return mgr.meteringCanReserveLocked(1)
}

func (mgr *Manager) meteringCanReserveLocked(slots int) bool {
	if slots < 1 || mgr.hostBootID == "" || !mgr.meteringHealthy {
		return false
	}
	reserved := 0
	for _, machine := range mgr.machines {
		if machine.meteringReserved {
			reserved++
		}
	}
	return len(mgr.meteringOutbox)+reserved+slots <= maxMeteringOutbox-meteringTerminalHeadroom
}

func (mgr *Manager) appendMeteringLocked(observation hostUsageObservation, terminal bool) error {
	limit := maxMeteringOutbox - meteringTerminalHeadroom
	if terminal {
		limit = maxMeteringOutbox
	}
	if len(mgr.meteringOutbox) >= limit {
		mgr.meteringHealthy = false
		return errors.New("durable metering outbox is saturated")
	}
	mgr.meteringOutbox = append(mgr.meteringOutbox, observation)
	if len(mgr.meteringOutbox) >= maxMeteringOutbox-meteringTerminalHeadroom {
		// Reaching the admission boundary is itself unhealthy. Existing leases
		// still own the terminal reserve, but no new lease may consume it.
		mgr.meteringHealthy = false
	}
	return nil
}

func (mgr *Manager) recordMeterStartLocked(machine *Machine) error {
	if !mgr.cfg.NehemiahMode || machine.LeaseID == "" {
		return nil
	}
	// Legacy/self-hosted callers predating the cloud wire contract do not carry
	// an authoritative public UUID lease. They remain unmetered compatibility
	// traffic; every control-plane-created lease has both validated identities.
	publicID := machine.Metadata["public_machine_id"]
	if !bootIDPattern.MatchString(strings.ToLower(machine.LeaseID)) ||
		len(publicID) > 128 || !publicMachineIDPattern.MatchString(publicID) {
		return nil
	}
	if machine.driver == nil || machine.driver.PID() <= 1 {
		return errors.New("cannot meter a machine before its VMM exists")
	}
	if !machine.meteringReserved && !mgr.meteringCanStartLocked() {
		return errors.New("metering persistence is unavailable or near saturation")
	}
	if machine.meteringReserved && (mgr.hostBootID == "" || len(mgr.meteringOutbox) >= maxMeteringOutbox) {
		return errors.New("reserved metering start capacity is unavailable")
	}
	now, err := mgr.monotonicNow()
	if err != nil {
		mgr.meteringHealthy = false
		return err
	}
	generation := machine.LeaseGeneration
	if generation == 0 {
		generation = 1
	}
	machine.Metering = machineMeteringState{
		HostBootID:         mgr.hostBootID,
		LeaseGeneration:    generation,
		Sequence:           1,
		StartMonotonicNS:   now,
		LastMonotonicNS:    now,
		EgressCounterEpoch: 1,
		LastObservedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}
	if machine.driver.tap != "" {
		if raw, counterErr := mgr.egress.allowedEgressBytes(machine.ID, machine.driver.tap); counterErr == nil {
			machine.Metering.EgressRawBytes = raw
		}
	}
	reserved := machine.meteringReserved
	if err := mgr.appendMachineObservationLocked(machine, "start", reserved, meterQualityExact, meterQualityReasonNone); err != nil {
		return err
	}
	machine.meteringReserved = false
	if len(mgr.meteringOutbox) >= maxMeteringOutbox-meteringTerminalHeadroom {
		mgr.meteringHealthy = false
	}
	return nil
}

func (mgr *Manager) sampleMachineMeteringLocked(machine *Machine, terminal bool) error {
	state := &machine.Metering
	if state.Sequence == 0 || state.Final {
		return nil
	}
	quality := meterQualityExact
	qualityReason := meterQualityReasonNone
	monotonic, err := mgr.monotonicNow()
	if err != nil {
		if !terminal {
			mgr.meteringHealthy = false
			return err
		}
		monotonic = state.LastMonotonicNS
		quality = meterQualityDefensible
		qualityReason = "terminal_monotonic_unavailable"
	}
	if monotonic < state.StartMonotonicNS {
		if !terminal {
			mgr.meteringHealthy = false
			return errors.New("host monotonic clock regressed")
		}
		monotonic = state.LastMonotonicNS
		quality = meterQualityDefensible
		qualityReason = "terminal_monotonic_regressed"
	}
	state.LastMonotonicNS = monotonic
	state.LastRuntimeNS = monotonic - state.StartMonotonicNS
	if machine.driver != nil && machine.driver.tap != "" {
		raw, counterErr := mgr.egress.allowedEgressBytes(machine.ID, machine.driver.tap)
		if counterErr == nil {
			if raw < state.EgressRawBytes {
				// An unexplained live-chain reset changes the epoch. The cumulative
				// high-water never regresses, while the control plane quarantines the
				// changed counter identity.
				state.EgressCounterEpoch++
				state.EgressCounterBase = state.EgressBytes
			} else {
				state.EgressBytes += raw - state.EgressRawBytes
			}
			state.EgressRawBytes = raw
		} else if !terminal {
			return counterErr
		} else if quality == meterQualityExact {
			quality = meterQualityDefensible
			qualityReason = "terminal_egress_unavailable"
		}
	}
	state.Sequence++
	state.LastObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if terminal {
		state.Final = true
	}
	kind := "checkpoint"
	if terminal {
		kind = "final"
	}
	return mgr.appendMachineObservationLocked(machine, kind, terminal, quality, qualityReason)
}

func (mgr *Manager) appendMachineObservationLocked(machine *Machine, kind string, terminal bool, quality, qualityReason string) error {
	state := machine.Metering
	if state.Sequence == 0 {
		return errors.New("machine metering has not started")
	}
	processID := 2
	if machine.driver != nil && machine.driver.PID() > 1 {
		processID = machine.driver.PID()
	}
	memoryBytes := uint64(machine.MemoryMB) * 1024 * 1024
	observation := hostUsageObservation{
		MachineID:           machine.Metadata["public_machine_id"],
		HostMachineID:       machine.ID,
		LeaseID:             machine.LeaseID,
		LeaseGeneration:     strconv.FormatUint(state.LeaseGeneration, 10),
		HostBootID:          state.HostBootID,
		Sequence:            strconv.FormatUint(state.Sequence, 10),
		Kind:                kind,
		Quality:             quality,
		QualityReason:       qualityReason,
		RuntimeNS:           strconv.FormatUint(state.LastRuntimeNS, 10),
		EgressBytes:         strconv.FormatUint(state.EgressBytes, 10),
		EgressCounterEpoch:  strconv.FormatUint(state.EgressCounterEpoch, 10),
		ObservedMonotonicNS: strconv.FormatUint(state.LastMonotonicNS, 10),
		ObservedAt:          state.LastObservedAt,
		VCPUs:               machine.VCPUs,
		MemoryBytes:         strconv.FormatUint(memoryBytes, 10),
		ProcessID:           processID,
	}
	if observation.MachineID == "" {
		return errors.New("managed machine is missing its public machine id")
	}
	return mgr.appendMeteringLocked(observation, terminal)
}

// checkpointMetering appends at most one durable cumulative checkpoint per
// live lease. It never overwrites/evicts evidence; saturation makes the host
// unhealthy and reserves the final-observation tail for teardown.
func (mgr *Manager) checkpointMetering() error {
	if !mgr.cfg.NehemiahMode {
		return nil
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	eligible := make([]*Machine, 0, len(mgr.machines))
	for _, machine := range mgr.machines {
		if !machine.pooled && machine.Metering.Sequence > 0 && !machine.Metering.Final {
			eligible = append(eligible, machine)
		}
	}
	if len(mgr.meteringOutbox)+len(eligible) > maxMeteringOutbox-meteringTerminalHeadroom {
		mgr.meteringHealthy = false
		return errors.New("durable metering outbox is near saturation")
	}
	if len(eligible) == 0 {
		return nil
	}
	priorOutboxLength := len(mgr.meteringOutbox)
	priorStates := make(map[*Machine]machineMeteringState, len(eligible))
	for _, machine := range eligible {
		priorStates[machine] = machine.Metering
		if err := mgr.sampleMachineMeteringLocked(machine, false); err != nil {
			for changed, state := range priorStates {
				changed.Metering = state
			}
			mgr.meteringOutbox = mgr.meteringOutbox[:priorOutboxLength]
			mgr.meteringHealthy = false
			return err
		}
	}
	if err := mgr.persistRequiredLocked(); err != nil {
		for machine, state := range priorStates {
			machine.Metering = state
		}
		mgr.meteringOutbox = mgr.meteringOutbox[:priorOutboxLength]
		mgr.meteringHealthy = false
		return fmt.Errorf("persist metering checkpoints: %w", err)
	}
	return nil
}

func (mgr *Manager) pendingMeteringBatch() []hostUsageObservation {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	count := len(mgr.meteringOutbox)
	if count > maxMeteringBatch {
		count = maxMeteringBatch
	}
	return append([]hostUsageObservation(nil), mgr.meteringOutbox[:count]...)
}

func (mgr *Manager) acknowledgeMeteringBatch(
	sent []hostUsageObservation,
	receipts []hostUsageObservationReceipt,
) error {
	if len(sent) != len(receipts) {
		return errors.New("control plane returned an incomplete metering acknowledgement")
	}
	for index, receipt := range receipts {
		if !receipt.Acknowledged ||
			receipt.LeaseID != sent[index].LeaseID ||
			receipt.LeaseGeneration != sent[index].LeaseGeneration ||
			receipt.HostBootID != sent[index].HostBootID ||
			receipt.Sequence != sent[index].Sequence {
			return errors.New("control plane returned an invalid metering acknowledgement")
		}
		switch receipt.Outcome {
		case "accepted", "duplicate", "pending_gap", "quarantined", "rejected_payload_conflict":
		default:
			return errors.New("control plane returned an unknown metering outcome")
		}
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.meteringOutbox) < len(sent) {
		return errors.New("durable metering outbox changed before acknowledgement")
	}
	for index := range sent {
		current := mgr.meteringOutbox[index]
		if current.HostBootID != sent[index].HostBootID ||
			current.LeaseID != sent[index].LeaseID ||
			current.LeaseGeneration != sent[index].LeaseGeneration ||
			current.Sequence != sent[index].Sequence {
			return errors.New("durable metering outbox ordering changed before acknowledgement")
		}
	}
	prior := mgr.meteringOutbox
	mgr.meteringOutbox = append([]hostUsageObservation(nil), prior[len(sent):]...)
	if err := mgr.persistRequiredLocked(); err != nil {
		mgr.meteringOutbox = prior
		mgr.meteringHealthy = false
		return fmt.Errorf("persist metering acknowledgement: %w", err)
	}
	if len(mgr.meteringOutbox) < maxMeteringOutbox-meteringTerminalHeadroom {
		mgr.meteringHealthy = true
	}
	return nil
}

func (mgr *Manager) meteringBacklog() int {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return len(mgr.meteringOutbox)
}

func (mgr *Manager) saveRecoverySnapshot(snapshot *machineStateSnapshot) error {
	if mgr.stateStore == nil {
		return errors.New("state persistence is unavailable")
	}
	snapshot.Generation++
	snapshot.UpdatedAt = time.Now().UTC()
	if err := mgr.stateStore.Save(*snapshot); err != nil {
		mgr.stateHealthy = false
		mgr.meteringHealthy = false
		return err
	}
	mgr.stateGeneration = snapshot.Generation
	mgr.stateHealthy = true
	return nil
}

// finalizePersistedMachine records the last defensible persisted high-water.
// It intentionally does not extend runtime to restart/loss detection time.
func (mgr *Manager) finalizePersistedMachine(snapshot *machineStateSnapshot, index int, reason string) error {
	machine := &snapshot.Machines[index]
	state := &machine.Metering
	if state.Sequence == 0 || state.Final {
		return nil
	}
	if len(snapshot.MeteringOutbox) >= maxMeteringOutbox {
		mgr.meteringHealthy = false
		return errors.New("durable metering terminal reserve is saturated")
	}
	state.Sequence++
	state.Final = true
	observedAt := state.LastObservedAt
	if observedAt == "" {
		observedAt = snapshot.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	processID := 2
	if machine.Runtime != nil && machine.Runtime.PID > 1 {
		processID = machine.Runtime.PID
	}
	observation := hostUsageObservation{
		MachineID:           machine.Metadata["public_machine_id"],
		HostMachineID:       machine.ID,
		LeaseID:             machine.LeaseID,
		LeaseGeneration:     strconv.FormatUint(state.LeaseGeneration, 10),
		HostBootID:          state.HostBootID,
		Sequence:            strconv.FormatUint(state.Sequence, 10),
		Kind:                "final",
		Quality:             meterQualityDefensible,
		QualityReason:       reason,
		RuntimeNS:           strconv.FormatUint(state.LastRuntimeNS, 10),
		EgressBytes:         strconv.FormatUint(state.EgressBytes, 10),
		EgressCounterEpoch:  strconv.FormatUint(state.EgressCounterEpoch, 10),
		ObservedMonotonicNS: strconv.FormatUint(state.LastMonotonicNS, 10),
		ObservedAt:          observedAt,
		VCPUs:               machine.VCPUs,
		MemoryBytes:         strconv.FormatUint(uint64(machine.MemoryMB)*1024*1024, 10),
		ProcessID:           processID,
	}
	if observation.MachineID == "" || observation.LeaseID == "" || observation.HostBootID == "" {
		return errors.New("persisted machine metering identity is incomplete")
	}
	snapshot.MeteringOutbox = append(snapshot.MeteringOutbox, observation)
	if err := mgr.saveRecoverySnapshot(snapshot); err != nil {
		snapshot.MeteringOutbox = snapshot.MeteringOutbox[:len(snapshot.MeteringOutbox)-1]
		state.Sequence--
		state.Final = false
		return fmt.Errorf("persist final recovered observation: %w", err)
	}
	mgr.meteringOutbox = append([]hostUsageObservation(nil), snapshot.MeteringOutbox...)
	return nil
}

// foldPersistedEgressCounter reads the pre-restart enforcement chain before it
// is flushed/reinstalled. A normal same-boot daemon restart therefore moves
// the old raw counter into the durable cumulative base without changing epoch.
func (mgr *Manager) foldPersistedEgressCounter(snapshot *machineStateSnapshot, index int) error {
	machine := &snapshot.Machines[index]
	state := &machine.Metering
	if state.Sequence == 0 || state.Final || machine.Runtime == nil || machine.Runtime.Tap == "" {
		return nil
	}
	policy, err := normalizeNetworkPolicy(machine.NetworkPolicy)
	if err != nil || policy.declaration.Mode != egressModeAllowlist {
		return err
	}
	raw, err := allowedEgressBytesForTap(machine.Runtime.Tap, mgr.egress.run)
	if err != nil {
		return err
	}
	if raw < state.EgressRawBytes {
		// This occurred before an intentional policy reset could be committed;
		// expose the unexplained epoch change to control-plane quarantine.
		state.EgressCounterEpoch++
		state.EgressCounterBase = state.EgressBytes
	} else {
		state.EgressBytes += raw - state.EgressRawBytes
	}
	state.EgressCounterBase = state.EgressBytes
	state.EgressRawBytes = 0
	if err := mgr.saveRecoverySnapshot(snapshot); err != nil {
		return fmt.Errorf("persist pre-reset egress high-water: %w", err)
	}
	return nil
}

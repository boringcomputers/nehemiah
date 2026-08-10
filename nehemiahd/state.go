package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	machineStateVersion  = 1
	maxMachineStateBytes = 64 * 1024 * 1024
)

type invalidMachineStateError struct {
	kind  string
	cause error
}

func (err *invalidMachineStateError) Error() string {
	return "invalid persisted machine state: " + err.kind
}

func (err *invalidMachineStateError) Unwrap() error { return err.cause }

func invalidMachineState(kind string, cause error) error {
	return &invalidMachineStateError{kind: kind, cause: cause}
}

func invalidMachineStateKind(err error) (string, bool) {
	var invalid *invalidMachineStateError
	if !errors.As(err, &invalid) {
		return "", false
	}
	return invalid.kind, true
}

type machineTransition struct {
	Sequence   uint64 `json:"sequence"`
	MachineID  string `json:"machine_id"`
	LeaseID    string `json:"lease_id,omitempty"`
	From       string `json:"from,omitempty"`
	To         string `json:"to"`
	Reason     string `json:"reason,omitempty"`
	OccurredAt string `json:"occurred_at"`
}

type persistedRuntime struct {
	PID       int       `json:"pid"`
	ScopeUnit string    `json:"scope_unit,omitempty"`
	Socket    string    `json:"socket"`
	Overlay   string    `json:"overlay"`
	VsockUDS  string    `json:"vsock_uds,omitempty"`
	Tap       string    `json:"tap,omitempty"`
	IP        string    `json:"ip,omitempty"`
	Jailed    bool      `json:"jailed"`
	Chroot    string    `json:"chroot,omitempty"`
	Network   bool      `json:"network"`
	StartedAt time.Time `json:"started_at,omitempty"`
	DiskMB    int       `json:"disk_mb,omitempty"`
}

type persistedMachine struct {
	ID                  string                   `json:"id"`
	Status              string                   `json:"status"`
	Mode                string                   `json:"mode"`
	BootMS              int64                    `json:"boot_ms"`
	Template            string                   `json:"template"`
	Display             bool                     `json:"display"`
	CreatedAt           time.Time                `json:"created_at"`
	StartedAt           time.Time                `json:"started_at,omitempty"`
	Ready               bool                     `json:"ready"`
	ReadyAt             time.Time                `json:"ready_at,omitempty"`
	ExpiresAt           time.Time                `json:"expires_at,omitempty"`
	VCPUs               int                      `json:"vcpus,omitempty"`
	MemoryMB            int                      `json:"memory_mb,omitempty"`
	DiskMB              int                      `json:"disk_mb,omitempty"`
	NetworkPolicy       networkPolicyDeclaration `json:"network_policy,omitempty"`
	Persistent          bool                     `json:"persistent"`
	ParentID            string                   `json:"parent_id,omitempty"`
	LeaseID             string                   `json:"lease_id,omitempty"`
	LeaseGeneration     uint64                   `json:"lease_generation,omitempty"`
	Metering            machineMeteringState     `json:"metering,omitempty"`
	Metadata            map[string]string        `json:"metadata,omitempty"`
	IdempotencyKey      string                   `json:"idempotency_key,omitempty"`
	RequestFingerprint  string                   `json:"request_fingerprint,omitempty"`
	RuntimeRootfsSHA256 string                   `json:"runtime_rootfs_sha256,omitempty"`
	ExtendOperations    map[string]time.Time     `json:"extend_operations,omitempty"`
	ReservedIP          string                   `json:"reserved_ip,omitempty"`
	Pooled              bool                     `json:"pooled,omitempty"`
	Runtime             *persistedRuntime        `json:"runtime,omitempty"`
}

type persistedForkOperation struct {
	SourceID        string    `json:"source_id"`
	IdempotencyKey  string    `json:"idempotency_key"`
	Fingerprint     string    `json:"fingerprint"`
	ChildIDs        []string  `json:"child_ids"`
	State           string    `json:"state"`
	FailureCode     string    `json:"failure_code,omitempty"`
	CreatedAt       time.Time `json:"created_at,omitempty"`
	RetainUntil     time.Time `json:"retain_until,omitempty"`
	RuntimeCohortID string    `json:"runtime_cohort_id,omitempty"`
	RootfsSHA256    string    `json:"rootfs_sha256,omitempty"`
}

type machineStateSnapshot struct {
	Version          int                       `json:"version"`
	Generation       uint64                    `json:"generation"`
	HostID           string                    `json:"host_id,omitempty"`
	RuntimeCohort    managedRuntimeCohort      `json:"runtime_cohort,omitempty"`
	UpdatedAt        time.Time                 `json:"updated_at"`
	Machines         []persistedMachine        `json:"machines"`
	JailerIdentities []persistedJailerIdentity `json:"jailer_identities,omitempty"`
	Forks            []persistedForkOperation  `json:"fork_operations,omitempty"`
	Transitions      []machineTransition       `json:"transitions,omitempty"`
	MeteringOutbox   []hostUsageObservation    `json:"metering_outbox,omitempty"`
}

// StateStore serializes state saves and commits with fsync+rename in the same
// directory. A torn write can therefore leave either the old or the new valid
// JSON document, never a partially-written state.json.
type StateStore struct {
	path      string
	mu        sync.Mutex
	lastSaved uint64
	openFile  func(string) (*os.File, error)
}

func NewStateStore(path string) *StateStore {
	if path == "" {
		return nil
	}
	return &StateStore{path: path, openFile: os.Open}
}

func (s *StateStore) Load() (machineStateSnapshot, error) {
	if s == nil {
		return machineStateSnapshot{Version: machineStateVersion}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pathInfo, err := os.Lstat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return machineStateSnapshot{Version: machineStateVersion}, nil
	}
	if err != nil {
		return machineStateSnapshot{}, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return machineStateSnapshot{}, invalidMachineState("unsafe_file_type", nil)
	}
	if pathInfo.Size() > maxMachineStateBytes {
		return machineStateSnapshot{}, invalidMachineState("oversized", nil)
	}
	openFile := s.openFile
	if openFile == nil {
		openFile = os.Open
	}
	f, err := openFile(s.path)
	if err != nil {
		return machineStateSnapshot{}, err
	}
	defer f.Close()
	openedInfo, err := f.Stat()
	if err != nil {
		return machineStateSnapshot{}, err
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return machineStateSnapshot{}, invalidMachineState("replaced_during_load", nil)
	}
	contents, err := io.ReadAll(io.LimitReader(f, int64(maxMachineStateBytes)+1))
	if err != nil {
		return machineStateSnapshot{}, fmt.Errorf("read state: %w", err)
	}
	if len(contents) > maxMachineStateBytes {
		return machineStateSnapshot{}, invalidMachineState("oversized", nil)
	}
	var snapshot machineStateSnapshot
	dec := json.NewDecoder(bytes.NewReader(contents))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&snapshot); err != nil {
		return machineStateSnapshot{}, invalidMachineState("malformed", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return machineStateSnapshot{}, invalidMachineState("trailing_data", err)
	}
	if snapshot.Version != machineStateVersion {
		return machineStateSnapshot{}, invalidMachineState("unsupported_version", nil)
	}
	s.lastSaved = snapshot.Generation
	return snapshot, nil
}

func (s *StateStore) Save(snapshot machineStateSnapshot) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if snapshot.Generation < s.lastSaved {
		return nil
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir state directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return fmt.Errorf("create state temp file: %w", err)
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	enc := json.NewEncoder(tmp)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(snapshot); err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	info, err := tmp.Stat()
	if err != nil {
		return fmt.Errorf("stat encoded state: %w", err)
	}
	if info.Size() > maxMachineStateBytes {
		return fmt.Errorf("encoded state exceeds safe limit %d", maxMachineStateBytes)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close state: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("replace state: %w", err)
	}
	committed = true
	dirHandle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open state directory for sync: %w", err)
	}
	if err := dirHandle.Sync(); err != nil {
		_ = dirHandle.Close()
		return fmt.Errorf("sync state directory: %w", err)
	}
	if err := dirHandle.Close(); err != nil {
		return fmt.Errorf("close state directory: %w", err)
	}
	s.lastSaved = snapshot.Generation
	return nil
}

func (mgr *Manager) snapshotLocked() machineStateSnapshot {
	mgr.stateGeneration++
	snapshot := machineStateSnapshot{
		Version:       machineStateVersion,
		Generation:    mgr.stateGeneration,
		HostID:        mgr.cfg.HostID,
		RuntimeCohort: mgr.cfg.RuntimeCohort,
		UpdatedAt:     time.Now().UTC(),
		Machines:      make([]persistedMachine, 0, len(mgr.machines)),
		Transitions:   append([]machineTransition(nil), mgr.transitions...),
	}
	for machineID, identity := range mgr.jailerIdentities {
		snapshot.JailerIdentities = append(snapshot.JailerIdentities, persistedJailerIdentity{
			MachineID:     machineID,
			UID:           identity.UID,
			GID:           identity.GID,
			ReservationID: identity.ReservationID,
		})
	}
	for _, machine := range mgr.machines {
		persisted := persistedMachine{
			ID:                  machine.ID,
			Status:              machine.Status,
			Mode:                machine.Mode,
			BootMS:              machine.BootMS,
			Template:            machine.Template,
			Display:             machine.Display,
			CreatedAt:           machine.CreatedAt,
			StartedAt:           machine.StartedAt,
			Ready:               machine.Ready,
			ReadyAt:             machine.ReadyAt,
			ExpiresAt:           machine.ExpiresAt,
			VCPUs:               machine.VCPUs,
			MemoryMB:            machine.MemoryMB,
			DiskMB:              machine.DiskMB,
			NetworkPolicy:       mustNormalizedNetworkDeclaration(machine.NetworkPolicy),
			Persistent:          machine.Persistent,
			ParentID:            machine.ParentID,
			LeaseID:             machine.LeaseID,
			LeaseGeneration:     machine.LeaseGeneration,
			Metering:            machine.Metering,
			Metadata:            cloneMetadata(machine.Metadata),
			IdempotencyKey:      machine.IdempotencyKey,
			RequestFingerprint:  machine.requestFingerprint,
			RuntimeRootfsSHA256: machine.runtimeRootfsSHA256,
			ExtendOperations:    cloneExtendOperations(machine.extendOperations),
			ReservedIP:          machine.reservedIP,
			Pooled:              machine.pooled,
		}
		if driver := machine.driver; driver != nil {
			persisted.Runtime = &persistedRuntime{
				PID:       driver.PID(),
				ScopeUnit: driver.scopeUnit,
				Socket:    driver.sock,
				Overlay:   driver.overlay,
				VsockUDS:  driver.vsockUDS,
				Tap:       driver.tap,
				IP:        driver.ip,
				Jailed:    driver.jailed,
				Chroot:    driver.chroot,
				Network:   driver.network,
				StartedAt: driver.startedAt,
				DiskMB:    driver.diskMB,
			}
		}
		snapshot.Machines = append(snapshot.Machines, persisted)
	}
	snapshot.MeteringOutbox = append([]hostUsageObservation(nil), mgr.meteringOutbox...)
	for key, reservation := range mgr.forkKeys {
		sourceID, idempotencyKey, ok := strings.Cut(key, "\x00")
		if !ok {
			continue
		}
		state := reservation.state
		if state == "" {
			state = "pending"
		}
		failureCode := ""
		if state == "failed" {
			failureCode = forkFailureCode(reservation.err)
		}
		snapshot.Forks = append(snapshot.Forks, persistedForkOperation{
			SourceID:        sourceID,
			IdempotencyKey:  idempotencyKey,
			Fingerprint:     reservation.fingerprint,
			ChildIDs:        append([]string(nil), reservation.childIDs...),
			State:           state,
			FailureCode:     failureCode,
			CreatedAt:       reservation.createdAt,
			RetainUntil:     reservation.retainUntil,
			RuntimeCohortID: reservation.runtimeExpectation.CohortID,
			RootfsSHA256:    reservation.runtimeExpectation.RootfsSHA256,
		})
	}
	sort.Slice(snapshot.Machines, func(i, j int) bool { return snapshot.Machines[i].ID < snapshot.Machines[j].ID })
	sort.Slice(snapshot.JailerIdentities, func(i, j int) bool {
		return snapshot.JailerIdentities[i].MachineID < snapshot.JailerIdentities[j].MachineID
	})
	sort.Slice(snapshot.Forks, func(i, j int) bool {
		if snapshot.Forks[i].SourceID == snapshot.Forks[j].SourceID {
			return snapshot.Forks[i].IdempotencyKey < snapshot.Forks[j].IdempotencyKey
		}
		return snapshot.Forks[i].SourceID < snapshot.Forks[j].SourceID
	})
	return snapshot
}

func (mgr *Manager) persistLocked() {
	if mgr.stateStore == nil {
		return
	}
	if err := mgr.persistRequiredLocked(); err != nil {
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventStatePersistFailed, managedHostLogFields{Err: err})
		} else {
			log.Printf("persist machine state: %v", err)
		}
	}
}

// persistRequiredLocked is the fail-closed state commit used at managed
// operation boundaries. The caller holds mgr.mu. Unlike persistLocked it
// reports failure so no external work or successful response can outrun the
// durable reservation/result record.
func (mgr *Manager) persistRequiredLocked() error {
	if mgr.stateStore == nil || mgr.stateSave == nil {
		mgr.stateHealthy = false
		return errors.New("state persistence is unavailable")
	}
	if err := mgr.stateSave(mgr.snapshotLocked()); err != nil {
		mgr.stateHealthy = false
		return err
	}
	mgr.stateHealthy = true
	return nil
}

func (mgr *Manager) transitionLocked(machine *Machine, from, to, reason string) {
	mgr.nextTransition++
	event := machineTransition{
		Sequence:   mgr.nextTransition,
		MachineID:  machine.ID,
		LeaseID:    machine.LeaseID,
		From:       from,
		To:         to,
		Reason:     reason,
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	mgr.transitions = append(mgr.transitions, event)
	if len(mgr.transitions) > 1024 {
		mgr.transitions = append([]machineTransition(nil), mgr.transitions[len(mgr.transitions)-1024:]...)
	}
}

func (mgr *Manager) EventsAfter(sequence uint64) []machineTransition {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	out := make([]machineTransition, 0)
	for _, event := range mgr.transitions {
		if event.Sequence > sequence {
			out = append(out, event)
		}
	}
	return out
}

type reconcileReport struct {
	Reattached       int  `json:"reattached"`
	Lost             int  `json:"lost"`
	Orphans          int  `json:"orphans_removed"`
	StateQuarantined bool `json:"state_quarantined"`
}

// Reconcile loads the last committed lease inventory, reattaches VMs whose
// process and API socket still prove their identity, marks unsupported entries
// lost, then removes resources not owned by the recovered inventory.
func (mgr *Manager) Reconcile() (reconcileReport, error) {
	var report reconcileReport
	if mgr.stateStore == nil {
		var cleanupErr error
		report.Orphans, cleanupErr = mgr.reapOrphansExcept(nil)
		if cleanupErr != nil {
			mgr.mu.Lock()
			mgr.stateHealthy = false
			mgr.mu.Unlock()
			return report, cleanupErr
		}
		return report, nil
	}
	snapshot, err := mgr.stateStore.Load()
	if err != nil {
		if _, invalid := invalidMachineStateKind(err); invalid {
			return mgr.recoverInvalidMachineState(report, err)
		}
		return mgr.recoverUnreadableMachineState(report, err)
	}
	if snapshot.HostID != "" && mgr.cfg.HostID != "" && snapshot.HostID != mgr.cfg.HostID {
		return mgr.recoverInvalidMachineState(report, invalidMachineState("host_identity", nil))
	}
	if mgr.cfg.NehemiahMode {
		freshEmptyState := snapshot.Generation == 0 && snapshot.HostID == "" && len(snapshot.Machines) == 0 && len(snapshot.JailerIdentities) == 0
		if !freshEmptyState && snapshot.RuntimeCohort != mgr.cfg.RuntimeCohort {
			return mgr.recoverInvalidMachineState(report, invalidMachineState("runtime_cohort", nil))
		}
		identities, identityErr := mgr.validatePersistedJailerIdentities(snapshot)
		if identityErr != nil {
			return mgr.recoverInvalidMachineState(report, invalidMachineState("jailer_identities", identityErr))
		}
		mgr.jailerIdentities = identities
	}
	now := time.Now().UTC()
	persistedMachines := make(map[string]persistedMachine, len(snapshot.Machines))
	for _, machine := range snapshot.Machines {
		if _, duplicate := persistedMachines[machine.ID]; duplicate {
			return mgr.recoverInvalidMachineState(report, invalidMachineState("duplicate_machine", nil))
		}
		persistedMachines[machine.ID] = machine
	}
	forkOperations, err := mgr.retainedForkOperations(snapshot, now)
	if err != nil {
		return mgr.recoverInvalidMachineState(report, invalidMachineState("invalid_fork_history", err))
	}
	mgr.stateGeneration = snapshot.Generation
	mgr.transitions = append([]machineTransition(nil), snapshot.Transitions...)
	if len(snapshot.MeteringOutbox) > maxMeteringOutbox {
		return mgr.recoverInvalidMachineState(report, invalidMachineState("metering_outbox", nil))
	}
	mgr.meteringOutbox = append([]hostUsageObservation(nil), snapshot.MeteringOutbox...)
	if len(mgr.meteringOutbox) >= maxMeteringOutbox-meteringTerminalHeadroom {
		mgr.meteringHealthy = false
	}
	for _, event := range mgr.transitions {
		if event.Sequence > mgr.nextTransition {
			mgr.nextTransition = event.Sequence
		}
	}

	known := make(map[string]struct{})
	for index := range snapshot.Machines {
		persisted := snapshot.Machines[index]
		if persisted.LeaseID != "" && persisted.LeaseGeneration == 0 {
			snapshot.Machines[index].LeaseGeneration = 1
			persisted.LeaseGeneration = 1
		}
		identity := mgr.jailerIdentities[persisted.ID]
		machineCfg := mgr.cfg
		if mgr.cfg.NehemiahMode {
			machineCfg.JailerUID = identity.UID
			machineCfg.JailerGID = identity.GID
		}
		if !validPersistedMachine(machineCfg, persisted, identity) || (!persisted.Persistent && !persisted.ExpiresAt.After(now)) {
			if err := mgr.finalizePersistedMachine(&snapshot, index, "invalid_or_expired_state"); err != nil {
				return report, err
			}
			persisted = snapshot.Machines[index]
			terminatePersisted(machineCfg, persisted)
			mgr.recordLost(persisted, "invalid_or_expired_state")
			report.Lost++
			continue
		}
		driver := reattachDriver(machineCfg, persisted)
		if driver == nil || !driverResponding(driver) {
			if err := mgr.finalizePersistedMachine(&snapshot, index, "runtime_unavailable"); err != nil {
				return report, err
			}
			persisted = snapshot.Machines[index]
			terminatePersisted(machineCfg, persisted)
			mgr.recordLost(persisted, "runtime_unavailable")
			report.Lost++
			continue
		}
		if persisted.Metering.Sequence > 0 && persisted.Metering.HostBootID != mgr.hostBootID {
			if err := mgr.finalizePersistedMachine(&snapshot, index, "host_boot_changed"); err != nil {
				return report, err
			}
			persisted = snapshot.Machines[index]
			terminatePersisted(machineCfg, persisted)
			mgr.recordLost(persisted, "host_boot_changed")
			report.Lost++
			continue
		}
		if driver.network && mgr.cfg.NetEnable {
			var networkErr error
			if driver.tap == "" || driver.tap != tapName(persisted.ID) {
				networkErr = fmt.Errorf("networked runtime has no expected tap")
			} else {
				networkErr = attachTapBridge(driver.tap, mgr.cfg.NetBridge, guestMAC(persisted.ID), mgr.cfg.NehemiahMode)
			}
			if networkErr == nil && mgr.cfg.NehemiahMode {
				networkErr = mgr.foldPersistedEgressCounter(&snapshot, index)
				persisted = snapshot.Machines[index]
			}
			if networkErr == nil && mgr.cfg.NehemiahMode {
				networkErr = mgr.secureManagedGuestNetwork(persisted.ID, driver, persisted.NetworkPolicy)
			}
			if networkErr != nil {
				// Reconciliation is an authority boundary: a live VMM whose L2 and
				// neighbor identity cannot be reasserted must not rejoin the fleet.
				if finalErr := mgr.finalizePersistedMachine(&snapshot, index, "network_isolation_unavailable"); finalErr != nil {
					return report, finalErr
				}
				persisted = snapshot.Machines[index]
				removePinnedGuestNeighbor(mgr.cfg.NetBridge, mgr.cfg.NetSubnet, driver.ip, guestMAC(persisted.ID))
				teardownTap(driver.tap)
				terminatePersisted(machineCfg, persisted)
				mgr.recordLost(persisted, "network_isolation_unavailable")
				report.Lost++
				continue
			}
		}
		machine := &Machine{
			ID:                  persisted.ID,
			Status:              "starting",
			Mode:                persisted.Mode,
			BootMS:              persisted.BootMS,
			Template:            persisted.Template,
			Display:             persisted.Display,
			CreatedAt:           persisted.CreatedAt,
			StartedAt:           persisted.StartedAt,
			ReadyAt:             persisted.ReadyAt,
			ExpiresAt:           persisted.ExpiresAt,
			VCPUs:               persisted.VCPUs,
			MemoryMB:            persisted.MemoryMB,
			DiskMB:              persisted.DiskMB,
			NetworkPolicy:       mustNormalizedNetworkDeclaration(persisted.NetworkPolicy),
			Persistent:          persisted.Persistent,
			ParentID:            persisted.ParentID,
			LeaseID:             persisted.LeaseID,
			LeaseGeneration:     persisted.LeaseGeneration,
			Metering:            persisted.Metering,
			Metadata:            cloneMetadata(persisted.Metadata),
			IdempotencyKey:      persisted.IdempotencyKey,
			requestFingerprint:  persisted.RequestFingerprint,
			runtimeRootfsSHA256: persisted.RuntimeRootfsSHA256,
			extendOperations:    cloneExtendOperations(persisted.ExtendOperations),
			reservedIP:          persisted.ReservedIP,
			pooled:              persisted.Pooled,
			driver:              driver,
			jailerIdentity:      identity,
		}
		if machine.StartedAt.IsZero() {
			machine.StartedAt = driver.startedAt
		}
		if machine.StartedAt.IsZero() {
			machine.StartedAt = machine.CreatedAt
		}
		if !machine.Persistent {
			id := machine.ID
			machine.timer = time.AfterFunc(time.Until(machine.ExpiresAt), func() { mgr.reap(id) })
		}
		mgr.mu.Lock()
		mgr.machines[machine.ID] = machine
		if machine.pooled {
			mgr.pool = append(mgr.pool, machine)
		}
		mgr.transitionLocked(machine, persisted.Status, "starting", "daemon_reattached")
		if machine.Metering.Sequence == 0 && machine.LeaseID != "" {
			if err := mgr.recordMeterStartLocked(machine); err != nil {
				delete(mgr.machines, machine.ID)
				mgr.mu.Unlock()
				terminatePersisted(machineCfg, persisted)
				return report, fmt.Errorf("start metering for upgraded recovered machine: %w", err)
			}
		}
		if machine.IdempotencyKey != "" {
			reservation := &createReservation{fingerprint: fingerprintPersisted(persisted), machineID: machine.ID, done: make(chan struct{})}
			close(reservation.done)
			mgr.createKeys[machine.IdempotencyKey] = reservation
		}
		mgr.mu.Unlock()
		known[machine.ID] = struct{}{}
		report.Reattached++
		if !mgr.awaitReady(machine.ID, mgr.reconcileReadyTimeout) {
			go mgr.watchReady(machine.ID)
		}
	}
	var interruptedForkChildren []*Machine
	mgr.mu.Lock()
	for _, operation := range forkOperations {
		reservation := &forkReservation{
			sourceID:    operation.SourceID,
			fingerprint: operation.Fingerprint,
			childIDs:    append([]string(nil), operation.ChildIDs...),
			state:       operation.State,
			createdAt:   operation.CreatedAt,
			retainUntil: operation.RetainUntil,
			runtimeExpectation: managedRuntimeExpectation{
				CohortID:     operation.RuntimeCohortID,
				RootfsSHA256: operation.RootfsSHA256,
			},
			done: make(chan struct{}),
		}
		switch operation.State {
		case "succeeded":
			invalid := false
			recovered := make([]*Machine, 0, len(operation.ChildIDs))
			for _, id := range operation.ChildIDs {
				child := mgr.machines[id]
				persistedChild, wasPersisted := persistedMachines[id]
				if child == nil || !wasPersisted || !validSucceededForkChild(operation.SourceID, child, persistedChild) {
					invalid = true
					break
				}
				recovered = append(recovered, child)
				if child.Status != "running" && child.Status != "starting" && child.Status != "booting" && child.Status != "warming" {
					invalid = true
					break
				}
			}
			if !invalid && !validManagedForkBatch(operation.SourceID, recovered) {
				invalid = true
			}
			if invalid {
				reservation.state = "failed"
				reservation.err = ErrForkBatchCleaned
				for _, child := range mgr.removeForkChildrenLocked(operation.ChildIDs, "managed_fork_incomplete_restart_cleanup") {
					delete(known, child.ID)
					interruptedForkChildren = append(interruptedForkChildren, child)
					report.Lost++
				}
			}
		case "failed":
			reservation.err = forkFailureFromCode(operation.FailureCode)
			for _, child := range mgr.removeForkChildrenLocked(operation.ChildIDs, "managed_fork_failed_restart_cleanup") {
				delete(known, child.ID)
				interruptedForkChildren = append(interruptedForkChildren, child)
				report.Lost++
			}
		case "pending":
			// A daemon restart can interrupt the strict batch between child boots.
			// Never surface or retain that partial set: clean it and durably replay
			// one terminal batch failure.
			reservation.state = "failed"
			reservation.err = ErrForkBatchCleaned
			for _, child := range mgr.removeForkChildrenLocked(operation.ChildIDs, "managed_fork_restart_cleanup") {
				delete(known, child.ID)
				interruptedForkChildren = append(interruptedForkChildren, child)
				report.Lost++
			}
		default:
			continue
		}
		close(reservation.done)
		mgr.forkKeys[operation.SourceID+"\x00"+operation.IdempotencyKey] = reservation
	}
	mgr.mu.Unlock()
	mgr.mu.Lock()
	persistErr := mgr.persistRequiredLocked()
	mgr.mu.Unlock()
	if persistErr != nil {
		return report, fmt.Errorf("persist reconciled machine state: %w", persistErr)
	}
	for _, child := range interruptedForkChildren {
		mgr.teardown(child)
	}
	report.Orphans, err = mgr.reapOrphansExcept(known)
	if err != nil {
		mgr.mu.Lock()
		mgr.stateHealthy = false
		mgr.mu.Unlock()
		return report, fmt.Errorf("clean reconciled orphan runtime: %w", err)
	}
	if mgr.cfg.NehemiahMode {
		mgr.mu.Lock()
		held := make([]string, 0, len(mgr.jailerIdentities))
		heldIdentities := make(map[string]jailerIdentity, len(mgr.jailerIdentities))
		for machineID := range mgr.jailerIdentities {
			if _, live := mgr.machines[machineID]; !live {
				held = append(held, machineID)
				heldIdentities[machineID] = mgr.jailerIdentities[machineID]
			}
		}
		mgr.mu.Unlock()
		sort.Strings(held)
		for _, machineID := range held {
			if err := mgr.releaseJailerIdentityAfterTeardown(machineID, heldIdentities[machineID]); err != nil {
				return report, fmt.Errorf("release recovered jailer identity %s: %w", machineID, err)
			}
		}
	}
	return report, nil
}

func validSucceededForkChild(sourceID string, child *Machine, persisted persistedMachine) bool {
	if child.pooled || child.ParentID != sourceID || child.LeaseID == "" || child.driver == nil || persisted.ParentID != sourceID {
		return false
	}
	if persisted.Status != "running" || !persisted.Ready || persisted.LeaseID != child.LeaseID {
		return false
	}
	if child.Metadata["public_machine_id"] == "" || child.Metadata["parent_machine_id"] == "" || child.Metadata["fork_operation_id"] == "" {
		return false
	}
	return true
}

func (mgr *Manager) retainedForkOperations(snapshot machineStateSnapshot, now time.Time) ([]persistedForkOperation, error) {
	machineExpiry := make(map[string]time.Time, len(snapshot.Machines))
	for _, machine := range snapshot.Machines {
		machineExpiry[machine.ID] = machine.ExpiresAt
	}
	operations := make([]persistedForkOperation, 0, min(len(snapshot.Forks), maxDurableForkOperations))
	for _, operation := range snapshot.Forks {
		if !validMachineID(operation.SourceID) ||
			!operationKeyPattern.MatchString(operation.IdempotencyKey) ||
			!regexpHex64(operation.Fingerprint) || !validPersistedForkChildren(operation.ChildIDs) {
			return nil, fmt.Errorf("invalid durable fork operation %q", operation.IdempotencyKey)
		}
		if operation.State != "pending" && operation.State != "succeeded" && operation.State != "failed" {
			return nil, fmt.Errorf("invalid durable fork state %q", operation.State)
		}
		if operation.CreatedAt.IsZero() {
			operation.CreatedAt = snapshot.UpdatedAt.UTC()
			if operation.CreatedAt.IsZero() {
				operation.CreatedAt = now
			}
		}
		minimumRetention := mgr.forkRetentionUntil(operation.CreatedAt, nil)
		for _, id := range operation.ChildIDs {
			if expiresAt := machineExpiry[id]; expiresAt.After(minimumRetention) {
				minimumRetention = expiresAt.UTC()
			}
		}
		if operation.RetainUntil.Before(minimumRetention) {
			operation.RetainUntil = minimumRetention
		}
		if operation.State != "pending" && !operation.RetainUntil.After(now) {
			continue
		}
		operations = append(operations, operation)
		if len(operations) > maxDurableForkOperations {
			return nil, fmt.Errorf("fork idempotency history exceeds safe limit %d", maxDurableForkOperations)
		}
	}
	return operations, nil
}

func cloneExtendOperations(source map[string]time.Time) map[string]time.Time {
	if len(source) == 0 {
		return nil
	}
	cloned := make(map[string]time.Time, len(source))
	for key, target := range source {
		cloned[key] = target
	}
	return cloned
}

func regexpHex64(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validPersistedForkChildren(ids []string) bool {
	if len(ids) < 1 || len(ids) > 8 {
		return false
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !validMachineID(id) {
			return false
		}
		if _, duplicate := seen[id]; duplicate {
			return false
		}
		seen[id] = struct{}{}
	}
	return true
}

func (mgr *Manager) validatePersistedJailerIdentities(snapshot machineStateSnapshot) (map[string]jailerIdentity, error) {
	identities := make(map[string]jailerIdentity, len(snapshot.JailerIdentities))
	usedUIDs := make(map[int]string, len(snapshot.JailerIdentities))
	usedGIDs := make(map[int]string, len(snapshot.JailerIdentities))
	available := mgr.identityAvailable
	if available == nil {
		available = managedJailerIdentityAvailable
	}
	for _, persisted := range snapshot.JailerIdentities {
		identity := jailerIdentity{UID: persisted.UID, GID: persisted.GID, ReservationID: persisted.ReservationID}
		if !validMachineID(persisted.MachineID) || !validateManagedJailerIdentity(mgr.cfg, identity) {
			return nil, errors.New("jailer identity entry is outside its configured pool")
		}
		if _, duplicate := identities[persisted.MachineID]; duplicate {
			return nil, errors.New("duplicate jailer identity machine id")
		}
		if owner, duplicate := usedUIDs[identity.UID]; duplicate {
			return nil, fmt.Errorf("jailer uid is shared by %s and %s", owner, persisted.MachineID)
		}
		if owner, duplicate := usedGIDs[identity.GID]; duplicate {
			return nil, fmt.Errorf("jailer gid is shared by %s and %s", owner, persisted.MachineID)
		}
		if err := available(identity.UID, identity.GID); err != nil {
			return nil, fmt.Errorf("restored jailer identity collides with host NSS: %w", err)
		}
		identities[persisted.MachineID] = identity
		usedUIDs[identity.UID] = persisted.MachineID
		usedGIDs[identity.GID] = persisted.MachineID
	}
	for _, machine := range snapshot.Machines {
		if _, exists := identities[machine.ID]; !exists {
			return nil, fmt.Errorf("managed machine %s has no durable jailer identity", machine.ID)
		}
	}
	return identities, nil
}

func (mgr *Manager) recordLost(persisted persistedMachine, reason string) {
	machine := &Machine{ID: persisted.ID, LeaseID: persisted.LeaseID}
	mgr.mu.Lock()
	mgr.transitionLocked(machine, persisted.Status, "lost", reason)
	mgr.mu.Unlock()
}

func validPersistedMachine(cfg Config, machine persistedMachine, identity jailerIdentity) bool {
	if !validMachineID(machine.ID) || machine.Runtime == nil || machine.Runtime.PID <= 1 {
		return false
	}
	runtime := machine.Runtime
	policy, err := normalizeNetworkPolicy(machine.NetworkPolicy)
	if err != nil ||
		(cfg.NehemiahMode && policy.declaration.Mode != egressModeOff) ||
		(policy.declaration.Mode == egressModeAllowlist && (!cfg.NehemiahMode || !cfg.NetEnable || !runtime.Network)) {
		return false
	}
	if !processMatchesMachine(runtime.PID, machine.ID) {
		return false
	}
	if cfg.NehemiahMode {
		expectedRootfs, rootfsErr := selectedManagedRootfsSHA256(cfg, machine.Template)
		if rootfsErr != nil || !constantTimeHexEqual(machine.RuntimeRootfsSHA256, expectedRootfs) {
			return false
		}
		unit, err := scopeUnitForMachine(machine.ID)
		if err != nil || runtime.ScopeUnit != unit || !processInManagedScope(runtime.PID, unit) {
			return false
		}
		if err := validateRestoredJailerOwnership(cfg, machine, identity); err != nil {
			return false
		}
	}
	if runtime.Jailed {
		return pathWithin(runtime.Socket, cfg.ChrootBase) && pathWithin(runtime.Overlay, cfg.ChrootBase) && pathWithin(runtime.Chroot, cfg.ChrootBase)
	}
	return pathWithin(runtime.Socket, cfg.RunDir) && pathWithin(runtime.Overlay, cfg.RunDir)
}

func mustNormalizedNetworkDeclaration(declaration networkPolicyDeclaration) networkPolicyDeclaration {
	policy, err := normalizeNetworkPolicy(declaration)
	if err != nil {
		return networkPolicyDeclaration{Mode: egressModeOff}
	}
	return policy.declaration
}

func reattachDriver(cfg Config, machine persistedMachine) *fcDriver {
	runtime := machine.Runtime
	if runtime == nil {
		return nil
	}
	tpl := cfg.Template(machine.Template)
	driver := &fcDriver{
		cfg:       cfg,
		id:        machine.ID,
		tpl:       tpl,
		pid:       runtime.PID,
		scopeUnit: runtime.ScopeUnit,
		sock:      runtime.Socket,
		overlay:   runtime.Overlay,
		vsockUDS:  runtime.VsockUDS,
		tap:       runtime.Tap,
		ip:        runtime.IP,
		jailed:    runtime.Jailed,
		chroot:    runtime.Chroot,
		network:   runtime.Network,
		startedAt: runtime.StartedAt,
		diskMB:    runtime.DiskMB,
	}
	if runtime.Jailed {
		driver.apiKernel, driver.apiRootfs, driver.apiVsock = "/vmlinux", "/rootfs.ext4", "/run/vsock"
	} else {
		driver.apiKernel, driver.apiRootfs, driver.apiVsock = cfg.KernelPath, runtime.Overlay, runtime.VsockUDS
	}
	driver.apiClt = newUnixClient(runtime.Socket)
	return driver
}

func driverResponding(driver *fcDriver) bool {
	if driver == nil || !fileExists(driver.sock) {
		return false
	}
	client := &http.Client{Timeout: 750 * time.Millisecond, Transport: driver.apiClt.Transport}
	req, err := http.NewRequest(http.MethodGet, "http://localhost/", nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode < 500
}

func terminatePersisted(cfg Config, machine persistedMachine) {
	if validMachineID(machine.ID) && machine.Runtime != nil {
		removePinnedGuestNeighbor(cfg.NetBridge, cfg.NetSubnet, machine.Runtime.IP, guestMAC(machine.ID))
		if machine.Runtime.Tap == tapName(machine.ID) {
			teardownTap(machine.Runtime.Tap)
		}
	}
	if machine.Runtime != nil {
		if expected, err := scopeUnitForMachine(machine.ID); cfg.NehemiahMode && err == nil && machine.Runtime.ScopeUnit == expected {
			stopManagedScope(cfg, expected)
			killManagedScopePID(machine.Runtime.PID, machine.ID, expected)
		} else if processMatchesMachine(machine.Runtime.PID, machine.ID) {
			_ = syscall.Kill(machine.Runtime.PID, syscall.SIGKILL)
		}
	}
	cleanupMachineArtifacts(cfg, machine.ID)
}

func pathWithin(path, root string) bool {
	if path == "" || root == "" || !filepath.IsAbs(path) || !filepath.IsAbs(root) {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func cloneMetadata(metadata map[string]string) map[string]string {
	if len(metadata) == 0 {
		return nil
	}
	clone := make(map[string]string, len(metadata))
	for key, value := range metadata {
		clone[key] = value
	}
	return clone
}

func fingerprintPersisted(machine persistedMachine) string {
	return machine.RequestFingerprint
}

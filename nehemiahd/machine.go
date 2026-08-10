package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Sentinel errors used by the Manager and surfaced as HTTP statuses.
var (
	ErrNotFound            = errors.New("machine not found")
	ErrTooManyMachines     = errors.New("machine capacity reached")
	ErrSnapshotUnavailable = errors.New("snapshot unavailable")
	ErrRateLimited         = errors.New("rate limit exceeded for your address")
	ErrHostDraining        = errors.New("host is draining")
	ErrHostUnhealthy       = errors.New("host isolation is unhealthy")
	ErrIdempotencyConflict = errors.New("idempotency key was already used for a different request")
	ErrInvalidLease        = errors.New("invalid control-plane lease metadata")
	ErrInvalidResources    = errors.New("invalid machine resources")
	ErrNotSupported        = errors.New("requested machine source is not supported")
	ErrForkSourceNotReady  = errors.New("fork source is not ready")
	ErrForkBatchFailed     = errors.New("fork batch failed")
	ErrForkBatchCleaned    = errors.New("incomplete fork batch was cleaned")
	ErrForkResultPending   = errors.New("fork result is not yet recoverable")
)

var machineIDPattern = regexp.MustCompile(`^m-[0-9a-f]{8}$`)
var operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

const maxDurableForkOperations = 4096

// Machine is a single running microVM plus the bookkeeping nehemiahd needs to
// manage its lifecycle. The exported time/id fields are stable; runtime handles
// (console, driver) are internal.
type Machine struct {
	ID        string
	Status    string
	Mode      string
	BootMS    int64
	Template  string
	Display   bool
	CreatedAt time.Time
	StartedAt time.Time
	Ready     bool
	ReadyAt   time.Time
	ExpiresAt time.Time
	VCPUs     int
	MemoryMB  int
	DiskMB    int
	// NetworkPolicy is the canonical durable managed-egress declaration. A NIC
	// with the zero/off policy remains forwarding-denied.
	NetworkPolicy networkPolicyDeclaration

	// Persistent machines have no TTL: no reap timer is armed, so they run until
	// explicitly deleted (or nehemiahd restarts). Gated by cfg.AllowPersistent.
	Persistent bool

	// ParentID is set on forks: the machine this one was branched from.
	ParentID string

	// LeaseID and Metadata are opaque control-plane ownership identifiers. They
	// are exposed only by the internal API and persisted without customer
	// credentials. IdempotencyKey binds a create request to this machine.
	LeaseID             string
	LeaseGeneration     uint64
	Metadata            map[string]string
	IdempotencyKey      string
	requestFingerprint  string
	runtimeRootfsSHA256 string
	extendOperations    map[string]time.Time
	// reservedIP is allocated under Manager.mu before a restored NIC boots. It
	// prevents concurrent fork batches from selecting the same static address.
	reservedIP string

	// creatorIP holds the limiter slot to release when the machine dies.
	creatorIP string

	// pooled: pre-booted, waiting in the warm pool (not yet handed to a user).
	pooled bool

	// driver owns the firecracker child process, stdio console and API socket.
	driver *fcDriver
	// networkProvisioning marks the bounded interval between a managed tap being
	// created and its exact per-machine policy becoming active. Runtime checks
	// recognize only this machine-derived tap name during that transition; once
	// published, the tap must match the durable machine inventory exactly.
	networkProvisioning bool

	// timer fires at ExpiresAt to reap the machine.
	timer *time.Timer

	// consoleMu serialises exclusive console users (exec, the terminal agent):
	// the serial line is shared state, and two concurrent writers garble both.
	consoleMu sync.Mutex

	// snapshotMu prevents a source runtime from being snapshotted concurrently
	// or torn down while Firecracker is paused.
	snapshotMu sync.Mutex

	// Metering is durable host evidence for this exact lease generation. It is
	// persisted with the machine and never derived from control-plane wall time.
	Metering         machineMeteringState
	meteringReserved bool

	// jailerIdentity is reserved durably before any managed VMM process is
	// launched. The reservation survives registry removal until teardown proves
	// that no process or artifact can still use these credentials.
	jailerIdentity jailerIdentity
}

// machineView is the JSON-serialisable public shape from the contract.
type machineView struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Mode       string `json:"mode"`
	BootMS     int64  `json:"boot_ms"`
	Template   string `json:"template"`
	Display    bool   `json:"display"`
	CreatedAt  string `json:"created_at"`
	StartedAt  string `json:"started_at,omitempty"`
	Ready      bool   `json:"ready"`
	ReadyAt    string `json:"ready_at,omitempty"`
	ExpiresAt  string `json:"expires_at"` // "" when the machine is persistent
	Persistent bool   `json:"persistent,omitempty"`
	Parent     string `json:"parent,omitempty"` // set on forks: the source machine
}

// View returns the JSON view of the machine.
func (m *Machine) View() machineView {
	expires := ""
	started := ""
	readyAt := ""
	if !m.Persistent {
		// Managed extend operations use this value as their durable absolute
		// result, so preserve sub-second precision from the requested target.
		expires = m.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	if !m.StartedAt.IsZero() {
		started = m.StartedAt.UTC().Format(time.RFC3339Nano)
	}
	if !m.ReadyAt.IsZero() {
		readyAt = m.ReadyAt.UTC().Format(time.RFC3339Nano)
	}
	return machineView{
		ID:         m.ID,
		Status:     m.Status,
		Mode:       m.Mode,
		BootMS:     m.BootMS,
		Template:   m.Template,
		Display:    m.Display,
		CreatedAt:  m.CreatedAt.UTC().Format(time.RFC3339),
		StartedAt:  started,
		Ready:      m.Ready,
		ReadyAt:    readyAt,
		ExpiresAt:  expires,
		Persistent: m.Persistent,
		Parent:     m.ParentID,
	}
}

// Manager is the thread-safe machine registry and lifecycle owner.
type Manager struct {
	cfg        Config
	limiter    *Limiter
	cgroups    *Cgroups
	egress     *egressController
	mu         sync.Mutex
	templateMu sync.Mutex
	machines   map[string]*Machine
	stopCh     chan struct{}
	stopOnce   sync.Once

	stateStore              *StateStore
	stateSave               func(machineStateSnapshot) error
	stateGeneration         uint64
	stateHealthy            bool
	networkHealthy          bool
	runtimeCohortHealthy    bool
	identityHealthy         bool
	stateRecovery           managedStateRecoveryOps
	orphanCleanup           managedOrphanCleanupOps
	networkRuntime          managedNetworkRuntimeOps
	runtimeAssetGuard       managedRuntimeAssetGuard
	runtimeCohortCheck      func(Config) error
	verifyIdentityTeardown  func(Config, string, jailerIdentity) error
	identityAvailable       func(int, int) error
	identityProcesses       managedJailerProcessOps
	jailerIdentities        map[string]jailerIdentity
	transitions             []machineTransition
	nextTransition          uint64
	createKeys              map[string]*createReservation
	forkKeys                map[string]*forkReservation
	boot                    func(Config, string, Template, string, bool, bool, int) (*fcDriver, string, int64, error)
	createSnapshot          func(*fcDriver, string) (string, error)
	readyProbe              func(context.Context, string) error
	forkReadyTimeout        time.Duration
	reconcileReadyTimeout   time.Duration
	managedReaddressTimeout time.Duration
	capacityProbe           hostProbe
	attachRestoredTap       func(string, string, string, bool) error
	pinRestoredNeighbor     func(string, string, string, string, string) error
	hostBootID              string
	monotonicNow            func() (uint64, error)
	meteringOutbox          []hostUsageObservation
	meteringHealthy         bool

	// Warm pool of pre-booted desktops + count currently warming (both under mu).
	pool    []*Machine
	warming int
}

type createReservation struct {
	fingerprint string
	machineID   string
	err         error
	done        chan struct{}
}

type managedForkChild struct {
	LeaseID         string
	LeaseGeneration uint64
	ExpiresAt       time.Time
	Metadata        map[string]string
	VCPUs           int
	MemoryMB        int
	DiskMB          int
}

type forkReservation struct {
	sourceID           string
	fingerprint        string
	childIDs           []string
	err                error
	state              string
	createdAt          time.Time
	retainUntil        time.Time
	done               chan struct{}
	cleanupDone        chan struct{}
	runtimeExpectation managedRuntimeExpectation
}

func forkFailureCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrSnapshotUnavailable):
		return "snapshot_unavailable"
	case errors.Is(err, ErrForkSourceNotReady):
		return "source_not_ready"
	case errors.Is(err, ErrHostDraining):
		return "host_draining"
	case errors.Is(err, ErrHostUnhealthy):
		return "host_unhealthy"
	case errors.Is(err, ErrTooManyMachines):
		return "host_capacity"
	case errors.Is(err, ErrForkBatchCleaned):
		return "fork_batch_cleaned"
	default:
		return "fork_batch_failed"
	}
}

func forkFailureFromCode(code string) error {
	switch code {
	case "snapshot_unavailable":
		return ErrSnapshotUnavailable
	case "source_not_ready":
		return ErrForkSourceNotReady
	case "host_draining":
		return ErrHostDraining
	case "host_unhealthy":
		return ErrHostUnhealthy
	case "host_capacity":
		return ErrTooManyMachines
	case "fork_batch_cleaned":
		return ErrForkBatchCleaned
	default:
		return ErrForkBatchFailed
	}
}

type machineCreateOptions struct {
	LeaseID            string
	LeaseGeneration    uint64
	Metadata           map[string]string
	IdempotencyKey     string
	RequestFingerprint string
	VCPUs              int
	MemoryMB           int
	DiskMB             int
	NetworkPolicy      networkPolicyDeclaration
	TrustedInternal    bool
	RuntimeExpectation managedRuntimeExpectation
}

// NewManager constructs an empty Manager with per-IP limiting and cgroup caps.
func NewManager(cfg Config) *Manager {
	bootID, bootIDErr := readHostBootID()
	mgr := &Manager{
		cfg:                    cfg,
		limiter:                NewLimiter(cfg.PerIPMax, cfg.CreateRatePerMin),
		cgroups:                NewCgroups(cfg),
		egress:                 newEgressController(cfg),
		machines:               make(map[string]*Machine),
		stopCh:                 make(chan struct{}),
		stateStore:             NewStateStore(cfg.StatePath),
		stateHealthy:           true,
		networkHealthy:         true,
		runtimeCohortHealthy:   true,
		identityHealthy:        true,
		stateRecovery:          defaultManagedStateRecoveryOps(cfg),
		orphanCleanup:          defaultManagedOrphanCleanupOps(cfg),
		networkRuntime:         defaultManagedNetworkRuntimeOps(),
		runtimeAssetGuard:      cfg.runtimeAssetGuard,
		verifyIdentityTeardown: verifyManagedJailerIdentityTeardown,
		identityAvailable:      managedJailerIdentityAvailable,
		identityProcesses:      defaultManagedJailerProcessOps(),
		jailerIdentities:       make(map[string]jailerIdentity),
		hostBootID:             bootID,
		monotonicNow:           hostMonotonicNS,
		meteringHealthy:        bootIDErr == nil,
		createKeys:             make(map[string]*createReservation),
		forkKeys:               make(map[string]*forkReservation),
		capacityProbe:          systemHostProbe{},
		boot:                   bootMachine,
		createSnapshot: func(driver *fcDriver, id string) (string, error) {
			return driver.CreateSnapshot(id)
		},
		forkReadyTimeout:        10 * time.Second,
		reconcileReadyTimeout:   2 * time.Second,
		managedReaddressTimeout: 15 * time.Second,
		attachRestoredTap:       attachTapBridge,
		pinRestoredNeighbor:     pinGuestNeighbor,
	}
	if cfg.NehemiahMode && bootIDErr != nil {
		mgr.stateHealthy = false
	}
	if mgr.stateStore != nil {
		mgr.stateSave = mgr.stateStore.Save
	}
	mgr.readyProbe = newGuestAgentClient(mgr).Ping
	return mgr
}

func validMachineID(id string) bool { return machineIDPattern.MatchString(id) }

// Count returns the number of live user machines (warm-pool desktops excluded).
func (mgr *Manager) Count() int {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	n := 0
	for _, m := range mgr.machines {
		if !m.pooled {
			n++
		}
	}
	return n
}

// Get returns a JSON view of a machine by id, built under the lock so it never
// races with Create/Branch mutating the machine's fields mid-boot.
func (mgr *Manager) Get(id string) (machineView, bool) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	m, ok := mgr.machines[id]
	if !ok {
		return machineView{}, false
	}
	return m.View(), true
}

// Console returns the live console for a machine's guest serial, under the lock
// so the driver field read never races with Create/Branch setting it.
// machineIP returns a machine's guest IP: forks are re-addressed to a static IP;
// a cold boot's DHCP identity is cached after its first successful lookup.
func (mgr *Manager) machineIP(id string) (string, bool) {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	var ip, tap string
	if ok && m.driver != nil {
		ip = m.driver.ip
		tap = m.driver.tap
	}
	mgr.mu.Unlock()
	if !ok {
		return "", false
	}
	if ip == "" {
		var leased bool
		ip, leased = guestIP(id, mgr.cfg.LeasesPath)
		if !leased {
			return "", false
		}
	}
	if mgr.cfg.NehemiahMode {
		if tap == "" {
			logManagedHostEvent(managedHostEventGuestTapMissing, managedHostLogFields{MachineID: id})
			return "", false
		}
		if err := pinGuestNeighbor(tap, mgr.cfg.NetBridge, mgr.cfg.NetSubnet, ip, guestMAC(id)); err != nil {
			logManagedHostEvent(managedHostEventGuestNeighborPinFailed, managedHostLogFields{MachineID: id, Err: err})
			return "", false
		}
	}

	// Retain the discovered DHCP identity so teardown removes the permanent
	// neighbor and daemon restart reconciliation can reassert it.
	mgr.mu.Lock()
	if current := mgr.machines[id]; current != nil && current.driver != nil && current.driver.tap == tap && current.driver.ip == "" {
		current.driver.ip = ip
		mgr.persistLocked()
	}
	mgr.mu.Unlock()
	return ip, true
}

// secureManagedGuestNetwork resolves the one DHCP identity allocated to a cold
// boot (forks already carry their statically reserved address), reasserts the
// host's permanent IP-to-MAC binding, and only then activates the per-tap
// policy. Until this succeeds attachTapBridge's direct DROP remains in force.
func (mgr *Manager) secureManagedGuestNetwork(id string, driver *fcDriver, policy networkPolicyDeclaration) error {
	if !mgr.cfg.NehemiahMode || driver == nil || driver.tap == "" {
		return errors.New("managed guest network has no isolated tap")
	}
	normalizedPolicy, err := normalizeNetworkPolicy(policy)
	if err != nil || normalizedPolicy.declaration.Mode != egressModeOff {
		return errors.New("managed private-beta network policy must be off")
	}
	address := driver.ip
	deadline := time.Now().Add(10 * time.Second)
	for address == "" && time.Now().Before(deadline) {
		if leased, ok := guestIP(id, mgr.cfg.LeasesPath); ok {
			address = leased
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := validateManagedGuestAddress(mgr.cfg.NetSubnet, address); err != nil {
		return err
	}
	if !driver.identityPinned {
		if err := mgr.pinRestoredNeighbor(driver.tap, mgr.cfg.NetBridge, mgr.cfg.NetSubnet, address, guestMAC(id)); err != nil {
			return err
		}
		driver.identityPinned = true
	}
	if err := mgr.egress.apply(id, driver.tap, address, normalizedPolicy.declaration); err != nil {
		return err
	}
	driver.ip = address
	return nil
}

// allocForkIPsLocked picks free static fork IPs while Manager.mu is held. Both
// pre-boot reservations and attached driver identities participate, so two
// concurrent batches can never reserve the same address.
func (mgr *Manager) allocForkIPsLocked(n int) []string {
	used := map[string]bool{}
	for _, m := range mgr.machines {
		if m.reservedIP != "" {
			used[m.reservedIP] = true
		}
		if m.driver != nil && m.driver.ip != "" {
			used[m.driver.ip] = true
		}
	}
	var ips []string
	for x := 200; x <= 250 && len(ips) < n; x++ {
		ip := fmt.Sprintf("%s.%d", mgr.cfg.NetSubnet, x)
		if !used[ip] {
			ips = append(ips, ip)
		}
	}
	return ips
}

func (mgr *Manager) reserveForkIP(machineID string) string {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	machine := mgr.machines[machineID]
	if machine == nil {
		return ""
	}
	if machine.reservedIP != "" {
		return machine.reservedIP
	}
	ips := mgr.allocForkIPsLocked(1)
	if len(ips) == 0 {
		return ""
	}
	machine.reservedIP = ips[0]
	mgr.persistLocked()
	return machine.reservedIP
}

func (mgr *Manager) Console(id string) (*Console, bool) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	m, ok := mgr.machines[id]
	if !ok || m.driver == nil {
		return nil, false
	}
	return m.driver.Console(), true
}

// Extend resets a machine's TTL to ttlSeconds from now (0 → the default TTL;
// clamped into [MinTTL, MaxTTL]). Persistent machines are returned untouched.
// Same stop/retime/re-arm sequence as claimPooled.
func (mgr *Manager) Extend(id string, ttlSeconds int) (machineView, error) {
	ttl := mgr.cfg.ClampTTL(ttlSeconds)
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	m, ok := mgr.machines[id]
	if !ok {
		return machineView{}, ErrNotFound
	}
	if m.Persistent {
		return m.View(), nil // no TTL to extend
	}
	m.ExpiresAt = time.Now().Add(time.Duration(ttl) * time.Second)
	if m.timer != nil {
		m.timer.Stop()
	}
	mid := m.ID
	m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(mid) })
	mgr.persistLocked()
	return m.View(), nil
}

// ExtendInternal applies an absolute control-plane expiry. Recording the key
// and target with the machine makes a retry after a lost response harmless: it
// can only reapply the original instant, never add another relative TTL.
func (mgr *Manager) ExtendInternal(id, leaseID, idempotencyKey string, target time.Time) (machineView, bool, error) {
	if !operationKeyPattern.MatchString(idempotencyKey) {
		return machineView{}, false, fmt.Errorf("%w: Idempotency-Key must match %s", ErrInvalidLease, operationKeyPattern.String())
	}
	now := time.Now()
	if target.IsZero() || !target.After(now) || target.After(now.Add(time.Duration(mgr.cfg.MaxTTL)*time.Second+5*time.Minute)) {
		return machineView{}, false, fmt.Errorf("%w: expires_at must be a future instant within the configured maximum TTL", ErrInvalidResources)
	}
	target = target.UTC()

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	m, ok := mgr.machines[id]
	if !ok || m.pooled {
		return machineView{}, false, ErrNotFound
	}
	if m.LeaseID == "" || leaseID != m.LeaseID {
		return machineView{}, false, ErrInvalidLease
	}
	if prior, ok := m.extendOperations[idempotencyKey]; ok {
		if !prior.Equal(target) {
			return machineView{}, false, ErrIdempotencyConflict
		}
		return m.View(), true, nil
	}
	if m.extendOperations == nil {
		m.extendOperations = make(map[string]time.Time)
	}
	m.extendOperations[idempotencyKey] = target
	if !m.Persistent && target.After(m.ExpiresAt) {
		m.ExpiresAt = target
		if m.timer != nil {
			m.timer.Stop()
		}
		mid := m.ID
		m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(mid) })
	}
	mgr.persistLocked()
	return m.View(), false, nil
}

// ExtendIfExpiring bumps a local machine's TTL to the default when less than
// window remains. Local agent loops call this so a demo cannot die mid-run.
// Managed, persistent, and already-gone machines are never changed.
func (mgr *Manager) ExtendIfExpiring(id string, window time.Duration) {
	// Managed expiry is set only by the lease-bound, idempotent control-plane
	// extension path. Keep this defense even though managed callers avoid this
	// helper, so a future convenience caller cannot silently mint runtime.
	if mgr.cfg.NehemiahMode {
		return
	}
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok || m.Persistent {
		mgr.mu.Unlock()
		return
	}
	remaining := time.Until(m.ExpiresAt)
	mgr.mu.Unlock()
	if remaining < window {
		_, _ = mgr.Extend(id, 0)
	}
}

// ConsoleLock returns the machine's console together with its exclusive-user
// lock (see Machine.consoleMu). Callers TryLock it around command injection.
func (mgr *Manager) ConsoleLock(id string) (*Console, *sync.Mutex, bool) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	m, ok := mgr.machines[id]
	if !ok || m.driver == nil || m.driver.console == nil {
		return nil, nil, false
	}
	return m.driver.Console(), &m.consoleMu, true
}

func (mgr *Manager) IsReady(id string) bool {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	machine, ok := mgr.machines[id]
	return ok && machine.Ready
}

func (mgr *Manager) awaitReady(id string, timeout time.Duration) bool {
	if mgr.readyProbe == nil {
		return false
	}
	deadline := time.Now().Add(timeout)
	for {
		mgr.mu.Lock()
		machine, exists := mgr.machines[id]
		alreadyReady := exists && machine.Ready
		mgr.mu.Unlock()
		if !exists || alreadyReady {
			return alreadyReady
		}
		probeDeadline := time.Now().Add(2 * time.Second)
		if probeDeadline.After(deadline) {
			probeDeadline = deadline
		}
		ctx, cancel := context.WithDeadline(context.Background(), probeDeadline)
		err := mgr.readyProbe(ctx, id)
		cancel()
		if err == nil {
			mgr.mu.Lock()
			if machine, ok := mgr.machines[id]; ok && !machine.Ready {
				from := machine.Status
				machine.Ready = true
				if machine.ReadyAt.IsZero() {
					machine.ReadyAt = time.Now().UTC()
				}
				machine.Status = "running"
				mgr.transitionLocked(machine, from, "running", "guest_agent_ready")
				mgr.persistLocked()
			}
			mgr.mu.Unlock()
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (mgr *Manager) watchReady(id string) {
	for {
		if mgr.awaitReady(id, 5*time.Second) {
			return
		}
		mgr.mu.Lock()
		_, exists := mgr.machines[id]
		mgr.mu.Unlock()
		if !exists {
			return
		}
	}
}

// DialVsock opens a stream to a guest vsock port for the machine (used by the
// /vnc bridge). Returns ErrNotFound if the machine is gone.
func (mgr *Manager) DialVsock(id string, port int) (net.Conn, error) {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	drv := (*fcDriver)(nil)
	if ok {
		drv = m.driver
	}
	mgr.mu.Unlock()
	if !ok || drv == nil {
		return nil, ErrNotFound
	}
	return drv.DialVsock(port)
}

// List returns JSON views of all machines.
func (mgr *Manager) List() []machineView {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	out := make([]machineView, 0, len(mgr.machines))
	for _, m := range mgr.machines {
		if m.pooled {
			continue // warm-pool desktops aren't user machines
		}
		out = append(out, m.View())
	}
	return out
}

// hasMemoryFor reports whether booting this template would keep the host above
// its memory reserve, so the box hits capacity gracefully instead of OOMing.
func (mgr *Manager) hasMemoryFor(tpl Template) bool {
	if mgr.cfg.MemReserveMB <= 0 {
		return true
	}
	need := tpl.MemSizeMB
	if need <= 0 {
		need = mgr.cfg.MemSizeMB
	}
	return availableMemoryMB()-need >= mgr.cfg.MemReserveMB
}

// hasManagedForkCapacityLocked verifies the whole managed batch against a
// fresh host-capacity sample and every in-memory reservation. The caller holds
// mgr.mu through this check and the child reservation inserts, so concurrent
// creates/forks cannot both consume the same advertised capacity.
func (mgr *Manager) hasManagedForkCapacityLocked(children []managedForkChild) bool {
	probe := mgr.capacityProbe
	if probe == nil {
		probe = systemHostProbe{}
	}
	resources := probe.Inspect(mgr.cfg)
	if resources.TotalCPU <= 0 || resources.TotalMemoryMB <= 0 || resources.TotalDiskBytes == 0 {
		return false
	}

	var reservedCPU, reservedMemoryMB int64
	var reservedDiskBytes uint64
	reserve := func(vcpus, memoryMB, diskMB int, templateName string) bool {
		tpl := mgr.cfg.Template(templateName)
		if vcpus <= 0 {
			vcpus = tpl.VCPUs
			if vcpus <= 0 {
				vcpus = mgr.cfg.VCPUs
			}
		}
		if memoryMB <= 0 {
			memoryMB = tpl.MemSizeMB
			if memoryMB <= 0 {
				memoryMB = mgr.cfg.MemSizeMB
			}
		}
		if vcpus < 0 || memoryMB < 0 || diskMB < 0 {
			return false
		}
		reservedCPU += int64(vcpus)
		reservedMemoryMB += int64(memoryMB)
		if diskMB > 0 {
			const bytesPerMiB = uint64(1024 * 1024)
			if uint64(diskMB) > ^uint64(0)/bytesPerMiB {
				return false
			}
			diskBytes := uint64(diskMB) * bytesPerMiB
			if reservedDiskBytes > ^uint64(0)-diskBytes {
				return false
			}
			reservedDiskBytes += diskBytes
		}
		return true
	}

	for _, machine := range mgr.machines {
		if !reserve(machine.VCPUs, machine.MemoryMB, machine.DiskMB, machine.Template) {
			return false
		}
	}
	// A warming desktop has already claimed a future MaxMachines slot even
	// before it appears in mgr.machines. Counting its configured resources is
	// deliberately conservative during that short transition.
	for range mgr.warming {
		if !reserve(0, 0, 0, "desktop") {
			return false
		}
	}

	var requestedCPU, requestedMemoryMB int64
	var requestedDiskBytes uint64
	for _, child := range children {
		beforeCPU, beforeMemory, beforeDisk := reservedCPU, reservedMemoryMB, reservedDiskBytes
		if !reserve(child.VCPUs, child.MemoryMB, child.DiskMB, "") {
			return false
		}
		requestedCPU += reservedCPU - beforeCPU
		requestedMemoryMB += reservedMemoryMB - beforeMemory
		requestedDiskBytes += reservedDiskBytes - beforeDisk
	}
	reservedCPU -= requestedCPU
	reservedMemoryMB -= requestedMemoryMB
	reservedDiskBytes -= requestedDiskBytes

	availableCPU := int64(resources.TotalCPU) - reservedCPU
	availableMemoryMB := int64(resources.AvailableMemoryMB - mgr.cfg.MemReserveMB)
	configuredMemoryMB := int64(resources.TotalMemoryMB-mgr.cfg.MemReserveMB) - reservedMemoryMB
	if configuredMemoryMB < availableMemoryMB {
		availableMemoryMB = configuredMemoryMB
	}
	availableDiskBytes := resources.AvailableDiskBytes
	if resources.TotalDiskBytes < availableDiskBytes {
		availableDiskBytes = resources.TotalDiskBytes
	}
	if reservedDiskBytes >= availableDiskBytes {
		availableDiskBytes = 0
	} else {
		availableDiskBytes -= reservedDiskBytes
	}

	return requestedCPU <= availableCPU &&
		requestedMemoryMB <= availableMemoryMB &&
		requestedDiskBytes <= availableDiskBytes
}

// CreateInternal applies host-level idempotency before performing a potentially
// slow boot. Concurrent retries with the same key wait for the first request;
// reusing a key for different inputs is rejected deterministically.
func (mgr *Manager) CreateInternal(template string, ttlSeconds int, netEnabled, persistent bool, creatorIP, idempotencyKey, leaseID string, metadata map[string]string, vcpus, memoryMB, diskMB int) (*Machine, bool, error) {
	return mgr.CreateInternalWithPolicy(template, ttlSeconds, netEnabled, persistent, creatorIP, idempotencyKey, leaseID, metadata, vcpus, memoryMB, diskMB, networkPolicyDeclaration{})
}

// CreateInternalWithPolicy binds a canonical managed-egress policy to the
// idempotent create. The declaration participates in the fingerprint, while an
// omitted policy keeps the legacy off-policy fingerprint for safe upgrades.
func (mgr *Manager) CreateInternalWithPolicy(template string, ttlSeconds int, netEnabled, persistent bool, creatorIP, idempotencyKey, leaseID string, metadata map[string]string, vcpus, memoryMB, diskMB int, declaration networkPolicyDeclaration) (*Machine, bool, error) {
	return mgr.CreateInternalWithPolicyGeneration(template, ttlSeconds, netEnabled, persistent, creatorIP, idempotencyKey, leaseID, 1, metadata, vcpus, memoryMB, diskMB, declaration)
}

func (mgr *Manager) CreateInternalWithPolicyGeneration(template string, ttlSeconds int, netEnabled, persistent bool, creatorIP, idempotencyKey, leaseID string, leaseGeneration uint64, metadata map[string]string, vcpus, memoryMB, diskMB int, declaration networkPolicyDeclaration) (*Machine, bool, error) {
	return mgr.createInternalWithRuntimeExpectation(template, ttlSeconds, netEnabled, persistent, creatorIP, idempotencyKey, leaseID, leaseGeneration, metadata, vcpus, memoryMB, diskMB, declaration, managedRuntimeExpectation{})
}

func (mgr *Manager) CreateInternalWithRuntimeExpectation(template string, ttlSeconds int, netEnabled, persistent bool, creatorIP, idempotencyKey, leaseID string, leaseGeneration uint64, metadata map[string]string, vcpus, memoryMB, diskMB int, declaration networkPolicyDeclaration, expectation managedRuntimeExpectation) (*Machine, bool, error) {
	if mgr.cfg.NehemiahMode {
		if err := mgr.validateManagedRuntimeExpectation(template, expectation); err != nil {
			return nil, false, err
		}
	}
	return mgr.createInternalWithRuntimeExpectation(template, ttlSeconds, netEnabled, persistent, creatorIP, idempotencyKey, leaseID, leaseGeneration, metadata, vcpus, memoryMB, diskMB, declaration, expectation)
}

func (mgr *Manager) createInternalWithRuntimeExpectation(template string, ttlSeconds int, netEnabled, persistent bool, creatorIP, idempotencyKey, leaseID string, leaseGeneration uint64, metadata map[string]string, vcpus, memoryMB, diskMB int, declaration networkPolicyDeclaration, expectation managedRuntimeExpectation) (*Machine, bool, error) {
	if err := validateInternalCreate(idempotencyKey, leaseID, metadata); err != nil {
		return nil, false, err
	}
	if leaseGeneration == 0 {
		return nil, false, fmt.Errorf("%w: lease_generation must be positive", ErrInvalidLease)
	}
	policy, err := normalizeNetworkPolicy(declaration)
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrInvalidResources, err)
	}
	if mgr.cfg.NehemiahMode && policy.declaration.Mode != egressModeOff {
		return nil, false, fmt.Errorf("%w: managed private-beta network_policy.mode must be off", ErrInvalidResources)
	}
	if mgr.cfg.NehemiahMode && len(policy.hostnames) != 0 {
		return nil, false, fmt.Errorf("%w: hostname egress rules require connection-aware enforcement", ErrInvalidResources)
	}
	if policy.declaration.Mode == egressModeAllowlist && (!netEnabled || !mgr.cfg.NetEnable || !mgr.cfg.NehemiahMode) {
		return nil, false, fmt.Errorf("%w: network allowlists require a managed machine with net=true", ErrInvalidResources)
	}
	if template == "" {
		template = "python"
	}
	if expectation != (managedRuntimeExpectation{}) {
		if err := mgr.validateManagedRuntimeExpectation(template, expectation); err != nil {
			return nil, false, err
		}
	}
	if ttlSeconds != 0 && (ttlSeconds < mgr.cfg.MinTTL || ttlSeconds > mgr.cfg.MaxTTL) {
		return nil, false, fmt.Errorf("%w: ttl_seconds must be between %d and %d", ErrInvalidResources, mgr.cfg.MinTTL, mgr.cfg.MaxTTL)
	}
	if _, _, err := mgr.requestedTemplate(template, vcpus, memoryMB, diskMB); err != nil {
		return nil, false, err
	}
	persistent = persistent && mgr.cfg.AllowPersistent
	fingerprint := createFingerprintWithPolicyGeneration(template, mgr.cfg.ClampTTL(ttlSeconds), netEnabled, persistent, leaseID, leaseGeneration, metadata, vcpus, memoryMB, diskMB, policy.declaration)
	if expectation != (managedRuntimeExpectation{}) {
		payload, _ := json.Marshal(struct {
			Fingerprint string                    `json:"fingerprint"`
			Runtime     managedRuntimeExpectation `json:"runtime"`
		}{fingerprint, expectation})
		sum := sha256.Sum256(payload)
		fingerprint = hex.EncodeToString(sum[:])
	}

	mgr.mu.Lock()
	if existing, ok := mgr.createKeys[idempotencyKey]; ok {
		if existing.fingerprint != fingerprint {
			mgr.mu.Unlock()
			return nil, false, ErrIdempotencyConflict
		}
		done := existing.done
		mgr.mu.Unlock()
		<-done
		if existing.err != nil {
			return nil, false, existing.err
		}
		mgr.mu.Lock()
		machine := mgr.machines[existing.machineID]
		mgr.mu.Unlock()
		if machine == nil {
			return nil, false, ErrNotFound
		}
		return machine, true, nil
	}
	if mgr.cfg.NehemiahMode && !mgr.managedAdmissionHealthyLocked() {
		mgr.mu.Unlock()
		return nil, false, ErrHostUnhealthy
	}
	reservation := &createReservation{fingerprint: fingerprint, done: make(chan struct{})}
	mgr.createKeys[idempotencyKey] = reservation
	mgr.mu.Unlock()

	options := machineCreateOptions{
		LeaseID:            leaseID,
		LeaseGeneration:    leaseGeneration,
		Metadata:           cloneMetadata(metadata),
		IdempotencyKey:     idempotencyKey,
		RequestFingerprint: fingerprint,
		VCPUs:              vcpus,
		MemoryMB:           memoryMB,
		DiskMB:             diskMB,
		NetworkPolicy:      policy.declaration,
		TrustedInternal:    true,
		RuntimeExpectation: expectation,
	}
	machine, err := mgr.create(template, ttlSeconds, netEnabled, persistent, creatorIP, options)
	mgr.mu.Lock()
	reservation.err = err
	if machine != nil {
		reservation.machineID = machine.ID
	}
	close(reservation.done)
	if err != nil {
		delete(mgr.createKeys, idempotencyKey)
	}
	mgr.mu.Unlock()
	return machine, false, err
}

func createFingerprintWithPolicyGeneration(template string, ttl int, netEnabled, persistent bool, leaseID string, leaseGeneration uint64, metadata map[string]string, vcpus, memoryMB, diskMB int, policy networkPolicyDeclaration) string {
	base := createFingerprintWithPolicy(template, ttl, netEnabled, persistent, leaseID, metadata, vcpus, memoryMB, diskMB, policy)
	if leaseGeneration == 1 {
		return base
	}
	payload, _ := json.Marshal(struct {
		CreateFingerprint string `json:"create_fingerprint"`
		LeaseGeneration   uint64 `json:"lease_generation"`
	}{base, leaseGeneration})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func createFingerprintWithPolicy(template string, ttl int, netEnabled, persistent bool, leaseID string, metadata map[string]string, vcpus, memoryMB, diskMB int, policy networkPolicyDeclaration) string {
	legacy := createFingerprint(template, ttl, netEnabled, persistent, leaseID, metadata, vcpus, memoryMB, diskMB)
	if policy.Mode == egressModeOff {
		return legacy
	}
	payload, _ := json.Marshal(struct {
		CreateFingerprint string                   `json:"create_fingerprint"`
		NetworkPolicy     networkPolicyDeclaration `json:"network_policy"`
	}{legacy, policy})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func validateInternalCreate(idempotencyKey, leaseID string, metadata map[string]string) error {
	if strings.TrimSpace(idempotencyKey) == "" || len(idempotencyKey) > 256 {
		return fmt.Errorf("%w: Idempotency-Key is required and must be at most 256 bytes", ErrInvalidLease)
	}
	if strings.TrimSpace(leaseID) == "" || len(leaseID) > 256 {
		return fmt.Errorf("%w: lease_id is required and must be at most 256 bytes", ErrInvalidLease)
	}
	if len(metadata) > 32 {
		return fmt.Errorf("%w: metadata is limited to 32 entries", ErrInvalidLease)
	}
	for key, value := range metadata {
		if key == "" || len(key) > 64 || len(value) > 1024 {
			return fmt.Errorf("%w: metadata keys and values exceed their size limit", ErrInvalidLease)
		}
		lower := strings.ToLower(key)
		for _, forbidden := range []string{"password", "secret", "token", "credential", "authorization", "cookie", "api_key", "apikey"} {
			if strings.Contains(lower, forbidden) {
				return fmt.Errorf("%w: metadata key %q could contain credentials", ErrInvalidLease, key)
			}
		}
	}
	return nil
}

func createFingerprint(template string, ttl int, netEnabled, persistent bool, leaseID string, metadata map[string]string, vcpus, memoryMB, diskMB int) string {
	keys := make([]string, 0, len(metadata))
	for key := range metadata {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([][2]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, [2]string{key, metadata[key]})
	}
	payload, _ := json.Marshal(struct {
		Template   string      `json:"template"`
		TTL        int         `json:"ttl"`
		Net        bool        `json:"net"`
		Persistent bool        `json:"persistent"`
		LeaseID    string      `json:"lease_id"`
		Metadata   [][2]string `json:"metadata"`
		VCPUs      int         `json:"vcpus"`
		MemoryMB   int         `json:"memory_mb"`
		DiskMB     int         `json:"disk_mb"`
	}{template, ttl, netEnabled, persistent, leaseID, pairs, vcpus, memoryMB, diskMB})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func (mgr *Manager) requestedTemplate(name string, vcpus, memoryMB, diskMB int) (Template, int, error) {
	if name != "python" && name != "desktop" {
		if _, ok := loadTemplateMeta(mgr.cfg, name); !ok {
			return Template{}, 0, fmt.Errorf("%w: template %q is not installed on this host", ErrNotSupported, name)
		}
	}
	template := mgr.cfg.Template(name)
	if vcpus < 0 || memoryMB < 0 || diskMB < 0 {
		return Template{}, 0, fmt.Errorf("%w: resource values cannot be negative", ErrInvalidResources)
	}
	if vcpus > mgr.cfg.MaxVCPUsPerMachine {
		return Template{}, 0, fmt.Errorf("%w: vcpus exceeds host maximum %d", ErrInvalidResources, mgr.cfg.MaxVCPUsPerMachine)
	}
	if memoryMB > mgr.cfg.MaxMemoryMBPerMachine {
		return Template{}, 0, fmt.Errorf("%w: memory_mb exceeds host maximum %d", ErrInvalidResources, mgr.cfg.MaxMemoryMBPerMachine)
	}
	if diskMB > mgr.cfg.OverlayQuotaMB {
		return Template{}, 0, fmt.Errorf("%w: disk_mb exceeds host maximum %d", ErrInvalidResources, mgr.cfg.OverlayQuotaMB)
	}
	if vcpus > 0 {
		template.VCPUs = vcpus
	}
	if memoryMB > 0 {
		if memoryMB < 128 {
			return Template{}, 0, fmt.Errorf("%w: memory_mb must be at least 128", ErrInvalidResources)
		}
		template.MemSizeMB = memoryMB
	}
	return template, diskMB, nil
}

// Create boots a new microVM from the given template with the (clamped) TTL.
// creatorIP is used for per-IP rate/concurrency limiting on the public endpoint.
func (mgr *Manager) Create(template string, ttlSeconds int, net, persistent bool, creatorIP string) (*Machine, error) {
	return mgr.create(template, ttlSeconds, net, persistent, creatorIP, machineCreateOptions{})
}

func (mgr *Manager) create(template string, ttlSeconds int, net, persistent bool, creatorIP string, options machineCreateOptions) (*Machine, error) {
	ttl := mgr.cfg.ClampTTL(ttlSeconds)
	persistent = persistent && mgr.cfg.AllowPersistent
	policy, policyErr := normalizeNetworkPolicy(options.NetworkPolicy)
	if policyErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidResources, policyErr)
	}
	if mgr.cfg.NehemiahMode && policy.declaration.Mode != egressModeOff {
		return nil, fmt.Errorf("%w: managed private-beta network_policy.mode must be off", ErrInvalidResources)
	}
	if mgr.cfg.NehemiahMode && len(policy.hostnames) != 0 {
		return nil, fmt.Errorf("%w: hostname egress rules require connection-aware enforcement", ErrInvalidResources)
	}
	if policy.declaration.Mode == egressModeAllowlist && (!net || !mgr.cfg.NetEnable || !mgr.cfg.NehemiahMode) {
		return nil, fmt.Errorf("%w: network allowlists require a managed machine with net=true", ErrInvalidResources)
	}
	options.NetworkPolicy = policy.declaration
	wantNetwork := net && mgr.cfg.NetEnable
	if mgr.cfg.Draining {
		return nil, ErrHostDraining
	}
	if mgr.cfg.NehemiahMode && !mgr.cgroups.Enabled() {
		return nil, ErrHostUnhealthy
	}

	// Public/self-hosted callers are bounded by their source address. Managed
	// control-plane admission is already authenticated and globally quota/capacity
	// checked; collapsing it onto one synthetic IP would make PerIPMax contradict
	// the host's advertised MaxMachines capacity.
	if options.TrustedInternal {
		creatorIP = ""
	} else if err := mgr.limiter.Acquire(creatorIP); err != nil {
		return nil, err
	}

	// Instant desktop: hand over a pre-booted one from the warm pool if ready.
	// Only for the stock desktop — published templates (even display ones) must
	// boot from their own snapshot, not a pooled vanilla machine.
	if !mgr.cfg.NehemiahMode && mgr.cfg.Template(template).Name == "desktop" && mgr.cfg.DesktopPool > 0 && !net {
		if m := mgr.claimPooled(creatorIP, ttl, persistent, options); m != nil {
			go mgr.refillPool()
			life := fmt.Sprintf("ttl=%ds", ttl)
			if persistent {
				life = "persistent"
			}
			if mgr.cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventWarmPoolClaimed, managedHostLogFields{MachineID: m.ID, TTLSeconds: int64(ttl), Persistent: persistent})
			} else {
				log.Printf("machine %s claimed from warm pool (%s)", m.ID, life)
			}
			return m, nil
		}
	}

	// Reserve a slot + id under the lock, but perform the (slow) boot outside it.
	tpl, requestedDiskMB, err := mgr.requestedTemplate(template, options.VCPUs, options.MemoryMB, options.DiskMB)
	if err != nil {
		mgr.limiter.Release(creatorIP)
		return nil, err
	}
	mgr.mu.Lock()
	if mgr.cfg.NehemiahMode && !mgr.managedAdmissionHealthyLocked() {
		mgr.mu.Unlock()
		mgr.limiter.Release(creatorIP)
		return nil, ErrHostUnhealthy
	}
	if mgr.cfg.NehemiahMode && options.LeaseID != "" && !mgr.meteringCanStartLocked() {
		mgr.mu.Unlock()
		mgr.limiter.Release(creatorIP)
		return nil, ErrHostUnhealthy
	}
	if len(mgr.machines) >= mgr.cfg.MaxMachines || !mgr.hasMemoryFor(tpl) {
		mgr.mu.Unlock()
		mgr.limiter.Release(creatorIP)
		return nil, ErrTooManyMachines
	}
	id := mgr.newID()
	identity, identityErr := mgr.reserveJailerIdentityLocked(id)
	if identityErr != nil {
		mgr.mu.Unlock()
		mgr.limiter.Release(creatorIP)
		return nil, identityErr
	}
	now := time.Now()
	m := &Machine{
		ID:                  id,
		Status:              "booting",
		Template:            tpl.Name,
		Display:             tpl.Display,
		creatorIP:           creatorIP,
		CreatedAt:           now,
		ExpiresAt:           now.Add(time.Duration(ttl) * time.Second),
		Persistent:          persistent,
		LeaseID:             options.LeaseID,
		LeaseGeneration:     options.LeaseGeneration,
		Metadata:            cloneMetadata(options.Metadata),
		IdempotencyKey:      options.IdempotencyKey,
		requestFingerprint:  options.RequestFingerprint,
		runtimeRootfsSHA256: options.RuntimeExpectation.RootfsSHA256,
		VCPUs:               tpl.VCPUs,
		MemoryMB:            tpl.MemSizeMB,
		DiskMB:              requestedDiskMB,
		NetworkPolicy:       options.NetworkPolicy,
		meteringReserved:    mgr.cfg.NehemiahMode && options.LeaseID != "",
		jailerIdentity:      identity,
		networkProvisioning: mgr.cfg.NehemiahMode && wantNetwork,
	}
	// Insert a placeholder so the slot is held and the id is unique.
	mgr.machines[id] = m
	mgr.transitionLocked(m, "", "booting", "create")
	if mgr.cfg.NehemiahMode {
		if persistErr := mgr.persistRequiredLocked(); persistErr != nil {
			delete(mgr.machines, id)
			delete(mgr.jailerIdentities, id)
			mgr.mu.Unlock()
			mgr.limiter.Release(creatorIP)
			return nil, ErrHostUnhealthy
		}
	} else {
		mgr.persistLocked()
	}
	mgr.mu.Unlock()

	// Use the template's prebuilt snapshot for a fast restore when eligible and
	// present; bootMachine falls back to a cold boot if the restore fails.
	// `net` forces a cold boot (the snapshot has no NIC) so the VM gets internet —
	// unless the snapshot itself was taken WITH a NIC (published template,
	// RestoreNet), in which case the restore keeps it and we re-address below.
	snapDir := ""
	if tpl.Snapshot && tpl.RestoreNet == wantNetwork {
		cand := filepath.Join(mgr.cfg.TemplatesDir, tpl.Name)
		if fileExists(filepath.Join(cand, "snapshot_file")) && fileExists(filepath.Join(cand, "mem_file")) {
			// A memory snapshot contains the guest kernel's mounted-filesystem
			// geometry. If the requested disk size differs, cold boot the same
			// rootfs and resize it offline instead of resuming stale FS state.
			rootfs := filepath.Join(cand, "rootfs.ext4")
			info, statErr := os.Stat(rootfs)
			if requestedDiskMB == 0 || (statErr == nil && info.Size() == int64(requestedDiskMB)*1024*1024) {
				snapDir = cand
			}
		}
	}

	drv, mode, bootMS, err := mgr.boot(mgr.configForMachine(m), id, tpl, snapDir, tpl.RestoreNet && snapDir != "", wantNetwork, requestedDiskMB)
	if err != nil {
		// Roll back the reservation (and the per-IP slot).
		mgr.mu.Lock()
		delete(mgr.machines, id)
		mgr.transitionLocked(m, "booting", "failed", err.Error())
		mgr.persistLocked()
		mgr.mu.Unlock()
		mgr.teardown(m)
		return nil, err
	}

	// Cap the guest's host resources (CPU/memory/pids). In jailed mode the jailer
	// already created a capped cgroup for the VM, so we don't place it again.
	if !mgr.cfg.JailerEnable {
		if err := mgr.cgroups.Place(drv.PID(), id, tpl, drv.overlay); err != nil {
			if mgr.cfg.NehemiahMode {
				drv.Close()
				mgr.mu.Lock()
				delete(mgr.machines, id)
				mgr.transitionLocked(m, "booting", "failed", "cgroup_limits")
				mgr.persistLocked()
				mgr.mu.Unlock()
				mgr.teardown(m)
				return nil, err
			}
			log.Printf("machine %s: cgroup limits unavailable: %v", id, err)
		}
	}

	// A machine restored from a published-with-NIC snapshot resumed on the
	// publisher's MAC/IP — give it a fresh identity, fork-style.
	if mode == "snapshot" && (tpl.RestoreNet || tpl.Display) {
		if mgr.cfg.NehemiahMode && tpl.RestoreNet {
			if err := mgr.readdressManagedFork(id, drv, true, ""); err != nil {
				drv.Close()
				mgr.mu.Lock()
				delete(mgr.machines, id)
				mgr.transitionLocked(m, "booting", "failed", "network_identity")
				mgr.persistLocked()
				mgr.mu.Unlock()
				mgr.teardown(m)
				return nil, ErrHostUnhealthy
			}
			if tpl.Display {
				mgr.repaintRestoredDisplay(id, drv)
			}
		} else {
			mgr.readdressFork(id, drv, tpl, tpl.RestoreNet, "")
		}
	}

	if wantNetwork && mgr.cfg.NehemiahMode {
		if err := mgr.secureManagedGuestNetwork(id, drv, options.NetworkPolicy); err != nil {
			drv.Close()
			mgr.mu.Lock()
			delete(mgr.machines, id)
			mgr.transitionLocked(m, "booting", "failed", "egress_policy")
			mgr.persistLocked()
			mgr.mu.Unlock()
			mgr.teardown(m)
			return nil, ErrHostUnhealthy
		}
	}

	mgr.mu.Lock()
	m.networkProvisioning = false
	if mgr.cfg.NehemiahMode && !mgr.managedAdmissionHealthyLocked() {
		m.driver = drv
		delete(mgr.machines, id)
		mgr.transitionLocked(m, "booting", "failed", "managed_runtime_drift")
		mgr.persistLocked()
		mgr.mu.Unlock()
		mgr.teardown(m)
		return nil, ErrHostUnhealthy
	}
	m.driver = drv
	m.Mode = mode
	m.BootMS = bootMS
	m.StartedAt = drv.startedAt
	if m.StartedAt.IsZero() {
		m.StartedAt = time.Now().UTC()
	}
	if m.DiskMB == 0 {
		if info, statErr := os.Stat(drv.overlay); statErr == nil {
			m.DiskMB = int((info.Size() + 1024*1024 - 1) / (1024 * 1024))
		}
	}
	m.Status = "starting"
	if !persistent {
		m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(id) })
	}
	mgr.transitionLocked(m, "booting", "starting", "vmm_started")
	priorMeteringOutbox := len(mgr.meteringOutbox)
	if err := mgr.recordMeterStartLocked(m); err != nil {
		delete(mgr.machines, id)
		mgr.transitionLocked(m, "starting", "failed", "metering_start")
		mgr.persistLocked()
		mgr.mu.Unlock()
		mgr.teardown(m)
		return nil, ErrHostUnhealthy
	}
	if mgr.cfg.NehemiahMode && m.Metering.Sequence > 0 {
		if err := mgr.persistRequiredLocked(); err != nil {
			mgr.meteringOutbox = mgr.meteringOutbox[:priorMeteringOutbox]
			m.Metering = machineMeteringState{}
			delete(mgr.machines, id)
			mgr.transitionLocked(m, "starting", "failed", "metering_persistence")
			mgr.persistLocked()
			mgr.mu.Unlock()
			mgr.teardown(m)
			return nil, ErrHostUnhealthy
		}
	} else {
		mgr.persistLocked()
	}
	mgr.mu.Unlock()
	if !mgr.awaitReady(id, 5*time.Second) {
		go mgr.watchReady(id)
	}

	ttlDesc := fmt.Sprintf("%ds", ttl)
	if persistent {
		ttlDesc = "persistent"
	}
	if mgr.cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventMachineCreated, managedHostLogFields{
			MachineID: id, DurationMS: bootMS, TTLSeconds: int64(ttl), Persistent: persistent,
		})
	} else {
		log.Printf("machine %s created (mode=%s boot_ms=%d ttl=%s)", id, mode, bootMS, ttlDesc)
	}
	return m, nil
}

// Branch forks a single machine from the source's live snapshot. Best effort:
// returns ErrSnapshotUnavailable (mapped to 501) if snapshotting fails.
func (mgr *Manager) Branch(id, creatorIP string) (*Machine, error) {
	forks, err := mgr.BranchN(id, creatorIP, 1)
	if err != nil {
		return nil, err
	}
	return forks[0], nil
}

// BranchN forks count machines from ONE snapshot of the source (the source is
// paused exactly once, however many clones are made). Partial failures keep the
// successes: the returned slice holds whatever booted; an error is returned
// only when nothing did.
func (mgr *Manager) BranchN(id, creatorIP string, count int) ([]*Machine, error) {
	count = min(max(count, 1), max(mgr.cfg.MaxForks, 1))

	mgr.mu.Lock()
	src, ok := mgr.machines[id]
	if !ok {
		mgr.mu.Unlock()
		return nil, ErrNotFound
	}
	if len(mgr.machines)+count > mgr.cfg.MaxMachines {
		mgr.mu.Unlock()
		return nil, ErrTooManyMachines
	}
	srcDriver := src.driver
	srcTemplate := src.Template
	srcVCPUs, srcMemoryMB, srcDiskMB := src.VCPUs, src.MemoryMB, src.DiskMB
	srcNetworkPolicy := src.NetworkPolicy
	now := time.Now()
	ttl := mgr.cfg.ClampTTL(int(time.Until(src.ExpiresAt).Seconds()))
	mgr.mu.Unlock()

	if srcDriver == nil {
		return nil, ErrSnapshotUnavailable
	}
	srcHadNIC := srcDriver.tap != "" // forks of a networked machine

	// Each fork counts against the caller's per-IP budget (released in teardown/
	// rollback). Take what we can get: forking 3-of-5 beats erroring out.
	var children []*Machine
	mgr.mu.Lock()
	for i := 0; i < count; i++ {
		if err := mgr.limiter.Acquire(creatorIP); err != nil {
			if i == 0 {
				mgr.mu.Unlock()
				return nil, err
			}
			break
		}
		reservedIP := ""
		if srcHadNIC && mgr.cfg.NetEnable {
			ips := mgr.allocForkIPsLocked(1)
			if len(ips) == 0 {
				mgr.limiter.Release(creatorIP)
				break
			}
			reservedIP = ips[0]
		}
		newID := mgr.newID()
		child := &Machine{
			ID:            newID,
			Status:        "booting",
			Template:      srcTemplate,
			ParentID:      id,
			creatorIP:     creatorIP,
			CreatedAt:     now,
			ExpiresAt:     now.Add(time.Duration(ttl) * time.Second),
			VCPUs:         srcVCPUs,
			MemoryMB:      srcMemoryMB,
			DiskMB:        srcDiskMB,
			NetworkPolicy: srcNetworkPolicy,
			reservedIP:    reservedIP,
		}
		mgr.machines[newID] = child
		mgr.transitionLocked(child, "", "booting", "branch")
		children = append(children, child)
	}
	mgr.persistLocked()
	mgr.mu.Unlock()
	if len(children) == 0 {
		return nil, ErrTooManyMachines
	}

	// ONE snapshot serves every clone (per-fork overlays are reflink copies of
	// its rootfs). Named after the first child; removed when all boots are done.
	src.snapshotMu.Lock()
	mgr.mu.Lock()
	sourceCurrent := mgr.machines[id] == src && src.driver == srcDriver
	mgr.mu.Unlock()
	if !sourceCurrent {
		src.snapshotMu.Unlock()
		for _, child := range children {
			mgr.rollback(child.ID)
		}
		return nil, ErrSnapshotUnavailable
	}
	snapDir, err := mgr.createSnapshot(srcDriver, children[0].ID)
	src.snapshotMu.Unlock()
	if err != nil {
		for _, c := range children {
			mgr.rollback(c.ID)
		}
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventSnapshotCreateFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("branch %s: snapshot failed: %v", id, err)
		}
		return nil, ErrSnapshotUnavailable
	}
	defer os.RemoveAll(snapDir)

	tpl, _, resourceErr := mgr.requestedTemplate(srcTemplate, srcVCPUs, srcMemoryMB, srcDiskMB)
	if resourceErr != nil {
		for _, child := range children {
			mgr.rollback(child.ID)
		}
		return nil, resourceErr
	}

	var booted []*Machine
	for i, child := range children {
		drv, mode, bootMS, err := mgr.boot(mgr.cfg, child.ID, tpl, snapDir, srcHadNIC, srcHadNIC && mgr.cfg.NetEnable, srcDiskMB)
		if err != nil {
			mgr.rollback(child.ID)
			if mgr.cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventMachineRestoreFailed, managedHostLogFields{
					SourceMachineID: id, MachineID: child.ID, Err: err,
					Attempt: int64(i + 1), Total: int64(len(children)),
				})
			} else {
				log.Printf("branch %s: restore %d/%d failed: %v", id, i+1, len(children), err)
			}
			continue
		}

		if !mgr.cfg.JailerEnable {
			if err := mgr.cgroups.Place(drv.PID(), child.ID, tpl, drv.overlay); err != nil {
				if mgr.cfg.NehemiahMode {
					drv.Close()
					mgr.rollback(child.ID)
					logManagedHostEvent(managedHostEventCgroupPlaceFailed, managedHostLogFields{MachineID: child.ID, SourceMachineID: id, Err: err})
					continue
				}
				log.Printf("machine %s: cgroup limits unavailable: %v", child.ID, err)
			}
		}

		if mgr.cfg.NehemiahMode && srcHadNIC {
			if err := mgr.readdressManagedFork(child.ID, drv, true, child.reservedIP); err != nil {
				drv.Close()
				mgr.rollback(child.ID)
				logManagedHostEvent(managedHostEventNetworkReaddressFailed, managedHostLogFields{
					MachineID: child.ID, SourceMachineID: id, Err: err,
					Attempt: int64(i + 1), Total: int64(len(children)),
				})
				continue
			}
			if err := mgr.secureManagedGuestNetwork(child.ID, drv, child.NetworkPolicy); err != nil {
				drv.Close()
				mgr.rollback(child.ID)
				logManagedHostEvent(managedHostEventEgressPolicyFailed, managedHostLogFields{
					MachineID: child.ID, SourceMachineID: id, Err: err,
					Attempt: int64(i + 1), Total: int64(len(children)),
				})
				continue
			}
		} else {
			mgr.readdressFork(child.ID, drv, tpl, srcHadNIC, child.reservedIP)
		}

		cid := child.ID
		mgr.mu.Lock()
		child.driver = drv
		child.Mode = mode
		child.BootMS = bootMS
		child.StartedAt = drv.startedAt
		if child.StartedAt.IsZero() {
			child.StartedAt = time.Now().UTC()
		}
		child.Status = "starting"
		child.timer = time.AfterFunc(time.Until(child.ExpiresAt), func() { mgr.reap(cid) })
		mgr.transitionLocked(child, "booting", "starting", "branch_vmm_started")
		mgr.persistLocked()
		mgr.mu.Unlock()
		if !mgr.awaitReady(cid, 5*time.Second) {
			go mgr.watchReady(cid)
		}

		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventMachineForked, managedHostLogFields{
				MachineID: cid, SourceMachineID: id, DurationMS: bootMS,
				Attempt: int64(i + 1), Total: int64(len(children)),
			})
		} else {
			log.Printf("machine %s branched from %s (mode=%s boot_ms=%d fork %d/%d)", cid, id, mode, bootMS, i+1, len(children))
		}
		booted = append(booted, child)
	}

	if len(booted) == 0 {
		return nil, ErrSnapshotUnavailable
	}
	return booted, nil
}

// ForkInternal creates a control-plane-described batch from exactly one live
// source snapshot. Unlike the local BranchN compatibility API, this operation
// is all-or-cleanup and persists both successful and failed idempotency results.
func (mgr *Manager) ForkInternal(sourceID, sourceLeaseID, idempotencyKey string, requested []managedForkChild) ([]*Machine, bool, error) {
	return mgr.forkInternal(sourceID, sourceLeaseID, idempotencyKey, requested, managedRuntimeExpectation{}, false)
}

func (mgr *Manager) ForkInternalWithRuntimeExpectation(sourceID, sourceLeaseID, idempotencyKey string, requested []managedForkChild, expectation managedRuntimeExpectation) ([]*Machine, bool, error) {
	return mgr.forkInternal(sourceID, sourceLeaseID, idempotencyKey, requested, expectation, mgr.cfg.NehemiahMode)
}

func (mgr *Manager) forkInternal(sourceID, sourceLeaseID, idempotencyKey string, requested []managedForkChild, expectation managedRuntimeExpectation, requireExpectation bool) ([]*Machine, bool, error) {
	if !operationKeyPattern.MatchString(idempotencyKey) {
		return nil, false, fmt.Errorf("%w: Idempotency-Key must match %s", ErrInvalidLease, operationKeyPattern.String())
	}
	if len(requested) < 1 || len(requested) > 8 {
		return nil, false, fmt.Errorf("%w: fork child count must be between 1 and 8", ErrInvalidResources)
	}
	for index := range requested {
		if requested[index].LeaseGeneration == 0 {
			requested[index].LeaseGeneration = 1
		}
		child := requested[index]
		if err := validateInternalCreate(idempotencyKey, child.LeaseID, child.Metadata); err != nil {
			return nil, false, err
		}
	}
	fingerprint := managedForkFingerprint(sourceID, sourceLeaseID, requested)
	operationKey := sourceID + "\x00" + idempotencyKey

	mgr.mu.Lock()
	// Exact replay is authorized by the durable fingerprint, which includes the
	// source lease and every child descriptor. Consult it before the live source:
	// the source may legitimately have been deleted after the host committed a
	// batch but before the control plane received the response.
	if existing, ok := mgr.forkKeys[operationKey]; ok {
		if existing.fingerprint != fingerprint {
			mgr.mu.Unlock()
			return nil, false, ErrIdempotencyConflict
		}
		if requireExpectation && existing.runtimeExpectation != expectation {
			mgr.mu.Unlock()
			return nil, false, ErrIdempotencyConflict
		}
		done := existing.done
		mgr.mu.Unlock()
		<-done
		children, err := mgr.forkReservationResult(existing)
		return children, true, err
	}
	if mgr.stateStore == nil || mgr.stateSave == nil || !mgr.managedAdmissionHealthyLocked() {
		mgr.mu.Unlock()
		return nil, false, ErrHostUnhealthy
	}
	if !mgr.meteringCanReserveLocked(len(requested)) {
		mgr.mu.Unlock()
		return nil, false, ErrHostUnhealthy
	}
	if len(requested) > max(mgr.cfg.MaxForks, 1) {
		mgr.mu.Unlock()
		return nil, false, fmt.Errorf("%w: fork child count exceeds host limit %d", ErrInvalidResources, max(mgr.cfg.MaxForks, 1))
	}
	now := time.Now().UTC()
	mgr.pruneForkReservationsLocked(now)
	if len(mgr.forkKeys) >= mgr.maxForkOperations() {
		mgr.mu.Unlock()
		return nil, false, ErrTooManyMachines
	}
	source, ok := mgr.machines[sourceID]
	if !ok || source.pooled {
		mgr.mu.Unlock()
		return nil, false, ErrNotFound
	}
	if source.LeaseID == "" || source.LeaseID != sourceLeaseID {
		mgr.mu.Unlock()
		return nil, false, ErrInvalidLease
	}
	if mgr.cfg.NehemiahMode {
		policy, err := normalizeNetworkPolicy(source.NetworkPolicy)
		if err != nil || policy.declaration.Mode != egressModeOff {
			mgr.mu.Unlock()
			return nil, false, fmt.Errorf("%w: managed fork source network_policy.mode must be off", ErrInvalidResources)
		}
	}
	if requireExpectation {
		if err := mgr.validateManagedRuntimeExpectation(source.Template, expectation); err != nil {
			mgr.mu.Unlock()
			return nil, false, err
		}
		if !constantTimeHexEqual(source.runtimeRootfsSHA256, expectation.RootfsSHA256) {
			mgr.mu.Unlock()
			return nil, false, fmt.Errorf("%w: fork source is not bound to the selected runtime rootfs", ErrInvalidResources)
		}
	}
	if mgr.cfg.Draining {
		mgr.mu.Unlock()
		return nil, false, ErrHostDraining
	}
	if mgr.cfg.NehemiahMode && !mgr.cgroups.Enabled() {
		mgr.mu.Unlock()
		return nil, false, ErrHostUnhealthy
	}
	if source.driver == nil || !source.Ready || source.Status != "running" || source.Persistent || !source.ExpiresAt.After(time.Now()) {
		mgr.mu.Unlock()
		return nil, false, ErrForkSourceNotReady
	}
	if err := validateManagedForkDescriptors(source, requested); err != nil {
		mgr.mu.Unlock()
		return nil, false, err
	}
	if len(mgr.machines)+mgr.warming+len(requested) > mgr.cfg.MaxMachines || !mgr.hasManagedForkCapacityLocked(requested) {
		mgr.mu.Unlock()
		return nil, false, ErrTooManyMachines
	}
	for _, machine := range mgr.machines {
		for _, child := range requested {
			if machine.LeaseID == child.LeaseID || (machine.Metadata != nil && machine.Metadata["public_machine_id"] == child.Metadata["public_machine_id"]) {
				mgr.mu.Unlock()
				return nil, false, fmt.Errorf("%w: a child lease or public id is already live", ErrIdempotencyConflict)
			}
		}
	}

	reservation := &forkReservation{
		sourceID:           sourceID,
		fingerprint:        fingerprint,
		state:              "pending",
		createdAt:          now,
		retainUntil:        mgr.forkRetentionUntil(now, requested),
		done:               make(chan struct{}),
		runtimeExpectation: expectation,
	}
	children := make([]*Machine, 0, len(requested))
	reservedIPs := make([]string, len(requested))
	if source.driver.tap != "" && mgr.cfg.NetEnable {
		allocated := mgr.allocForkIPsLocked(len(requested))
		if len(allocated) != len(requested) {
			mgr.mu.Unlock()
			return nil, false, ErrTooManyMachines
		}
		copy(reservedIPs, allocated)
	}
	for index, descriptor := range requested {
		generation := descriptor.LeaseGeneration
		if generation == 0 {
			generation = 1
		}
		childID := mgr.newID()
		identity, identityErr := mgr.reserveJailerIdentityLocked(childID)
		if identityErr != nil {
			for _, reserved := range children {
				delete(mgr.machines, reserved.ID)
				delete(mgr.jailerIdentities, reserved.ID)
			}
			mgr.mu.Unlock()
			return nil, false, identityErr
		}
		child := &Machine{
			ID:                  childID,
			Status:              "booting",
			Template:            source.Template,
			Display:             source.Display,
			CreatedAt:           now,
			ExpiresAt:           descriptor.ExpiresAt.UTC(),
			VCPUs:               descriptor.VCPUs,
			MemoryMB:            descriptor.MemoryMB,
			DiskMB:              descriptor.DiskMB,
			ParentID:            sourceID,
			LeaseID:             descriptor.LeaseID,
			LeaseGeneration:     generation,
			Metadata:            cloneMetadata(descriptor.Metadata),
			NetworkPolicy:       source.NetworkPolicy,
			runtimeRootfsSHA256: source.runtimeRootfsSHA256,
			reservedIP:          reservedIPs[index],
			meteringReserved:    true,
			jailerIdentity:      identity,
			networkProvisioning: source.driver.tap != "" && mgr.cfg.NetEnable,
		}
		mgr.machines[child.ID] = child
		mgr.transitionLocked(child, "", "booting", "managed_fork_reserved")
		reservation.childIDs = append(reservation.childIDs, child.ID)
		children = append(children, child)
	}
	mgr.forkKeys[operationKey] = reservation
	if persistErr := mgr.persistRequiredLocked(); persistErr != nil {
		// No snapshot or VMM restore has begun. Remove the entire in-memory
		// reservation and attempt a second durable write so even a save which
		// failed ambiguously cannot leave a pending operation behind.
		removed := mgr.removeForkChildrenLocked(reservation.childIDs, "managed_fork_reservation_persist_failed")
		reservation.state = "failed"
		reservation.err = ErrForkBatchCleaned
		close(reservation.done)
		cleanupErr := mgr.persistRequiredLocked()
		mgr.mu.Unlock()
		mgr.teardownForkChildren(removed)
		if cleanupErr != nil {
			logManagedHostEvent(managedHostEventForkRollbackPersistFailed, managedHostLogFields{SourceMachineID: sourceID, Err: cleanupErr})
		}
		logManagedHostEvent(managedHostEventForkReservationPersistFailed, managedHostLogFields{SourceMachineID: sourceID, Err: persistErr})
		return nil, false, ErrForkBatchCleaned
	}
	sourceDriver := source.driver
	mgr.mu.Unlock()

	err := mgr.runManagedFork(source, sourceDriver, children)
	mgr.mu.Lock()
	cleanupCheckpoint := mgr.captureForkCleanupLocked(reservation.childIDs)
	var removed []*Machine
	if err != nil {
		// Every operational failure is terminal only after one last atomic sweep
		// proves that none of the reserved children remain registered.
		removed = mgr.removeForkChildrenLocked(reservation.childIDs, "managed_fork_terminal_cleanup")
		err = ErrForkBatchCleaned
		reservation.err = err
		reservation.state = "failed"
	} else {
		reservation.err = nil
		reservation.state = "succeeded"
	}
	terminalSaveErr := mgr.persistRequiredLocked()
	if terminalSaveErr != nil && err == nil {
		// A successful batch without a durable terminal result would duplicate on
		// retry or disappear on restart. Convert it to a whole-batch failure and
		// commit that cleanup decision before waking replay waiters.
		removed = append(removed, mgr.removeForkChildrenLocked(reservation.childIDs, "managed_fork_terminal_persist_failed")...)
		reservation.err = ErrForkBatchCleaned
		reservation.state = "failed"
		err = ErrForkBatchCleaned
		terminalSaveErr = mgr.persistRequiredLocked()
	} else if terminalSaveErr != nil {
		// The operational failure already removed its children. Retry the same
		// terminal record once, allowing a transient persistence fault to recover.
		terminalSaveErr = mgr.persistRequiredLocked()
	}
	if terminalSaveErr != nil {
		mgr.restoreForkCleanupLocked(cleanupCheckpoint)
		removed = nil
	}
	mgr.mu.Unlock()
	mgr.teardownForkChildren(removed)
	mgr.mu.Lock()
	close(reservation.done)
	mgr.mu.Unlock()
	if terminalSaveErr != nil {
		logManagedHostEvent(managedHostEventForkTerminalPersistFailed, managedHostLogFields{SourceMachineID: sourceID, Err: terminalSaveErr})
		// The host remains unhealthy and rejects all new work, but the caller can
		// safely release this batch reservation because teardown completed above.
		return nil, false, ErrForkBatchCleaned
	}
	if err != nil {
		return nil, false, err
	}
	result, resultErr := mgr.forkReservationResult(reservation)
	return result, false, resultErr
}

func (mgr *Manager) maxForkOperations() int {
	if mgr.cfg.MaxForkOperations > 0 && mgr.cfg.MaxForkOperations < maxDurableForkOperations {
		return mgr.cfg.MaxForkOperations
	}
	return maxDurableForkOperations
}

func (mgr *Manager) forkRetentionUntil(now time.Time, children []managedForkChild) time.Time {
	seconds := max(mgr.cfg.MaxTTL, mgr.cfg.DefaultTTL, 1)
	retainUntil := now.Add(time.Duration(seconds) * time.Second)
	for _, child := range children {
		if child.ExpiresAt.After(retainUntil) {
			retainUntil = child.ExpiresAt
		}
	}
	return retainUntil.UTC()
}

func (mgr *Manager) pruneForkReservationsLocked(now time.Time) {
	for key, reservation := range mgr.forkKeys {
		if reservation.state != "pending" && !reservation.retainUntil.IsZero() && !reservation.retainUntil.After(now) {
			delete(mgr.forkKeys, key)
		}
	}
}

func validateManagedForkDescriptors(source *Machine, children []managedForkChild) error {
	parentPublicID := source.Metadata["public_machine_id"]
	if parentPublicID == "" {
		return fmt.Errorf("%w: source public_machine_id is unavailable", ErrInvalidLease)
	}
	publicIDs := make(map[string]struct{}, len(children))
	leases := make(map[string]struct{}, len(children))
	operationID := ""
	now := time.Now()
	for _, child := range children {
		publicID := child.Metadata["public_machine_id"]
		if publicID == "" || len(publicID) > 256 || child.Metadata["parent_machine_id"] != parentPublicID || child.Metadata["fork_operation_id"] == "" {
			return fmt.Errorf("%w: fork child metadata does not bind the source and operation", ErrInvalidLease)
		}
		if operationID == "" {
			operationID = child.Metadata["fork_operation_id"]
		} else if operationID != child.Metadata["fork_operation_id"] {
			return fmt.Errorf("%w: fork children must share one operation id", ErrInvalidLease)
		}
		if _, duplicate := publicIDs[publicID]; duplicate {
			return fmt.Errorf("%w: fork child public ids must be unique", ErrInvalidLease)
		}
		if _, duplicate := leases[child.LeaseID]; duplicate {
			return fmt.Errorf("%w: fork child leases must be unique", ErrInvalidLease)
		}
		publicIDs[publicID] = struct{}{}
		leases[child.LeaseID] = struct{}{}
		if child.VCPUs != source.VCPUs || child.MemoryMB != source.MemoryMB || child.DiskMB != source.DiskMB {
			return fmt.Errorf("%w: fork child resources must exactly match the source", ErrInvalidResources)
		}
		if !child.ExpiresAt.After(now) || child.ExpiresAt.After(source.ExpiresAt) {
			return fmt.Errorf("%w: fork child expiry must not outlive the current source lease", ErrInvalidResources)
		}
	}
	return nil
}

func managedForkFingerprint(sourceID, sourceLeaseID string, children []managedForkChild) string {
	type canonicalChild struct {
		LeaseID         string      `json:"lease_id"`
		LeaseGeneration uint64      `json:"lease_generation,omitempty"`
		ExpiresAt       string      `json:"expires_at"`
		Metadata        [][2]string `json:"metadata"`
		VCPUs           int         `json:"vcpus"`
		MemoryMB        int         `json:"memory_mb"`
		DiskMB          int         `json:"disk_mb"`
	}
	canonical := make([]canonicalChild, 0, len(children))
	for _, child := range children {
		keys := make([]string, 0, len(child.Metadata))
		for key := range child.Metadata {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		pairs := make([][2]string, 0, len(keys))
		for _, key := range keys {
			pairs = append(pairs, [2]string{key, child.Metadata[key]})
		}
		generation := child.LeaseGeneration
		if generation == 1 {
			generation = 0
		}
		canonical = append(canonical, canonicalChild{
			LeaseID: child.LeaseID, LeaseGeneration: generation,
			ExpiresAt: child.ExpiresAt.UTC().Format(time.RFC3339Nano),
			Metadata:  pairs, VCPUs: child.VCPUs, MemoryMB: child.MemoryMB, DiskMB: child.DiskMB,
		})
	}
	payload, _ := json.Marshal(struct {
		SourceID      string           `json:"source_id"`
		SourceLeaseID string           `json:"source_lease_id"`
		Children      []canonicalChild `json:"children"`
	}{sourceID, sourceLeaseID, canonical})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func (mgr *Manager) forkReservationResult(reservation *forkReservation) ([]*Machine, error) {
	for {
		mgr.mu.Lock()
		cleanupDone := reservation.cleanupDone
		if cleanupDone == nil {
			break
		}
		mgr.mu.Unlock()
		<-cleanupDone
	}
	if reservation.state == "pending" {
		mgr.mu.Unlock()
		return nil, ErrForkResultPending
	}
	if reservation.err != nil {
		err := reservation.err
		mgr.mu.Unlock()
		return nil, err
	}
	children := make([]*Machine, 0, len(reservation.childIDs))
	pending := false
	invalid := false
	for _, id := range reservation.childIDs {
		child := mgr.machines[id]
		if child == nil {
			invalid = true
			continue
		}
		children = append(children, child)
		if child.Status == "starting" || child.Status == "booting" || child.Status == "warming" {
			pending = true
			continue
		}
		if !child.Ready || child.Status != "running" {
			invalid = true
			continue
		}
	}
	if len(children) == len(reservation.childIDs) && !validManagedForkBatch(reservation.sourceID, children) {
		invalid = true
	}
	if invalid || len(children) != len(reservation.childIDs) {
		cleanupDone := make(chan struct{})
		reservation.cleanupDone = cleanupDone
		cleanupCheckpoint := mgr.captureForkCleanupLocked(reservation.childIDs)
		removed := mgr.removeForkChildrenLocked(reservation.childIDs, "managed_fork_incomplete_replay_cleanup")
		reservation.state = "failed"
		reservation.err = ErrForkBatchCleaned
		persistErr := mgr.persistRequiredLocked()
		if persistErr != nil {
			mgr.restoreForkCleanupLocked(cleanupCheckpoint)
			removed = nil
		}
		mgr.mu.Unlock()
		mgr.teardownForkChildren(removed)
		mgr.mu.Lock()
		close(cleanupDone)
		reservation.cleanupDone = nil
		mgr.mu.Unlock()
		if persistErr != nil {
			logManagedHostEvent(managedHostEventForkReplayCleanupPersistFailed, managedHostLogFields{Err: persistErr})
		}
		return nil, ErrForkBatchCleaned
	}
	if pending {
		mgr.mu.Unlock()
		return nil, ErrForkResultPending
	}
	mgr.mu.Unlock()
	return children, nil
}

func validManagedForkBatch(sourceID string, children []*Machine) bool {
	if len(children) == 0 {
		return false
	}
	publicIDs := make(map[string]struct{}, len(children))
	leases := make(map[string]struct{}, len(children))
	reservedIPs := make(map[string]struct{}, len(children))
	operationID := ""
	parentPublicID := ""
	template := children[0].Template
	vcpus, memoryMB, diskMB := children[0].VCPUs, children[0].MemoryMB, children[0].DiskMB
	for _, child := range children {
		if child == nil || child.pooled || child.ParentID != sourceID || child.LeaseID == "" || child.driver == nil ||
			child.Template != template || child.VCPUs != vcpus || child.MemoryMB != memoryMB || child.DiskMB != diskMB {
			return false
		}
		publicID := child.Metadata["public_machine_id"]
		parentID := child.Metadata["parent_machine_id"]
		childOperationID := child.Metadata["fork_operation_id"]
		if publicID == "" || parentID == "" || childOperationID == "" {
			return false
		}
		if operationID == "" {
			operationID = childOperationID
			parentPublicID = parentID
		} else if operationID != childOperationID || parentPublicID != parentID {
			return false
		}
		if _, duplicate := publicIDs[publicID]; duplicate {
			return false
		}
		if _, duplicate := leases[child.LeaseID]; duplicate {
			return false
		}
		publicIDs[publicID] = struct{}{}
		leases[child.LeaseID] = struct{}{}
		if child.reservedIP != "" {
			if _, duplicate := reservedIPs[child.reservedIP]; duplicate {
				return false
			}
			reservedIPs[child.reservedIP] = struct{}{}
		}
	}
	return true
}

type forkCleanupMachineState struct {
	machine  *Machine
	status   string
	metering machineMeteringState
}

type forkCleanupCheckpoint struct {
	machines         map[string]forkCleanupMachineState
	outboxLength     int
	transitionLength int
	nextTransition   uint64
}

func (mgr *Manager) captureForkCleanupLocked(childIDs []string) forkCleanupCheckpoint {
	checkpoint := forkCleanupCheckpoint{
		machines:         make(map[string]forkCleanupMachineState, len(childIDs)),
		outboxLength:     len(mgr.meteringOutbox),
		transitionLength: len(mgr.transitions),
		nextTransition:   mgr.nextTransition,
	}
	for _, id := range childIDs {
		if machine := mgr.machines[id]; machine != nil {
			checkpoint.machines[id] = forkCleanupMachineState{
				machine: machine, status: machine.Status, metering: machine.Metering,
			}
		}
	}
	return checkpoint
}

// restoreForkCleanupLocked is used only when the durable cleanup commit fails.
// The VMMs were deliberately left alive, so restoring their registry and meter
// high-waters prevents an undurable final from reaching the control plane.
func (mgr *Manager) restoreForkCleanupLocked(checkpoint forkCleanupCheckpoint) {
	for id, prior := range checkpoint.machines {
		prior.machine.Status = prior.status
		prior.machine.Metering = prior.metering
		mgr.machines[id] = prior.machine
	}
	if len(mgr.meteringOutbox) >= checkpoint.outboxLength {
		mgr.meteringOutbox = mgr.meteringOutbox[:checkpoint.outboxLength]
	}
	if len(mgr.transitions) >= checkpoint.transitionLength {
		mgr.transitions = mgr.transitions[:checkpoint.transitionLength]
	}
	mgr.nextTransition = checkpoint.nextTransition
}

// removeForkChildrenLocked atomically removes every surviving child from the
// host registry. The caller must durably commit the operation decision before
// invoking teardownForkChildren outside mgr.mu.
func (mgr *Manager) removeForkChildrenLocked(childIDs []string, reason string) []*Machine {
	terminalNeeded := 0
	seenLive := make(map[string]struct{}, len(childIDs))
	for _, id := range childIDs {
		if _, duplicate := seenLive[id]; duplicate {
			continue
		}
		seenLive[id] = struct{}{}
		if child := mgr.machines[id]; child != nil && child.Metering.Sequence > 0 && !child.Metering.Final {
			terminalNeeded++
		}
	}
	if len(mgr.meteringOutbox)+terminalNeeded > maxMeteringOutbox {
		mgr.meteringHealthy = false
		logManagedHostEvent(managedHostEventForkMeteringCapacityReached, managedHostLogFields{Count: int64(terminalNeeded), Limit: int64(maxMeteringOutbox)})
		return nil
	}
	removed := make([]*Machine, 0, len(childIDs))
	seen := make(map[string]struct{}, len(childIDs))
	for _, id := range childIDs {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		child := mgr.machines[id]
		if child == nil {
			continue
		}
		if err := mgr.sampleMachineMeteringLocked(child, true); err != nil {
			mgr.meteringHealthy = false
			logManagedHostEvent(managedHostEventForkMeteringFinalizeFailed, managedHostLogFields{MachineID: id, Err: err})
			continue
		}
		delete(mgr.machines, id)
		mgr.removePooledLocked(id)
		mgr.transitionLocked(child, child.Status, "failed", reason)
		removed = append(removed, child)
	}
	return removed
}

func (mgr *Manager) teardownForkChildren(children []*Machine) {
	for _, child := range children {
		mgr.teardown(child)
	}
}

func (mgr *Manager) runManagedFork(source *Machine, sourceDriver *fcDriver, children []*Machine) error {
	source.snapshotMu.Lock()
	mgr.mu.Lock()
	sourceCurrent := mgr.machines[source.ID] == source && source.driver == sourceDriver && source.Ready && source.Status == "running"
	mgr.mu.Unlock()
	if !sourceCurrent {
		source.snapshotMu.Unlock()
		mgr.rollbackForkChildren(children)
		return ErrForkSourceNotReady
	}
	snapDir, err := mgr.createSnapshot(sourceDriver, children[0].ID)
	source.snapshotMu.Unlock()
	if err != nil {
		mgr.rollbackForkChildren(children)
		logManagedHostEvent(managedHostEventSnapshotCreateFailed, managedHostLogFields{MachineID: source.ID, Err: err})
		return ErrSnapshotUnavailable
	}
	defer os.RemoveAll(snapDir)

	tpl := mgr.cfg.Template(source.Template)
	tpl.VCPUs = source.VCPUs
	tpl.MemSizeMB = source.MemoryMB
	sourceHadNIC := sourceDriver.tap != ""
	for i, child := range children {
		driver, mode, bootMS, bootErr := mgr.boot(mgr.configForMachine(child), child.ID, tpl, snapDir, sourceHadNIC, sourceHadNIC && mgr.cfg.NetEnable, child.DiskMB)
		if bootErr != nil {
			mgr.rollbackForkChildren(children)
			logManagedHostEvent(managedHostEventMachineRestoreFailed, managedHostLogFields{
				MachineID: child.ID, SourceMachineID: source.ID, Err: bootErr,
				Attempt: int64(i + 1), Total: int64(len(children)),
			})
			return ErrForkBatchFailed
		}
		if !mgr.cfg.JailerEnable {
			if placeErr := mgr.cgroups.Place(driver.PID(), child.ID, tpl, driver.overlay); placeErr != nil {
				if mgr.cfg.NehemiahMode {
					driver.Close()
					mgr.rollbackForkChildren(children)
					logManagedHostEvent(managedHostEventCgroupPlaceFailed, managedHostLogFields{MachineID: child.ID, SourceMachineID: source.ID, Err: placeErr})
					return ErrForkBatchFailed
				}
				log.Printf("machine %s: cgroup limits unavailable: %v", child.ID, placeErr)
			}
		}
		if addressErr := mgr.readdressManagedFork(child.ID, driver, sourceHadNIC, child.reservedIP); addressErr != nil {
			driver.Close()
			mgr.rollbackForkChildren(children)
			logManagedHostEvent(managedHostEventNetworkReaddressFailed, managedHostLogFields{
				MachineID: child.ID, SourceMachineID: source.ID, Err: addressErr,
				Attempt: int64(i + 1), Total: int64(len(children)),
			})
			return ErrForkBatchFailed
		}
		if sourceHadNIC {
			if policyErr := mgr.secureManagedGuestNetwork(child.ID, driver, child.NetworkPolicy); policyErr != nil {
				driver.Close()
				mgr.rollbackForkChildren(children)
				logManagedHostEvent(managedHostEventEgressPolicyFailed, managedHostLogFields{
					MachineID: child.ID, SourceMachineID: source.ID, Err: policyErr,
					Attempt: int64(i + 1), Total: int64(len(children)),
				})
				return ErrForkBatchFailed
			}
		}
		mgr.mu.Lock()
		current := mgr.machines[child.ID]
		child.networkProvisioning = false
		if current != child || (mgr.cfg.NehemiahMode && !mgr.managedAdmissionHealthyLocked()) {
			mgr.mu.Unlock()
			if sourceHadNIC {
				mgr.egress.remove(child.ID, driver.tap)
			}
			driver.Close()
			mgr.rollbackForkChildren(children)
			return ErrForkBatchFailed
		}
		child.driver = driver
		child.Mode = mode
		child.BootMS = bootMS
		child.StartedAt = driver.startedAt
		if child.StartedAt.IsZero() {
			child.StartedAt = time.Now().UTC()
		}
		child.Status = "starting"
		childID := child.ID
		child.timer = time.AfterFunc(time.Until(child.ExpiresAt), func() { mgr.reap(childID) })
		mgr.transitionLocked(child, "booting", "starting", "managed_fork_vmm_started")
		if meterErr := mgr.recordMeterStartLocked(child); meterErr != nil {
			mgr.mu.Unlock()
			mgr.rollbackForkChildren(children)
			return ErrForkBatchFailed
		}
		if persistErr := mgr.persistRequiredLocked(); persistErr != nil {
			mgr.mu.Unlock()
			mgr.rollbackForkChildren(children)
			return ErrForkBatchFailed
		}
		mgr.mu.Unlock()
		if tpl.Display {
			mgr.repaintRestoredDisplay(child.ID, driver)
		}
	}

	ready := make(chan bool, len(children))
	for _, child := range children {
		go func(id string) { ready <- mgr.awaitReady(id, mgr.forkReadyTimeout) }(child.ID)
	}
	for range children {
		if !<-ready {
			mgr.rollbackForkChildren(children)
			return ErrForkBatchFailed
		}
	}
	mgr.mu.Lock()
	allReady := true
	for _, child := range children {
		current := mgr.machines[child.ID]
		if current != child || !child.Ready || child.Status != "running" {
			allReady = false
			break
		}
	}
	mgr.mu.Unlock()
	if !allReady {
		mgr.rollbackForkChildren(children)
		return ErrForkBatchFailed
	}
	return nil
}

func (mgr *Manager) rollbackForkChildren(children []*Machine) {
	ids := make([]string, 0, len(children))
	for _, child := range children {
		ids = append(ids, child.ID)
	}
	mgr.mu.Lock()
	cleanupCheckpoint := mgr.captureForkCleanupLocked(ids)
	removed := mgr.removeForkChildrenLocked(ids, "managed_fork_rollback")
	persistErr := mgr.persistRequiredLocked()
	if persistErr != nil {
		mgr.restoreForkCleanupLocked(cleanupCheckpoint)
		removed = nil
	}
	mgr.mu.Unlock()
	mgr.teardownForkChildren(removed)
	if persistErr != nil {
		logManagedHostEvent(managedHostEventForkRollbackPersistFailed, managedHostLogFields{Err: persistErr})
	}
}

// readdressFork gives a snapshot-restored machine that resumed on its source's
// MAC/IP a fresh identity while its tap is still off the bridge, then attaches
// it — so it joins the network cleanly and never collides with the source. It
// also repaints a restored desktop (xrefresh for classic X apps; chromium needs
// a real Ctrl-R). Used by Branch (forks) and Create (published templates whose
// snapshot carried a NIC). reserveIP, when non-empty, is a pre-allocated fork
// IP (fleet forks allocate their batch up front); otherwise one is allocated.
func (mgr *Manager) prepareForkReaddress(id string, drv *fcDriver, hadNIC bool, reserveIP string, required bool) (string, error) {
	var reip string
	if hadNIC && mgr.cfg.NetEnable {
		forkIP := reserveIP
		if forkIP == "" {
			forkIP = mgr.reserveForkIP(id)
		}
		if forkIP != "" {
			drv.ip = forkIP
			reip = fmt.Sprintf("ip link set eth0 down; ip link set eth0 address %s; ip link set eth0 up; ip addr flush dev eth0; ip addr add %s/24 dev eth0; ip route replace default via %s.1; printf 'nameserver %s.1\\n' > /etc/resolv.conf\n",
				guestMAC(id), forkIP, mgr.cfg.NetSubnet, mgr.cfg.NetSubnet)
		} else if required {
			return "", fmt.Errorf("no guest address is available for restored network")
		}
	}
	return reip, nil
}

func (mgr *Manager) applyForkReaddress(id string, drv *fcDriver, reip string) error {
	if reip == "" {
		return nil
	}
	if drv.console == nil || drv.tap == "" {
		return fmt.Errorf("restored network has no console or tap")
	}
	time.Sleep(700 * time.Millisecond)
	written, err := drv.console.Write([]byte(reip))
	if err != nil {
		return fmt.Errorf("write restored guest network identity: wrote %d/%d: %w", written, len(reip), err)
	}
	if written != len(reip) {
		return fmt.Errorf("write restored guest network identity: wrote %d/%d", written, len(reip))
	}
	time.Sleep(600 * time.Millisecond)
	if err := mgr.attachRestoredTap(drv.tap, mgr.cfg.NetBridge, guestMAC(id), mgr.cfg.NehemiahMode); err != nil {
		return err
	}
	if mgr.cfg.NehemiahMode {
		if err := mgr.pinRestoredNeighbor(drv.tap, mgr.cfg.NetBridge, mgr.cfg.NetSubnet, drv.ip, guestMAC(id)); err != nil {
			return err
		}
		drv.identityPinned = true
	}
	return nil
}

// readdressManagedFork is synchronous: an all-or-nothing managed fork batch
// cannot become ready until its restored NIC is isolated, MAC-locked and pinned
// to the child's address on the host.
func (mgr *Manager) readdressManagedFork(id string, drv *fcDriver, hadNIC bool, reserveIP string) error {
	reip, err := mgr.prepareForkReaddress(id, drv, hadNIC, reserveIP, hadNIC && mgr.cfg.NetEnable)
	if err != nil {
		return err
	}
	if reip == "" {
		return nil
	}
	if drv == nil || drv.tap == "" {
		return fmt.Errorf("restored managed network has no isolated tap")
	}

	mgr.mu.Lock()
	machine := mgr.machines[id]
	leaseID := ""
	if machine != nil {
		leaseID = machine.LeaseID
	}
	mgr.mu.Unlock()
	if leaseID == "" {
		return fmt.Errorf("%w: managed network identity has no current lease", ErrInvalidLease)
	}

	ctx, cancel := context.WithTimeout(context.Background(), mgr.managedReaddressTimeout)
	defer cancel()
	client := newManagedDriverGuestAgentClient(mgr, id, leaseID, drv)
	var lastErr error
	for {
		result, execErr := client.Exec(ctx, id, guestExecRequest{
			Command:   strings.TrimSpace(reip),
			Timeout:   5 * time.Second,
			MaxOutput: 4 << 10,
		})
		if execErr == nil {
			if result.TimedOut {
				return fmt.Errorf("guest network identity command timed out")
			}
			if result.ExitCode != 0 {
				return fmt.Errorf("guest network identity command exited %d", result.ExitCode)
			}
			break
		}
		if errors.Is(execErr, ErrInvalidLease) {
			return execErr
		}
		var remoteErr *guestAgentRemoteError
		if errors.As(execErr, &remoteErr) {
			return fmt.Errorf("guest network identity was rejected: %w", execErr)
		}
		lastErr = execErr
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("guest network identity unavailable: %w", lastErr)
		case <-timer.C:
		}
	}
	if err := mgr.attachRestoredTap(drv.tap, mgr.cfg.NetBridge, guestMAC(id), true); err != nil {
		return err
	}
	if err := mgr.pinRestoredNeighbor(drv.tap, mgr.cfg.NetBridge, mgr.cfg.NetSubnet, drv.ip, guestMAC(id)); err != nil {
		return err
	}
	drv.identityPinned = true
	return nil
}

func (mgr *Manager) repaintRestoredDisplay(id string, drv *fcDriver) {
	if drv.console == nil {
		return
	}
	go func() {
		_, _ = drv.console.Write([]byte("DISPLAY=:0 xrefresh 2>/dev/null\n"))
		time.Sleep(400 * time.Millisecond)
		if guest, err := mgr.DialVsock(id, VsockPort); err == nil {
			defer guest.Close()
			if cli, err := newRFBClient(guest); err == nil {
				cli.Click(1, 450, 83) // focus chromium
				time.Sleep(150 * time.Millisecond)
				cli.keyEvent(true, 0xffe3) // Ctrl down
				cli.keyEvent(true, 0x72)   // r
				cli.keyEvent(false, 0x72)
				cli.keyEvent(false, 0xffe3) // Ctrl up
				cli.MoveMouse(455, 305)
			}
		}
	}()
}

// readdressFork preserves the legacy/local asynchronous behavior. Managed
// fleet forks use readdressManagedFork above so the batch can fail atomically.
func (mgr *Manager) readdressFork(id string, drv *fcDriver, tpl Template, hadNIC bool, reserveIP string) {
	reip, err := mgr.prepareForkReaddress(id, drv, hadNIC, reserveIP, false)
	if err != nil {
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventNetworkReaddressFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("machine %s: prepare restored network: %v", id, err)
		}
		return
	}
	if reip == "" && !tpl.Display {
		return
	}
	go func() {
		if err := mgr.applyForkReaddress(id, drv, reip); err != nil {
			if mgr.cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventNetworkReaddressFailed, managedHostLogFields{MachineID: id, Err: err})
			} else {
				log.Printf("machine %s: attach restored tap: %v", id, err)
			}
			return
		}
		if tpl.Display {
			mgr.repaintRestoredDisplay(id, drv)
		}
	}()
}

// Destroy tears down a machine by id, returning false if it does not exist.
func (mgr *Manager) Destroy(id string) bool {
	destroyed, err := mgr.destroy(id, mgr.cfg.NehemiahMode)
	if err != nil {
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventMachineDestroyDeferred, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("machine %s destroy deferred: %v", id, err)
		}
	}
	return destroyed
}

func (mgr *Manager) DestroyInternal(id string) (bool, error) {
	return mgr.destroy(id, true)
}

func (mgr *Manager) destroy(id string, durable bool) (bool, error) {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok {
		mgr.mu.Unlock()
		return false, nil
	}
	from := m.Status
	priorMetering := m.Metering
	priorOutbox := len(mgr.meteringOutbox)
	m.Status = "stopping"
	mgr.transitionLocked(m, from, "stopping", "delete_requested")
	if err := mgr.sampleMachineMeteringLocked(m, true); err != nil {
		m.Status = from
		m.Metering = priorMetering
		mgr.meteringOutbox = mgr.meteringOutbox[:priorOutbox]
		mgr.mu.Unlock()
		return false, fmt.Errorf("persist final metering observation: %w", err)
	}
	delete(mgr.machines, id)
	mgr.transitionLocked(m, "stopping", "stopped", "deleted")
	if durable && m.Metering.Sequence > 0 {
		if err := mgr.persistRequiredLocked(); err != nil {
			mgr.machines[id] = m
			m.Status = from
			m.Metering = priorMetering
			mgr.meteringOutbox = mgr.meteringOutbox[:priorOutbox]
			mgr.mu.Unlock()
			return false, fmt.Errorf("persist machine stop: %w", err)
		}
	} else {
		mgr.persistLocked()
	}
	mgr.mu.Unlock()

	mgr.teardown(m)
	if mgr.cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventMachineDestroyed, managedHostLogFields{MachineID: id})
	} else {
		log.Printf("machine %s destroyed", id)
	}
	return true, nil
}

// reap is invoked by the TTL timer.
func (mgr *Manager) reap(id string) {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok {
		mgr.mu.Unlock()
		return
	}
	from := m.Status
	priorMetering := m.Metering
	priorOutbox := len(mgr.meteringOutbox)
	if err := mgr.sampleMachineMeteringLocked(m, true); err != nil {
		m.Metering = priorMetering
		mgr.meteringOutbox = mgr.meteringOutbox[:priorOutbox]
		m.timer = time.AfterFunc(5*time.Second, func() { mgr.reap(id) })
		mgr.mu.Unlock()
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventMachineExpiryMeteringFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("machine %s expiry metering deferred: %v", id, err)
		}
		return
	}
	delete(mgr.machines, id)
	mgr.removePooledLocked(id)
	mgr.transitionLocked(m, from, "stopped", "ttl_expired")
	if mgr.cfg.NehemiahMode {
		if err := mgr.persistRequiredLocked(); err != nil {
			mgr.machines[id] = m
			m.Metering = priorMetering
			mgr.meteringOutbox = mgr.meteringOutbox[:priorOutbox]
			m.timer = time.AfterFunc(5*time.Second, func() { mgr.reap(id) })
			mgr.mu.Unlock()
			if mgr.cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventMachineExpiryPersistFailed, managedHostLogFields{MachineID: id, Err: err})
			} else {
				log.Printf("machine %s expiry persistence deferred: %v", id, err)
			}
			return
		}
	} else {
		mgr.persistLocked()
	}
	mgr.mu.Unlock()

	mgr.teardown(m)
	if mgr.cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventMachineExpired, managedHostLogFields{MachineID: id})
	} else {
		log.Printf("machine %s expired (ttl)", id)
	}
}

// removePooledLocked drops a machine from the warm pool (caller holds mu).
func (mgr *Manager) removePooledLocked(id string) {
	for i, p := range mgr.pool {
		if p.ID == id {
			mgr.pool = append(mgr.pool[:i], mgr.pool[i+1:]...)
			return
		}
	}
}

// rollback removes a reserved slot and is used when boot/branch fails.
func (mgr *Manager) rollback(id string) {
	mgr.mu.Lock()
	m := mgr.machines[id]
	delete(mgr.machines, id)
	if m != nil {
		mgr.transitionLocked(m, m.Status, "failed", "rollback")
	}
	mgr.persistLocked()
	mgr.mu.Unlock()
	if m != nil {
		mgr.teardown(m)
	}
}

// teardown stops timers and kills the driver. Safe to call with a partially
// constructed machine.
func (mgr *Manager) teardown(m *Machine) {
	if m == nil {
		return
	}
	if m.timer != nil {
		m.timer.Stop()
	}
	if m.driver != nil {
		m.snapshotMu.Lock()
		if mgr.cfg.NehemiahMode && m.driver.tap != "" {
			mgr.egress.remove(m.ID, m.driver.tap)
		}
		m.driver.Close()
		m.snapshotMu.Unlock()
	}
	mgr.cgroups.Remove(m.ID)
	if m.creatorIP != "" {
		mgr.limiter.Release(m.creatorIP)
	}
	if err := mgr.releaseJailerIdentityAfterTeardown(m.ID, m.jailerIdentity); err != nil {
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventJailerIdentityReleaseFailed, managedHostLogFields{MachineID: m.ID, Err: err})
		} else {
			log.Printf("machine %s jailer identity remains reserved: %v", m.ID, err)
		}
	}
}

// StartReaper starts a background sweep as a safety net for any timers that were
// missed (the per-machine AfterFunc is the primary mechanism).
func (mgr *Manager) StartReaper() {
	mgr.refillPool() // start warming the pool immediately
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-mgr.stopCh:
				return
			case <-t.C:
				mgr.refillPool() // keep the pool topped up (recovers from failures)
				now := time.Now()
				var expired []string
				mgr.mu.Lock()
				for id, m := range mgr.machines {
					// Persistent machines have no TTL — the periodic sweep must skip
					// them (they still carry an ExpiresAt, but no reaper honors it).
					if !m.Persistent && now.After(m.ExpiresAt) {
						expired = append(expired, id)
					}
				}
				mgr.mu.Unlock()
				for _, id := range expired {
					mgr.reap(id)
				}
			}
		}
	}()
}

// Shutdown stops the reaper and tears down all live machines.
func (mgr *Manager) Shutdown() {
	mgr.stopOnce.Do(func() { close(mgr.stopCh) })
	mgr.mu.Lock()
	all := make([]*Machine, 0, len(mgr.machines))
	for id, m := range mgr.machines {
		all = append(all, m)
		delete(mgr.machines, id)
		mgr.transitionLocked(m, m.Status, "stopped", "daemon_shutdown")
	}
	mgr.persistLocked()
	mgr.mu.Unlock()
	for _, m := range all {
		mgr.teardown(m)
	}
}

// ShutdownPreserve stops daemon-owned timers and I/O without terminating the
// Firecracker processes or deleting their sockets/overlays. Nehemiah service
// restarts use this path; startup reconciliation proves each persisted runtime
// before adopting it. Fleet draining remains an explicit control-plane action.
func (mgr *Manager) ShutdownPreserve() {
	mgr.stopOnce.Do(func() { close(mgr.stopCh) })
	if err := mgr.checkpointMetering(); err != nil {
		logManagedHostEvent(managedHostEventMeteringCheckpointFailed, managedHostLogFields{Err: err})
	}
	mgr.mu.Lock()
	all := make([]*Machine, 0, len(mgr.machines))
	for _, machine := range mgr.machines {
		if machine.timer != nil {
			machine.timer.Stop()
			machine.timer = nil
		}
		all = append(all, machine)
	}
	mgr.persistLocked()
	mgr.mu.Unlock()
	for _, machine := range all {
		if machine.driver != nil {
			machine.driver.Detach()
		}
	}
}

// newID returns a fresh "m-<8 hex>" id. Caller must hold mgr.mu.
func (mgr *Manager) newID() string {
	for {
		var b [4]byte
		_, _ = rand.Read(b[:])
		id := "m-" + hex.EncodeToString(b[:])
		if _, exists := mgr.machines[id]; exists {
			continue
		}
		// A failed teardown deliberately leaves its identity reservation behind.
		// Never let a random machine-id collision attach new work to that held
		// reservation; it can be reused only after verified teardown removes it.
		if _, held := mgr.jailerIdentities[id]; !held {
			return id
		}
	}
}

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func managedIdentityTestManager(t *testing.T) *Manager {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.JailerEnable = true
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	mgr := NewManager(cfg)
	mgr.cgroups = &Cgroups{cfg: cfg, base: t.TempDir(), enabled: true}
	mgr.identityAvailable = func(int, int) error { return nil }
	mgr.identityProcesses = managedJailerProcessOps{
		listPIDs:      func() ([]int, error) { return nil, nil },
		credentials:   func(int) (managedProcessCredentials, error) { return managedProcessCredentials{}, nil },
		processExists: func(int) (bool, error) { return false, nil },
	}
	mgr.verifyIdentityTeardown = func(Config, string, jailerIdentity) error { return nil }
	mgr.capacityProbe = staticHostProbe{hostResources{
		Architecture: "x86_64", KVM: true, Jailer: true, TotalCPU: 64,
		TotalMemoryMB: 64 * 1024, AvailableMemoryMB: 64 * 1024,
		TotalDiskBytes: 1 << 40, AvailableDiskBytes: 1 << 40,
	}}
	mgr.readyProbe = func(context.Context, string) error { return nil }
	return mgr
}

func TestManagedCreatesUseDistinctDurableJailerIdentities(t *testing.T) {
	mgr := managedIdentityTestManager(t)
	expectation := managedRuntimeExpectation{
		CohortID: mgr.cfg.RuntimeCohort.ID, RootfsSHA256: mgr.cfg.RuntimeCohort.PythonRootfsSHA256,
	}
	var bootMu sync.Mutex
	bootIdentities := make(map[string]jailerIdentity)
	bootFiles := make(map[string]string)
	bootDir := t.TempDir()
	mgr.boot = func(cfg Config, id string, template Template, _ string, _ bool, network bool, _ int) (*fcDriver, string, int64, error) {
		overlay := filepath.Join(bootDir, id+"-uid-"+strconv.Itoa(cfg.JailerUID)+".ext4")
		if err := os.WriteFile(overlay, []byte(id), 0o600); err != nil {
			return nil, "", 0, err
		}
		bootMu.Lock()
		bootIdentities[id] = jailerIdentity{UID: cfg.JailerUID, GID: cfg.JailerGID}
		bootFiles[id] = overlay
		bootMu.Unlock()
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, network: network, overlay: overlay, apiClt: harmlessFirecrackerClient()}, "coldboot", 1, nil
	}
	type result struct {
		machine *Machine
		err     error
	}
	results := make(chan result, 2)
	for index := 0; index < 2; index++ {
		index := index
		go func() {
			machine, _, err := mgr.CreateInternalWithRuntimeExpectation(
				"python", 120, false, false, "internal", "identity-create-"+string(rune('a'+index)), "identity-lease-"+string(rune('a'+index)), 1,
				nil, 0, 0, 0, networkPolicyDeclaration{}, expectation,
			)
			results <- result{machine: machine, err: err}
		}()
	}
	created := make([]*Machine, 0, 2)
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("managed create: %v", result.err)
		}
		created = append(created, result.machine)
	}
	identities := []jailerIdentity{created[0].jailerIdentity, created[1].jailerIdentity}
	sort.Slice(identities, func(i, j int) bool { return identities[i].UID < identities[j].UID })
	if !jailerIdentityMatchesSlot(identities[0], 30000, 30000) || !jailerIdentityMatchesSlot(identities[1], 30001, 30001) {
		t.Fatalf("identities=%+v, want distinct paired slots", identities)
	}
	if identities[0].ReservationID == identities[1].ReservationID {
		t.Fatal("concurrent machines received the same reservation identity")
	}
	for _, machine := range created {
		if got := bootIdentities[machine.ID]; got.UID != machine.jailerIdentity.UID || got.GID != machine.jailerIdentity.GID {
			t.Fatalf("machine %s boot identity=%+v durable=%+v", machine.ID, got, machine.jailerIdentity)
		}
		if file := bootFiles[machine.ID]; file == "" || !strings.Contains(filepath.Base(file), "uid-"+strconv.Itoa(machine.jailerIdentity.UID)+".ext4") {
			t.Fatalf("machine %s file %q is not bound to jailer uid %d", machine.ID, file, machine.jailerIdentity.UID)
		}
	}
	if bootFiles[created[0].ID] == bootFiles[created[1].ID] {
		t.Fatal("concurrent managed VMs shared one runtime file")
	}
	snapshot, err := mgr.stateStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.JailerIdentities) != 2 {
		t.Fatalf("durable identity count=%d want=2", len(snapshot.JailerIdentities))
	}
	for _, machine := range created {
		if _, err := mgr.DestroyInternal(machine.ID); err != nil {
			t.Fatalf("destroy %s: %v", machine.ID, err)
		}
	}
	if len(mgr.jailerIdentities) != 0 {
		t.Fatalf("identity reservations remain after verified teardown: %+v", mgr.jailerIdentities)
	}
}

func TestManagedJailerIdentitySkipsNSSCollisionsAndExhaustsClosed(t *testing.T) {
	mgr := managedIdentityTestManager(t)
	mgr.cfg.MaxMachines = 3
	mgr.identityAvailable = func(uid, gid int) error {
		if uid == 30000 || gid == 30000 {
			return errJailerIdentityCollision
		}
		return nil
	}
	mgr.mu.Lock()
	first, err := mgr.reserveJailerIdentityLocked("m-01020304")
	second, secondErr := mgr.reserveJailerIdentityLocked("m-01020305")
	mgr.mu.Unlock()
	if err != nil || secondErr != nil {
		t.Fatalf("reserve identities: %v / %v", err, secondErr)
	}
	if !jailerIdentityMatchesSlot(first, 30001, 30001) || !jailerIdentityMatchesSlot(second, 30002, 30002) {
		t.Fatalf("collision allocations=%+v/%+v", first, second)
	}
	mgr.mu.Lock()
	_, exhaustedErr := mgr.reserveJailerIdentityLocked("m-01020306")
	mgr.mu.Unlock()
	if !errors.Is(exhaustedErr, ErrHostUnhealthy) {
		t.Fatalf("exhaustion error=%v want ErrHostUnhealthy", exhaustedErr)
	}
}

func TestManagedJailerIdentitySkipsLiveNumericCredentialHolders(t *testing.T) {
	mgr := managedIdentityTestManager(t)
	mgr.cfg.MaxMachines = 3
	mgr.identityProcesses = managedJailerProcessOps{
		listPIDs: func() ([]int, error) { return []int{42}, nil },
		credentials: func(int) (managedProcessCredentials, error) {
			return managedProcessCredentials{
				uids:              [4]int{1000, 1000, 30000, 1000},
				gids:              [4]int{1000, 1000, 1000, 1000},
				supplementaryGIDs: []int{30001},
			}, nil
		},
		processExists: func(int) (bool, error) { return true, nil },
	}
	mgr.mu.Lock()
	identity, err := mgr.reserveJailerIdentityLocked("m-01020304")
	mgr.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if !jailerIdentityMatchesSlot(identity, 30002, 30002) {
		t.Fatalf("live uid/supplementary-gid collision allocation=%+v, want slot 30002", identity)
	}
	mgr.identityProcesses.credentials = func(int) (managedProcessCredentials, error) {
		return managedProcessCredentials{}, syscall.EIO
	}
	mgr.mu.Lock()
	_, err = mgr.reserveJailerIdentityLocked("m-01020305")
	mgr.mu.Unlock()
	if !errors.Is(err, syscall.EIO) {
		t.Fatalf("unreadable live credential inventory error=%v, want EIO", err)
	}
}

func TestManagedJailerIdentityReleaseIsVerifiedBeforeReuse(t *testing.T) {
	mgr := managedIdentityTestManager(t)
	machineID := "m-01020304"
	mgr.mu.Lock()
	identity, err := mgr.reserveJailerIdentityLocked(machineID)
	if err == nil {
		err = mgr.persistRequiredLocked()
	}
	mgr.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	mgr.verifyIdentityTeardown = func(Config, string, jailerIdentity) error { return errors.New("scope still active") }
	if err := mgr.releaseJailerIdentityAfterTeardown(machineID, identity); err == nil {
		t.Fatal("unverified identity release succeeded")
	}
	if mgr.jailerIdentities[machineID] != identity || mgr.identityHealthy {
		t.Fatalf("held=%+v healthy=%t, want reservation held and unhealthy", mgr.jailerIdentities, mgr.identityHealthy)
	}
	mgr.mu.Lock()
	next, nextErr := mgr.reserveJailerIdentityLocked("m-01020305")
	mgr.mu.Unlock()
	if nextErr != nil || next.UID == identity.UID || next.GID == identity.GID {
		t.Fatalf("identity reused before verified teardown: next=%+v err=%v", next, nextErr)
	}
	mgr.verifyIdentityTeardown = func(Config, string, jailerIdentity) error { return nil }
	if err := mgr.releaseJailerIdentityAfterTeardown(machineID, identity); err != nil {
		t.Fatal(err)
	}
	mgr.mu.Lock()
	reused, reuseErr := mgr.reserveJailerIdentityLocked("m-01020306")
	mgr.mu.Unlock()
	if reuseErr != nil || reused.UID != identity.UID || reused.GID != identity.GID || reused.ReservationID == identity.ReservationID {
		t.Fatalf("verified slot reuse=%+v err=%v want numeric slot=%d:%d with a fresh reservation", reused, reuseErr, identity.UID, identity.GID)
	}
}

func TestManagedJailerIdentityReleaseRejectsABAReservation(t *testing.T) {
	mgr := managedIdentityTestManager(t)
	machineID := "m-01020304"
	mgr.mu.Lock()
	first, err := mgr.reserveJailerIdentityLocked(machineID)
	if err == nil {
		delete(mgr.jailerIdentities, machineID)
	}
	second, secondErr := mgr.reserveJailerIdentityLocked(machineID)
	mgr.mu.Unlock()
	if err != nil || secondErr != nil {
		t.Fatalf("reserve ABA identities: %v / %v", err, secondErr)
	}
	if first.UID != second.UID || first.GID != second.GID || first.ReservationID == second.ReservationID {
		t.Fatalf("unexpected ABA setup first=%+v second=%+v", first, second)
	}
	if err := mgr.releaseJailerIdentityAfterTeardown(machineID, first); err == nil {
		t.Fatal("stale teardown released a replacement reservation")
	}
	if got := mgr.jailerIdentities[machineID]; got != second {
		t.Fatalf("replacement reservation changed: got=%+v want=%+v", got, second)
	}
}

func jailerIdentityMatchesSlot(identity jailerIdentity, uid, gid int) bool {
	return identity.UID == uid && identity.GID == gid && validJailerIdentityReservationID(identity.ReservationID)
}

func TestJailerIdentityProcessScanFailsClosedOnUnreadableStatus(t *testing.T) {
	identity := jailerIdentity{UID: 30000, GID: 30000}
	base := managedJailerProcessOps{
		listPIDs:      func() ([]int, error) { return []int{42}, nil },
		credentials:   func(int) (managedProcessCredentials, error) { return managedProcessCredentials{}, syscall.EIO },
		processExists: func(int) (bool, error) { return true, nil },
	}
	if err := scanManagedJailerIdentityProcesses(identity, base); !errors.Is(err, syscall.EIO) {
		t.Fatalf("unreadable status error=%v want EIO", err)
	}
	base.credentials = func(int) (managedProcessCredentials, error) { return managedProcessCredentials{}, os.ErrNotExist }
	if err := scanManagedJailerIdentityProcesses(identity, base); err == nil {
		t.Fatal("missing status for an existing process was ignored")
	}
	base.processExists = func(int) (bool, error) { return false, nil }
	if err := scanManagedJailerIdentityProcesses(identity, base); err != nil {
		t.Fatalf("proven process disappearance rejected: %v", err)
	}
	base.credentials = func(int) (managedProcessCredentials, error) {
		return managedProcessCredentials{
			uids: [4]int{1000, 1000, 30000, 1000}, gids: [4]int{1000, 1000, 1000, 1000},
		}, nil
	}
	if err := scanManagedJailerIdentityProcesses(identity, base); err == nil {
		t.Fatal("live process holding the uid was ignored")
	}
	base.credentials = func(int) (managedProcessCredentials, error) {
		return managedProcessCredentials{
			uids: [4]int{1000, 1000, 1000, 1000}, gids: [4]int{1000, 1000, 1000, 1000},
			supplementaryGIDs: []int{30000},
		}, nil
	}
	if err := scanManagedJailerIdentityProcesses(identity, base); err == nil {
		t.Fatal("live process holding the gid only as a supplementary group was ignored")
	}
}

func TestManagedProcessCredentialParserIsStrictAndBounded(t *testing.T) {
	valid := []byte("Name:\ttest\nUid:\t1000\t1001\t1002\t1003\nGid:\t2000\t2001\t2002\t2003\nGroups:\t3000 3001\n")
	credentials, err := parseManagedProcessCredentials(valid)
	if err != nil {
		t.Fatal(err)
	}
	if credentials.uids != [4]int{1000, 1001, 1002, 1003} ||
		credentials.gids != [4]int{2000, 2001, 2002, 2003} ||
		!reflect.DeepEqual(credentials.supplementaryGIDs, []int{3000, 3001}) {
		t.Fatalf("parsed credentials=%+v", credentials)
	}
	for name, contents := range map[string][]byte{
		"missing groups":  []byte("Uid:\t1\t1\t1\t1\nGid:\t1\t1\t1\t1\n"),
		"duplicate uid":   append(append([]byte(nil), valid...), []byte("Uid:\t1\t1\t1\t1\n")...),
		"malformed group": []byte("Uid:\t1\t1\t1\t1\nGid:\t1\t1\t1\t1\nGroups:\tbad\n"),
		"oversized":       make([]byte, maxManagedProcessStatusBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseManagedProcessCredentials(contents); err == nil {
				t.Fatal("malformed process credentials were accepted")
			}
		})
	}
}

func TestRestoredJailerOwnershipRequiresExactProcessAndOverlayIdentity(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.JailerUID = uid
	cfg.JailerGID = gid
	cfg.MaxMachines = 2
	overlay := filepath.Join(t.TempDir(), "overlay.ext4")
	if err := os.WriteFile(overlay, []byte("overlay"), 0o600); err != nil {
		t.Fatal(err)
	}
	machine := persistedMachine{Runtime: &persistedRuntime{PID: os.Getpid(), Overlay: overlay}}
	identity := jailerIdentity{UID: uid, GID: gid, ReservationID: "0123456789abcdef0123456789abcdef"}
	if err := validateRestoredJailerOwnership(cfg, machine, identity); err != nil {
		t.Fatalf("exact restored ownership rejected: %v", err)
	}
	if err := validateRestoredJailerOwnership(cfg, machine, jailerIdentity{UID: uid + 1, GID: gid + 1, ReservationID: "0123456789abcdef0123456789abcdef"}); err == nil {
		t.Fatal("wrong restored process/file ownership was accepted")
	}
}

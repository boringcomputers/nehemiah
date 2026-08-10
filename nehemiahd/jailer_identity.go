package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

var errJailerIdentityCollision = errors.New("managed jailer identity collides with a host account")

type jailerIdentity struct {
	UID           int    `json:"uid"`
	GID           int    `json:"gid"`
	ReservationID string `json:"reservation_id"`
}

type persistedJailerIdentity struct {
	MachineID     string `json:"machine_id"`
	UID           int    `json:"uid"`
	GID           int    `json:"gid"`
	ReservationID string `json:"reservation_id"`
}

type managedJailerProcessOps struct {
	listPIDs      func() ([]int, error)
	credentials   func(int) (managedProcessCredentials, error)
	processExists func(int) (bool, error)
}

type managedProcessCredentials struct {
	uids              [4]int
	gids              [4]int
	supplementaryGIDs []int
}

const (
	maxManagedProcessStatusBytes = 1 << 20
	maxManagedSupplementaryGIDs  = 65536
)

func (mgr *Manager) reserveJailerIdentityLocked(machineID string) (jailerIdentity, error) {
	if !mgr.cfg.NehemiahMode {
		return jailerIdentity{}, nil
	}
	if !validMachineID(machineID) || mgr.cfg.JailerUID <= 0 || mgr.cfg.JailerGID <= 0 {
		return jailerIdentity{}, ErrHostUnhealthy
	}
	if identity, exists := mgr.jailerIdentities[machineID]; exists {
		return identity, nil
	}
	usedUIDs := make(map[int]struct{}, len(mgr.jailerIdentities))
	usedGIDs := make(map[int]struct{}, len(mgr.jailerIdentities))
	for _, identity := range mgr.jailerIdentities {
		usedUIDs[identity.UID] = struct{}{}
		usedGIDs[identity.GID] = struct{}{}
	}
	liveUIDs, liveGIDs, err := managedJailerLiveCredentialInventory(mgr.identityProcesses)
	if err != nil {
		return jailerIdentity{}, fmt.Errorf("inspect live managed jailer credentials: %w", err)
	}
	available := mgr.identityAvailable
	if available == nil {
		available = managedJailerIdentityAvailable
	}
	for slot := 0; slot < mgr.cfg.MaxMachines; slot++ {
		uid := mgr.cfg.JailerUID + slot
		gid := mgr.cfg.JailerGID + slot
		if _, used := usedUIDs[uid]; used {
			continue
		}
		if _, used := usedGIDs[gid]; used {
			continue
		}
		if _, held := liveUIDs[uid]; held {
			continue
		}
		if _, held := liveGIDs[gid]; held {
			continue
		}
		if err := available(uid, gid); err != nil {
			if errors.Is(err, errJailerIdentityCollision) {
				continue
			}
			return jailerIdentity{}, fmt.Errorf("inspect managed jailer identity %d:%d: %w", uid, gid, err)
		}
		reservationID, err := newJailerIdentityReservationID()
		if err != nil {
			return jailerIdentity{}, fmt.Errorf("create managed jailer reservation identity: %w", err)
		}
		identity := jailerIdentity{UID: uid, GID: gid, ReservationID: reservationID}
		mgr.jailerIdentities[machineID] = identity
		return identity, nil
	}
	return jailerIdentity{}, fmt.Errorf("%w: no collision-free managed jailer identity is available", ErrHostUnhealthy)
}

func (mgr *Manager) configForMachine(machine *Machine) Config {
	cfg := mgr.cfg
	if cfg.NehemiahMode && machine != nil {
		cfg.JailerUID = machine.jailerIdentity.UID
		cfg.JailerGID = machine.jailerIdentity.GID
	}
	return cfg
}

func managedJailerIdentityAvailable(uid, gid int) error {
	uidText := strconv.Itoa(uid)
	account, userErr := user.LookupId(uidText)
	if userErr == nil {
		// The base bootstrap account is the only named identity in the pool. All
		// other slots intentionally remain numeric-only so one account cannot be
		// shared by two VMMs.
		if account.Username != "boringjail" || account.Uid != uidText || account.Gid != strconv.Itoa(gid) {
			return fmt.Errorf("%w: uid %d belongs to %q", errJailerIdentityCollision, uid, account.Username)
		}
	} else {
		var unknown user.UnknownUserIdError
		if !errors.As(userErr, &unknown) {
			return userErr
		}
	}
	group, groupErr := user.LookupGroupId(strconv.Itoa(gid))
	if groupErr == nil {
		if group.Name != "boringjail" || group.Gid != strconv.Itoa(gid) {
			return fmt.Errorf("%w: gid %d belongs to %q", errJailerIdentityCollision, gid, group.Name)
		}
	} else {
		var unknown user.UnknownGroupIdError
		if !errors.As(groupErr, &unknown) {
			return groupErr
		}
	}
	return nil
}

func validateManagedJailerIdentity(cfg Config, identity jailerIdentity) bool {
	if identity.UID < cfg.JailerUID || identity.GID < cfg.JailerGID {
		return false
	}
	uidSlot := identity.UID - cfg.JailerUID
	gidSlot := identity.GID - cfg.JailerGID
	return uidSlot == gidSlot && uidSlot >= 0 && uidSlot < cfg.MaxMachines && validJailerIdentityReservationID(identity.ReservationID)
}

func newJailerIdentityReservationID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func validJailerIdentityReservationID(value string) bool {
	if len(value) != 32 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 16
}

func validateRestoredJailerOwnership(cfg Config, machine persistedMachine, identity jailerIdentity) error {
	if !cfg.NehemiahMode {
		return nil
	}
	if !validateManagedJailerIdentity(cfg, identity) || machine.Runtime == nil {
		return errors.New("invalid restored jailer identity")
	}
	uids, gids, err := processCredentialSets(machine.Runtime.PID)
	if err != nil {
		return err
	}
	for _, observed := range uids {
		if observed != identity.UID {
			return fmt.Errorf("restored VMM uid %d does not match reserved uid %d", observed, identity.UID)
		}
	}
	for _, observed := range gids {
		if observed != identity.GID {
			return fmt.Errorf("restored VMM gid %d does not match reserved gid %d", observed, identity.GID)
		}
	}
	info, err := os.Lstat(machine.Runtime.Overlay)
	if err != nil {
		return fmt.Errorf("stat restored overlay: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || int(stat.Uid) != identity.UID || int(stat.Gid) != identity.GID {
		return errors.New("restored overlay ownership does not match its reserved jailer identity")
	}
	return nil
}

func processCredentialSets(pid int) ([4]int, [4]int, error) {
	credentials, err := readManagedProcessCredentials(pid)
	return credentials.uids, credentials.gids, err
}

func readManagedProcessCredentials(pid int) (managedProcessCredentials, error) {
	if pid <= 1 {
		return managedProcessCredentials{}, errors.New("unsafe process id")
	}
	contents, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	if err != nil {
		return managedProcessCredentials{}, err
	}
	return parseManagedProcessCredentials(contents)
}

func parseManagedProcessCredentials(contents []byte) (managedProcessCredentials, error) {
	if len(contents) == 0 || len(contents) > maxManagedProcessStatusBytes {
		return managedProcessCredentials{}, errors.New("process status exceeds its credential parsing bound")
	}
	var credentials managedProcessCredentials
	uidSeen, gidSeen, groupsSeen := false, false, false
	parseTuple := func(label string, fields []string, destination *[4]int, seen *bool) error {
		if *seen || len(fields) != 5 {
			return fmt.Errorf("process status has malformed %s credentials", label)
		}
		*seen = true
		for index := range destination {
			value, parseErr := strconv.Atoi(fields[index+1])
			if parseErr != nil || value < 0 {
				return fmt.Errorf("process status has invalid %s credential", label)
			}
			destination[index] = value
		}
		return nil
	}
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "Uid:":
			if err := parseTuple("Uid", fields, &credentials.uids, &uidSeen); err != nil {
				return managedProcessCredentials{}, err
			}
		case "Gid:":
			if err := parseTuple("Gid", fields, &credentials.gids, &gidSeen); err != nil {
				return managedProcessCredentials{}, err
			}
		case "Groups:":
			if groupsSeen || len(fields)-1 > maxManagedSupplementaryGIDs {
				return managedProcessCredentials{}, errors.New("process status has malformed supplementary groups")
			}
			groupsSeen = true
			credentials.supplementaryGIDs = make([]int, 0, len(fields)-1)
			for _, raw := range fields[1:] {
				value, parseErr := strconv.Atoi(raw)
				if parseErr != nil || value < 0 {
					return managedProcessCredentials{}, errors.New("process status has an invalid supplementary group")
				}
				credentials.supplementaryGIDs = append(credentials.supplementaryGIDs, value)
			}
		}
	}
	if !uidSeen || !gidSeen || !groupsSeen {
		return managedProcessCredentials{}, errors.New("process status is missing credential fields")
	}
	return credentials, nil
}

func verifyManagedJailerIdentityTeardown(cfg Config, machineID string, identity jailerIdentity) error {
	if !cfg.NehemiahMode || identity == (jailerIdentity{}) {
		return nil
	}
	if !validMachineID(machineID) || !validateManagedJailerIdentity(cfg, identity) {
		return errors.New("unsafe managed jailer teardown identity")
	}
	if err := scanManagedJailerIdentityProcesses(identity, defaultManagedJailerProcessOps()); err != nil {
		return err
	}
	unit, err := scopeUnitForMachine(machineID)
	if err != nil {
		return err
	}
	active, err := cgroupTreeHasProcesses(filepath.Join("/sys/fs/cgroup/system.slice", unit))
	if err != nil {
		return fmt.Errorf("verify managed scope teardown: %w", err)
	}
	if active {
		return errors.New("managed scope still contains a process")
	}
	if _, err := os.Lstat(filepath.Join("/sys/class/net", tapName(machineID))); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return fmt.Errorf("verify managed tap teardown: %w", err)
		}
		return errors.New("managed tap still exists")
	}
	if _, err := os.Lstat(filepath.Join(cfg.ChrootBase, "firecracker", machineID)); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return fmt.Errorf("verify managed jail teardown: %w", err)
		}
		return errors.New("managed jail still exists")
	}
	if entries, err := os.ReadDir(cfg.RunDir); err == nil {
		for _, entry := range entries {
			if artifactOwnedBy(entry.Name(), map[string]struct{}{machineID: {}}) {
				return fmt.Errorf("managed runtime artifact %s still exists", entry.Name())
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("verify managed runtime artifacts: %w", err)
	}
	return nil
}

func defaultManagedJailerProcessOps() managedJailerProcessOps {
	return managedJailerProcessOps{
		listPIDs: func() ([]int, error) {
			entries, err := os.ReadDir("/proc")
			if err != nil {
				return nil, err
			}
			pids := make([]int, 0, len(entries))
			for _, entry := range entries {
				pid, parseErr := strconv.Atoi(entry.Name())
				if parseErr == nil && pid > 1 {
					pids = append(pids, pid)
				}
			}
			return pids, nil
		},
		credentials: readManagedProcessCredentials,
		processExists: func(pid int) (bool, error) {
			_, err := os.Lstat(filepath.Join("/proc", strconv.Itoa(pid)))
			if err == nil {
				return true, nil
			}
			if errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return false, err
		},
	}
}

func scanManagedJailerIdentityProcesses(identity jailerIdentity, ops managedJailerProcessOps) error {
	uids, gids, err := managedJailerLiveCredentialInventory(ops)
	if err != nil {
		return err
	}
	if _, held := uids[identity.UID]; held {
		return fmt.Errorf("a live process still holds jailer uid %d", identity.UID)
	}
	if _, held := gids[identity.GID]; held {
		return fmt.Errorf("a live process still holds jailer gid %d", identity.GID)
	}
	return nil
}

func managedJailerLiveCredentialInventory(ops managedJailerProcessOps) (map[int]struct{}, map[int]struct{}, error) {
	if ops.listPIDs == nil || ops.credentials == nil || ops.processExists == nil {
		return nil, nil, errors.New("managed jailer process scan is unavailable")
	}
	pids, err := ops.listPIDs()
	if err != nil {
		return nil, nil, fmt.Errorf("list processes for jailer identity use: %w", err)
	}
	uids := make(map[int]struct{})
	gids := make(map[int]struct{})
	for _, pid := range pids {
		if pid <= 1 {
			return nil, nil, errors.New("process inventory contains an unsafe pid")
		}
		credentials, credentialErr := ops.credentials(pid)
		if credentialErr != nil {
			if !errors.Is(credentialErr, os.ErrNotExist) && !errors.Is(credentialErr, syscall.ESRCH) {
				return nil, nil, fmt.Errorf("read process %d credentials: %w", pid, credentialErr)
			}
			exists, existsErr := ops.processExists(pid)
			if existsErr != nil {
				return nil, nil, fmt.Errorf("prove process %d disappeared: %w", pid, existsErr)
			}
			if !exists {
				continue
			}
			return nil, nil, fmt.Errorf("process %d remains but its credentials are unreadable", pid)
		}
		for _, uid := range credentials.uids {
			uids[uid] = struct{}{}
		}
		for _, gid := range credentials.gids {
			gids[gid] = struct{}{}
		}
		for _, gid := range credentials.supplementaryGIDs {
			gids[gid] = struct{}{}
		}
	}
	return uids, gids, nil
}

func (mgr *Manager) releaseJailerIdentityAfterTeardown(machineID string, expected jailerIdentity) error {
	if !mgr.cfg.NehemiahMode {
		return nil
	}
	mgr.mu.Lock()
	identity, held := mgr.jailerIdentities[machineID]
	mgr.mu.Unlock()
	if !held {
		return nil
	}
	if expected != (jailerIdentity{}) && identity != expected {
		mgr.mu.Lock()
		mgr.identityHealthy = false
		mgr.mu.Unlock()
		return errors.New("managed jailer identity reservation changed before teardown")
	}
	verify := mgr.verifyIdentityTeardown
	if verify == nil {
		verify = verifyManagedJailerIdentityTeardown
	}
	if err := verify(mgr.cfg, machineID, identity); err != nil {
		mgr.mu.Lock()
		mgr.identityHealthy = false
		mgr.mu.Unlock()
		return fmt.Errorf("verify managed jailer identity release: %w", err)
	}
	mgr.mu.Lock()
	current, stillHeld := mgr.jailerIdentities[machineID]
	if !stillHeld {
		mgr.mu.Unlock()
		return nil
	}
	if current != identity {
		mgr.identityHealthy = false
		mgr.mu.Unlock()
		return errors.New("managed jailer identity reservation changed during teardown")
	}
	delete(mgr.jailerIdentities, machineID)
	if err := mgr.persistRequiredLocked(); err != nil {
		mgr.jailerIdentities[machineID] = identity
		mgr.identityHealthy = false
		mgr.mu.Unlock()
		return fmt.Errorf("persist managed jailer identity release: %w", err)
	}
	mgr.mu.Unlock()
	return nil
}

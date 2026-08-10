package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	maxStateQuarantineBytes = 1 * 1024 * 1024
	maxStateQuarantineFiles = 3
)

type managedStateRecoveryOps struct {
	listScopes       func() ([]string, error)
	stopScope        func(string) error
	listTaps         func() ([]string, error)
	isolateTap       func(string) error
	cleanupArtifacts func() (int, error)
}

func defaultManagedStateRecoveryOps(cfg Config) managedStateRecoveryOps {
	return managedStateRecoveryOps{
		listScopes: managedStateScopeUnits,
		stopScope: func(unit string) error {
			return stopManagedScopeVerified(cfg, unit)
		},
		// Discovery must not trust the current network setting: a prior daemon
		// can have left a managed tap behind even when this invocation has
		// networking disabled.
		listTaps:   managedTapInterfaces,
		isolateTap: isolateManagedTap,
		cleanupArtifacts: func() (int, error) {
			return reapOrphansExcept(cfg, nil)
		},
	}
}

func (ops managedStateRecoveryOps) valid() bool {
	return ops.listScopes != nil && ops.stopScope != nil && ops.listTaps != nil &&
		ops.isolateTap != nil && ops.cleanupArtifacts != nil
}

// recoverInvalidMachineState is a startup-only authority reset. It does not
// move or replace state.json until every discoverable managed VMM scope and tap
// has disappeared. stateHealthy remains false throughout, so a failed recovery
// cannot race new admission even if this method is reused outside main startup.
func (mgr *Manager) recoverInvalidMachineState(report reconcileReport, stateErr error) (reconcileReport, error) {
	kind, ok := invalidMachineStateKind(stateErr)
	if !ok {
		return report, stateErr
	}
	if err := mgr.isolateForStateRecovery(&report); err != nil {
		return report, fmt.Errorf("managed recovery for invalid state kind %s did not isolate every runtime: %w", kind, err)
	}

	_, err := mgr.stateStore.QuarantineInvalid(kind)
	if err != nil {
		return report, fmt.Errorf("managed recovery for invalid state kind %s could not quarantine evidence: %w", kind, err)
	}

	mgr.mu.Lock()
	if len(mgr.machines) != 0 {
		mgr.mu.Unlock()
		return report, errors.New("managed invalid-state recovery found an initialized machine registry")
	}
	mgr.stateGeneration = 0
	mgr.transitions = nil
	mgr.nextTransition = 0
	mgr.createKeys = make(map[string]*createReservation)
	mgr.forkKeys = make(map[string]*forkReservation)
	mgr.meteringOutbox = nil
	if err := mgr.persistRequiredLocked(); err != nil {
		mgr.mu.Unlock()
		return report, fmt.Errorf("commit empty state after managed isolation: %w", err)
	}
	mgr.mu.Unlock()

	report.StateQuarantined = true
	logManagedHostEvent(managedHostEventStateQuarantined, managedHostLogFields{Quarantined: true})
	return report, nil
}

// recoverUnreadableMachineState handles failures for which state.json cannot
// be safely inspected or moved (permission, path, or filesystem I/O errors).
// It preserves the original evidence and error, but it still tears down every
// discoverable managed runtime before startup fails. A retry must never infer
// an empty inventory from an unreadable authority file.
func (mgr *Manager) recoverUnreadableMachineState(report reconcileReport, stateErr error) (reconcileReport, error) {
	isolationErr := mgr.isolateForStateRecovery(&report)
	if isolationErr != nil {
		return report, fmt.Errorf("managed state load and runtime isolation failed: %w", errors.Join(stateErr, isolationErr))
	}
	return report, fmt.Errorf("managed state load failed after runtime isolation: %w", stateErr)
}

func (mgr *Manager) isolateForStateRecovery(report *reconcileReport) error {
	mgr.mu.Lock()
	mgr.stateHealthy = false
	mgr.mu.Unlock()

	ops := mgr.stateRecovery
	if !ops.valid() {
		ops = defaultManagedStateRecoveryOps(mgr.cfg)
	}
	removed, err := isolateManagedStateResources(ops)
	report.Orphans += removed
	return err
}

func isolateManagedStateResources(ops managedStateRecoveryOps) (int, error) {
	if !ops.valid() {
		return 0, errors.New("managed state recovery operations are incomplete")
	}
	removed := make(map[string]struct{})
	artifactsRemoved := 0
	for pass := 0; pass < 3; pass++ {
		taps, tapListErr := ops.listTaps()
		if tapListErr == nil {
			for _, tap := range taps {
				if !managedTapPattern.MatchString(tap) {
					return len(removed) + artifactsRemoved, fmt.Errorf("unsafe managed tap identifier")
				}
				_ = ops.isolateTap(tap)
				removed["tap:"+tap] = struct{}{}
			}
		}

		scopes, scopeListErr := ops.listScopes()
		if scopeListErr == nil {
			for _, unit := range scopes {
				if _, ok := machineIDForScopeUnit(unit); !ok {
					return len(removed) + artifactsRemoved, fmt.Errorf("unsafe managed scope identifier")
				}
				_ = ops.stopScope(unit)
				removed["scope:"+unit] = struct{}{}
			}
		}

		if pass == 0 {
			var cleanupErr error
			artifactsRemoved, cleanupErr = ops.cleanupArtifacts()
			if cleanupErr != nil {
				return len(removed) + artifactsRemoved, fmt.Errorf("clean managed recovery artifacts: %w", cleanupErr)
			}
		}
		remainingTaps, finalTapErr := ops.listTaps()
		remainingScopes, finalScopeErr := ops.listScopes()
		if finalTapErr == nil && finalScopeErr == nil && len(remainingTaps) == 0 && len(remainingScopes) == 0 {
			return len(removed) + artifactsRemoved, nil
		}
		if pass == 2 {
			switch {
			case finalTapErr != nil:
				return len(removed) + artifactsRemoved, fmt.Errorf("verify managed taps are absent: %w", finalTapErr)
			case finalScopeErr != nil:
				return len(removed) + artifactsRemoved, fmt.Errorf("verify managed scopes are stopped: %w", finalScopeErr)
			default:
				return len(removed) + artifactsRemoved, fmt.Errorf("managed resources remain after recovery: scopes=%d taps=%d", len(remainingScopes), len(remainingTaps))
			}
		}
	}
	return len(removed) + artifactsRemoved, errors.New("managed state recovery did not converge")
}

func managedStateScopeUnits() ([]string, error) {
	const systemSlice = "/sys/fs/cgroup/system.slice"
	entries, err := os.ReadDir(systemSlice)
	if err != nil {
		return nil, err
	}
	units := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, ok := machineIDForScopeUnit(entry.Name()); !ok {
			continue
		}
		// Include empty-but-loaded scopes as well as scopes with live tasks.
		// stopManagedScopeVerified stops the exact unit, and the subsequent
		// discovery pass proves systemd removed the sibling scope entirely.
		units = append(units, entry.Name())
	}
	sort.Strings(units)
	return units, nil
}

func cgroupTreeHasProcesses(root string) (bool, error) {
	found := false
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return filepath.SkipDir
			}
			return walkErr
		}
		if found || !entry.IsDir() {
			return nil
		}
		contents, err := os.ReadFile(filepath.Join(path, "cgroup.procs"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(strings.Fields(string(contents))) != 0 {
			found = true
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return found, err
}

func stopManagedScopeVerified(cfg Config, unit string) error {
	if _, ok := machineIDForScopeUnit(unit); !ok {
		return errors.New("unsafe managed scope identifier")
	}
	stopManagedScope(cfg, unit)
	path := filepath.Join("/sys/fs/cgroup/system.slice", unit)
	deadline := time.Now().Add(5 * time.Second)
	for {
		active, err := cgroupTreeHasProcesses(path)
		if err == nil && !active {
			return nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("verify stopped managed scope: %w", err)
			}
			return errors.New("managed scope still contains a process")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func managedTapInterfaces() ([]string, error) {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return nil, err
	}
	taps := make([]string, 0)
	for _, entry := range entries {
		if managedTapPattern.MatchString(entry.Name()) {
			taps = append(taps, entry.Name())
		}
	}
	sort.Strings(taps)
	return taps, nil
}

func isolateManagedTap(tap string) error {
	if !managedTapPattern.MatchString(tap) {
		return errors.New("unsafe managed tap identifier")
	}
	run := func(name string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, name, args...).CombinedOutput()
	}
	_, _ = run("ip", "link", "set", tap, "down")
	removeTapEgressPolicy(tap, run)
	_, _ = run("ip", "link", "del", tap)
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err := os.Lstat(filepath.Join("/sys/class/net", tap))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("verify managed tap removal: %w", err)
		}
		if time.Now().After(deadline) {
			return errors.New("managed tap survived forced isolation")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (s *StateStore) QuarantineInvalid(kind string) (string, error) {
	if s == nil {
		return "", errors.New("state persistence is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Lstat(s.path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("invalid state evidence is not a regular file")
	}
	kind = safeStateQuarantineKind(kind)
	directory := filepath.Dir(s.path)
	base := filepath.Base(s.path)
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	var evidence string
	for attempt := 0; attempt < 100; attempt++ {
		candidate := filepath.Join(directory, fmt.Sprintf("%s.corrupt-%s-%s-%d-%d", base, kind, stamp, os.Getpid(), attempt))
		if _, err := os.Lstat(candidate); errors.Is(err, os.ErrNotExist) {
			evidence = candidate
			break
		} else if err != nil {
			return "", err
		}
	}
	if evidence == "" {
		return "", errors.New("could not allocate a unique state quarantine name")
	}
	if err := os.Rename(s.path, evidence); err != nil {
		return "", err
	}
	restore := func(recoveryErr error) (string, error) {
		_ = os.Rename(evidence, s.path)
		return "", recoveryErr
	}
	file, err := os.OpenFile(evidence, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return restore(err)
	}
	if info.Size() > maxStateQuarantineBytes {
		err = file.Truncate(maxStateQuarantineBytes)
	}
	if err == nil {
		err = file.Chmod(0o600)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return restore(err)
	}
	if closeErr != nil {
		return restore(closeErr)
	}
	if err := boundStateQuarantines(directory, base); err != nil {
		return restore(err)
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return restore(err)
	}
	err = directoryHandle.Sync()
	closeErr = directoryHandle.Close()
	if err != nil {
		return restore(err)
	}
	if closeErr != nil {
		return restore(closeErr)
	}
	s.lastSaved = 0
	return evidence, nil
}

func safeStateQuarantineKind(kind string) string {
	switch kind {
	case "host_identity", "invalid_fork_history", "malformed", "metering_outbox", "oversized", "replaced_during_load", "trailing_data", "unsafe_file_type", "unsupported_version":
		return kind
	default:
		return "invalid"
	}
}

func boundStateQuarantines(directory, base string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	prefix := base + ".corrupt-"
	names := make([]string, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(path); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return errors.New("state quarantine contains a non-regular entry")
		}
		file, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		if info.Size() > maxStateQuarantineBytes {
			err = file.Truncate(maxStateQuarantineBytes)
		}
		if err == nil {
			err = file.Chmod(0o600)
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	for _, name := range names[:max(0, len(names)-maxStateQuarantineFiles)] {
		if err := os.Remove(filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	return nil
}

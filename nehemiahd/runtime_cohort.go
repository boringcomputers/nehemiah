package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

const (
	managedRuntimeContractVersion = 4
	maxManagedRuntimeAssetBytes   = int64(64 << 30)
)

// managedRuntimeCohort is the signed release identity for every byte which can
// define a built-in managed VM. The cohort ID hashes the expected digests (not
// the observed files); observed files are independently hashed before use.
type managedRuntimeCohort struct {
	ID                  string `json:"id"`
	ContractVersion     int    `json:"contract_version"`
	Arch                string `json:"arch"`
	PythonRootfsSHA256  string `json:"python_rootfs_sha256"`
	DesktopRootfsSHA256 string `json:"desktop_rootfs_sha256"`
	KernelSHA256        string `json:"kernel_sha256"`
	FirecrackerSHA256   string `json:"firecracker_sha256"`
	JailerSHA256        string `json:"jailer_sha256"`
}

type managedRuntimeExpectation struct {
	CohortID     string `json:"runtime_cohort_id"`
	RootfsSHA256 string `json:"rootfs_sha256"`
}

// managedRuntimeAssetSeal is captured from the same opened object whose bytes
// were fully hashed during startup. Heartbeats compare this complete metadata
// identity instead of rereading multi-gigabyte rootfs images every few seconds.
// Any drift is sticky and requires a restart, which performs the full hash
// again before admission can reopen.
type managedRuntimeAssetSeal struct {
	Path      string
	Device    uint64
	Inode     uint64
	Size      int64
	Mode      uint32
	UID       uint32
	GID       uint32
	MTimeSec  int64
	MTimeNsec int64
	CTimeSec  int64
	CTimeNsec int64
}

type managedRuntimeAssetGuard struct {
	Cohort managedRuntimeCohort
	Assets []managedRuntimeAssetSeal
}

type managedRuntimeAssetSpec struct {
	name     string
	path     string
	expected string
}

func (cohort managedRuntimeCohort) Validate() error {
	if cohort.ContractVersion != managedRuntimeContractVersion {
		return fmt.Errorf("contract_version must be %d", managedRuntimeContractVersion)
	}
	if cohort.Arch != "amd64" && cohort.Arch != "arm64" {
		return errors.New("arch must be amd64 or arm64")
	}
	if cohort.Arch != runtime.GOARCH {
		return fmt.Errorf("arch %q does not match host architecture %q", cohort.Arch, runtime.GOARCH)
	}
	for name, digest := range map[string]string{
		"python rootfs":  cohort.PythonRootfsSHA256,
		"desktop rootfs": cohort.DesktopRootfsSHA256,
		"kernel":         cohort.KernelSHA256,
		"firecracker":    cohort.FirecrackerSHA256,
		"jailer":         cohort.JailerSHA256,
	} {
		if !validCanonicalSHA256(digest) {
			return fmt.Errorf("%s digest must be lowercase SHA-256", name)
		}
	}
	want := cohort.computedID()
	if !constantTimeHexEqual(cohort.ID, want) {
		return errors.New("cohort id does not match its canonical contract")
	}
	return nil
}

func (cohort managedRuntimeCohort) canonicalBytes() []byte {
	return []byte(fmt.Sprintf(
		"contract_version=%d\narch=%s\npython=%s\ndesktop=%s\nkernel=%s\nfirecracker=%s\njailer=%s\n",
		cohort.ContractVersion,
		cohort.Arch,
		cohort.PythonRootfsSHA256,
		cohort.DesktopRootfsSHA256,
		cohort.KernelSHA256,
		cohort.FirecrackerSHA256,
		cohort.JailerSHA256,
	))
}

func (cohort managedRuntimeCohort) computedID() string {
	digest := sha256.Sum256(cohort.canonicalBytes())
	return hex.EncodeToString(digest[:])
}

func validCanonicalSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func constantTimeHexEqual(left, right string) bool {
	leftBytes, leftErr := hex.DecodeString(left)
	rightBytes, rightErr := hex.DecodeString(right)
	if leftErr != nil || rightErr != nil || len(leftBytes) != sha256.Size || len(rightBytes) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare(leftBytes, rightBytes) == 1
}

func validateManagedRuntimeCohortAssets(cfg Config) error {
	_, err := initializeManagedRuntimeAssetGuard(cfg)
	return err
}

func managedRuntimeAssetSpecs(cfg Config) []managedRuntimeAssetSpec {
	return []managedRuntimeAssetSpec{
		{name: "python rootfs", path: cfg.BaseRootfs, expected: cfg.RuntimeCohort.PythonRootfsSHA256},
		{name: "desktop rootfs", path: cfg.DesktopRootfs, expected: cfg.RuntimeCohort.DesktopRootfsSHA256},
		{name: "kernel", path: cfg.KernelPath, expected: cfg.RuntimeCohort.KernelSHA256},
		{name: "firecracker", path: cfg.FirecrackerBin, expected: cfg.RuntimeCohort.FirecrackerSHA256},
		{name: "jailer", path: cfg.JailerBin, expected: cfg.RuntimeCohort.JailerSHA256},
	}
}

func initializeManagedRuntimeAssetGuard(cfg Config) (managedRuntimeAssetGuard, error) {
	if !cfg.NehemiahMode {
		return managedRuntimeAssetGuard{}, nil
	}
	if err := cfg.RuntimeCohort.Validate(); err != nil {
		return managedRuntimeAssetGuard{}, err
	}
	guard := managedRuntimeAssetGuard{
		Cohort: cfg.RuntimeCohort,
		Assets: make([]managedRuntimeAssetSeal, 0, 5),
	}
	for _, asset := range managedRuntimeAssetSpecs(cfg) {
		observed, seal, err := hashManagedRuntimeAssetWithSeal(asset.path, sha256.New())
		if err != nil {
			return managedRuntimeAssetGuard{}, fmt.Errorf("%s: %w", asset.name, err)
		}
		if !constantTimeHexEqual(observed, asset.expected) {
			return managedRuntimeAssetGuard{}, fmt.Errorf("%s digest does not match signed runtime cohort", asset.name)
		}
		guard.Assets = append(guard.Assets, seal)
	}
	return guard, nil
}

// hashManagedRuntimeAsset follows no links, rejects mutable/unbounded files,
// proves the opened descriptor is the object which was inspected, and detects
// replacement or resizing during the bounded read.
func hashManagedRuntimeAsset(path string, digest hash.Hash) (string, error) {
	observed, _, err := hashManagedRuntimeAssetWithSeal(path, digest)
	return observed, err
}

func hashManagedRuntimeAssetWithSeal(path string, digest hash.Hash) (string, managedRuntimeAssetSeal, error) {
	before, err := validateManagedRegular(path, true)
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	if before.Size() <= 0 || before.Size() > maxManagedRuntimeAssetBytes {
		return "", managedRuntimeAssetSeal{}, fmt.Errorf("asset size %d is outside the managed bound", before.Size())
	}
	beforeSeal, err := managedRuntimeSeal(path, before)
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	openedSeal, err := managedRuntimeSeal(path, opened)
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) || openedSeal != beforeSeal {
		return "", managedRuntimeAssetSeal{}, errors.New("asset was replaced while opening")
	}
	read, err := io.CopyBuffer(digest, io.LimitReader(file, before.Size()+1), make([]byte, 1024*1024))
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	if read != before.Size() {
		return "", managedRuntimeAssetSeal{}, errors.New("asset changed size while hashing")
	}
	afterOpened, err := file.Stat()
	if err != nil {
		return "", managedRuntimeAssetSeal{}, err
	}
	afterPath, pathErr := os.Lstat(path)
	afterOpenedSeal, sealErr := managedRuntimeSeal(path, afterOpened)
	afterPathSeal, pathSealErr := managedRuntimeSeal(path, afterPath)
	if pathErr != nil || sealErr != nil || pathSealErr != nil ||
		!os.SameFile(before, afterOpened) || !os.SameFile(before, afterPath) ||
		afterOpenedSeal != beforeSeal || afterPathSeal != beforeSeal {
		return "", managedRuntimeAssetSeal{}, errors.New("asset changed while hashing")
	}
	return hex.EncodeToString(digest.Sum(nil)), beforeSeal, nil
}

func managedRuntimeSeal(path string, info os.FileInfo) (managedRuntimeAssetSeal, error) {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return managedRuntimeAssetSeal{}, errors.New("runtime asset is not an immutable regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || stat.Gid != 0 {
		return managedRuntimeAssetSeal{}, errors.New("runtime asset is not owned by root:root")
	}
	return managedRuntimeAssetSeal{
		Path: path, Device: uint64(stat.Dev), Inode: stat.Ino, Size: info.Size(),
		Mode: stat.Mode, UID: stat.Uid, GID: stat.Gid,
		MTimeSec: stat.Mtim.Sec, MTimeNsec: stat.Mtim.Nsec,
		CTimeSec: stat.Ctim.Sec, CTimeNsec: stat.Ctim.Nsec,
	}, nil
}

func (guard managedRuntimeAssetGuard) ValidateMetadata(cfg Config) error {
	if !cfg.NehemiahMode {
		return nil
	}
	if err := cfg.RuntimeCohort.Validate(); err != nil {
		return err
	}
	if guard.Cohort != cfg.RuntimeCohort || len(guard.Assets) != len(managedRuntimeAssetSpecs(cfg)) {
		return errors.New("runtime asset guard was not established by startup hashing")
	}
	for index, asset := range managedRuntimeAssetSpecs(cfg) {
		expected := guard.Assets[index]
		if expected.Path != asset.path {
			return fmt.Errorf("%s path changed after startup", asset.name)
		}
		observed, err := observeManagedRuntimeAssetSeal(asset.path)
		if err != nil {
			return fmt.Errorf("%s metadata: %w", asset.name, err)
		}
		if observed != expected {
			return fmt.Errorf("%s metadata changed after startup", asset.name)
		}
	}
	return nil
}

// observeManagedRuntimeAssetSeal proves that the path and the descriptor opened
// with O_NOFOLLOW identify the same unchanged object. This keeps periodic
// validation metadata-only without reopening a symlink/replacement race.
func observeManagedRuntimeAssetSeal(path string) (managedRuntimeAssetSeal, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return managedRuntimeAssetSeal{}, err
	}
	beforeSeal, err := managedRuntimeSeal(path, before)
	if err != nil {
		return managedRuntimeAssetSeal{}, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return managedRuntimeAssetSeal{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return managedRuntimeAssetSeal{}, err
	}
	openedSeal, err := managedRuntimeSeal(path, opened)
	if err != nil || !os.SameFile(before, opened) || openedSeal != beforeSeal {
		return managedRuntimeAssetSeal{}, errors.New("runtime asset changed while opening")
	}
	after, err := os.Lstat(path)
	if err != nil {
		return managedRuntimeAssetSeal{}, err
	}
	afterSeal, err := managedRuntimeSeal(path, after)
	if err != nil || !os.SameFile(opened, after) || afterSeal != openedSeal {
		return managedRuntimeAssetSeal{}, errors.New("runtime asset changed while observing metadata")
	}
	return openedSeal, nil
}

func (mgr *Manager) validateManagedRuntimeExpectation(template string, expectation managedRuntimeExpectation) error {
	if !mgr.cfg.NehemiahMode {
		return nil
	}
	if !constantTimeHexEqual(expectation.CohortID, mgr.cfg.RuntimeCohort.ID) {
		return fmt.Errorf("%w: runtime cohort does not match this host", ErrInvalidResources)
	}
	expectedRootfs, err := mgr.selectedManagedRootfsSHA256(template)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidResources, err)
	}
	if !constantTimeHexEqual(expectation.RootfsSHA256, expectedRootfs) {
		return fmt.Errorf("%w: selected rootfs does not match this host", ErrInvalidResources)
	}
	return nil
}

func (mgr *Manager) selectedManagedRootfsSHA256(template string) (string, error) {
	return selectedManagedRootfsSHA256(mgr.cfg, template)
}

func selectedManagedRootfsSHA256(cfg Config, template string) (string, error) {
	if template == "" || template == "python" {
		return cfg.RuntimeCohort.PythonRootfsSHA256, nil
	}
	if template == "desktop" {
		return cfg.RuntimeCohort.DesktopRootfsSHA256, nil
	}
	path := filepath.Join(cfg.TemplatesDir, template, "rootfs.ext4")
	observed, err := hashManagedRuntimeAsset(path, sha256.New())
	if err != nil {
		return "", fmt.Errorf("hash selected template rootfs: %w", err)
	}
	return observed, nil
}

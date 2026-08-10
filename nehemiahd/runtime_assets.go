package main

import (
	"debug/elf"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"runtime"
	"syscall"
)

const minimumManagedRootfsBytes = 64 << 20

// validateManagedRuntimeAssets is deliberately cheap enough for the heartbeat
// probe. Cloud-init performs checksum, size and e2fsck verification before the
// atomic install; the daemon independently refuses links, mutable files,
// architecture-mismatched kernels and non-ext4 images both at startup and on
// every host observation.
func validateManagedRuntimeAssets(cfg Config, requireRootOwner bool) error {
	if !cfg.NehemiahMode {
		return nil
	}
	if err := validateManagedKernel(cfg.KernelPath, requireRootOwner); err != nil {
		return fmt.Errorf("kernel: %w", err)
	}
	for name, path := range map[string]string{
		"python rootfs":  cfg.BaseRootfs,
		"desktop rootfs": cfg.DesktopRootfs,
	} {
		if err := validateManagedExt4(path, requireRootOwner); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	baseInfo, err := os.Lstat(cfg.BaseRootfs)
	if err != nil {
		return err
	}
	desktopInfo, err := os.Lstat(cfg.DesktopRootfs)
	if err != nil {
		return err
	}
	if os.SameFile(baseInfo, desktopInfo) {
		return fmt.Errorf("python and desktop rootfs must be distinct files")
	}
	return nil
}

func validateManagedRegular(path string, requireRootOwner bool) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular non-symlink file", path)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("%s is group/world writable", path)
	}
	if requireRootOwner {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 {
			return nil, fmt.Errorf("%s is not root-owned", path)
		}
	}
	return info, nil
}

func validateManagedKernel(path string, requireRootOwner bool) error {
	info, err := validateManagedRegular(path, requireRootOwner)
	if err != nil {
		return err
	}
	if info.Size() < 1<<20 {
		return fmt.Errorf("%s is too small to be a guest kernel", path)
	}
	kernel, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("%s is not an ELF kernel: %w", path, err)
	}
	defer kernel.Close()
	if kernel.Class != elf.ELFCLASS64 {
		return fmt.Errorf("%s is not a 64-bit kernel", path)
	}
	expected := elf.EM_X86_64
	if runtime.GOARCH == "arm64" {
		expected = elf.EM_AARCH64
	}
	if kernel.Machine != expected {
		return fmt.Errorf("%s kernel architecture is %s, expected %s", path, kernel.Machine, expected)
	}
	return nil
}

func validateManagedExt4(path string, requireRootOwner bool) error {
	info, err := validateManagedRegular(path, requireRootOwner)
	if err != nil {
		return err
	}
	if info.Size() < minimumManagedRootfsBytes {
		return fmt.Errorf("%s is too small to be a managed rootfs", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	var magic [2]byte
	if _, err := file.ReadAt(magic[:], 1024+56); err != nil && err != io.EOF {
		return err
	}
	if binary.LittleEndian.Uint16(magic[:]) != 0xef53 {
		return fmt.Errorf("%s does not contain an ext4 superblock", path)
	}
	return nil
}

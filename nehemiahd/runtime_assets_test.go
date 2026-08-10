package main

import (
	"debug/elf"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeTestManagedAssets(t *testing.T) Config {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	kernelSource := "/proc/self/exe"
	kernelBytes, err := os.ReadFile(kernelSource)
	if err != nil {
		t.Fatal(err)
	}
	cfg.KernelPath = filepath.Join(t.TempDir(), "vmlinux")
	if err := os.WriteFile(cfg.KernelPath, kernelBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	writeRootfs := func(name string) string {
		path := filepath.Join(t.TempDir(), name)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_EXCL, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(minimumManagedRootfsBytes); err != nil {
			file.Close()
			t.Fatal(err)
		}
		var magic [2]byte
		binary.LittleEndian.PutUint16(magic[:], 0xef53)
		if _, err := file.WriteAt(magic[:], 1024+56); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cfg.BaseRootfs = writeRootfs("python.ext4")
	cfg.DesktopRootfs = writeRootfs("desktop.ext4")
	return cfg
}

func TestValidateManagedRuntimeAssetsAcceptsELFAndDistinctExt4Images(t *testing.T) {
	cfg := writeTestManagedAssets(t)
	if err := validateManagedRuntimeAssets(cfg, false); err != nil {
		t.Fatal(err)
	}
	kernel, err := elf.Open(cfg.KernelPath)
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	expected := elf.EM_X86_64
	if runtime.GOARCH == "arm64" {
		expected = elf.EM_AARCH64
	}
	if kernel.Machine != expected {
		t.Fatalf("test kernel machine=%s want=%s", kernel.Machine, expected)
	}
}

func TestValidateManagedRuntimeAssetsRejectsMissingUnsafeAndWrongTypes(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *Config)
		want   string
	}{
		{name: "missing desktop", mutate: func(t *testing.T, cfg *Config) {
			if err := os.Remove(cfg.DesktopRootfs); err != nil {
				t.Fatal(err)
			}
		}, want: "desktop rootfs"},
		{name: "symlink rootfs", mutate: func(t *testing.T, cfg *Config) {
			target := cfg.BaseRootfs
			link := filepath.Join(t.TempDir(), "rootfs.ext4")
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			cfg.BaseRootfs = link
		}, want: "non-symlink"},
		{name: "writable rootfs", mutate: func(t *testing.T, cfg *Config) {
			if err := os.Chmod(cfg.BaseRootfs, 0o666); err != nil {
				t.Fatal(err)
			}
		}, want: "group/world writable"},
		{name: "non ext4", mutate: func(t *testing.T, cfg *Config) {
			file, err := os.OpenFile(cfg.BaseRootfs, os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.WriteAt([]byte{0, 0}, 1024+56); err != nil {
				file.Close()
				t.Fatal(err)
			}
			file.Close()
		}, want: "ext4 superblock"},
		{name: "same image", mutate: func(_ *testing.T, cfg *Config) {
			cfg.DesktopRootfs = cfg.BaseRootfs
		}, want: "distinct"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := writeTestManagedAssets(t)
			test.mutate(t, &cfg)
			err := validateManagedRuntimeAssets(cfg, false)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error=%v want containing %q", err, test.want)
			}
		})
	}
}

func TestSystemHostProbeMarksUnavailableRuntimeAssetsUnhealthy(t *testing.T) {
	cfg := writeTestManagedAssets(t)
	cfg.DesktopRootfs = filepath.Join(t.TempDir(), "missing.ext4")
	resources := (systemHostProbe{}).Inspect(cfg)
	found := false
	for _, reason := range resources.Errors {
		if reason == "runtime_assets_unavailable" {
			found = true
		}
	}
	if !found {
		t.Fatalf("errors=%v, want runtime_assets_unavailable", resources.Errors)
	}
}

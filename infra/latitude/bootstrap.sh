#!/usr/bin/env bash
#
# bootstrap.sh - Provision a fresh Ubuntu 24.04 (x86_64 or aarch64) host for the
#                "Nehemiah" Firecracker microVM sandbox.
#
# Run as root on the target box:
#     sudo bash infra/latitude/bootstrap.sh
#
# Idempotent and safe to re-run. Installs firecracker + jailer, fetches a
# firecracker-compatible uncompressed kernel, and builds the base Alpine rootfs.
#
set -euo pipefail

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
NEHEMIAH_ROOT="/opt/boring"
BIN_DIR="${NEHEMIAH_ROOT}/bin"
KERNEL_DIR="${NEHEMIAH_ROOT}/kernel"
KERNEL_PATH="${KERNEL_DIR}/vmlinux"
ROOTFS_DIR="${NEHEMIAH_ROOT}/rootfs"
RUN_DIR="${NEHEMIAH_ROOT}/run"
TEMPLATE_DIR="${NEHEMIAH_ROOT}/templates"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GITHUB_API="https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest"

# Arch — firecracker + kernel artifacts differ between x86_64 and aarch64. uname's
# names (x86_64 / aarch64) match firecracker's release naming, so ARCH drives both.
ARCH="$(uname -m)"

# Kernel candidate URLs (arch-specific), tried in order. First one that downloads
# AND passes the "file" ELF/Linux-kernel check wins.
case "${ARCH}" in
  x86_64)
    KERNEL_URLS=(
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.11/x86_64/vmlinux-6.1.128"
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102"
      "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin"
    ) ;;
  aarch64)
    KERNEL_URLS=(
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/aarch64/vmlinux-6.1.128"
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/aarch64/vmlinux-6.1.102"
      "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/aarch64/kernels/vmlinux.bin"
    ) ;;
esac

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[bootstrap:error]\033[0m %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# Preconditions
# --------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

case "${ARCH}" in
  x86_64 | aarch64) : ;;
  *) die "unsupported arch '${ARCH}', expected x86_64 or aarch64" ;;
esac
log "Target arch: ${ARCH}"

# --------------------------------------------------------------------------
# 1. Packages
# --------------------------------------------------------------------------
log "Updating apt and installing dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates jq e2fsprogs iproute2 iptables cpio util-linux \
  git build-essential file debootstrap
log "Dependencies installed."

# --------------------------------------------------------------------------
# 2. KVM verification + ip_forward
# --------------------------------------------------------------------------
log "Verifying KVM support..."
[ -e /dev/kvm ] || die "/dev/kvm not present - box lacks nested/hardware virtualization"
[ -r /dev/kvm ] && [ -w /dev/kvm ] || warn "/dev/kvm not read/write for root? continuing"

if grep -Eqw '(vmx|svm)' /proc/cpuinfo; then
  log "CPU virtualization extensions (vmx/svm) present."
else
  warn "No vmx/svm flag in /proc/cpuinfo; firecracker may still work if /dev/kvm is functional."
fi

log "Enabling net.ipv4.ip_forward..."
sysctl -w net.ipv4.ip_forward=1 >/dev/null
# Persist across reboots (idempotent).
if [ -d /etc/sysctl.d ]; then
  echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-boring.conf
fi

# --------------------------------------------------------------------------
# 3. Directory layout
# --------------------------------------------------------------------------
log "Creating ${NEHEMIAH_ROOT} layout..."
mkdir -p "${BIN_DIR}" "${KERNEL_DIR}" "${ROOTFS_DIR}" "${RUN_DIR}" "${TEMPLATE_DIR}"

# Jailer prerequisites: the chroot base + the unprivileged uid/gid the jailer
# drops firecracker into (NEHEMIAH_JAILER=1). Without these, jailed boots fail with
# "Canonicalize(/srv/jailer)" / "fc.sock did not appear".
mkdir -p /srv/jailer
groupadd -g 991 boringjail 2>/dev/null || true
useradd -u 30000 -g 991 -M -s /usr/sbin/nologin boringjail 2>/dev/null || true

# --------------------------------------------------------------------------
# 4. Install firecracker + jailer
# --------------------------------------------------------------------------
install_firecracker() {
  if [ -x "${BIN_DIR}/firecracker" ] && "${BIN_DIR}/firecracker" --version >/dev/null 2>&1; then
    log "firecracker already installed: $("${BIN_DIR}/firecracker" --version | head -n1)"
    return 0
  fi

  log "Resolving latest firecracker release tag from GitHub API..."
  local tag
  tag="$(curl -fsSL "${GITHUB_API}" | jq -r '.tag_name')"
  [ -n "${tag}" ] && [ "${tag}" != "null" ] || die "could not resolve firecracker release tag"
  log "Latest firecracker tag: ${tag}"

  local tmp
  tmp="$(mktemp -d)"
  # Ensure temp dir is cleaned up on any exit from this function's subshell scope.
  trap 'rm -rf "${tmp}"' RETURN

  local tgz="${tmp}/firecracker.tgz"
  local url="https://github.com/firecracker-microvm/firecracker/releases/download/${tag}/firecracker-${tag}-${ARCH}.tgz"
  log "Downloading ${url}"
  curl -fSL --retry 3 -o "${tgz}" "${url}" || die "failed to download firecracker release tarball"

  log "Extracting release tarball..."
  tar -xzf "${tgz}" -C "${tmp}"

  # Layout inside tarball: release-<tag>-<arch>/firecracker-<tag>-<arch> and jailer-<tag>-<arch>
  local rel_dir="${tmp}/release-${tag}-${ARCH}"
  local fc_bin="${rel_dir}/firecracker-${tag}-${ARCH}"
  local jail_bin="${rel_dir}/jailer-${tag}-${ARCH}"

  # Fall back to a glob search if the expected path differs.
  if [ ! -f "${fc_bin}" ]; then
    fc_bin="$(find "${tmp}" -type f -name "firecracker-*-${ARCH}" ! -name '*.debug' | head -n1)"
  fi
  if [ ! -f "${jail_bin}" ]; then
    jail_bin="$(find "${tmp}" -type f -name "jailer-*-${ARCH}" ! -name '*.debug' | head -n1)"
  fi

  [ -f "${fc_bin}" ]   || die "firecracker binary not found in release tarball"
  [ -f "${jail_bin}" ] || warn "jailer binary not found in release tarball (continuing without jailer)"

  install -m 0755 "${fc_bin}" "${BIN_DIR}/firecracker"
  [ -f "${jail_bin}" ] && install -m 0755 "${jail_bin}" "${BIN_DIR}/jailer"

  log "firecracker installed: $("${BIN_DIR}/firecracker" --version | head -n1)"
}
install_firecracker

# --------------------------------------------------------------------------
# 5. Fetch an uncompressed firecracker-compatible kernel
# --------------------------------------------------------------------------
kernel_is_valid() {
  local path="$1"
  [ -s "${path}" ] || return 1
  # Accept ELF or "Linux kernel x86 boot executable" (vmlinux.bin bzImage form).
  local desc
  desc="$(file -b "${path}" 2>/dev/null || true)"
  case "${desc}" in
    *ELF*)                       return 0 ;;
    *"Linux kernel x86 boot"*)   return 0 ;;
    *boot*executable*)           return 0 ;;
    *) return 1 ;;
  esac
}

install_kernel() {
  if kernel_is_valid "${KERNEL_PATH}"; then
    log "Kernel already present and valid: ${KERNEL_PATH} ($(file -b "${KERNEL_PATH}"))"
    return 0
  fi

  local url
  for url in "${KERNEL_URLS[@]}"; do
    log "Trying kernel URL: ${url}"
    local tmp
    tmp="$(mktemp)"
    if curl -fSL --retry 2 -o "${tmp}" "${url}"; then
      if kernel_is_valid "${tmp}"; then
        install -m 0644 "${tmp}" "${KERNEL_PATH}"
        rm -f "${tmp}"
        log "Kernel installed from ${url}: $(file -b "${KERNEL_PATH}")"
        return 0
      else
        warn "Downloaded file did not look like a kernel: $(file -b "${tmp}")"
      fi
    else
      warn "Download failed: ${url}"
    fi
    rm -f "${tmp}"
  done

  die "Could not fetch a valid kernel from any candidate URL.
      Please supply a firecracker-compatible uncompressed kernel at:
        ${KERNEL_PATH}
      (e.g. build one with the firecracker kernel config, or copy a known-good vmlinux.)"
}
install_kernel

# --------------------------------------------------------------------------
# 6. Build base rootfs
# --------------------------------------------------------------------------
log "Building base rootfs (build-rootfs.sh)..."
bash "${SCRIPT_DIR}/build-rootfs.sh"

# --------------------------------------------------------------------------
# 7. Success banner
# --------------------------------------------------------------------------
cat <<BANNER

============================================================================
  Nehemiah box bootstrap COMPLETE
----------------------------------------------------------------------------
  firecracker : $("${BIN_DIR}/firecracker" --version 2>/dev/null | head -n1)
  jailer      : $([ -x "${BIN_DIR}/jailer" ] && "${BIN_DIR}/jailer" --version 2>/dev/null | head -n1 || echo "(not installed)")
  kernel      : ${KERNEL_PATH} ($(file -b "${KERNEL_PATH}"))
  rootfs      : ${ROOTFS_DIR}/rootfs.ext4 ($(du -h "${ROOTFS_DIR}/rootfs.ext4" 2>/dev/null | cut -f1))
  run dir     : ${RUN_DIR}
  templates   : ${TEMPLATE_DIR}
----------------------------------------------------------------------------
  NEXT STEPS:
    1. (optional) Build the python snapshot template:
         sudo bash ${SCRIPT_DIR}/build-template.sh python
    2. Deploy the nehemiahd binary to /usr/local/bin/nehemiahd
    3. (optional) Set a token:  echo 'NEHEMIAH_TOKEN=...' > /etc/boring/nehemiahd.env
    4. Install the service:
         install -m0644 ${SCRIPT_DIR}/nehemiahd.service /etc/systemd/system/nehemiahd.service
         systemctl daemon-reload && systemctl enable --now nehemiahd
    5. Verify:  curl -s http://localhost:8080/healthz | jq
============================================================================

BANNER
log "Done."

#!/usr/bin/env bash
#
# bootstrap.sh - Provision a fresh Ubuntu 24.04 (x86_64 or aarch64) host for the
#                "Nehemiah" Firecracker microVM sandbox.
#
# Run as root on the target box:
#     sudo bash infra/latitude/bootstrap.sh
#
# Idempotent and safe to re-run. Installs Firecracker, jailer, and the kernel
# from local artifacts already verified against the signed release. Production
# guest images must also have been installed by cloud-init.
#
# MANAGED HOSTS ONLY. This installs exclusively from signed managed-release
# artifacts and requires the managed-release inputs below (NEHEMIAH_RELEASE_VERSION,
# the signed archive/kernel, and the managed-host package cohort). It is driven by
# infra/latitude/provision.sh + cloud-init; the self-serve infra/setup.sh and
# infra/local/setup-local.sh flows do not satisfy this contract and refuse to run it.
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

: "${NEHEMIAH_FIRECRACKER_ARCHIVE:?signed release Firecracker archive is required}"
: "${NEHEMIAH_FIRECRACKER_SHA256:?signed manifest Firecracker SHA-256 is required}"
: "${NEHEMIAH_KERNEL_IMAGE:?signed release kernel image is required}"
: "${NEHEMIAH_KERNEL_SHA256:?signed manifest kernel SHA-256 is required}"
: "${NEHEMIAH_FIRECRACKER_INSTALLED_SHA256:?signed installed Firecracker SHA-256 is required}"
: "${NEHEMIAH_JAILER_INSTALLED_SHA256:?signed installed jailer SHA-256 is required}"
: "${NEHEMIAH_RELEASE_VERSION:?signed release version is required}"
: "${NEHEMIAH_RUNTIME_PYTHON_SHA256:?signed python rootfs SHA-256 is required}"
: "${NEHEMIAH_RUNTIME_DESKTOP_SHA256:?signed desktop rootfs SHA-256 is required}"

# Arch — firecracker + kernel artifacts differ between x86_64 and aarch64. uname's
# names (x86_64 / aarch64) match firecracker's release naming, so ARCH drives both.
ARCH="$(uname -m)"

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[bootstrap:error]\033[0m %s\n' "$*" >&2; exit 1; }

# The first identity in nehemiahd's bounded per-VM UID/GID pool has a named
# bootstrap account. Every other slot remains numeric-only. Never hide account
# creation errors: a stale name or an unrelated owner of either numeric id is a
# host-identity collision and must abort provisioning.
ensure_boringjail_account() {
  local account_name=boringjail expected_uid=30000 expected_gid=30000
  local expected_home=/nonexistent expected_shell=/usr/sbin/nologin
  local group_by_name group_by_id user_by_name user_by_id password_status
  local name uid gid gecos home shell members extra status

  lookup_record() {
    local database="$1" key="$2" destination="$3" output lookup_status
    set +e
    output="$(getent "$database" "$key" 2>/dev/null)"
    lookup_status=$?
    set -e
    case "$lookup_status" in
      0) [[ -n "$output" && "$output" != *$'\n'* ]] || die "ambiguous ${database} identity for ${key}" ;;
      2) output="" ;;
      *) die "cannot query ${database} identity for ${key}" ;;
    esac
    printf -v "$destination" '%s' "$output"
  }

  lookup_record group "$account_name" group_by_name
  lookup_record group "$expected_gid" group_by_id
  if [[ -z "$group_by_name" && -z "$group_by_id" ]]; then
    groupadd --gid "$expected_gid" "$account_name" \
      || die "cannot create the managed jailer group"
  elif [[ -z "$group_by_name" || -z "$group_by_id" || "$group_by_name" != "$group_by_id" ]]; then
    die "managed jailer group name or gid is already owned by another identity"
  fi
  lookup_record group "$account_name" group_by_name
  lookup_record group "$expected_gid" group_by_id
  IFS=: read -r name _ gid members extra <<<"$group_by_name"
  [[ "$group_by_name" == "$group_by_id" && "$name" == "$account_name" && \
    "$gid" == "$expected_gid" && -z "$members" && -z "$extra" ]] \
    || die "managed jailer group does not match the signed host contract"

  lookup_record passwd "$account_name" user_by_name
  lookup_record passwd "$expected_uid" user_by_id
  if [[ -z "$user_by_name" && -z "$user_by_id" ]]; then
    useradd --uid "$expected_uid" --gid "$expected_gid" --no-create-home \
      --home-dir "$expected_home" --shell "$expected_shell" --comment "" "$account_name" \
      || die "cannot create the managed jailer account"
  elif [[ -z "$user_by_name" || -z "$user_by_id" || "$user_by_name" != "$user_by_id" ]]; then
    die "managed jailer account name or uid is already owned by another identity"
  fi
  lookup_record passwd "$account_name" user_by_name
  lookup_record passwd "$expected_uid" user_by_id
  IFS=: read -r name _ uid gid gecos home shell extra <<<"$user_by_name"
  [[ "$user_by_name" == "$user_by_id" && "$name" == "$account_name" && \
    "$uid" == "$expected_uid" && "$gid" == "$expected_gid" && -z "$gecos" && \
    "$home" == "$expected_home" && "$shell" == "$expected_shell" && -z "$extra" ]] \
    || die "managed jailer account does not match the signed host contract"

  password_status="$(passwd --status "$account_name" 2>/dev/null)" \
    || die "cannot verify that the managed jailer account is locked"
  read -r name status extra <<<"$password_status"
  [[ "$name" == "$account_name" && "$status" == "L" ]] \
    || die "managed jailer account must remain password-locked"

  install -d -o root -g root -m 0755 /srv/jailer
  [[ "$(stat -c '%a:%u:%g' /srv/jailer)" == "755:0:0" ]] \
    || die "managed jailer chroot base must be root-owned mode 0755"
}

# --------------------------------------------------------------------------
# Preconditions
# --------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

case "${ARCH}" in
  x86_64 | aarch64) : ;;
  *) die "unsupported arch '${ARCH}', expected x86_64 or aarch64" ;;
esac
log "Target arch: ${ARCH}"

for digest in \
  "${NEHEMIAH_FIRECRACKER_SHA256}" "${NEHEMIAH_KERNEL_SHA256}" \
  "${NEHEMIAH_FIRECRACKER_INSTALLED_SHA256}" "${NEHEMIAH_JAILER_INSTALLED_SHA256}" \
  "${NEHEMIAH_RUNTIME_PYTHON_SHA256}" "${NEHEMIAH_RUNTIME_DESKTOP_SHA256}"; do
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || die "signed manifest contains an invalid SHA-256"
done
for asset in "${NEHEMIAH_FIRECRACKER_ARCHIVE}" "${NEHEMIAH_KERNEL_IMAGE}"; do
  [[ -f "${asset}" && ! -L "${asset}" && -s "${asset}" ]] \
    || die "signed release runtime input is missing or unsafe"
done
[[ "$(stat -c %s "${NEHEMIAH_FIRECRACKER_ARCHIVE}")" -le 16777216 ]] \
  || die "signed release Firecracker archive exceeds its size policy"
[[ "$(stat -c %s "${NEHEMIAH_KERNEL_IMAGE}")" -le 67108864 ]] \
  || die "signed release kernel exceeds its size policy"

ASSET_WORK="$(mktemp -d /var/tmp/nehemiah-assets.XXXXXX)"
trap 'rm -rf -- "${ASSET_WORK}"' EXIT

# --------------------------------------------------------------------------
# 1. Signed offline package cohort
# --------------------------------------------------------------------------
package_arch=amd64
[[ "$ARCH" == aarch64 ]] && package_arch=arm64
python3 /opt/boring/bin/managed-host-packages verify-installed \
  --arch "$package_arch" --release-version "$NEHEMIAH_RELEASE_VERSION" \
  || die "signed managed-host package cohort is missing or has drifted"
log "Signed offline package cohort verified."

# --------------------------------------------------------------------------
# 2. KVM verification + ip_forward
# --------------------------------------------------------------------------
log "Verifying KVM support..."
[ -e /dev/kvm ] || die "/dev/kvm not present - box lacks nested/hardware virtualization"
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  warn "/dev/kvm not read/write for root? continuing"
fi

if grep -Eqw '(vmx|svm)' /proc/cpuinfo; then
  log "CPU virtualization extensions (vmx/svm) present."
else
  warn "No vmx/svm flag in /proc/cpuinfo; firecracker may still work if /dev/kvm is functional."
fi

log "Enabling net.ipv4.ip_forward..."
sysctl -w net.ipv4.ip_forward=1 >/dev/null
# Persist across reboots (idempotent).
if [ -d /etc/sysctl.d ]; then
  cat > /etc/sysctl.d/99-nehemiah.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.default.send_redirects=0
net.ipv4.conf.all.route_localnet=0
net.ipv4.conf.default.route_localnet=0
kernel.unprivileged_bpf_disabled=1
fs.protected_fifos=2
fs.protected_regular=2
EOF
fi

# --------------------------------------------------------------------------
# 3. Directory layout
# --------------------------------------------------------------------------
log "Creating ${NEHEMIAH_ROOT} layout..."
mkdir -p "${BIN_DIR}" "${KERNEL_DIR}" "${ROOTFS_DIR}" "${RUN_DIR}" "${TEMPLATE_DIR}"
install -d -m0700 /var/lib/nehemiahd

# Jailer prerequisites: the chroot base + the first unprivileged uid/gid in the
# per-machine pool. Without these, jailed boots fail with
# "Canonicalize(/srv/jailer)" / "fc.sock did not appear".
ensure_boringjail_account

# --------------------------------------------------------------------------
# 4. Install firecracker + jailer
# --------------------------------------------------------------------------
install_firecracker() {
  local extracted="${ASSET_WORK}/firecracker"
  mkdir -p "${extracted}"
  log "Installing the retained signed-release Firecracker archive..."
  printf '%s  %s\n' "${NEHEMIAH_FIRECRACKER_SHA256}" "${NEHEMIAH_FIRECRACKER_ARCHIVE}" \
    | sha256sum --check --strict --status \
    || die "signed release Firecracker checksum verification failed"
  python3 - "${NEHEMIAH_FIRECRACKER_ARCHIVE}" "${extracted}" <<'PY'
import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if not members or len(members) > 128 or sum(member.size for member in members) > 256 * 1024 * 1024:
        raise SystemExit("Firecracker archive exceeds extraction bounds")
    seen = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        canonical = str(path)
        if (
            path.is_absolute()
            or ".." in path.parts
            or canonical in seen
            or not (member.isdir() or member.isfile())
        ):
            raise SystemExit("Firecracker archive contains an unsafe entry")
        seen.add(canonical)
    bundle.extractall(destination, members=members, filter="data")
PY

  local -a firecracker_bins jailer_bins
  mapfile -t firecracker_bins < <(find "${extracted}" -type f -name "firecracker-*-${ARCH}" ! -name '*.debug' | sort)
  mapfile -t jailer_bins < <(find "${extracted}" -type f -name "jailer-*-${ARCH}" ! -name '*.debug' | sort)
  [ "${#firecracker_bins[@]}" -eq 1 ] || die "Firecracker archive has an unexpected binary set"
  [ "${#jailer_bins[@]}" -eq 1 ] || die "Firecracker archive has an unexpected jailer set"
  local fc_bin="${firecracker_bins[0]}"
  local jail_bin="${jailer_bins[0]}"
  [[ "$(sha256sum "$fc_bin" | cut -d' ' -f1)" == "$NEHEMIAH_FIRECRACKER_INSTALLED_SHA256" ]] \
    || die "installed Firecracker digest does not match the signed cohort"
  [[ "$(sha256sum "$jail_bin" | cut -d' ' -f1)" == "$NEHEMIAH_JAILER_INSTALLED_SHA256" ]] \
    || die "installed jailer digest does not match the signed cohort"
  local expected_machine="x86-64"
  [[ "${ARCH}" == aarch64 ]] && expected_machine="ARM aarch64"
  for binary in "${fc_bin}" "${jail_bin}"; do
    local description
    description="$(file -b "${binary}")"
    [[ "${description}" == *"ELF 64-bit LSB"* && \
        "${description}" == *"${expected_machine}"* ]] \
      || die "Firecracker archive contains a wrong-architecture binary"
  done

  install -m 0755 "${fc_bin}" "${BIN_DIR}/firecracker"
  install -m 0755 "${jail_bin}" "${BIN_DIR}/jailer"

  log "firecracker installed: $("${BIN_DIR}/firecracker" --version | head -n1)"
}
install_firecracker

# --------------------------------------------------------------------------
# 5. Install the retained uncompressed Firecracker-compatible kernel
# --------------------------------------------------------------------------
kernel_is_valid() {
  local path="$1"
  [ -s "${path}" ] || return 1
  local desc
  desc="$(file -b "${path}" 2>/dev/null || true)"
  if [[ "${ARCH}" == x86_64 ]]; then
    [[ "${desc}" == *"Linux kernel x86 boot executable"* || \
        ( "${desc}" == *"ELF 64-bit LSB"* && "${desc}" == *"x86-64"* ) ]]
  else
    [[ "${desc}" == *"Linux kernel ARM64 boot executable"* || \
        ( "${desc}" == *"ELF 64-bit LSB"* && "${desc}" == *"ARM aarch64"* ) ]]
  fi
}

install_kernel() {
  log "Installing the retained signed-release guest kernel..."
  printf '%s  %s\n' "${NEHEMIAH_KERNEL_SHA256}" "${NEHEMIAH_KERNEL_IMAGE}" \
    | sha256sum --check --strict --status \
    || die "signed release kernel checksum verification failed"
  kernel_is_valid "${NEHEMIAH_KERNEL_IMAGE}" \
    || die "signed release kernel has an invalid architecture or executable format"
  install -m 0644 "${NEHEMIAH_KERNEL_IMAGE}" "${KERNEL_PATH}"
  log "Kernel installed: $(file -b "${KERNEL_PATH}")"
}
install_kernel

# --------------------------------------------------------------------------
# 6. Require both signed guest images
# --------------------------------------------------------------------------
rootfs_is_ext4() {
  local image="$1" magic
  [[ -f "$image" && ! -L "$image" && -s "$image" ]] || return 1
  magic="$(dd if="$image" bs=1 skip=1080 count=2 status=none | od -An -tx1 | tr -d ' \n')"
  [[ "$magic" == 53ef ]] || return 1
  file -b "$image" | grep -q 'ext4 filesystem data'
}
for image_and_digest in \
  "${ROOTFS_DIR}/rootfs.ext4:${NEHEMIAH_RUNTIME_PYTHON_SHA256}" \
  "${ROOTFS_DIR}/desktop.ext4:${NEHEMIAH_RUNTIME_DESKTOP_SHA256}"; do
  image="${image_and_digest%%:*}"
  expected_digest="${image_and_digest##*:}"
  rootfs_is_ext4 "$image" \
    || die "required signed guest image is missing or invalid: $image"
  [[ "$(sha256sum "$image" | cut -d' ' -f1)" == "$expected_digest" ]] \
    || die "required signed guest image checksum mismatch: $image"
  e2fsck -fn "$image" >/dev/null \
    || die "required signed guest image failed filesystem validation: $image"
done

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
  desktop     : ${ROOTFS_DIR}/desktop.ext4 ($(du -h "${ROOTFS_DIR}/desktop.ext4" 2>/dev/null | cut -f1))
  run dir     : ${RUN_DIR}
  templates   : ${TEMPLATE_DIR}
============================================================================

BANNER
log "Done."

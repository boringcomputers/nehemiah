#!/usr/bin/env bash
#
# build-rootfs.sh - LOCAL DEVELOPMENT ONLY: build a mutable Alpine rootfs.
# Managed hosts must install signed release ext4 artifacts through cloud-init;
# this script deliberately refuses the old managed/minimal profile.
#
# Produces /opt/boring/rootfs/rootfs.ext4 :
#   * ~512MB ext4 image
#   * Caller-provided Alpine minirootfs plus mutable local apk/npm packages
#   * /etc/inittab that boots an interactive /bin/sh on ttyS0 and prints
#     the "NEHEMIAH_READY" marker (required by nehemiahd for boot_ms timing)
#
# Run as root. Idempotent: rebuilds the image from scratch each run.
#
set -euo pipefail

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
NEHEMIAH_ROOT="/opt/boring"
ROOTFS_DIR="${NEHEMIAH_ROOT}/rootfs"
IMG="${ROOTFS_DIR}/rootfs.ext4"
IMG_SIZE_MB="${IMG_SIZE_MB:-1280}" # room for opt-in local development packages
GUEST_AGENT_BIN="${GUEST_AGENT_BIN:-${NEHEMIAH_ROOT}/bin/bc-guest-agent}"

ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine"
ALPINE_BRANCH="${ALPINE_BRANCH:-v3.20}"
ALPINE_MINIROOTFS_TARBALL="${ALPINE_MINIROOTFS_TARBALL:-}"
NEHEMIAH_MANAGED_ROOTFS="${NEHEMIAH_MANAGED_ROOTFS:-0}"

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
log()  { printf '\033[1;34m[rootfs]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[rootfs:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[rootfs:error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -x "${GUEST_AGENT_BIN}" ] || die "guest agent not found at ${GUEST_AGENT_BIN} (build guest-agent first)"
[ -f "${ALPINE_MINIROOTFS_TARBALL}" ] \
  || die "ALPINE_MINIROOTFS_TARBALL must name a previously checksum-verified archive"
[[ "${NEHEMIAH_MANAGED_ROOTFS}" == 0 ]] \
  || die "managed rootfs builds are forbidden; install signed release images via cloud-init"

# --------------------------------------------------------------------------
# Working state + cleanup trap
# --------------------------------------------------------------------------
WORK="$(mktemp -d /tmp/boring-rootfs.XXXXXX)"
MNT="${WORK}/mnt"
mkdir -p "${MNT}"

cleanup() {
  local rc=$?
  # Unmount pseudo filesystems first (reverse order), then the image itself.
  # '|| true' everywhere so cleanup never masks the real exit code / never fails.
  umount -R "${MNT}/proc" 2>/dev/null || true
  umount -R "${MNT}/sys"  2>/dev/null || true
  umount -R "${MNT}/dev"  2>/dev/null || true
  if mountpoint -q "${MNT}" 2>/dev/null; then
    umount "${MNT}" 2>/dev/null || umount -l "${MNT}" 2>/dev/null || true
  fi
  rm -rf "${WORK}" 2>/dev/null || true
  return $rc
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------
# 1. Create + format ext4 image
# --------------------------------------------------------------------------
mkdir -p "${ROOTFS_DIR}"
log "Creating ${IMG_SIZE_MB}MB ext4 image at ${IMG}..."
rm -f "${IMG}"
# Sparse allocation; ext4 without a journal keeps the image lean and fast.
dd if=/dev/zero of="${IMG}" bs=1M count=0 seek="${IMG_SIZE_MB}" status=none
mkfs.ext4 -q -F -O ^has_journal "${IMG}"

log "Mounting image..."
mount -o loop "${IMG}" "${MNT}"

# --------------------------------------------------------------------------
# 2. Extract the checksum-verified minirootfs
# --------------------------------------------------------------------------
log "Extracting minirootfs into image..."
tar -xzf "${ALPINE_MINIROOTFS_TARBALL}" -C "${MNT}"
install -D -m0755 "${GUEST_AGENT_BIN}" "${MNT}/usr/local/sbin/bc-guest-agent"

# --------------------------------------------------------------------------
# 3. Configure inside a chroot
# --------------------------------------------------------------------------
log "Configuring guest (resolv.conf, inittab, root passwd)..."

# DNS for apk inside the chroot.
cp -f /etc/resolv.conf "${MNT}/etc/resolv.conf"

# Mount pseudo filesystems required by apk / chroot.
mount -t proc   proc   "${MNT}/proc"
mount -t sysfs  sysfs  "${MNT}/sys"
mount --bind    /dev   "${MNT}/dev"

# Local prototype-only profile. It is not used by signed managed cloud-init.
mkdir -p "${MNT}/etc/apk"
cat > "${MNT}/etc/apk/repositories" <<EOF
${ALPINE_MIRROR}/${ALPINE_BRANCH}/main
${ALPINE_MIRROR}/${ALPINE_BRANCH}/community
EOF
chroot "${MNT}" /bin/sh -eux <<'CHROOT_EOF'
apk update
apk add --no-cache python3 py3-pip nodejs npm curl git
npm install -g @anthropic-ai/claude-code || true
passwd -d root || true
[ -e /dev/ttyS0 ] || mknod /dev/ttyS0 c 4 64 || true
CHROOT_EOF

# Unmount pseudo fs now that chroot work is done (before writing inittab is fine
# either way, but keep the mounted window minimal).
umount "${MNT}/proc" 2>/dev/null || true
umount "${MNT}/sys"  2>/dev/null || true
umount "${MNT}/dev"  2>/dev/null || true

# --------------------------------------------------------------------------
# 4. Guest-agent supervisor + inittab. The serial marker is emitted only after
#    the guest agent has bound AF_VSOCK and written its readiness file.
# --------------------------------------------------------------------------
log "Writing guest-agent supervisor..."
cat > "${MNT}/sbin/bc-guest-agent-supervisor" <<'SUPERVISOR_EOF'
#!/bin/sh
while true; do
  rm -f /run/bc-guest-agent.ready
  /usr/local/sbin/bc-guest-agent >>/var/log/bc-guest-agent.log 2>&1
  sleep 1
done
SUPERVISOR_EOF
chmod +x "${MNT}/sbin/bc-guest-agent-supervisor"

log "Writing /etc/inittab..."
cat > "${MNT}/etc/inittab" <<'INITTAB_EOF'
::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/bin/mount -t devtmpfs devtmpfs /dev
::sysinit:/bin/mkdir -p /dev/pts /run /var/log
::sysinit:/bin/mount -t devpts devpts /dev/pts
::sysinit:/bin/hostname boring
::sysinit:/bin/sh -c '/sbin/bc-guest-agent-supervisor &'
::sysinit:/bin/sh -c 'i=0; while [ ! -e /run/bc-guest-agent.ready ] && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.05; done; [ -e /run/bc-guest-agent.ready ] && echo NEHEMIAH_READY > /dev/ttyS0 || echo "guest agent failed to become ready" > /dev/ttyS0'
ttyS0::respawn:/bin/sh -l
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
INITTAB_EOF

# Nice-to-have: a minimal hostname file + friendly PS1.
echo "boring" > "${MNT}/etc/hostname"

# --------------------------------------------------------------------------
# 5. Unmount cleanly (trap will also handle this on failure)
# --------------------------------------------------------------------------
log "Syncing and unmounting..."
sync
umount "${MNT}"

# Sanity: fsck the freshly built image (non-fatal).
e2fsck -fy "${IMG}" >/dev/null 2>&1 || warn "e2fsck reported issues on ${IMG}"

log "Base rootfs built: ${IMG} ($(du -h "${IMG}" | cut -f1))"
log "Done."

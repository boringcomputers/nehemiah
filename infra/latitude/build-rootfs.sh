#!/usr/bin/env bash
#
# build-rootfs.sh - Build the base Alpine ext4 rootfs for boring microVMs.
#
# Produces /opt/boring/rootfs/rootfs.ext4 :
#   * ~512MB ext4 image
#   * Alpine minirootfs (busybox init) with python3 installed
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
IMG_SIZE_MB="${IMG_SIZE_MB:-1280}"   # room for the Claude Code CLI

ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine"
ALPINE_BRANCH="${ALPINE_BRANCH:-v3.20}"     # 3.x series
ALPINE_ARCH="$(uname -m)"     # x86_64 / aarch64 — matches Alpine's arch naming

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
log()  { printf '\033[1;34m[rootfs]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[rootfs:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[rootfs:error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

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
# 1. Resolve + download alpine minirootfs
# --------------------------------------------------------------------------
log "Resolving latest alpine-minirootfs for ${ALPINE_BRANCH}/${ALPINE_ARCH}..."
RELEASES_URL="${ALPINE_MIRROR}/${ALPINE_BRANCH}/releases/${ALPINE_ARCH}"

# Parse the release index for the newest alpine-minirootfs-*.tar.gz filename.
TARBALL="$(curl -fsSL "${RELEASES_URL}/" \
  | grep -oE 'alpine-minirootfs-[0-9][0-9.]*-'"${ALPINE_ARCH}"'\.tar\.gz' \
  | sort -V | tail -n1)"
[ -n "${TARBALL}" ] || die "could not find an alpine-minirootfs tarball at ${RELEASES_URL}/"
log "Selected: ${TARBALL}"

MINIROOT_TGZ="${WORK}/${TARBALL}"
log "Downloading ${RELEASES_URL}/${TARBALL}"
curl -fSL --retry 3 -o "${MINIROOT_TGZ}" "${RELEASES_URL}/${TARBALL}" \
  || die "failed to download alpine minirootfs"

# --------------------------------------------------------------------------
# 2. Create + format ext4 image
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
# 3. Extract minirootfs
# --------------------------------------------------------------------------
log "Extracting minirootfs into image..."
tar -xzf "${MINIROOT_TGZ}" -C "${MNT}"

# --------------------------------------------------------------------------
# 4. Configure inside a chroot
# --------------------------------------------------------------------------
log "Configuring guest (resolv.conf, python3, inittab, root passwd)..."

# DNS for apk inside the chroot.
cp -f /etc/resolv.conf "${MNT}/etc/resolv.conf"

# Configure apk repositories explicitly (main + community) so python3 resolves.
mkdir -p "${MNT}/etc/apk"
cat > "${MNT}/etc/apk/repositories" <<EOF
${ALPINE_MIRROR}/${ALPINE_BRANCH}/main
${ALPINE_MIRROR}/${ALPINE_BRANCH}/community
EOF

# Mount pseudo filesystems required by apk / chroot.
mount -t proc   proc   "${MNT}/proc"
mount -t sysfs  sysfs  "${MNT}/sys"
mount --bind    /dev   "${MNT}/dev"

# Install python3. Use the host's chroot (Alpine's busybox provides /bin/sh).
chroot "${MNT}" /bin/sh -eux <<'CHROOT_EOF'
apk update
apk add --no-cache python3 py3-pip nodejs npm curl git
# Claude Code CLI, preinstalled so `claude` is ready in every shell (users bring
# their own ANTHROPIC_API_KEY). Best-effort: don't fail the whole image if npm hiccups.
npm install -g @anthropic-ai/claude-code || true
# Blank root password for demo convenience.
passwd -d root || true
# Ensure ttyS0 device node exists even if devtmpfs is late.
[ -e /dev/ttyS0 ] || mknod /dev/ttyS0 c 4 64 || true
CHROOT_EOF

# Unmount pseudo fs now that chroot work is done (before writing inittab is fine
# either way, but keep the mounted window minimal).
umount "${MNT}/proc" 2>/dev/null || true
umount "${MNT}/sys"  2>/dev/null || true
umount "${MNT}/dev"  2>/dev/null || true

# --------------------------------------------------------------------------
# 5. inittab - busybox init reads this. NEHEMIAH_READY marker is REQUIRED.
# --------------------------------------------------------------------------
log "Writing /etc/inittab..."
cat > "${MNT}/etc/inittab" <<'INITTAB_EOF'
::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/bin/mount -t devtmpfs devtmpfs /dev
::sysinit:/bin/hostname boring
::sysinit:/bin/sh -c 'echo NEHEMIAH_READY > /dev/ttyS0'
ttyS0::respawn:/bin/sh -l
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
INITTAB_EOF

# Nice-to-have: a minimal hostname file + friendly PS1.
echo "boring" > "${MNT}/etc/hostname"

# --------------------------------------------------------------------------
# 6. Unmount cleanly (trap will also handle this on failure)
# --------------------------------------------------------------------------
log "Syncing and unmounting..."
sync
umount "${MNT}"

# Sanity: fsck the freshly built image (non-fatal).
e2fsck -fy "${IMG}" >/dev/null 2>&1 || warn "e2fsck reported issues on ${IMG}"

log "Base rootfs built: ${IMG} ($(du -h "${IMG}" | cut -f1))"
log "Done."

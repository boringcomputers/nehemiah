#!/usr/bin/env bash
#
# build-desktop-rootfs.sh - Build the "desktop" ext4 rootfs for Nehemiah.
#
# A minimal Debian rootfs that boots straight into a headless X session
# (Xvfb + openbox + xterm + xclock) served over VNC, and bridges the VNC port
# out over vsock so the host (nehemiahd) can reach it without any guest networking:
#
#     browser ⟶ nehemiahd /vnc WS ⟶ vsock:5900 ⟶ socat ⟶ x11vnc(127.0.0.1:5900) ⟶ Xvfb :0
#
# Produces /opt/boring/rootfs/desktop.ext4. Run as root on the box.
#
set -euo pipefail

NEHEMIAH_ROOT="/opt/boring"
ROOTFS_DIR="${NEHEMIAH_ROOT}/rootfs"
IMG="${ROOTFS_DIR}/desktop.ext4"
IMG_SIZE_MB="${IMG_SIZE_MB:-6144}"   # room for chromium + node + coding agents
SUITE="${SUITE:-bookworm}"
MIRROR="${MIRROR:-http://deb.debian.org/debian}"
# xcalc/xclock come from x11-apps; figlet for banners. (galculator was dropped —
# its GTK/dconf-service chain breaks a minbase debootstrap.) chromium + node +
# the coding-agent CLIs are installed in the chroot below, not via debootstrap.
PKGS="xvfb,x11vnc,openbox,xterm,x11-xserver-utils,xfonts-base,x11-apps,fonts-liberation,figlet,socat,ca-certificates,curl,git,xz-utils,procps,iproute2"

log()  { printf '\033[1;34m[desktop]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[desktop:error]\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root"

WORK="$(mktemp -d /tmp/boring-desktop.XXXXXX)"
MNT="${WORK}/mnt"
mkdir -p "${MNT}"
cleanup() {
  local rc=$?
  umount -R "${MNT}/proc" 2>/dev/null || true
  umount -R "${MNT}/sys" 2>/dev/null || true
  umount -R "${MNT}/dev" 2>/dev/null || true
  mountpoint -q "${MNT}" 2>/dev/null && { umount "${MNT}" 2>/dev/null || umount -l "${MNT}" 2>/dev/null || true; }
  rm -rf "${WORK}" 2>/dev/null || true
  return $rc
}
trap cleanup EXIT INT TERM

mkdir -p "${ROOTFS_DIR}"
log "Creating ${IMG_SIZE_MB}MB ext4 image at ${IMG}..."
rm -f "${IMG}"
dd if=/dev/zero of="${IMG}" bs=1M count=0 seek="${IMG_SIZE_MB}" status=none
mkfs.ext4 -q -F -O ^has_journal "${IMG}"
mount -o loop "${IMG}" "${MNT}"

log "debootstrap ${SUITE} (minbase + desktop packages)..."
debootstrap --variant=minbase --include="${PKGS}" "${SUITE}" "${MNT}" "${MIRROR}" \
  || die "debootstrap failed"

log "Configuring guest (chromium + node 22 + coding agents)..."
cp -f /etc/resolv.conf "${MNT}/etc/resolv.conf"   # DNS for apt/npm inside chroot
mount -t proc proc "${MNT}/proc"
mount -t sysfs sysfs "${MNT}/sys"
mount --bind /dev "${MNT}/dev"
mount -t devpts devpts "${MNT}/dev/pts" 2>/dev/null || true   # apt/chromium postinst want it

chroot "${MNT}" /bin/sh -eux <<'CHROOT_EOF'
export DEBIAN_FRONTEND=noninteractive
passwd -d root || true
echo boring > /etc/hostname

# A real browser for the desktop.
apt-get update
apt-get install -y --no-install-recommends chromium

# Node 22 (glibc) from the official tarball — the coding-agent CLIs need >=22.
# Node names the arch x64/arm64 (not x86_64/aarch64), so map from uname.
NODE_ARCH=$(uname -m); [ "$NODE_ARCH" = "x86_64" ] && NODE_ARCH=x64; [ "$NODE_ARCH" = "aarch64" ] && NODE_ARCH=arm64
NODEFILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v22\.[0-9.]+-linux-'"$NODE_ARCH"'\.tar\.xz' | head -1)
curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODEFILE}" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm -f /tmp/node.tar.xz
export PATH=/usr/local/bin:$PATH

# Coding-agent CLIs (users bring their own keys). Best-effort each so one flaky
# postinstall doesn't sink the whole image.
npm install -g @anthropic-ai/claude-code || true
npm install -g @openai/codex || true
npm install -g --ignore-scripts @earendil-works/pi-coding-agent || true
# Cursor ships its own installer (no npm package); it drops cursor-agent under
# ~/.local — symlink it onto PATH.
curl https://cursor.com/install -fsS | bash || true
CA=$(find /root -name cursor-agent -type f 2>/dev/null | head -1); [ -n "$CA" ] && ln -sf "$CA" /usr/local/bin/cursor-agent || true

apt-get clean
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /tmp/* 2>/dev/null || true
CHROOT_EOF

# --- PID1 startup: bring up X + VNC + vsock bridge, print the boot marker -----
log "Installing /sbin/boring-init..."
cat > "${MNT}/sbin/boring-init" <<'INIT_EOF'
#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null
mount -t tmpfs tmpfs /tmp 2>/dev/null
mount -t tmpfs tmpfs /run 2>/dev/null
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts 2>/dev/null  # xterm needs ptys
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
hostname boring 2>/dev/null
# Firecracker guests boot with loopback DOWN; x11vnc + socat talk over 127.0.0.1.
ip link set lo up 2>/dev/null || true
# eth0 is configured by the kernel (ip=dhcp); publish its DNS so the browser works.
cat /proc/net/pnp > /etc/resolv.conf 2>/dev/null || echo "nameserver 1.1.1.1" > /etc/resolv.conf
export HOME=/root DISPLAY=:0

Xvfb :0 -screen 0 1280x800x24 -ac -nolisten tcp >/var/log/xvfb.log 2>&1 &
i=0; while [ ! -S /tmp/.X11-unix/X0 ] && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.1; done

xsetroot -solid "#0b0b0c" 2>/dev/null
openbox >/var/log/openbox.log 2>&1 &
# chromium needs a system dbus; start one (harmless if already up).
dbus-uuidgen --ensure 2>/dev/null || true
mkdir -p /run/dbus && dbus-daemon --system --fork 2>/dev/null || true
# A real browser (main window), a dev terminal that advertises the coding agents,
# and the calculator (kept for the computer-use agent demo). xcalc honours -geometry.
# Call the real ELF, not /usr/bin/chromium: Debian's launcher wrapper aborts on
# arm64 ("[: -lt: unexpected operator"). Same path on x86_64, so it's arch-neutral.
CHROMIUM_BIN=/usr/lib/chromium/chromium; [ -x "$CHROMIUM_BIN" ] || CHROMIUM_BIN=chromium
"$CHROMIUM_BIN" --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu --no-first-run \
  --disable-features=Translate --password-store=basic --user-data-dir=/root/.chromium \
  --window-size=900,600 --window-position=16,20 https://duckduckgo.com >/var/log/chromium.log 2>&1 &
xterm -fa "DejaVu Sans Mono" -fs 10 -geometry 108x13+16+648 -bg "#0e0e0e" -fg "#ededed" \
  -title "Nehemiah" -e /bin/sh -c 'echo "Nehemiah . desktop microVM"; echo "coding agents ready:  claude   codex   cursor-agent   pi   (bring your own key)"; echo; exec /bin/sh' >/dev/null 2>&1 &
xcalc -geometry 300x400+956+20 >/var/log/xcalc.log 2>&1 &
# -threads: serve input + framebuffer concurrently (responsive input). -defer 10:
# send updates ~10ms after a change (low latency). Keep -noxdamage — Xvfb's DAMAGE
# misses some initial window paints, so we poll the framebuffer instead.
x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -noxdamage -threads -defer 10 -quiet >/var/log/x11vnc.log 2>&1 &

# Bridge guest vsock port 5900 -> local VNC. The host connects via the vsock UDS.
socat VSOCK-LISTEN:5900,fork,reuseaddr TCP:127.0.0.1:5900 >/var/log/socat.log 2>&1 &

echo NEHEMIAH_READY > /dev/ttyS0
exec /bin/sh
INIT_EOF
chmod +x "${MNT}/sbin/boring-init"

umount "${MNT}/dev/pts" 2>/dev/null || true   # nested under /dev; unmount first
umount "${MNT}/proc" 2>/dev/null || true
umount "${MNT}/sys" 2>/dev/null || true
umount "${MNT}/dev" 2>/dev/null || true

sync
umount "${MNT}" 2>/dev/null || umount -l "${MNT}"
e2fsck -fy "${IMG}" >/dev/null 2>&1 || true
log "Desktop rootfs built: ${IMG} ($(du -h "${IMG}" | cut -f1))"

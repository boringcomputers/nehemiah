#!/usr/bin/env bash
#
# setup-local.sh — run a full Nehemiah host locally on an Apple Silicon
# Mac, inside a Lima nested-virt Linux VM (which is where /dev/kvm lives).
#
# From the repo root on your Mac:
#   NEHEMIAH_ANTHROPIC_KEY=sk-ant-...  ./infra/local/setup-local.sh
#
# What it does: ensures the Lima VM, cross-builds nehemiahd for linux/arm64 on the
# Mac, ships the infra scripts + binary into the guest, runs bootstrap + the
# arm64 image builds + networking + nehemiahd there, and forwards port 8080 back to
# the Mac. Then point apps/web/.env at http://localhost:8080 and `npm run dev`.
#
# Options (env): SKIP_DESKTOP=1 (skip the ~8-min desktop image), NEHEMIAH_TOKEN,
#   NEHEMIAH_S3_* (persistent volumes), VM=<lima instance name> (default: boring).
#
set -euo pipefail

VM="${VM:-boring}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIMA_YAML="${REPO_ROOT}/infra/local/lima-boring.yaml"

log()  { printf '\033[1;34m[local]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[local:error]\033[0m %s\n' "$*" >&2; exit 1; }
invm() { limactl shell "${VM}" -- sudo bash -c "$*"; }

# --- local bootstrap is descoped --------------------------------------------
# bootstrap.sh installs Firecracker/jailer/kernel only from signed managed-release
# artifacts, which this Lima flow cannot supply. Provision managed hosts with
# infra/latitude/provision.sh + cloud-init. Set NEHEMIAH_ALLOW_UNMANAGED_BOOTSTRAP=1
# only if the guest already carries the signed release inputs.
[ "${NEHEMIAH_ALLOW_UNMANAGED_BOOTSTRAP:-}" = "1" ] || die "local bootstrap is unsupported — bootstrap.sh installs only from signed managed-release artifacts (see infra/latitude/README.md). Set NEHEMIAH_ALLOW_UNMANAGED_BOOTSTRAP=1 to override only if the guest already carries the signed release inputs."

# --- 0. host preflight -------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "this script is for a Mac host; on Linux use infra/setup.sh directly"
command -v limactl >/dev/null || die "Lima not installed — run: brew install lima"
command -v go >/dev/null || die "Go not installed on the Mac (needed to cross-build nehemiahd) — brew install go"

# --- 1. ensure the Lima nested-virt VM --------------------------------------
if ! limactl list -q 2>/dev/null | grep -qx "${VM}"; then
	log "Creating Lima VM '${VM}' (nested-virt arm64 Ubuntu)…"
	limactl start --name="${VM}" --tty=false "${LIMA_YAML}"
elif [ "$(limactl list --format '{{.Status}}' "${VM}" 2>/dev/null)" != "Running" ]; then
	log "Starting Lima VM '${VM}'…"
	limactl start "${VM}"
else
	log "Lima VM '${VM}' already running."
fi

# --- 2. make-or-break: /dev/kvm in the guest --------------------------------
log "Checking /dev/kvm inside the guest…"
invm 'test -e /dev/kvm' || die "/dev/kvm missing in the guest — nested virtualization isn't working"
GUEST_ARCH="$(limactl shell "${VM}" -- uname -m)"
log "  ok: guest is ${GUEST_ARCH} with /dev/kvm"

# --- 3. cross-build the host and guest agents for the nested VM ---------------
log "Cross-building nehemiahd + guest agent for linux/${GUEST_ARCH}…"
GOARCH="arm64"; [ "${GUEST_ARCH}" = "x86_64" ] && GOARCH="amd64"
( cd "${REPO_ROOT}/nehemiahd" && GOOS=linux GOARCH="${GOARCH}" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tmp/nehemiahd-local . )
( cd "${REPO_ROOT}/guest-agent" && GOOS=linux GOARCH="${GOARCH}" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tmp/bc-guest-agent-local . )
log "  built $(file -b /tmp/nehemiahd-local | cut -d, -f1-2)"

# --- 4. ship infra scripts + nehemiahd binary into the guest ------------------
log "Shipping infra scripts + nehemiahd/guest agent into the guest…"
invm 'mkdir -p /root/infra /opt/boring/bin'
tar czf - -C "${REPO_ROOT}/infra/latitude" . | limactl shell "${VM}" -- sudo tar xzf - -C /root/infra
limactl shell "${VM}" -- sudo cp /dev/stdin /usr/local/bin/nehemiahd < /tmp/nehemiahd-local
limactl shell "${VM}" -- sudo cp /dev/stdin /opt/boring/bin/bc-guest-agent < /tmp/bc-guest-agent-local
invm 'chmod +x /usr/local/bin/nehemiahd'
invm 'chmod +x /opt/boring/bin/bc-guest-agent'
invm 'ln -sfn /usr/local/bin/nehemiahd /usr/local/bin/boringd'   # pre-rename name keeps working

# --- 5. build the stack in the guest (arch-adapted scripts auto-detect) ------
log "bootstrap (firecracker + jailer + kernel + base rootfs)…"
invm 'bash /root/infra/bootstrap.sh'
# (bootstrap.sh already calls build-rootfs.sh — no separate invocation needed)
log "python snapshot template (~3ms restore; non-fatal — cold boot works without it)…"
invm 'bash /root/infra/build-template.sh python' || log "  snapshot template unavailable on ${GUEST_ARCH} — python will cold-boot instead"
if [ "${SKIP_DESKTOP:-}" = "1" ]; then
	log "skipping desktop image (SKIP_DESKTOP=1)"
else
	log "desktop image (chromium + node + agents) — a few minutes…"
	invm 'bash /root/infra/build-desktop-rootfs.sh' || log "  desktop image build had issues (python shell still works)"
fi
log "guest networking (bridge + NAT + egress firewall)…"
invm 'install -m0755 /root/infra/net-setup.sh /opt/boring/bin/net-setup.sh && bash /opt/boring/bin/net-setup.sh && cp /root/infra/boring-net-local.service /etc/systemd/system/boring-net.service && systemctl daemon-reload && systemctl enable boring-net.service || true'

# --- 6. nehemiahd config + service (bind 0.0.0.0 so Lima can forward it) -------
log "installing nehemiahd service…"
invm "cp /root/infra/nehemiahd-local.service /etc/systemd/system/nehemiahd.service"
limactl shell "${VM}" -- sudo bash -c "install -d -m0755 /etc/boring && umask 077 && cat > /etc/boring/nehemiahd.env" <<EOF
NEHEMIAH_ADDR=0.0.0.0:8080
NEHEMIAH_ALLOW_PERSISTENT=1
NEHEMIAH_JAILER=1
NEHEMIAH_NET=1
NEHEMIAH_TOKEN=${NEHEMIAH_TOKEN:-}
NEHEMIAH_ANTHROPIC_KEY=${NEHEMIAH_ANTHROPIC_KEY:-}
NEHEMIAH_OPENROUTER_KEY=${NEHEMIAH_OPENROUTER_KEY:-}
NEHEMIAH_S3_ENDPOINT=${NEHEMIAH_S3_ENDPOINT:-}
NEHEMIAH_S3_KEY=${NEHEMIAH_S3_KEY:-}
NEHEMIAH_S3_SECRET=${NEHEMIAH_S3_SECRET:-}
NEHEMIAH_S3_BUCKET=${NEHEMIAH_S3_BUCKET:-boring-volumes}
NEHEMIAH_S3_REGION=${NEHEMIAH_S3_REGION:-}
NEHEMIAH_S3_SSL=${NEHEMIAH_S3_SSL:-}
EOF
invm 'systemctl daemon-reload && systemctl enable --now nehemiahd && sleep 2 && systemctl is-active nehemiahd'

# --- 7. verify -------------------------------------------------------------
# Read the forwarded host port from the Lima config (single source of truth) so
# the health check always matches the actual forward. Change the port by editing
# hostPort in lima-boring.yaml, not a separate override.
HOST_PORT="$(grep -oE 'hostPort:[[:space:]]*[0-9]+' "${LIMA_YAML}" | grep -oE '[0-9]+' | head -1)"
HOST_PORT="${HOST_PORT:-8088}"
log "Health check (Lima forwards guest :8080 → Mac 127.0.0.1:${HOST_PORT})…"
sleep 2
HEALTH="$(curl -s --max-time 8 http://127.0.0.1:${HOST_PORT}/healthz || true)"
echo "  ${HEALTH}"
# Verify it's actually nehemiahd (its healthz carries "kvm"), not some other local
# service that happens to answer on this port.
echo "${HEALTH}" | grep -q '"kvm"' || die "port ${HOST_PORT} on the Mac isn't nehemiahd (got: ${HEALTH:-nothing}) — is something else bound to it? change hostPort in ${LIMA_YAML} to a free port, then 'limactl stop ${VM}' and re-run."

log "Done. A Nehemiah host is running on your Mac (in the '${VM}' Lima VM)."
echo "  Point apps/web/.env at it:  NEHEMIAH_URL=http://localhost:${HOST_PORT} $( [ -n "${NEHEMIAH_TOKEN:-}" ] && echo "(+ NEHEMIAH_TOKEN)" )"
echo "  Then:  npm run dev -w web   → http://localhost:5173"
echo "  Stop the VM (frees RAM):  limactl stop ${VM}"

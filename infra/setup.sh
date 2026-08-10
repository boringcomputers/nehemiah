#!/usr/bin/env bash
#
# setup.sh — turn a fresh Ubuntu 24.04 box (x86_64 or arm64) with /dev/kvm into a
# running nehemiahd (the Nehemiah host daemon), end to end, from your laptop.
#
# Provider-agnostic: works on any such box you can root-SSH into (Latitude,
# Hetzner, a bare-metal, a nested-virt VM, …). Idempotent — safe to re-run.
#
#   NEHEMIAH_ANTHROPIC_KEY=sk-ant-... ./infra/setup.sh root@YOUR_BOX_IP
#
# Options (env vars):
#   NEHEMIAH_ANTHROPIC_KEY   powers the AI agents + inference gateway (recommended)
#   NEHEMIAH_TOKEN           require this bearer token on /v1/* (recommended if the
#                          endpoint is public; omit only behind an SSH tunnel)
#   NEHEMIAH_S3_ENDPOINT     S3 host for persistent volumes (+ _KEY/_SECRET/_BUCKET/
#                          _REGION/_SSL) — optional; omit to disable storage
#   SKIP_DESKTOP=1         skip the ~8-min desktop image build (browser + agents)
#   BIND_LOCALHOST=1       bind nehemiahd to 127.0.0.1 (reach it only via SSH tunnel)
#
set -euo pipefail

TARGET="${1:-}"
if [[ -z "${TARGET}" || "${TARGET}" == "-h" || "${TARGET}" == "--help" ]]; then
	grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
	exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new "${TARGET}")
GO_VERSION="1.25.0"

log() { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup:error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. preflight ------------------------------------------------------------
log "Preflight on ${TARGET}…"
"${SSH[@]}" 'true' || die "can't SSH to ${TARGET}"
eval "$("${SSH[@]}" 'echo ARCH=$(uname -m) KVM=$([ -e /dev/kvm ] && echo yes || echo no) ID=$(. /etc/os-release; echo $VERSION_ID)')"
case "${ARCH}" in
	x86_64) GOARCH="amd64" ;;
	aarch64) GOARCH="arm64" ;;
	*) die "box arch is ${ARCH}; nehemiahd needs x86_64 or aarch64" ;;
esac
[[ "${KVM}" == "yes" ]] || die "/dev/kvm missing — the box needs hardware/nested virtualization"
log "  ok: Ubuntu ${ID:-?} ${ARCH} with /dev/kvm"

# --- 1. ship infra scripts + nehemiahd source ----------------------------------
log "Copying infra scripts + nehemiahd source…"
"${SSH[@]}" 'mkdir -p /root/infra /opt/boring/src'
scp -q -o StrictHostKeyChecking=accept-new \
	"${REPO_ROOT}"/infra/latitude/*.sh "${REPO_ROOT}"/infra/latitude/*.service \
	"${REPO_ROOT}"/infra/latitude/Caddyfile "${TARGET}:/root/infra/"
rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
	--exclude '*_test.go' "${REPO_ROOT}/nehemiahd/" "${TARGET}:/opt/boring/src/"

# --- 2. install Go (matching go.mod) -----------------------------------------
log "Ensuring Go ${GO_VERSION}…"
"${SSH[@]}" bash -euo pipefail <<EOF
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION}"; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
fi
/usr/local/go/bin/go version
EOF

# --- 3. bootstrap: firecracker, jailer, kernel, base rootfs ------------------
log "Bootstrap (firecracker + jailer + kernel + base rootfs)…"
"${SSH[@]}" 'bash /root/infra/bootstrap.sh'

# --- 4. build the guest images + snapshot ------------------------------------
log "Building base rootfs (python + node + claude)…"
"${SSH[@]}" 'bash /root/infra/build-rootfs.sh'
log "Building the python snapshot template (~3ms restore)…"
"${SSH[@]}" 'bash /root/infra/build-template.sh python'
if [[ "${SKIP_DESKTOP:-}" == "1" ]]; then
	log "Skipping the desktop image (SKIP_DESKTOP=1)."
else
	log "Building the desktop image (chromium + node + coding agents) — a few minutes…"
	"${SSH[@]}" 'bash /root/infra/build-desktop-rootfs.sh'
fi

# --- 5. guest networking (bridge + NAT + egress firewall) --------------------
log "Setting up guest networking…"
"${SSH[@]}" bash -euo pipefail <<'EOF'
install -m0755 /root/infra/net-setup.sh /opt/boring/bin/net-setup.sh
bash /opt/boring/bin/net-setup.sh
cp /root/infra/boring-net.service /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload && systemctl enable boring-net.service 2>/dev/null || true
EOF

# --- 6. build + install nehemiahd, write env, start ----------------------------
log "Building + installing nehemiahd…"
"${SSH[@]}" bash -euo pipefail <<'EOF'
cd /opt/boring/src
CGO_ENABLED=0 /usr/local/go/bin/go build -trimpath -ldflags="-s -w" -o /usr/local/bin/nehemiahd .
ln -sfn /usr/local/bin/nehemiahd /usr/local/bin/boringd   # pre-rename name keeps working
cp /root/infra/nehemiahd.service /etc/systemd/system/nehemiahd.service
EOF

log "Writing config (secrets not printed)…"
ADDR="0.0.0.0:8080"; [[ "${BIND_LOCALHOST:-}" == "1" ]] && ADDR="127.0.0.1:8080"
# Private (localhost-bound) installs are single-owner, so no-TTL machines are
# safe to allow; a public bind leaves it off so it can't be drained.
ALLOW_PERSISTENT=0; [[ "${BIND_LOCALHOST:-}" == "1" ]] && ALLOW_PERSISTENT=1
"${SSH[@]}" "install -d -m0755 /etc/boring && umask 077 && cat > /etc/boring/nehemiahd.env" <<EOF
NEHEMIAH_ADDR=${ADDR}
NEHEMIAH_ALLOW_PERSISTENT=${ALLOW_PERSISTENT}
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

"${SSH[@]}" 'systemctl list-unit-files boringd.service >/dev/null 2>&1 && { systemctl disable --now boringd.service || true; rm -f /etc/systemd/system/boringd.service; }; systemctl daemon-reload && systemctl enable --now nehemiahd && sleep 2 && systemctl is-active nehemiahd'

# --- 7. verify ---------------------------------------------------------------
log "Health check…"
HEALTH="$("${SSH[@]}" 'curl -s --max-time 8 http://127.0.0.1:8080/healthz' || true)"
echo "  ${HEALTH}"
echo "${HEALTH}" | grep -q '"ok":true' || die "nehemiahd is up but /healthz didn't return ok — check: ssh ${TARGET} journalctl -u nehemiahd"

log "Done. nehemiahd is running on ${TARGET}."
if [[ "${BIND_LOCALHOST:-}" == "1" ]]; then
	echo "  It's bound to localhost — reach it with:  ssh -N -L 8080:localhost:8080 ${TARGET}"
	echo "  then set apps/web/.env: NEHEMIAH_URL=http://localhost:8080 (+ NEHEMIAH_TOKEN) and npm run dev -w web"
else
	echo "  Point the site at it: PUBLIC_NEHEMIAH_URL=http://<box-ip>:8080 (put it behind TLS for production)."
fi

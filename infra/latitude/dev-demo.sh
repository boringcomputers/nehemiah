#!/usr/bin/env bash
#
# dev-demo.sh — one command to run the hero with a LIVE microVM terminal.
#
#   npm run dev:demo
#
# Reads the box address + token from ~/.config/latitude, makes sure the SSH
# tunnel to nehemiahd is up, health-checks it, then starts the web app with the
# right env and opens the browser. No env vars to remember.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

CFG="${HOME}/.config/latitude"
LOCAL_PORT="${NEHEMIAH_LOCAL_PORT:-18080}"

ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
step() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Load box config + token ------------------------------------------------
[ -f "${CFG}/server.env" ] || die "${CFG}/server.env not found — provision the box first (see infra/latitude/README.md)"
# shellcheck disable=SC1090,SC1091
source "${CFG}/server.env"
[ -f "${CFG}/boring_token" ] || die "${CFG}/boring_token not found — set a token and redeploy nehemiahd"
TOKEN="$(cat "${CFG}/boring_token")"
: "${SERVER_IP:?SERVER_IP missing from server.env}"
: "${SSH_KEY:?SSH_KEY missing from server.env}"

# --- 2. Ensure the SSH tunnel: localhost:LOCAL_PORT -> box:8080 ----------------
if pgrep -f "${LOCAL_PORT}:localhost:8080" >/dev/null 2>&1 && \
   curl -fsS --max-time 4 "http://localhost:${LOCAL_PORT}/healthz" >/dev/null 2>&1; then
  ok "tunnel already up on :${LOCAL_PORT}"
else
  step "opening SSH tunnel  localhost:${LOCAL_PORT} → ${SERVER_IP}:8080"
  ssh -f -N -L "${LOCAL_PORT}:localhost:8080" -i "${SSH_KEY}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ExitOnForwardFailure=yes \
    "root@${SERVER_IP}" || die "tunnel failed — is the box up? (check: ssh -i ${SSH_KEY} root@${SERVER_IP})"
  sleep 1
fi

# --- 3. Health-check nehemiahd through the tunnel -------------------------------
HEALTH="$(curl -fsS --max-time 5 "http://localhost:${LOCAL_PORT}/healthz" 2>/dev/null || true)"
[ -n "${HEALTH}" ] || die "nehemiahd not reachable through the tunnel — is the service running on the box? (systemctl status nehemiahd)"
ok "nehemiahd healthy: ${HEALTH}"

# --- 4. Pick a free app port --------------------------------------------------
pick_port() {
  local p
  for p in $(seq "${1}" $(( ${1} + 25 ))); do
    lsof -ti "tcp:${p}" >/dev/null 2>&1 || { echo "${p}"; return; }
  done
  echo "${1}"
}
APP_PORT="${NEHEMIAH_APP_PORT:-$(pick_port 5173)}"

# --- 5. Auto-open the browser once the server responds ------------------------
(
  for _ in $(seq 1 40); do
    if curl -fsS "http://localhost:${APP_PORT}/" -o /dev/null 2>/dev/null; then
      command -v open >/dev/null 2>&1 && open "http://localhost:${APP_PORT}/" || true
      break
    fi
    sleep 0.5
  done
) &

echo
ok "everything wired — starting the app"
step "open  http://localhost:${APP_PORT}  and press ⏎ to get a computer"
echo

export NEHEMIAH_URL="http://localhost:${LOCAL_PORT}"
export NEHEMIAH_TOKEN="${TOKEN}"
exec npm --workspace web run dev -- --port "${APP_PORT}" --strictPort

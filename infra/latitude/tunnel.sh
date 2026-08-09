#!/usr/bin/env bash
#
# tunnel.sh — forward local :8080 to the Latitude box's nehemiahd :8080 over SSH.
#
# nehemiahd is intentionally NOT exposed to the public internet (it runs untrusted
# code). This tunnel is how you reach it from your laptop to run the demo.
#
# Config from ~/.config/latitude/server.env:
#   SERVER_IP   public IPv4 of the box
#   SSH_KEY     private key that can root@ the box
#
# Usage:
#   infra/latitude/tunnel.sh          # forwards localhost:8080 -> box:8080
#   infra/latitude/tunnel.sh 9090     # forwards localhost:9090 -> box:8080
#
set -euo pipefail

ENV_FILE="${HOME}/.config/latitude/server.env"

usage() {
  cat <<'EOF'
Usage: infra/latitude/tunnel.sh [LOCAL_PORT]

Opens an SSH tunnel: localhost:<LOCAL_PORT> -> box:8080 (nehemiahd).
LOCAL_PORT defaults to 8080.

Requires ~/.config/latitude/server.env with SERVER_IP and SSH_KEY.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

LOCAL_PORT="${1:-8080}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "error: ${ENV_FILE} not found. Create it with SERVER_IP and SSH_KEY." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"
: "${SERVER_IP:?SERVER_IP must be set in ${ENV_FILE}}"
: "${SSH_KEY:?SSH_KEY must be set in ${ENV_FILE}}"

if [[ ! -f "${SSH_KEY}" ]]; then
  echo "error: SSH_KEY '${SSH_KEY}' does not exist." >&2
  exit 1
fi

cat <<EOF
==> Tunnel: http://localhost:${LOCAL_PORT}  ->  ${SERVER_IP}:8080 (nehemiahd)

    Leave this running. In another terminal, run the demo:

      # from repo root
      NEHEMIAH_URL=http://localhost:${LOCAL_PORT} node packages/sdk/demo.mjs

    Quick check:
      curl http://localhost:${LOCAL_PORT}/healthz

    (If nehemiahd requires a token, export NEHEMIAH_TOKEN too.)

    Press Ctrl-C to close the tunnel.
EOF

exec ssh \
  -i "${SSH_KEY}" \
  -o StrictHostKeyChecking=accept-new \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -N -L "${LOCAL_PORT}:localhost:8080" \
  "root@${SERVER_IP}"

#!/usr/bin/env bash
#
# teardown.sh — DELETE the Latitude.sh bare-metal server to STOP BILLING.
#
# This is destructive and irreversible: the box (and everything on it) is gone.
# Use it when you're done with the prototype so the ~$0.52/hr meter stops.
#
# Config from ~/.config/latitude/:
#   - api_key:    read from LATITUDE_API_KEY (env or ~/.config/latitude/server.env),
#                 or from the file ~/.config/latitude/api_key
#   - server_id:  read from LATITUDE_SERVER_ID / SERVER_ID (env or server.env),
#                 or from the file ~/.config/latitude/server_id
#   - hostname:   fallback recovery when no server_id is known — read from
#                 LATITUDE_HOSTNAME or ~/.config/latitude/last-created-hostname,
#                 then resolved to a unique server via the Latitude API.
#
# The API key is NEVER printed.
#
# Usage:
#   infra/latitude/teardown.sh
#
set -euo pipefail

CONF_DIR="${HOME}/.config/latitude"
ENV_FILE="${CONF_DIR}/server.env"

usage() {
  cat <<'EOF'
Usage: infra/latitude/teardown.sh

DELETES the Latitude.sh server via API to stop billing. Prompts for
confirmation (type "yes"). Reads api_key and server_id from
~/.config/latitude/ (server.env or api_key/server_id files).
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# ---- load config (env file is optional; files/env may supply values) ---------
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

API_KEY="${LATITUDE_API_KEY:-}"
if [[ -z "${API_KEY}" && -f "${CONF_DIR}/api_key" ]]; then
  API_KEY="$(tr -d '[:space:]' < "${CONF_DIR}/api_key")"
fi

SERVER_ID="${LATITUDE_SERVER_ID:-${SERVER_ID:-}}"
if [[ -z "${SERVER_ID}" && -f "${CONF_DIR}/server_id" ]]; then
  SERVER_ID="$(tr -d '[:space:]' < "${CONF_DIR}/server_id")"
fi

if [[ -z "${API_KEY}" ]]; then
  echo "error: no API key found. Set LATITUDE_API_KEY in ${ENV_FILE} or create ${CONF_DIR}/api_key." >&2
  exit 1
fi

# Recovery path: when no id is known (e.g. provisioning saw a malformed create
# response, or a status poll failed before the id was saved), look the server up
# by the durable hostname correlation value that provision.sh records. We never
# parse an id from a possibly-malformed body — we query the provider and require a
# single validated match.
HOSTNAME_LOOKUP="${LATITUDE_HOSTNAME:-}"
if [[ -z "${HOSTNAME_LOOKUP}" && -f "${CONF_DIR}/last-created-hostname" ]]; then
  HOSTNAME_LOOKUP="$(tr -d '[:space:]' < "${CONF_DIR}/last-created-hostname")"
fi
if [[ -z "${SERVER_ID}" && -n "${HOSTNAME_LOOKUP}" ]]; then
  echo "==> no server_id on file; looking up the server by hostname '${HOSTNAME_LOOKUP}'" >&2
  LOOKUP_RESP="$(mktemp "${TMPDIR:-/tmp}/latitude_lookup.XXXXXX")"
  LOOKUP_CODE="$(
    curl -sS -o "${LOOKUP_RESP}" -w '%{http_code}' \
      -G "https://api.latitude.sh/servers" \
      --data-urlencode "filter[hostname]=${HOSTNAME_LOOKUP}" \
      --data-urlencode "page[size]=200" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Accept: application/vnd.api+json"
  )"
  if [[ "${LOOKUP_CODE}" == "200" ]]; then
    if SERVER_ID="$(python3 - "${LOOKUP_RESP}" "${HOSTNAME_LOOKUP}" <<'PY'
import json, pathlib, re, sys
resp = json.loads(pathlib.Path(sys.argv[1]).read_text())
wanted = sys.argv[2]
ids = []
for item in resp.get("data", []) or []:
    if not isinstance(item, dict):
        continue
    attrs = item.get("attributes") or {}
    if attrs.get("hostname") != wanted:
        continue
    sid = item.get("id")
    if isinstance(sid, str) and re.fullmatch(r"sv_[A-Za-z0-9_-]{4,128}", sid):
        ids.append(sid)
ids = sorted(set(ids))
if len(ids) == 1:
    print(ids[0])
elif not ids:
    raise SystemExit("no server matches the hostname")
else:
    raise SystemExit("multiple servers match the hostname; set LATITUDE_SERVER_ID explicitly")
PY
)"; then
      echo "==> resolved server ${SERVER_ID} by hostname" >&2
    else
      SERVER_ID=""
      echo "error: hostname lookup could not resolve a unique server id for '${HOSTNAME_LOOKUP}'." >&2
      echo "       Inspect the Latitude dashboard and set LATITUDE_SERVER_ID explicitly." >&2
    fi
  else
    echo "error: hostname lookup failed (HTTP ${LOOKUP_CODE})." >&2
  fi
  rm -f "${LOOKUP_RESP}"
fi

if [[ -z "${SERVER_ID}" ]]; then
  echo "error: no server_id found. Set LATITUDE_SERVER_ID/SERVER_ID in ${ENV_FILE}, create ${CONF_DIR}/server_id, or set LATITUDE_HOSTNAME to recover the host by provider lookup." >&2
  exit 1
fi

# ---- confirm -----------------------------------------------------------------
cat <<EOF
================================================================================
  DESTRUCTIVE: this DELETES Latitude.sh server '${SERVER_ID}' and STOPS billing.
  Everything on the box (VMs, snapshots, rootfs, nehemiahd) is permanently lost.
================================================================================
EOF
printf 'Type "yes" to delete server %s: ' "${SERVER_ID}"
read -r CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "aborted — nothing deleted."
  exit 1
fi

# ---- delete ------------------------------------------------------------------
echo "==> DELETE https://api.latitude.sh/servers/${SERVER_ID}"
HTTP_CODE="$(
  curl -sS -o /tmp/latitude_teardown_resp.$$ -w '%{http_code}' \
    -X DELETE "https://api.latitude.sh/servers/${SERVER_ID}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Accept: application/vnd.api+json" \
    -H "Content-Type: application/vnd.api+json"
)"
RESP_BODY="$(cat "/tmp/latitude_teardown_resp.$$" 2>/dev/null || true)"
rm -f "/tmp/latitude_teardown_resp.$$"

case "${HTTP_CODE}" in
  200|202|204)
    echo "==> OK (HTTP ${HTTP_CODE}) — server ${SERVER_ID} deleted. Billing stopped."
    [[ -n "${RESP_BODY}" ]] && echo "    ${RESP_BODY}"
    ;;
  404)
    echo "==> HTTP 404 — server ${SERVER_ID} not found (already deleted?). Nothing to bill."
    ;;
  *)
    echo "error: unexpected HTTP ${HTTP_CODE} from Latitude API." >&2
    [[ -n "${RESP_BODY}" ]] && echo "    ${RESP_BODY}" >&2
    exit 1
    ;;
esac

cat <<'EOF'

Note: deleting the server does NOT delete the Latitude project. If this was the
only server and the project is now empty, you can remove the project too from the
Latitude dashboard (or via the API) to keep your account tidy. Projects are free;
only servers bill.
EOF

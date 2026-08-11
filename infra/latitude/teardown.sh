#!/usr/bin/env bash
#
# teardown.sh — DELETE the Latitude.sh bare-metal server to STOP BILLING.
#
# This is destructive and irreversible: the box (and everything on it) is gone.
# Use it when you're done with the prototype so the ~$0.52/hr meter stops.
#
# State is read from the same directory provision.sh writes its recovery
# records to: LATITUDE_STATE_DIR, else $XDG_CONFIG_HOME/latitude, else
# ~/.config/latitude. Within that directory:
#   - api_key:    read from LATITUDE_API_KEY (env or server.env), or from the
#                 file named by LATITUDE_API_KEY_FILE (default <state>/api_key)
#   - server_id:  read from LATITUDE_SERVER_ID / SERVER_ID (env or server.env),
#                 or from the file <state>/server_id
#   - hostname:   fallback recovery when no server_id is known — read from
#                 LATITUDE_HOSTNAME or <state>/last-created-hostname,
#                 then resolved to a unique server via the Latitude API.
#                 When the server_id came from the state file and a hostname
#                 record exists, both must agree (verified via the provider)
#                 before anything is deleted; conflicting records abort.
#                 An explicit LATITUDE_SERVER_ID bypasses the check.
#
# The API key is NEVER printed.
#
# Usage:
#   infra/latitude/teardown.sh
#
set -euo pipefail

# Must match the state-directory precedence in provision.sh, or a server
# provisioned with an alternate state location cannot be found and the
# hourly-billed host keeps running.
CONF_DIR="${LATITUDE_STATE_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/latitude}"
ENV_FILE="${CONF_DIR}/server.env"
API_KEY_FILE="${LATITUDE_API_KEY_FILE:-${CONF_DIR}/api_key}"

usage() {
  cat <<'EOF'
Usage: infra/latitude/teardown.sh

DELETES the Latitude.sh server via API to stop billing. Prompts for
confirmation (type "yes"). Reads api_key and server_id from the same state
directory provision.sh writes to — LATITUDE_STATE_DIR, else
$XDG_CONFIG_HOME/latitude, else ~/.config/latitude (server.env or
api_key/server_id files).
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
if [[ -z "${API_KEY}" && -f "${API_KEY_FILE}" ]]; then
  API_KEY="$(tr -d '[:space:]' < "${API_KEY_FILE}")"
fi

SERVER_ID="${LATITUDE_SERVER_ID:-${SERVER_ID:-}}"
SERVER_ID_SOURCE="env"
if [[ -z "${SERVER_ID}" && -f "${CONF_DIR}/server_id" ]]; then
  SERVER_ID="$(tr -d '[:space:]' < "${CONF_DIR}/server_id")"
  SERVER_ID_SOURCE="file"
fi

if [[ -z "${API_KEY}" ]]; then
  echo "error: no API key found. Set LATITUDE_API_KEY in ${ENV_FILE} or create ${API_KEY_FILE}." >&2
  exit 1
fi

# The durable hostname correlation value that provision.sh records (or an
# explicit LATITUDE_HOSTNAME). Used to recover a host when no id is known, and
# to verify a file-sourced id before the destructive delete.
HOSTNAME_LOOKUP="${LATITUDE_HOSTNAME:-}"
if [[ -z "${HOSTNAME_LOOKUP}" && -f "${CONF_DIR}/last-created-hostname" ]]; then
  HOSTNAME_LOOKUP="$(tr -d '[:space:]' < "${CONF_DIR}/last-created-hostname")"
fi

# Resolve HOSTNAME_LOOKUP to a validated server id via the provider. We never
# parse an id from a possibly-malformed local body — we query the provider and
# require a single validated match. Prints the id on success. Returns 0 on a
# unique match, 2 when no server matches, 4 when several match, 3 when the
# lookup itself failed.
lookup_server_by_hostname() {
  local response code resolved status=0
  response="$(mktemp "${TMPDIR:-/tmp}/latitude_lookup.XXXXXX")"
  code="$(
    curl -sS -o "${response}" -w '%{http_code}' \
      -G "https://api.latitude.sh/servers" \
      --data-urlencode "filter[hostname]=${HOSTNAME_LOOKUP}" \
      --data-urlencode "page[size]=200" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Accept: application/vnd.api+json"
  )" || { rm -f "${response}"; return 3; }
  if [[ "${code}" != "200" ]]; then
    rm -f "${response}"
    echo "error: hostname lookup failed (HTTP ${code})." >&2
    return 3
  fi
  resolved="$(python3 - "${response}" "${HOSTNAME_LOOKUP}" <<'PY'
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
    raise SystemExit(0)
raise SystemExit(2 if not ids else 4)
PY
)" || status=$?
  rm -f "${response}"
  [[ "${status}" -eq 0 ]] && printf '%s\n' "${resolved}"
  return "${status}"
}

# Recovery path: when no id is known (e.g. provisioning saw a malformed create
# response, or a status poll failed before the id was saved), recover the host
# by the recorded hostname.
if [[ -z "${SERVER_ID}" && -n "${HOSTNAME_LOOKUP}" ]]; then
  echo "==> no server_id on file; looking up the server by hostname '${HOSTNAME_LOOKUP}'" >&2
  LOOKUP_STATUS=0
  SERVER_ID="$(lookup_server_by_hostname)" || LOOKUP_STATUS=$?
  if [[ "${LOOKUP_STATUS}" -eq 0 ]]; then
    echo "==> resolved server ${SERVER_ID} by hostname" >&2
  else
    SERVER_ID=""
    if [[ "${LOOKUP_STATUS}" -ne 3 ]]; then
      echo "error: hostname lookup could not resolve a unique server id for '${HOSTNAME_LOOKUP}'." >&2
    fi
    echo "       Inspect the Latitude dashboard and set LATITUDE_SERVER_ID explicitly." >&2
  fi
fi

# Conflicting-records guard: a stale server_id file alongside a newer
# last-created-hostname (an interrupted provisioning run) must not silently
# delete the PREVIOUS server while the newly billed host keeps running. When
# the id came from the state file and a hostname record exists, require the
# provider to agree before deleting; reject a conflict instead of preferring
# the id. An explicit LATITUDE_SERVER_ID bypasses this check.
if [[ -n "${SERVER_ID}" && "${SERVER_ID_SOURCE}" == "file" && -n "${HOSTNAME_LOOKUP}" ]]; then
  echo "==> verifying the on-file server_id against hostname '${HOSTNAME_LOOKUP}'" >&2
  VERIFY_STATUS=0
  RESOLVED_ID="$(lookup_server_by_hostname)" || VERIFY_STATUS=$?
  case "${VERIFY_STATUS}" in
    0)
      if [[ "${RESOLVED_ID}" != "${SERVER_ID}" ]]; then
        echo "error: conflicting recovery records — ${CONF_DIR}/server_id says '${SERVER_ID}' but hostname '${HOSTNAME_LOOKUP}' resolves to '${RESOLVED_ID}' (likely an interrupted provisioning run)." >&2
        echo "       Inspect the Latitude dashboard, tear down each host explicitly with LATITUDE_SERVER_ID=<id>, and remove the stale ${CONF_DIR}/server_id file." >&2
        exit 1
      fi
      echo "==> verified: the hostname resolves to the same server" >&2
      ;;
    2)
      # No live server carries the hostname, so the recorded host is already
      # gone; deleting by the on-file id is a safe no-op (404) at worst.
      echo "==> hostname matches no live server; proceeding with the on-file server_id" >&2
      ;;
    4)
      echo "error: multiple servers match hostname '${HOSTNAME_LOOKUP}'; cannot verify the on-file server_id." >&2
      echo "       Tear down explicitly with LATITUDE_SERVER_ID=<id>." >&2
      exit 1
      ;;
    *)
      echo "error: could not verify the on-file server_id (hostname lookup failed); refusing a blind destructive delete." >&2
      echo "       Retry, or tear down explicitly with LATITUDE_SERVER_ID=<id>." >&2
      exit 1
      ;;
  esac
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

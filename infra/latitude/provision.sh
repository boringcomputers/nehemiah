#!/usr/bin/env bash
# Manually render and provision one approved Latitude managed host. Bootstrap
# credentials stay in private files and never appear in curl argv or stdout.
set -euo pipefail
set +x
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  infra/latitude/provision.sh --config FILE [--output NEW_FILE]
  infra/latitude/provision.sh --config FILE --output NEW_FILE --render-only

Live provisioning reads these non-bootstrap values from the environment or
the documented private files:
  LATITUDE_API_KEY or LATITUDE_API_KEY_FILE
  LATITUDE_PROJECT, LATITUDE_SSH_KEY

--output retains the private rendered cloud-config for operator inspection.
Without it, the payload is held only in a mode-0700 temporary directory.
EOF
}

die() {
  printf 'provision: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[provision] %s\n' "$*"
}

CONFIG_FILE=""
OUTPUT_FILE=""
RENDER_ONLY=0
while (($#)); do
  case "$1" in
    --config | --output)
      (($# >= 2)) || die "missing value for $1"
      option="$1"
      value="$2"
      shift 2
      case "$option" in
        --config)
          [[ -z "$CONFIG_FILE" ]] || die "duplicate --config"
          CONFIG_FILE="$value"
          ;;
        --output)
          [[ -z "$OUTPUT_FILE" ]] || die "duplicate --output"
          OUTPUT_FILE="$value"
          ;;
      esac
      ;;
    --render-only)
      [[ "$RENDER_ONLY" == 0 ]] || die "duplicate --render-only"
      RENDER_ONLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$CONFIG_FILE" ]] || { usage >&2; exit 2; }
if [[ "$RENDER_ONLY" == 1 && -z "$OUTPUT_FILE" ]]; then
  die "--render-only requires --output"
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nehemiah-provision.XXXXXX")"
chmod 0700 "$WORK_DIR"
USER_DATA_ID=""
API_READY=0

latitude_request() {
  local method="$1" path="$2" request_file="$3" response_file="$4" expected="$5"
  local code
  local -a arguments=(
    --config "$WORK_DIR/curl.conf"
    --request "$method"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$request_file" ]]; then
    arguments+=(--data-binary "@$request_file")
  fi
  : > "$response_file"
  if ! code="$(curl "${arguments[@]}" "${LATITUDE_API_BASE}${path}")"; then
    printf 'provision: Latitude request transport failed for %s %s\n' \
      "$method" "$path" >&2
    return 1
  fi
  if [[ " $expected " != *" $code "* ]]; then
    printf 'provision: Latitude request %s %s returned HTTP %s\n' \
      "$method" "$path" "$code" >&2
    return 1
  fi
}

delete_user_data() {
  [[ -n "$USER_DATA_ID" && "$API_READY" == 1 ]] || return 0
  if latitude_request DELETE "/user_data/$USER_DATA_ID" "" \
    "$WORK_DIR/delete-user-data-response.json" "200 202 204 404"; then
    log "deleted one-time Latitude user-data record $USER_DATA_ID"
    USER_DATA_ID=""
  else
    printf 'provision: could not delete one-time user-data record %s\n' \
      "$USER_DATA_ID" >&2
  fi
}

cleanup() {
  local status=$?
  set +e
  delete_user_data
  rm -rf -- "$WORK_DIR"
  return "$status"
}
trap cleanup EXIT

if [[ -n "$OUTPUT_FILE" ]]; then
  RENDERED_USER_DATA="$OUTPUT_FILE"
else
  RENDERED_USER_DATA="$WORK_DIR/user-data.yaml"
fi
"$SCRIPT_DIR/render-user-data.sh" \
  --config "$CONFIG_FILE" \
  --output "$RENDERED_USER_DATA"
if [[ "$RENDER_ONLY" == 1 ]]; then
  log "render-only complete; no Latitude API request was made"
  exit 0
fi

STATE_DIR="${LATITUDE_STATE_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/latitude}"
API_KEY_FILE="${LATITUDE_API_KEY_FILE:-$STATE_DIR/api_key}"
API_KEY="${LATITUDE_API_KEY:-}"
if [[ -z "$API_KEY" ]]; then
  [[ -f "$API_KEY_FILE" && ! -L "$API_KEY_FILE" ]] \
    || die "set LATITUDE_API_KEY or create the private API key file $API_KEY_FILE"
  [[ "$(stat -c '%a:%u' "$API_KEY_FILE")" == "600:$(id -u)" ]] \
    || die "Latitude API key file must be mode 0600 and owned by the invoking user"
  API_KEY="$(< "$API_KEY_FILE")"
fi
[[ "$API_KEY" =~ ^[A-Za-z0-9][A-Za-z0-9._~+/-]{19,4095}$ ]] \
  || die "Latitude API key has an invalid format"

: "${LATITUDE_PROJECT:?set LATITUDE_PROJECT (proj_...)}"
: "${LATITUDE_SSH_KEY:?set LATITUDE_SSH_KEY (ssh_...)}"
PLAN="${LATITUDE_PLAN:-c3-small-x86}"
SITE="${LATITUDE_SITE:-MIA2}"
HOSTNAME_VALUE="${LATITUDE_HOSTNAME:-nehemiah-metal-01}"
LATITUDE_API_BASE="${LATITUDE_API_BASE:-https://api.latitude.sh}"
POLL_ATTEMPTS="${LATITUDE_POLL_ATTEMPTS:-60}"
POLL_INTERVAL_SECONDS="${LATITUDE_POLL_INTERVAL_SECONDS:-15}"

mapfile -t provider_image_config < <(python3 - "$CONFIG_FILE" <<'PY'
import pathlib
import re
import sys

wanted = {
    "LATITUDE_OS_ID",
    "LATITUDE_OS_SLUG",
    "LATITUDE_OS_VERSION",
    "LATITUDE_OS_ARCH",
}
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line or line.startswith("#"):
        continue
    match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
    if match and match.group(1) in wanted:
        if match.group(1) in values:
            raise SystemExit("duplicate provider image field")
        values[match.group(1)] = match.group(2)
if set(values) != wanted or any("\n" in value or "\r" in value for value in values.values()):
    raise SystemExit("provider image identity is incomplete")
for key in ("LATITUDE_OS_ID", "LATITUDE_OS_SLUG", "LATITUDE_OS_VERSION", "LATITUDE_OS_ARCH"):
    print(values[key])
PY
)
[[ "${#provider_image_config[@]}" -eq 4 ]] \
  || die "could not read the exact provider image identity from the private config"
LATITUDE_OS_ID="${provider_image_config[0]}"
OPERATING_SYSTEM="${provider_image_config[1]}"
LATITUDE_OS_VERSION="${provider_image_config[2]}"
LATITUDE_OS_ARCH="${provider_image_config[3]}"
unset provider_image_config

[[ "$LATITUDE_PROJECT" =~ ^proj_[A-Za-z0-9_-]{4,128}$ ]] \
  || die "invalid LATITUDE_PROJECT"
[[ "$LATITUDE_SSH_KEY" =~ ^ssh_[A-Za-z0-9_-]{4,128}$ ]] \
  || die "invalid LATITUDE_SSH_KEY"
[[ "$PLAN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "invalid LATITUDE_PLAN"
[[ "$SITE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] || die "invalid LATITUDE_SITE"
[[ "$LATITUDE_OS_ID" =~ ^os_[A-Za-z0-9_-]{4,128}$ ]] \
  || die "invalid LATITUDE_OS_ID"
[[ "$LATITUDE_OS_VERSION" =~ ^24\.04([.[:space:]A-Za-z0-9_-]{0,63})$ ]] \
  || die "invalid LATITUDE_OS_VERSION"
case "$LATITUDE_OS_ARCH:$OPERATING_SYSTEM" in
  amd64:ubuntu_24_04_x64_lts | arm64:ubuntu_24_04_arm64_lts) ;;
  *) die "provider image architecture and slug do not match" ;;
esac
[[ "$HOSTNAME_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$ ]] \
  || die "invalid LATITUDE_HOSTNAME"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]{0,2}$ && "$POLL_ATTEMPTS" -le 240 ]] \
  || die "LATITUDE_POLL_ATTEMPTS must be between 1 and 240"
[[ "$POLL_INTERVAL_SECONDS" =~ ^[0-9]{1,2}$ && "$POLL_INTERVAL_SECONDS" -le 60 ]] \
  || die "LATITUDE_POLL_INTERVAL_SECONDS must be between 0 and 60"

if [[ "${LATITUDE_ALLOW_HTTP_FOR_TESTS:-0}" == 1 ]]; then
  [[ "$LATITUDE_API_BASE" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] \
    || die "the HTTP test escape hatch is restricted to IPv4 loopback"
  CURL_PROTOCOL=http
else
  [[ "$LATITUDE_API_BASE" == "https://api.latitude.sh" ]] \
    || die "Latitude API base must be exactly https://api.latitude.sh"
  [[ "$POLL_INTERVAL_SECONDS" -ge 1 ]] \
    || die "live provisioning requires a positive poll interval"
  CURL_PROTOCOL=https
fi

cat > "$WORK_DIR/curl.conf" <<EOF
silent
show-error
connect-timeout = 15
max-time = 90
proto = "=${CURL_PROTOCOL}"
header = "Authorization: Bearer ${API_KEY}"
header = "Accept: application/vnd.api+json"
header = "Content-Type: application/vnd.api+json"
EOF
chmod 0600 "$WORK_DIR/curl.conf"
API_KEY=""
unset LATITUDE_API_KEY
API_READY=1

# The provider image is an explicit launch-time trust input. Resolve its opaque
# API id before creating user data or any billable server and require the live
# record to retain the reviewed slug, version, architecture mapping, and plan.
# Latitude's operating-system API does not expose a separate architecture
# field, so the exact approved slug is the authoritative architecture mapping.
provider_image_evidence="$WORK_DIR/provider-image-selection.json"
provider_image_found=0
for page_number in $(seq 1 20); do
  latitude_request GET \
    "/plans/operating_systems?page%5Bsize%5D=100&page%5Bnumber%5D=${page_number}" \
    "" "$WORK_DIR/operating-systems.json" 200
  provider_image_status="$(python3 - \
    "$WORK_DIR/operating-systems.json" "$provider_image_evidence" \
    "$LATITUDE_OS_ID" "$OPERATING_SYSTEM" "$LATITUDE_OS_VERSION" \
    "$LATITUDE_OS_ARCH" "$PLAN" <<'PY'
import json
import pathlib
import re
import sys

response_path, evidence_path, image_id, slug, version, architecture, plan = sys.argv[1:]
try:
    response = json.loads(pathlib.Path(response_path).read_text())
except (OSError, json.JSONDecodeError):
    raise SystemExit("Latitude returned invalid operating-system JSON") from None
data = response.get("data") if isinstance(response, dict) else None
if not isinstance(data, list) or len(data) > 100:
    raise SystemExit("Latitude returned an invalid operating-system page")
matches = [entry for entry in data if isinstance(entry, dict) and entry.get("id") == image_id]
if len(matches) > 1:
    raise SystemExit("Latitude returned a duplicate operating-system id")
if not matches:
    print("more" if len(data) == 100 else "end")
    raise SystemExit(0)

entry = matches[0]
attributes = entry.get("attributes")
if entry.get("type") != "operating_system" or not isinstance(attributes, dict):
    raise SystemExit("Latitude operating-system identity has an invalid type")
provisionable = attributes.get("provisionable_on")
expected_architecture = {
    "ubuntu_24_04_x64_lts": "amd64",
    "ubuntu_24_04_arm64_lts": "arm64",
}.get(attributes.get("slug"))
if (
    attributes.get("slug") != slug
    or attributes.get("version") != version
    or expected_architecture != architecture
    or not isinstance(provisionable, list)
    or not provisionable
    or not all(
        isinstance(value, str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value)
        for value in provisionable
    )
    or len(provisionable) != len(set(provisionable))
    or plan not in provisionable
):
    raise SystemExit("Latitude operating-system record differs from the approved image identity")
evidence = {
    "architecture": architecture,
    "id": image_id,
    "plan": plan,
    "provisionableOn": sorted(provisionable),
    "provider": "latitude",
    "slug": slug,
    "version": version,
}
path = pathlib.Path(evidence_path)
path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
path.chmod(0o600)
print("found")
PY
)"
  case "$provider_image_status" in
    found)
      provider_image_found=1
      break
      ;;
    end) break ;;
    more) ;;
    *) die "could not validate the Latitude operating-system response" ;;
  esac
done
[[ "$provider_image_found" == 1 ]] \
  || die "approved Latitude operating-system id was not found within the bounded inventory"
log "validated approved Latitude operating-system id $LATITUDE_OS_ID for $PLAN"

python3 - "$RENDERED_USER_DATA" "$LATITUDE_PROJECT" "$HOSTNAME_VALUE" \
  > "$WORK_DIR/create-user-data.json" <<'PY'
import base64
import json
import pathlib
import sys

payload = pathlib.Path(sys.argv[1]).read_bytes()
if not payload.startswith(b"#cloud-config\n") or len(payload) > 1024 * 1024:
    raise SystemExit("rendered user-data is invalid or too large")
print(json.dumps({
    "data": {
        "type": "user_data",
        "attributes": {
            "content": base64.b64encode(payload).decode("ascii"),
            "description": f"one-time-nehemiah-bootstrap-{sys.argv[3]}",
            "project": sys.argv[2],
        },
    },
}, separators=(",", ":")))
PY
chmod 0600 "$WORK_DIR/create-user-data.json"
latitude_request POST /user_data "$WORK_DIR/create-user-data.json" \
  "$WORK_DIR/create-user-data-response.json" 201
USER_DATA_ID="$(python3 - "$WORK_DIR/create-user-data-response.json" <<'PY'
import json
import pathlib
import re
import sys

identifier = json.loads(pathlib.Path(sys.argv[1]).read_text())["data"]["id"]
if not isinstance(identifier, str) or not re.fullmatch(r"ud_[A-Za-z0-9_-]{4,128}", identifier):
    raise SystemExit("Latitude returned an invalid user-data id")
print(identifier)
PY
)"
log "created one-time Latitude user-data record $USER_DATA_ID"

python3 - "$LATITUDE_PROJECT" "$PLAN" "$SITE" "$OPERATING_SYSTEM" \
  "$HOSTNAME_VALUE" "$LATITUDE_SSH_KEY" "$USER_DATA_ID" \
  > "$WORK_DIR/create-server.json" <<'PY'
import json
import sys

project, plan, site, operating_system, hostname, ssh_key, user_data = sys.argv[1:]
print(json.dumps({
    "data": {
        "type": "servers",
        "attributes": {
            "project": project,
            "plan": plan,
            "site": site,
            "operating_system": operating_system,
            "hostname": hostname,
            "ssh_keys": [ssh_key],
            "user_data": user_data,
            "billing": "hourly",
        },
    },
}, separators=(",", ":")))
PY
chmod 0600 "$WORK_DIR/create-server.json"
latitude_request POST /servers "$WORK_DIR/create-server.json" \
  "$WORK_DIR/create-server-response.json" 201
# Latitude has accepted the (billable) create. Persist durable recovery inputs
# BEFORE parsing so an accepted-but-unparseable response can still be identified
# and torn down — WORK_DIR is removed on exit. The requested hostname is the
# durable correlation value teardown.sh uses to find the server via a provider
# lookup when the id cannot be validated from the response body.
mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"
# Commit the new host's recovery record before touching the previously recorded
# server_id: clearing first would open a window (a kill between the rm and the
# rename) where the state directory identifies NO host at all and teardown could
# not discover the one that is now billing. The record is staged inside
# STATE_DIR so the final mv is an atomic rename (WORK_DIR may be on another
# filesystem).
hostname_record_tmp="$(mktemp "$STATE_DIR/.last-created-hostname.XXXXXX")"
printf '%s\n' "$HOSTNAME_VALUE" > "$hostname_record_tmp"
chmod 0600 "$hostname_record_tmp"
mv -- "$hostname_record_tmp" "$STATE_DIR/last-created-hostname"
raw_creation_tmp="$(mktemp "$STATE_DIR/.created-server.XXXXXX")"
cp -- "$WORK_DIR/create-server-response.json" "$raw_creation_tmp"
chmod 0600 "$raw_creation_tmp"
mv -- "$raw_creation_tmp" "$STATE_DIR/last-created-server.json"
# Only now drop the stale server_id — this host is already recoverable by
# hostname. Clearing before the id parse below keeps the parse-failure path
# safe: teardown falls through to hostname recovery for THIS host instead of
# deleting the prior server. (A kill before this rm leaves the stale id
# alongside the new hostname record, which teardown would target first; that
# state is recoverable — remove the server_id file and rerun teardown — unlike
# a window holding no record of the new host at all.)
rm -f -- "$STATE_DIR/server_id"
log "persisted recovery inputs (hostname + raw response) under $STATE_DIR for teardown"
if ! SERVER_ID="$(python3 - "$WORK_DIR/create-server-response.json" <<'PY'
import json
import pathlib
import re
import sys

identifier = json.loads(pathlib.Path(sys.argv[1]).read_text())["data"]["id"]
if not isinstance(identifier, str) or not re.fullmatch(r"sv_[A-Za-z0-9_-]{4,128}", identifier):
    raise SystemExit("Latitude returned an invalid server id")
print(identifier)
PY
)"; then
  die "Latitude accepted the billable create but returned an unparseable server id.
A host may be billing now. Do NOT read the id from the malformed body
($STATE_DIR/last-created-server.json); recover it by its hostname:
    LATITUDE_HOSTNAME='$HOSTNAME_VALUE' infra/latitude/teardown.sh"
fi
# Persist the validated id before polling so teardown can discover it even if the
# status poll below fails after the host is already billing.
if [[ ! -e "$STATE_DIR/server_id" && ! -L "$STATE_DIR/server_id" ]]; then
  server_id_tmp="$(mktemp "$STATE_DIR/.server_id.XXXXXX")"
  printf '%s\n' "$SERVER_ID" > "$server_id_tmp"
  chmod 0600 "$server_id_tmp"
  mv -- "$server_id_tmp" "$STATE_DIR/server_id"
  log "saved the server id to $STATE_DIR/server_id"
else
  log "left existing $STATE_DIR/server_id unchanged; use LATITUDE_SERVER_ID=$SERVER_ID for teardown"
fi
log "created hourly-billed server $SERVER_ID; waiting for provider status=on"

SERVER_IP=""
SERVER_STATUS=""
for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1)); do
  latitude_request GET "/servers/$SERVER_ID" "" \
    "$WORK_DIR/get-server-response.json" 200
  read -r SERVER_STATUS SERVER_IP < <(
    python3 - "$WORK_DIR/get-server-response.json" <<'PY'
import ipaddress
import json
import pathlib
import sys

attributes = json.loads(pathlib.Path(sys.argv[1]).read_text())["data"]["attributes"]
status = attributes.get("status", "")
address = attributes.get("primary_ipv4") or ""
if address:
    ipaddress.ip_address(address)
print(status, address)
PY
  )
  [[ "$SERVER_STATUS" == on && -n "$SERVER_IP" ]] && break
  sleep "$POLL_INTERVAL_SECONDS"
done
if [[ "$SERVER_STATUS" != on || -z "$SERVER_IP" ]]; then
  die "server $SERVER_ID exists but did not become online; inspect it before billing continues"
fi

# Latitude has consumed this record for the completed deployment. Delete the
# reusable API object; the host also erases cloud-init's cached payload after
# successful control-plane enrollment.
delete_user_data

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"
# The server id was persisted before polling (above); only provider evidence
# remains to record now that the host is confirmed online.
provider_evidence_path="$STATE_DIR/provider-image-${SERVER_ID}.json"
if [[ ! -e "$provider_evidence_path" && ! -L "$provider_evidence_path" ]]; then
  provider_evidence_tmp="$(mktemp "$STATE_DIR/.provider-image.XXXXXX")"
  cp -- "$provider_image_evidence" "$provider_evidence_tmp"
  chmod 0600 "$provider_evidence_tmp"
  mv "$provider_evidence_tmp" "$provider_evidence_path"
  log "saved provider image evidence to $provider_evidence_path"
else
  log "left existing provider image evidence unchanged: $provider_evidence_path"
fi

log "server $SERVER_ID is online at $SERVER_IP"
printf '%s\n' \
  "Cloud-init may still be enrolling. Verify the host in the control plane and" \
  "check /var/lib/nehemiahd/bootstrap.complete before admitting workloads." \
  "To stop hourly billing: LATITUDE_SERVER_ID=$SERVER_ID infra/latitude/teardown.sh"

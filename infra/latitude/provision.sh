#!/usr/bin/env bash
#
# provision.sh — create a Latitude.sh bare-metal box for Nehemiah, then
# tell you how to set it up. Optional convenience for Latitude users; if you have
# a box anywhere else (Ubuntu 24.04 x86_64 + /dev/kvm), skip this and run
# ../setup.sh directly.
#
# Needs a Latitude API key + a project + an uploaded SSH key. Get them from the
# Latitude dashboard, then:
#
#   LATITUDE_API_KEY=... LATITUDE_PROJECT=proj_... LATITUDE_SSH_KEY=ssh_... \
#     ./provision.sh
#
# Options (env): LATITUDE_PLAN (default c3-small-x86), LATITUDE_SITE (default MIA2),
#   LATITUDE_OS (default ubuntu_24_04_x64_lts), LATITUDE_HOSTNAME (default nehemiah-metal-01).
#
set -euo pipefail

: "${LATITUDE_API_KEY:?set LATITUDE_API_KEY}"
: "${LATITUDE_PROJECT:?set LATITUDE_PROJECT (proj_...)}"
: "${LATITUDE_SSH_KEY:?set LATITUDE_SSH_KEY (ssh_... — an uploaded SSH key id)}"
# Latitude's ssh_keys create field does not reliably inject the key; the reliable
# path is a cloud-init user_data that appends the key to /root/.ssh/authorized_keys.
# Set LATITUDE_USER_DATA to a user_data id (ud_...) that does this, or SSH will fail.
USER_DATA="${LATITUDE_USER_DATA:-}"
PLAN="${LATITUDE_PLAN:-c3-small-x86}"
SITE="${LATITUDE_SITE:-MIA2}"
OS="${LATITUDE_OS:-ubuntu_24_04_x64_lts}"
HOST="${LATITUDE_HOSTNAME:-nehemiah-metal-01}"

log() { printf '\033[1;34m[provision]\033[0m %s\n' "$*"; }

log "Creating ${PLAN} @ ${SITE} (${OS}) in ${LATITUDE_PROJECT}…"
RESP="$(curl -sS -g --max-time 90 -X POST 'https://api.latitude.sh/servers' \
	-H "Authorization: Bearer ${LATITUDE_API_KEY}" \
	-H 'Accept: application/vnd.api+json' -H 'Content-Type: application/vnd.api+json' \
	-d "{\"data\":{\"type\":\"servers\",\"attributes\":{\"project\":\"${LATITUDE_PROJECT}\",\"plan\":\"${PLAN}\",\"site\":\"${SITE}\",\"operating_system\":\"${OS}\",\"hostname\":\"${HOST}\",\"ssh_keys\":[\"${LATITUDE_SSH_KEY}\"]${USER_DATA:+,\"user_data\":\"${USER_DATA}\"},\"billing\":\"hourly\"}}}")"

ID="$(printf '%s' "${RESP}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",{}).get("id","") if "errors" not in d else "ERR:"+json.dumps(d["errors"])[:300])')"
[[ "${ID}" == ERR:* || -z "${ID}" ]] && { echo "provision failed: ${ID:-$RESP}" >&2; exit 1; }

log "Server ${ID} created. Waiting for it to come online + get an IP…"
IP=""
for _ in $(seq 1 60); do
	INFO="$(curl -sS -g --max-time 30 "https://api.latitude.sh/servers/${ID}" \
		-H "Authorization: Bearer ${LATITUDE_API_KEY}" -H 'Accept: application/vnd.api+json')"
	IP="$(printf '%s' "${INFO}" | python3 -c 'import sys,json;a=json.load(sys.stdin).get("data",{}).get("attributes",{});print(a.get("primary_ipv4") or "")')"
	ST="$(printf '%s' "${INFO}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("attributes",{}).get("status",""))')"
	[[ -n "${IP}" && "${ST}" == "on" ]] && break
	sleep 15
done
[[ -n "${IP}" ]] || { echo "server created (${ID}) but no IP yet — check the Latitude dashboard" >&2; exit 1; }

log "Ready: ${HOST} = ${IP} (server ${ID})."
echo
echo "Next — set it up (from the repo root):"
echo "  NEHEMIAH_ANTHROPIC_KEY=sk-ant-... ./infra/setup.sh root@${IP}"
echo
echo "To delete it later (stops billing): ./infra/latitude/teardown.sh  (server_id ${ID})"

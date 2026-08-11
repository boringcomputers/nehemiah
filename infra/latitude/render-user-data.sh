#!/usr/bin/env bash
# Render a private, self-contained cloud-config for one approved managed host.
# Secrets are read from a mode-0600 config file and are never written to stdout.
set -euo pipefail
set +x
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: infra/latitude/render-user-data.sh --config FILE --output NEW_FILE

FILE must be a non-symlink, mode-0600 KEY=value file. NEW_FILE must not
already exist; it is created mode 0600 because it contains recoverable
base64-encoded bootstrap credentials.
EOF
}

die() {
  printf 'render-user-data: %s\n' "$*" >&2
  exit 1
}

CONFIG_FILE=""
OUTPUT_FILE=""
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
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$CONFIG_FILE" && -n "$OUTPUT_FILE" ]] || { usage >&2; exit 2; }
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || die "config must be a regular, non-symlink file"
[[ "$(stat -c '%a:%u' "$CONFIG_FILE")" == "600:$(id -u)" ]] \
  || die "config must be mode 0600 and owned by the invoking user"
[[ -f "$SCRIPT_DIR/cloud-init.sh" && ! -L "$SCRIPT_DIR/cloud-init.sh" ]] \
  || die "cloud-init.sh is missing or is a symlink"
for required_script in validate-managed-release.py verify-minisign.py wireguard-config.py; do
  [[ -f "$SCRIPT_DIR/$required_script" && ! -L "$SCRIPT_DIR/$required_script" ]] \
    || die "$required_script is missing or is a symlink"
done
[[ ! -e "$OUTPUT_FILE" && ! -L "$OUTPUT_FILE" ]] \
  || die "output already exists; refusing to overwrite it"
OUTPUT_PARENT="$(dirname "$OUTPUT_FILE")"
[[ -d "$OUTPUT_PARENT" && ! -L "$OUTPUT_PARENT" ]] \
  || die "output parent must be an existing, non-symlink directory"

declare -A allowed=()
for key in \
  NEHEMIAH_RELEASE_BASE \
  NEHEMIAH_RELEASE_VERSION \
  NEHEMIAH_RELEASE_MINISIGN_KEY \
  NEHEMIAH_HOST_ID \
  NEHEMIAH_REGION \
  NEHEMIAH_PROVIDER_ID \
  LATITUDE_OS_ID \
  LATITUDE_OS_SLUG \
  LATITUDE_OS_VERSION \
  LATITUDE_OS_ARCH \
  NEHEMIAH_FLEET_BOOTSTRAP_TOKEN \
  NEHEMIAH_CONTROL_PLANE_URL \
  NEHEMIAH_TEMPLATE_OBJECT_ORIGIN \
  NEHEMIAH_ADVERTISE_ADDRESS \
  NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS \
  NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS \
  NEHEMIAH_WIREGUARD_CONFIG_B64 \
  NEHEMIAH_OTEL_ENABLED \
  NEHEMIAH_OTEL_ENDPOINT \
  NEHEMIAH_OTEL_AUTHORIZATION \
  NEHEMIAH_SERVICE_VERSION \
  NEHEMIAH_INSTANCE_ID \
  NEHEMIAH_DEPLOYMENT_ENVIRONMENT \
  NEHEMIAH_OTEL_EXPORT_INTERVAL_MS \
  NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS \
  NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO \
  NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64; do
  allowed["$key"]=1
done

declare -A values=()
line_number=0
while IFS= read -r line || [[ -n "$line" ]]; do
  ((line_number += 1))
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] \
    || die "config line $line_number must be KEY=value without shell syntax"
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  [[ -n "${allowed[$key]:-}" ]] || die "unknown config key on line $line_number"
  [[ ! -v "values[$key]" ]] || die "duplicate config key on line $line_number"
  values["$key"]="$value"
done < "$CONFIG_FILE"

required=(
  NEHEMIAH_RELEASE_BASE
  NEHEMIAH_RELEASE_VERSION
  NEHEMIAH_RELEASE_MINISIGN_KEY
  NEHEMIAH_HOST_ID
  NEHEMIAH_REGION
  LATITUDE_OS_ID
  LATITUDE_OS_SLUG
  LATITUDE_OS_VERSION
  LATITUDE_OS_ARCH
  NEHEMIAH_FLEET_BOOTSTRAP_TOKEN
  NEHEMIAH_CONTROL_PLANE_URL
  NEHEMIAH_ADVERTISE_ADDRESS
  NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS
  NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS
  NEHEMIAH_WIREGUARD_CONFIG_B64
  NEHEMIAH_OTEL_ENABLED
  NEHEMIAH_OTEL_ENDPOINT
  NEHEMIAH_OTEL_AUTHORIZATION
  NEHEMIAH_SERVICE_VERSION
  NEHEMIAH_INSTANCE_ID
  NEHEMIAH_DEPLOYMENT_ENVIRONMENT
  NEHEMIAH_OTEL_EXPORT_INTERVAL_MS
  NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS
  NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO
  NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64
)
for key in "${required[@]}"; do
  [[ -n "${values[$key]:-}" ]] || die "missing required config key $key"
done
values[NEHEMIAH_PROVIDER_ID]="${values[NEHEMIAH_PROVIDER_ID]:-${values[NEHEMIAH_HOST_ID]}}"

[[ "${values[NEHEMIAH_RELEASE_VERSION]}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] \
  || die "invalid release version"
[[ "${values[NEHEMIAH_RELEASE_MINISIGN_KEY]}" =~ ^RW[A-Za-z0-9+/]{54}$ ]] \
  || die "invalid Minisign public key"
for key in NEHEMIAH_HOST_ID NEHEMIAH_REGION NEHEMIAH_PROVIDER_ID; do
  [[ "${values[$key]}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
    || die "invalid $key"
done
[[ "${values[LATITUDE_OS_ID]}" =~ ^os_[A-Za-z0-9_-]{4,128}$ ]] \
  || die "invalid LATITUDE_OS_ID"
[[ "${values[LATITUDE_OS_SLUG]}" =~ ^ubuntu_24_04_(x64|arm64)_lts$ ]] \
  || die "LATITUDE_OS_SLUG must be an approved Ubuntu 24.04 image slug"
[[ "${values[LATITUDE_OS_VERSION]}" =~ ^24\.04([.[:space:]A-Za-z0-9_-]{0,63})$ ]] \
  || die "invalid LATITUDE_OS_VERSION"
case "${values[LATITUDE_OS_ARCH]}:${values[LATITUDE_OS_SLUG]}" in
  amd64:ubuntu_24_04_x64_lts | arm64:ubuntu_24_04_arm64_lts) ;;
  *) die "Latitude image architecture and slug do not match" ;;
esac
[[ "${values[NEHEMIAH_FLEET_BOOTSTRAP_TOKEN]}" =~ ^nhe_[A-Za-z0-9_-]{43}$ ]] \
  || die "invalid fleet bootstrap credential"
[[ "${values[NEHEMIAH_OTEL_ENABLED]}" == true ]] \
  || die "NEHEMIAH_OTEL_ENABLED must be exactly true"
[[ ${#values[NEHEMIAH_OTEL_AUTHORIZATION]} -ge 16 && \
    ${#values[NEHEMIAH_OTEL_AUTHORIZATION]} -le 4096 && \
    "${values[NEHEMIAH_OTEL_AUTHORIZATION]}" =~ ^[A-Za-z][A-Za-z0-9_-]{0,31}\ [-A-Za-z0-9._~+/=]+$ ]] \
  || die "invalid OTLP authorization value"
otel_credential="${values[NEHEMIAH_OTEL_AUTHORIZATION]#* }"
[[ "${values[NEHEMIAH_OTEL_AUTHORIZATION]}" != "${values[NEHEMIAH_FLEET_BOOTSTRAP_TOKEN]}" && \
    "$otel_credential" != "${values[NEHEMIAH_FLEET_BOOTSTRAP_TOKEN]}" ]] \
  || die "OTLP authorization must be distinct from the fleet credential"
for key in NEHEMIAH_SERVICE_VERSION NEHEMIAH_INSTANCE_ID; do
  [[ "${values[$key]}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
    || die "invalid $key"
done
case "${values[NEHEMIAH_DEPLOYMENT_ENVIRONMENT]}" in
  staging | production) ;;
  *) die "managed telemetry environment must be staging or production" ;;
esac
[[ "${values[NEHEMIAH_OTEL_EXPORT_INTERVAL_MS]}" =~ ^[1-9][0-9]*$ && \
    ${values[NEHEMIAH_OTEL_EXPORT_INTERVAL_MS]} -ge 5000 && \
    ${values[NEHEMIAH_OTEL_EXPORT_INTERVAL_MS]} -le 300000 ]] \
  || die "invalid OTLP export interval"
[[ "${values[NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS]}" =~ ^[1-9][0-9]*$ && \
    ${values[NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS]} -ge 1000 && \
    ${values[NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS]} -le 30000 && \
    ${values[NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS]} -lt ${values[NEHEMIAH_OTEL_EXPORT_INTERVAL_MS]} ]] \
  || die "invalid OTLP export timeout"
[[ "${values[NEHEMIAH_WIREGUARD_CONFIG_B64]}" =~ ^[A-Za-z0-9+/]*={0,2}$ && \
    ${#values[NEHEMIAH_WIREGUARD_CONFIG_B64]} -le 131072 ]] \
  || die "invalid WireGuard configuration encoding"
[[ "${values[NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64]}" =~ ^[A-Za-z0-9+/]*={0,2}$ && \
    ${#values[NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64]} -le 32768 ]] \
  || die "invalid SSH public key encoding"

python3 - "${values[NEHEMIAH_RELEASE_BASE]}" \
  "${values[NEHEMIAH_CONTROL_PLANE_URL]}" \
  "${values[NEHEMIAH_ADVERTISE_ADDRESS]}" \
  "${values[NEHEMIAH_TEMPLATE_OBJECT_ORIGIN]:-}" \
  "${values[NEHEMIAH_OTEL_ENDPOINT]}" \
  "${values[NEHEMIAH_REGION]}" \
  "${values[NEHEMIAH_INSTANCE_ID]}" \
  "${values[NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO]}" <<'PY'
import ipaddress
import math
import re
import sys
from urllib.parse import urlsplit

for label, raw in (("release base", sys.argv[1]), ("control-plane URL", sys.argv[2])):
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?", raw):
        raise SystemExit(f"invalid {label}")
    parsed = urlsplit(raw)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise SystemExit(f"invalid {label}")
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit(f"invalid {label}") from None
ipaddress.ip_address(sys.argv[3])
if sys.argv[4]:
    parsed = urlsplit(sys.argv[4])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise SystemExit("invalid template object origin")

otel_endpoint = urlsplit(sys.argv[5])
if otel_endpoint.scheme != "https" or not otel_endpoint.hostname or otel_endpoint.username or otel_endpoint.password or otel_endpoint.path not in ("", "/") or otel_endpoint.query or otel_endpoint.fragment:
    raise SystemExit("invalid OTLP endpoint")
try:
    ipaddress.ip_address(otel_endpoint.hostname)
except ValueError:
    pass
else:
    raise SystemExit("OTLP endpoint must use a DNS hostname")
try:
    if otel_endpoint.port is not None and not 1 <= otel_endpoint.port <= 65535:
        raise ValueError
except ValueError:
    raise SystemExit("invalid OTLP endpoint port") from None
for label, identity in (("region", sys.argv[6]), ("instance id", sys.argv[7])):
    try:
        ipaddress.ip_address(identity)
    except ValueError:
        pass
    else:
        raise SystemExit(f"{label} must not be an IP address")
try:
    sample_ratio = float(sys.argv[8])
except ValueError:
    raise SystemExit("invalid OTLP trace sample ratio") from None
if not math.isfinite(sample_ratio) or not 0.001 <= sample_ratio <= 1:
    raise SystemExit("invalid OTLP trace sample ratio")
PY

validate_encoded_file() {
  local kind="$1" encoded="$2"
  printf '%s' "$encoded" | python3 -c '
import base64
import binascii
import re
import sys

kind = sys.argv[1]
encoded = sys.stdin.buffer.read()
try:
    decoded = base64.b64decode(encoded, validate=True)
except binascii.Error:
    raise SystemExit(f"invalid {kind} base64") from None
if not decoded or b"\x00" in decoded:
    raise SystemExit(f"invalid {kind} content")
if kind != "WireGuard":
    if len(decoded) > 16384 or decoded.count(b"\n") > 1 or (b"\n" in decoded and not decoded.endswith(b"\n")):
        raise SystemExit("SSH authorized key must contain exactly one line")
    line = decoded.rstrip(b"\n")
    if not re.match(rb"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) [A-Za-z0-9+/]+={0,3}(?: .*)?$", line):
        raise SystemExit("invalid SSH authorized key")
' "$kind"
}
validate_encoded_file WireGuard "${values[NEHEMIAH_WIREGUARD_CONFIG_B64]}"
validate_encoded_file SSH "${values[NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64]}"
canonical_wireguard="$({
  printf '%s' "${values[NEHEMIAH_WIREGUARD_CONFIG_B64]}" \
    | python3 "$SCRIPT_DIR/wireguard-config.py" canonicalize-base64 \
        --advertise-address "${values[NEHEMIAH_ADVERTISE_ADDRESS]}" \
        --control-plane-address "${values[NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS]}" \
        --gateway-address "${values[NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS]}" \
        --guest-subnet 10.200.0.0/24
} 2>&1)" || die "$canonical_wireguard"
values[NEHEMIAH_WIREGUARD_CONFIG_B64]="$(printf '%s' "$canonical_wireguard" | base64 --wrap=0)"

bootstrap_keys=(
  NEHEMIAH_RELEASE_BASE
  NEHEMIAH_RELEASE_VERSION
  NEHEMIAH_RELEASE_MINISIGN_KEY
  NEHEMIAH_HOST_ID
  NEHEMIAH_REGION
  NEHEMIAH_PROVIDER_ID
  LATITUDE_OS_ID
  LATITUDE_OS_SLUG
  LATITUDE_OS_VERSION
  LATITUDE_OS_ARCH
  NEHEMIAH_FLEET_BOOTSTRAP_TOKEN
  NEHEMIAH_CONTROL_PLANE_URL
  NEHEMIAH_TEMPLATE_OBJECT_ORIGIN
  NEHEMIAH_ADVERTISE_ADDRESS
  NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS
  NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS
  NEHEMIAH_WIREGUARD_CONFIG_B64
  NEHEMIAH_OTEL_ENABLED
  NEHEMIAH_OTEL_ENDPOINT
  NEHEMIAH_OTEL_AUTHORIZATION
  NEHEMIAH_SERVICE_VERSION
  NEHEMIAH_INSTANCE_ID
  NEHEMIAH_DEPLOYMENT_ENVIRONMENT
  NEHEMIAH_OTEL_EXPORT_INTERVAL_MS
  NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS
  NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO
)
bootstrap_environment=""
for key in "${bootstrap_keys[@]}"; do
  printf -v escaped_value '%q' "${values[$key]:-}"
  bootstrap_environment+="${key}=${escaped_value}"$'\n'
done

bootstrap_b64="$(printf '%s' "$bootstrap_environment" | base64 --wrap=0)"
cloud_init_b64="$(base64 --wrap=0 "$SCRIPT_DIR/cloud-init.sh")"
minisign_verifier_b64="$(base64 --wrap=0 "$SCRIPT_DIR/verify-minisign.py")"
release_validator_b64="$(base64 --wrap=0 "$SCRIPT_DIR/validate-managed-release.py")"
wireguard_parser_b64="$(base64 --wrap=0 "$SCRIPT_DIR/wireguard-config.py")"
ssh_key_b64="${values[NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64]}"

output_owned=0
render_complete=0
cleanup() {
  local status=$?
  exec 9>&- 2>/dev/null || true
  if [[ "$output_owned" == 1 && "$render_complete" != 1 ]]; then
    rm -f -- "$OUTPUT_FILE"
  fi
  return "$status"
}
trap cleanup EXIT
set -o noclobber
if ! exec 9> "$OUTPUT_FILE"; then
  die "could not create output without overwriting an existing path"
fi
output_owned=1
set +o noclobber
chmod 0600 "$OUTPUT_FILE"
cat >&9 <<EOF
#cloud-config
write_files:
  - path: /etc/nehemiah/bootstrap.env
    owner: root:root
    permissions: '0600'
    encoding: b64
    content: ${bootstrap_b64}
  - path: /usr/local/sbin/nehemiah-cloud-init
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${cloud_init_b64}
  - path: /usr/local/libexec/nehemiah-verify-minisign
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${minisign_verifier_b64}
  - path: /usr/local/libexec/nehemiah-validate-release
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${release_validator_b64}
  - path: /usr/local/libexec/nehemiah-wireguard-config
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${wireguard_parser_b64}
  - path: /root/.ssh/authorized_keys
    owner: root:root
    permissions: '0600'
    encoding: b64
    content: ${ssh_key_b64}
runcmd:
  - [ /usr/local/sbin/nehemiah-cloud-init ]
EOF
exec 9>&-
output_sha256="$(sha256sum "$OUTPUT_FILE" | awk '{print $1}')"
render_complete=1
printf 'rendered private cloud-config: %s (sha256=%s)\n' "$OUTPUT_FILE" "$output_sha256"

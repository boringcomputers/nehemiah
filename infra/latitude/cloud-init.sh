#!/usr/bin/env bash
# Provider-neutral cloud-init payload for an approved managed host. The manual
# renderer writes this script and a private bootstrap environment into cloud-init.
set -euo pipefail
set +x
umask 077

BOOTSTRAP_ENV=/etc/nehemiah/bootstrap.env
DAEMON_ENV=/etc/boring/nehemiahd.env
MANAGED_HOST_MARKER=/etc/boring/managed-host
if [[ ! -f "$BOOTSTRAP_ENV" || ! -r "$BOOTSTRAP_ENV" ]]; then
  echo "missing $BOOTSTRAP_ENV" >&2
  exit 1
fi
if [[ -L "$BOOTSTRAP_ENV" || "$(stat -c '%a:%u' "$BOOTSTRAP_ENV")" != 600:0 ]]; then
  echo "$BOOTSTRAP_ENV must be a root-owned regular mode-0600 file" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$BOOTSTRAP_ENV"

: "${NEHEMIAH_RELEASE_BASE:?required}"
: "${NEHEMIAH_RELEASE_VERSION:?required}"
: "${NEHEMIAH_RELEASE_MINISIGN_KEY:?required}"
: "${NEHEMIAH_HOST_ID:?required}"
: "${NEHEMIAH_REGION:?required}"
: "${LATITUDE_OS_ID:?required}"
: "${LATITUDE_OS_SLUG:?required}"
: "${LATITUDE_OS_VERSION:?required}"
: "${LATITUDE_OS_ARCH:?required}"
: "${NEHEMIAH_FLEET_BOOTSTRAP_TOKEN:?required}"
: "${NEHEMIAH_CONTROL_PLANE_URL:?required}"
: "${NEHEMIAH_ADVERTISE_ADDRESS:?required}"
: "${NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS:?required}"
: "${NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS:?required}"
: "${NEHEMIAH_WIREGUARD_CONFIG_B64:?required}"
: "${NEHEMIAH_OTEL_ENABLED:?required}"
: "${NEHEMIAH_OTEL_ENDPOINT:?required}"
: "${NEHEMIAH_OTEL_AUTHORIZATION:?required}"
: "${NEHEMIAH_SERVICE_VERSION:?required}"
: "${NEHEMIAH_INSTANCE_ID:?required}"
: "${NEHEMIAH_DEPLOYMENT_ENVIRONMENT:?required}"
: "${NEHEMIAH_OTEL_EXPORT_INTERVAL_MS:?required}"
: "${NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS:?required}"
: "${NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO:?required}"
NEHEMIAH_TEMPLATE_OBJECT_ORIGIN="${NEHEMIAH_TEMPLATE_OBJECT_ORIGIN:-}"

[[ "$NEHEMIAH_RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] \
  || { echo "invalid release version" >&2; exit 1; }
[[ "$NEHEMIAH_RELEASE_MINISIGN_KEY" =~ ^RW[A-Za-z0-9+/]{54}$ ]] \
  || { echo "invalid release minisign public key" >&2; exit 1; }
[[ "$NEHEMIAH_HOST_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid host id" >&2; exit 1; }
[[ "$NEHEMIAH_REGION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid region" >&2; exit 1; }
[[ "$LATITUDE_OS_ID" =~ ^os_[A-Za-z0-9_-]{4,128}$ ]] \
  || { echo "invalid Latitude operating-system id" >&2; exit 1; }
[[ "$LATITUDE_OS_SLUG" =~ ^ubuntu_24_04_(x64|arm64)_lts$ ]] \
  || { echo "invalid Latitude operating-system slug" >&2; exit 1; }
[[ "$LATITUDE_OS_VERSION" =~ ^24\.04([.[:space:]A-Za-z0-9_-]{0,63})$ ]] \
  || { echo "invalid Latitude operating-system version" >&2; exit 1; }
case "$LATITUDE_OS_ARCH:$LATITUDE_OS_SLUG" in
  amd64:ubuntu_24_04_x64_lts | arm64:ubuntu_24_04_arm64_lts) ;;
  *) echo "Latitude operating-system architecture mismatch" >&2; exit 1 ;;
esac
[[ "$NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" =~ ^nhe_[A-Za-z0-9_-]{43}$ ]] \
  || { echo "invalid fleet bootstrap credential" >&2; exit 1; }
[[ "$NEHEMIAH_OTEL_ENABLED" == true ]] \
  || { echo "NEHEMIAH_OTEL_ENABLED must be exactly true" >&2; exit 1; }
[[ ${#NEHEMIAH_OTEL_AUTHORIZATION} -ge 16 && \
    ${#NEHEMIAH_OTEL_AUTHORIZATION} -le 4096 && \
    "$NEHEMIAH_OTEL_AUTHORIZATION" =~ ^[A-Za-z][A-Za-z0-9_-]{0,31}\ [-A-Za-z0-9._~+/=]+$ ]] \
  || { echo "invalid OTLP authorization value" >&2; exit 1; }
for identity in "$NEHEMIAH_SERVICE_VERSION" "$NEHEMIAH_INSTANCE_ID"; do
  [[ "$identity" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
    || { echo "invalid telemetry identity" >&2; exit 1; }
done
case "$NEHEMIAH_DEPLOYMENT_ENVIRONMENT" in
  staging | production) ;;
  *) echo "invalid managed telemetry environment" >&2; exit 1 ;;
esac
[[ "$NEHEMIAH_OTEL_EXPORT_INTERVAL_MS" =~ ^[1-9][0-9]*$ && \
    $NEHEMIAH_OTEL_EXPORT_INTERVAL_MS -ge 5000 && \
    $NEHEMIAH_OTEL_EXPORT_INTERVAL_MS -le 300000 ]] \
  || { echo "invalid OTLP export interval" >&2; exit 1; }
[[ "$NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS" =~ ^[1-9][0-9]*$ && \
    $NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS -ge 1000 && \
    $NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS -le 30000 && \
    $NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS -lt $NEHEMIAH_OTEL_EXPORT_INTERVAL_MS ]] \
  || { echo "invalid OTLP export timeout" >&2; exit 1; }
python3 - "$NEHEMIAH_RELEASE_BASE" "$NEHEMIAH_CONTROL_PLANE_URL" \
  "$NEHEMIAH_ADVERTISE_ADDRESS" "$NEHEMIAH_TEMPLATE_OBJECT_ORIGIN" \
  "$NEHEMIAH_OTEL_ENDPOINT" "$NEHEMIAH_REGION" "$NEHEMIAH_INSTANCE_ID" \
  "$NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO" <<'PY'
import ipaddress
import math
import re
import sys
from urllib.parse import urlsplit

for label, raw in (("release base", sys.argv[1]), ("control-plane URL", sys.argv[2])):
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?", raw):
        raise SystemExit(f"{label} must be a simple HTTPS URL without credentials, query, or fragment")
    parsed = urlsplit(raw)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise SystemExit(f"invalid {label}")
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit(f"invalid {label} port") from None
ipaddress.ip_address(sys.argv[3])
if sys.argv[4]:
    parsed = urlsplit(sys.argv[4])
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("template object origin must be an origin-only HTTPS URL")
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit("invalid template object origin port") from None

otel_endpoint = urlsplit(sys.argv[5])
if (
    otel_endpoint.scheme != "https"
    or not otel_endpoint.hostname
    or otel_endpoint.username
    or otel_endpoint.password
    or otel_endpoint.path not in ("", "/")
    or otel_endpoint.query
    or otel_endpoint.fragment
):
    raise SystemExit("OTLP endpoint must be an origin-only HTTPS URL")
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
[[ "$NEHEMIAH_WIREGUARD_CONFIG_B64" =~ ^[A-Za-z0-9+/]*={0,2}$ && \
    ${#NEHEMIAH_WIREGUARD_CONFIG_B64} -le 131072 ]] \
  || { echo "invalid WireGuard configuration encoding" >&2; exit 1; }

NEHEMIAH_PROVIDER_ID="${NEHEMIAH_PROVIDER_ID:-${NEHEMIAH_HOST_ID}}"
[[ "$NEHEMIAH_PROVIDER_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid provider id" >&2; exit 1; }
# Generate both inbound credentials on this host. They are sent to the control
# plane during authenticated enrollment and never shared across hosts. Preserve
# them if cloud-init is deliberately re-run on an already-enrolled host.
existing_token() {
  local wanted="$1" name value found=""
  if [[ -f "$DAEMON_ENV" && ! -L "$DAEMON_ENV" ]]; then
    while IFS='=' read -r name value; do
      if [[ "$name" == "$wanted" ]]; then
        found="$value"
      fi
    done < "$DAEMON_ENV"
  fi
  if [[ ${#found} -ge 32 && ${#found} -le 4096 && "$found" =~ ^[-A-Za-z0-9._~+/=]+$ ]]; then
    printf '%s' "$found"
  fi
  return 0
}
NEHEMIAH_INTERNAL_TOKEN="$(existing_token NEHEMIAH_INTERNAL_TOKEN)"
NEHEMIAH_HOST_GATEWAY_TOKEN="$(existing_token NEHEMIAH_TOKEN)"
NEHEMIAH_INTERNAL_TOKEN="${NEHEMIAH_INTERNAL_TOKEN:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"
NEHEMIAH_HOST_GATEWAY_TOKEN="${NEHEMIAH_HOST_GATEWAY_TOKEN:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"
NEHEMIAH_OTEL_CREDENTIAL="${NEHEMIAH_OTEL_AUTHORIZATION#* }"
[[ "$NEHEMIAH_INTERNAL_TOKEN" != "$NEHEMIAH_HOST_GATEWAY_TOKEN" && \
    "$NEHEMIAH_INTERNAL_TOKEN" != "$NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" && \
    "$NEHEMIAH_HOST_GATEWAY_TOKEN" != "$NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" && \
    "$NEHEMIAH_OTEL_AUTHORIZATION" != "$NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" && \
    "$NEHEMIAH_OTEL_CREDENTIAL" != "$NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" && \
    "$NEHEMIAH_OTEL_AUTHORIZATION" != "$NEHEMIAH_INTERNAL_TOKEN" && \
    "$NEHEMIAH_OTEL_CREDENTIAL" != "$NEHEMIAH_INTERNAL_TOKEN" && \
    "$NEHEMIAH_OTEL_AUTHORIZATION" != "$NEHEMIAH_HOST_GATEWAY_TOKEN" && \
    "$NEHEMIAH_OTEL_CREDENTIAL" != "$NEHEMIAH_HOST_GATEWAY_TOKEN" ]] \
  || { echo "managed host credentials must be distinct" >&2; exit 1; }
if [[ "$NEHEMIAH_ADVERTISE_ADDRESS" == *:* ]]; then
  NEHEMIAH_LISTEN_ADDRESS="[${NEHEMIAH_ADVERTISE_ADDRESS}]:8080"
else
  NEHEMIAH_LISTEN_ADDRESS="${NEHEMIAH_ADVERTISE_ADDRESS}:8080"
fi

for bootstrap_command in apt-get bash curl dpkg dpkg-deb openssl python3 sha256sum stat tar uname; do
  command -v "$bootstrap_command" >/dev/null 2>&1 \
    || { echo "provider base image is missing bootstrap command: $bootstrap_command" >&2; exit 1; }
done
case "$(uname -m)" in
  x86_64) RELEASE_ARCH=amd64 ;;
  aarch64) RELEASE_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ "$LATITUDE_OS_ARCH" == "$RELEASE_ARCH" ]] \
  || { echo "provider image architecture does not match the running host" >&2; exit 1; }

RELEASE_DIR=$(mktemp -d /var/tmp/nehemiah-release.XXXXXX)
trap 'rm -rf -- "$RELEASE_DIR"' EXIT
RELEASE_URL="${NEHEMIAH_RELEASE_BASE%/}/v${NEHEMIAH_RELEASE_VERSION}"
MANIFEST_URL="${RELEASE_URL}/SHA256SUMS"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-filesize 1048576 \
  "$MANIFEST_URL" -o "$RELEASE_DIR/SHA256SUMS"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-filesize 65536 \
  "${MANIFEST_URL}.minisig" -o "$RELEASE_DIR/SHA256SUMS.minisig"
/usr/local/libexec/nehemiah-verify-minisign \
  --message "$RELEASE_DIR/SHA256SUMS" \
  --signature "$RELEASE_DIR/SHA256SUMS.minisig" \
  --public-key "$NEHEMIAH_RELEASE_MINISIGN_KEY"
python3 - "$RELEASE_DIR/SHA256SUMS" "$NEHEMIAH_RELEASE_VERSION" <<'PY'
import pathlib
import re
import sys

checksum_path, version = sys.argv[1:]
contents = pathlib.Path(checksum_path).read_text()
if not contents.endswith("\n") or "\r" in contents:
    raise SystemExit("signed checksum metadata has invalid line endings")
entries = {}
for line in contents[:-1].split("\n"):
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]{0,254})", line)
    if not match or match.group(2) in entries:
        raise SystemExit("signed checksum metadata is malformed or duplicated")
    entries[match.group(2)] = match.group(1)
expected = {"release-manifest.json", "nehemiah.rb", f"nehemiah-cli-{version}.tgz", f"nehemiah-host-bootstrap_{version}.tar.gz"}
for component in ("nehemiahd", "bc-guest-agent", "bc-gateway"):
    for arch in ("amd64", "arm64"):
        expected.add(f"{component}_{version}_linux_{arch}.tar.gz")
for flavor in ("python", "desktop"):
    for arch in ("amd64", "arm64"):
        expected.add(f"nehemiah-guest-{flavor}_{version}_linux_{arch}.ext4.gz")
for arch in ("amd64", "arm64"):
    expected.add(f"nehemiah-guest-scan_{version}_linux_{arch}.json")
    expected.add(f"nehemiah-host-packages_{version}_ubuntu24.04_linux_{arch}.tar.gz")
    expected.add(f"nehemiah-runtime-firecracker_1.15.1_linux_{arch}.tgz")
    expected.add(f"nehemiah-runtime-kernel_6.1.155_linux_{arch}.bin")
if set(entries) != expected:
    raise SystemExit("signed checksum metadata does not contain the exact release artifact set")
PY

fetch_release_artifact() {
  local artifact="$1" max_bytes="${2:-536870912}" matches
  [[ "$artifact" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$ ]] \
    || { echo "unsafe release artifact name" >&2; exit 1; }
  matches="$(awk -v name="$artifact" '$2 == name { print }' "$RELEASE_DIR/SHA256SUMS")"
  [[ "$(printf '%s\n' "$matches" | grep -c .)" -eq 1 && \
      "$matches" =~ ^[0-9a-f]{64}[[:space:]][[:space:]] ]] || {
    echo "signed checksum metadata does not contain exactly one $artifact" >&2
    exit 1
  }
  [[ "$max_bytes" =~ ^[1-9][0-9]*$ && "$max_bytes" -le 2147483648 ]] \
    || { echo "unsafe release artifact size bound" >&2; exit 1; }
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-filesize "$max_bytes" \
    "${RELEASE_URL}/${artifact}" \
    -o "$RELEASE_DIR/$artifact"
  (cd "$RELEASE_DIR" && printf '%s\n' "$matches" | sha256sum --check --strict --status)
}

fetch_release_artifact release-manifest.json
/usr/local/libexec/nehemiah-validate-release \
  --manifest "$RELEASE_DIR/release-manifest.json" \
  --version "$NEHEMIAH_RELEASE_VERSION" \
  --arch "$RELEASE_ARCH" \
  --output "$RELEASE_DIR/selected-release.env"
# The validator emits only fixed uppercase names and strict numeric/hash/file values.
# shellcheck disable=SC1091
source "$RELEASE_DIR/selected-release.env"

NEHEMIAH_FIRECRACKER_SHA256="$FIRECRACKER_ARCHIVE_SHA256"
NEHEMIAH_KERNEL_SHA256="$KERNEL_SHA256"
NEHEMIAH_FIRECRACKER_INSTALLED_SHA256="$FIRECRACKER_INSTALLED_SHA256"
NEHEMIAH_JAILER_INSTALLED_SHA256="$JAILER_INSTALLED_SHA256"
NEHEMIAH_RUNTIME_PYTHON_SHA256="$PYTHON_SHA256"
NEHEMIAH_RUNTIME_DESKTOP_SHA256="$DESKTOP_SHA256"
for artifact in "$DAEMON_ARTIFACT" "$AGENT_ARTIFACT" "$HOST_ARTIFACT"; do
  fetch_release_artifact "$artifact"
done
fetch_release_artifact "$PACKAGE_ARTIFACT" "$PACKAGE_MAX_BYTES"
fetch_release_artifact "$FIRECRACKER_ARTIFACT" "$FIRECRACKER_MAX_BYTES"
fetch_release_artifact "$KERNEL_ARTIFACT" "$KERNEL_MAX_BYTES"
NEHEMIAH_FIRECRACKER_ARCHIVE="$RELEASE_DIR/$FIRECRACKER_ARTIFACT"
NEHEMIAH_KERNEL_IMAGE="$RELEASE_DIR/$KERNEL_ARTIFACT"
export NEHEMIAH_FIRECRACKER_ARCHIVE NEHEMIAH_FIRECRACKER_SHA256
export NEHEMIAH_KERNEL_IMAGE NEHEMIAH_KERNEL_SHA256
export NEHEMIAH_FIRECRACKER_INSTALLED_SHA256 NEHEMIAH_JAILER_INSTALLED_SHA256
export NEHEMIAH_RUNTIME_PYTHON_SHA256 NEHEMIAH_RUNTIME_DESKTOP_SHA256
export NEHEMIAH_RELEASE_VERSION

safe_extract() {
  local archive="$1" destination="$2"
  mkdir -p "$destination"
  python3 - "$archive" "$destination" <<'PY'
import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if len(members) > 4096 or sum(member.size for member in members) > 512 * 1024 * 1024:
        raise SystemExit("release archive exceeds extraction limits")
    seen = set()
    for member in members:
        normalized = pathlib.PurePosixPath(member.name)
        canonical = str(normalized)
        if normalized.is_absolute() or ".." in normalized.parts or canonical in seen:
            raise SystemExit("release archive contains an unsafe or duplicate path")
        if not (member.isdir() or member.isfile()):
            raise SystemExit("release archive contains a non-regular entry")
        seen.add(canonical)
    bundle.extractall(destination, members=members, filter="data")
PY
}

safe_extract "$RELEASE_DIR/$HOST_ARTIFACT" "$RELEASE_DIR/host"
for relative in managed-host-packages.py validate-managed-release.py verify-minisign.py wireguard-config.py; do
  [[ -f "$RELEASE_DIR/host/infra/latitude/$relative" && \
      ! -L "$RELEASE_DIR/host/infra/latitude/$relative" ]] \
    || { echo "host bootstrap archive is missing $relative" >&2; exit 1; }
done
python3 "$RELEASE_DIR/host/infra/latitude/managed-host-packages.py" install \
  --archive "$RELEASE_DIR/$PACKAGE_ARTIFACT" \
  --manifest-sha256 "$PACKAGE_MANIFEST_SHA256" \
  --arch "$RELEASE_ARCH" \
  --release-version "$NEHEMIAH_RELEASE_VERSION"
# Cross-check the bootstrap verifier with the exact retained Minisign package.
minisign -Vm "$RELEASE_DIR/SHA256SUMS" -x "$RELEASE_DIR/SHA256SUMS.minisig" \
  -P "$NEHEMIAH_RELEASE_MINISIGN_KEY"

install_guest_image() {
  local flavor="$1" destination="$2" artifact="$3" max_bytes="$4"
  local expected_bytes="$5" expected_sha="$6" temporary magic
  fetch_release_artifact "$artifact" "$max_bytes"
  gzip --test "$RELEASE_DIR/$artifact"
  install -d -m 0755 /opt/boring/rootfs
  [[ ! -L /opt/boring/rootfs ]] || { echo "rootfs directory must not be a symlink" >&2; exit 1; }
  temporary="$(mktemp "/opt/boring/rootfs/.${flavor}.ext4.XXXXXX")"
  gzip -dc "$RELEASE_DIR/$artifact" | dd of="$temporary" bs=4M conv=sparse,fsync status=none
  [[ "$(stat -c %s "$temporary")" == "$expected_bytes" ]] \
    || { echo "$flavor image uncompressed size mismatch" >&2; exit 1; }
  [[ "$(sha256sum "$temporary" | cut -d' ' -f1)" == "$expected_sha" ]] \
    || { echo "$flavor image uncompressed checksum mismatch" >&2; exit 1; }
  magic="$(dd if="$temporary" bs=1 skip=1080 count=2 status=none | od -An -tx1 | tr -d ' \n')"
  [[ "$magic" == 53ef ]] || { echo "$flavor image is not ext4" >&2; exit 1; }
  file -b "$temporary" | grep -q 'ext4 filesystem data' \
    || { echo "$flavor image has an invalid filesystem type" >&2; exit 1; }
  e2fsck -fn "$temporary" >/dev/null
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv -fT "$temporary" "$destination"
  [[ -f "$destination" && ! -L "$destination" && "$(stat -c '%a:%u' "$destination")" == 644:0 ]] \
    || { echo "$flavor image was not installed safely" >&2; exit 1; }
}

install_guest_image python /opt/boring/rootfs/rootfs.ext4 \
  "$PYTHON_ARTIFACT" "$PYTHON_MAX_BYTES" "$PYTHON_UNCOMPRESSED_BYTES" "$PYTHON_SHA256"
install_guest_image desktop /opt/boring/rootfs/desktop.ext4 \
  "$DESKTOP_ARTIFACT" "$DESKTOP_MAX_BYTES" "$DESKTOP_UNCOMPRESSED_BYTES" "$DESKTOP_SHA256"

safe_extract "$RELEASE_DIR/$DAEMON_ARTIFACT" "$RELEASE_DIR/daemon"
safe_extract "$RELEASE_DIR/$AGENT_ARTIFACT" "$RELEASE_DIR/agent"
[[ -f "$RELEASE_DIR/daemon/nehemiahd" && ! -L "$RELEASE_DIR/daemon/nehemiahd" ]] \
  || { echo "daemon archive is missing nehemiahd" >&2; exit 1; }
[[ -f "$RELEASE_DIR/agent/bc-guest-agent" && ! -L "$RELEASE_DIR/agent/bc-guest-agent" ]] \
  || { echo "agent archive is missing bc-guest-agent" >&2; exit 1; }
install -D -m 0755 "$RELEASE_DIR/daemon/nehemiahd" /usr/local/bin/nehemiahd
install -D -m 0755 "$RELEASE_DIR/agent/bc-guest-agent" /opt/boring/bin/bc-guest-agent

ASSET_ROOT=/opt/nehemiah
for relative in \
  bootstrap.sh cloud-init.sh managed-host-packages.py managed-host-preflight.sh \
  net-setup.sh validate-managed-release.py verify-isolation.sh verify-minisign.py \
  wireguard-config.py; do
  source_path="$RELEASE_DIR/host/infra/latitude/$relative"
  [[ -f "$source_path" && ! -L "$source_path" ]] \
    || { echo "host bootstrap archive is missing $relative" >&2; exit 1; }
  install -D -m 0755 "$source_path" "$ASSET_ROOT/infra/latitude/$relative"
done
for relative in boring-net.service nehemiahd.service; do
  source_path="$RELEASE_DIR/host/infra/latitude/$relative"
  [[ -f "$source_path" && ! -L "$source_path" ]] \
    || { echo "host bootstrap archive is missing $relative" >&2; exit 1; }
  install -D -m 0644 "$source_path" "$ASSET_ROOT/infra/latitude/$relative"
done

install -d -m 0700 /etc/wireguard
wireguard_tmp="$(mktemp /etc/wireguard/.wg0.conf.XXXXXX)"
printf '%s' "$NEHEMIAH_WIREGUARD_CONFIG_B64" \
  | base64 --decode > "$wireguard_tmp"
chown root:root "$wireguard_tmp"
chmod 0600 "$wireguard_tmp"
NEHEMIAH_WIREGUARD_CONFIG_SHA256="$(sha256sum "$wireguard_tmp" | cut -d' ' -f1)"
python3 "$ASSET_ROOT/infra/latitude/wireguard-config.py" verify \
  --advertise-address "$NEHEMIAH_ADVERTISE_ADDRESS" \
  --control-plane-address "$NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS" \
  --gateway-address "$NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS" \
  --guest-subnet 10.200.0.0/24 \
  --expected-sha256 "$NEHEMIAH_WIREGUARD_CONFIG_SHA256" \
  --path "$wireguard_tmp"
mv -fT "$wireguard_tmp" /etc/wireguard/wg0.conf
wg-quick strip wg0 >/dev/null
systemctl enable --now wg-quick@wg0

install -d -m 0750 /etc/boring
cat > "$DAEMON_ENV" <<EOF
NEHEMIAH_MODE=1
NEHEMIAH_RELEASE_VERSION=${NEHEMIAH_RELEASE_VERSION}
NEHEMIAH_HOST_ID=${NEHEMIAH_HOST_ID}
NEHEMIAH_REGION=${NEHEMIAH_REGION}
NEHEMIAH_PROVIDER_ID=${NEHEMIAH_PROVIDER_ID}
NEHEMIAH_PROVIDER_IMAGE_ID=${LATITUDE_OS_ID}
NEHEMIAH_PROVIDER_IMAGE_SLUG=${LATITUDE_OS_SLUG}
NEHEMIAH_PROVIDER_IMAGE_VERSION=${LATITUDE_OS_VERSION}
NEHEMIAH_PROVIDER_IMAGE_ARCH=${LATITUDE_OS_ARCH}
NEHEMIAH_ADDR=${NEHEMIAH_LISTEN_ADDRESS}
NEHEMIAH_ADVERTISE_ADDRESS=${NEHEMIAH_ADVERTISE_ADDRESS}
NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS=${NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS}
NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS=${NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS}
NEHEMIAH_WIREGUARD_CONFIG_SHA256=${NEHEMIAH_WIREGUARD_CONFIG_SHA256}
NEHEMIAH_RUNTIME_COHORT_ID=${RUNTIME_COHORT_ID}
NEHEMIAH_RUNTIME_CONTRACT_VERSION=${RUNTIME_CONTRACT_VERSION}
NEHEMIAH_RUNTIME_ARCH=${RELEASE_ARCH}
NEHEMIAH_RUNTIME_PYTHON_SHA256=${PYTHON_SHA256}
NEHEMIAH_RUNTIME_DESKTOP_SHA256=${DESKTOP_SHA256}
NEHEMIAH_RUNTIME_KERNEL_SHA256=${KERNEL_SHA256}
NEHEMIAH_RUNTIME_FIRECRACKER_SHA256=${FIRECRACKER_INSTALLED_SHA256}
NEHEMIAH_RUNTIME_JAILER_SHA256=${JAILER_INSTALLED_SHA256}
NEHEMIAH_INTERNAL_TOKEN=${NEHEMIAH_INTERNAL_TOKEN}
NEHEMIAH_FLEET_BOOTSTRAP_TOKEN=${NEHEMIAH_FLEET_BOOTSTRAP_TOKEN}
NEHEMIAH_TOKEN=${NEHEMIAH_HOST_GATEWAY_TOKEN}
NEHEMIAH_CONTROL_PLANE_URL=${NEHEMIAH_CONTROL_PLANE_URL}
NEHEMIAH_CONTROL_PLANE_ALLOW_HTTP=0
NEHEMIAH_OTEL_ENABLED=${NEHEMIAH_OTEL_ENABLED}
NEHEMIAH_OTEL_ENDPOINT=${NEHEMIAH_OTEL_ENDPOINT}
NEHEMIAH_OTEL_AUTHORIZATION=${NEHEMIAH_OTEL_AUTHORIZATION}
NEHEMIAH_SERVICE_VERSION=${NEHEMIAH_SERVICE_VERSION}
NEHEMIAH_INSTANCE_ID=${NEHEMIAH_INSTANCE_ID}
NEHEMIAH_DEPLOYMENT_ENVIRONMENT=${NEHEMIAH_DEPLOYMENT_ENVIRONMENT}
NEHEMIAH_OTEL_EXPORT_INTERVAL_MS=${NEHEMIAH_OTEL_EXPORT_INTERVAL_MS}
NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS=${NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS}
NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO=${NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO}
NEHEMIAH_HEARTBEAT_SECONDS=10
NEHEMIAH_MAX_TTL=86400
NEHEMIAH_OVERLAY_QUOTA_MB=20480
NEHEMIAH_JAILER=1
NEHEMIAH_CGROUP=1
NEHEMIAH_NET=1
NEHEMIAH_NET_SUBNET=10.200.0
EOF
if [[ -n "$NEHEMIAH_TEMPLATE_OBJECT_ORIGIN" ]]; then
  printf 'NEHEMIAH_TEMPLATE_OBJECT_ORIGIN=%s\n' "$NEHEMIAH_TEMPLATE_OBJECT_ORIGIN" \
    >> "$DAEMON_ENV"
fi
chmod 0600 "$DAEMON_ENV"

install -d -m 0700 /var/lib/nehemiahd
provider_image_tmp="$(mktemp /var/lib/nehemiahd/.provider-image.XXXXXX)"
cat > "$provider_image_tmp" <<EOF
provider=latitude
id=${LATITUDE_OS_ID}
slug=${LATITUDE_OS_SLUG}
version=${LATITUDE_OS_VERSION}
arch=${LATITUDE_OS_ARCH}
EOF
chown root:root "$provider_image_tmp"
chmod 0600 "$provider_image_tmp"
mv -fT "$provider_image_tmp" /var/lib/nehemiahd/provider-image

ASSET_ROOT=/opt/nehemiah
test -x "$ASSET_ROOT/infra/latitude/bootstrap.sh"
test -x "$ASSET_ROOT/infra/latitude/managed-host-preflight.sh"
test -x "$ASSET_ROOT/infra/latitude/net-setup.sh"
test -x "$ASSET_ROOT/infra/latitude/managed-host-packages.py"
test -x "$ASSET_ROOT/infra/latitude/wireguard-config.py"
test -r "$ASSET_ROOT/infra/latitude/boring-net.service"
test -r "$ASSET_ROOT/infra/latitude/nehemiahd.service"

# Install the retained, signed host runtime (the signed guest images are already
# in place), then explicitly install networking
# and service units. Keep this explicit: bootstrap.sh intentionally only builds
# host artifacts and does not enable daemons.
install -m 0755 "$ASSET_ROOT/infra/latitude/managed-host-packages.py" /opt/boring/bin/managed-host-packages
install -m 0755 "$ASSET_ROOT/infra/latitude/wireguard-config.py" /opt/boring/bin/wireguard-config
"$ASSET_ROOT/infra/latitude/bootstrap.sh"
install -m 0755 "$ASSET_ROOT/infra/latitude/managed-host-preflight.sh" /opt/boring/bin/managed-host-preflight.sh
install -m 0755 "$ASSET_ROOT/infra/latitude/net-setup.sh" /opt/boring/bin/net-setup.sh
install -m 0644 "$ASSET_ROOT/infra/latitude/boring-net.service" /etc/systemd/system/boring-net.service
install -m 0644 "$ASSET_ROOT/infra/latitude/nehemiahd.service" /etc/systemd/system/nehemiahd.service

# This root-only marker distinguishes an approved, signed-release install from
# the separate local/prototype path. Publish it atomically only after the signed
# runtime bootstrap and managed units have installed successfully.
managed_marker_tmp="$(mktemp /etc/boring/.managed-host.XXXXXX)"
printf '%s\n' nehemiah-managed-host-v1 > "$managed_marker_tmp"
chown root:root "$managed_marker_tmp"
chmod 0400 "$managed_marker_tmp"
mv -fT "$managed_marker_tmp" "$MANAGED_HOST_MARKER"
systemctl daemon-reload
systemctl enable --now boring-net.service
systemctl enable nehemiahd.service
systemctl restart nehemiahd.service

# Do not erase the only usable enrollment credential until the daemon has
# durably enrolled and atomically removed the one-time token from its service
# environment. A failed bootstrap remains retryable and fails visibly.
enrollment_ready=0
for _ in $(seq 1 120); do
  if [[ -f /var/lib/nehemiahd/enrollment.json && \
        ! -L /var/lib/nehemiahd/enrollment.json && \
        "$(stat -c '%a:%u' /var/lib/nehemiahd/enrollment.json)" == 600:0 ]] && \
      systemctl is-active --quiet nehemiahd.service && \
      ! grep -Eq '^(NEHEMIAH|BORING)_FLEET_BOOTSTRAP_TOKEN=' "$DAEMON_ENV"; then
    enrollment_ready=1
    break
  fi
  sleep 1
done
if [[ "$enrollment_ready" != 1 ]]; then
  echo "managed host did not complete enrollment within 120 seconds" >&2
  exit 1
fi

# The source bundle and cloud-init's cached copy both contain recoverable
# base64-encoded credentials. Remove them only after durable enrollment.
shred -u "$BOOTSTRAP_ENV" 2>/dev/null || rm -f -- "$BOOTSTRAP_ENV"
for cached_user_data in \
  /var/lib/cloud/instances/*/user-data.txt \
  /var/lib/cloud/instances/*/user-data.txt.i; do
  [[ -e "$cached_user_data" || -L "$cached_user_data" ]] || continue
  if [[ -L "$cached_user_data" ]]; then
    unlink "$cached_user_data"
  elif [[ -f "$cached_user_data" ]]; then
    shred -u "$cached_user_data" 2>/dev/null || rm -f -- "$cached_user_data"
  fi
done
install -d -m 0700 /var/lib/nehemiahd
printf 'release=%s\n' "$NEHEMIAH_RELEASE_VERSION" \
  > /var/lib/nehemiahd/bootstrap.complete
chmod 0600 /var/lib/nehemiahd/bootstrap.complete

#!/usr/bin/env bash
# Exact, credential-safe preflight shared by the signed managed systemd units.
set -euo pipefail
set +x

ENV_PATH=/etc/boring/nehemiahd.env
MARKER_PATH=/etc/boring/managed-host
NET_SETUP=/opt/boring/bin/net-setup.sh
PACKAGE_GUARD=/opt/boring/bin/managed-host-packages
WIREGUARD_GUARD=/opt/boring/bin/wireguard-config
WIREGUARD_PATH=/etc/wireguard/wg0.conf
PROVIDER_IMAGE_PATH=/var/lib/nehemiahd/provider-image

fail_closed() {
  local label="$1"
  if [[ -x "$NET_SETUP" ]]; then
    /usr/bin/env NEHEMIAH_MODE=1 "$NET_SETUP" --fail-closed >/dev/null 2>&1 || true
  fi
  echo "managed host preflight failed: $label" >&2
  exit 1
}

require_exact_file() {
  local path="$1" expected_metadata="$2" label="$3" actual_metadata
  [[ -f "$path" && ! -L "$path" ]] || fail_closed "$label is not a regular file"
  actual_metadata="$(stat -c '%a:%u:%g' -- "$path")" \
    || fail_closed "$label metadata is unreadable"
  [[ "$actual_metadata" == "$expected_metadata" ]] \
    || fail_closed "$label ownership or mode is invalid"
}

require_exact_file "$ENV_PATH" 600:0:0 'managed environment'
require_exact_file "$MARKER_PATH" 400:0:0 'managed marker'
[[ "$(< "$MARKER_PATH")" == nehemiah-managed-host-v1 ]] \
  || fail_closed 'managed marker content is invalid'
require_exact_file "$WIREGUARD_PATH" 600:0:0 'WireGuard configuration'
require_exact_file "$PROVIDER_IMAGE_PATH" 600:0:0 'provider image evidence'
for required in \
  NEHEMIAH_RELEASE_VERSION NEHEMIAH_RUNTIME_ARCH NEHEMIAH_ADVERTISE_ADDRESS \
  NEHEMIAH_NET_SUBNET NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS \
  NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS \
  NEHEMIAH_WIREGUARD_CONFIG_SHA256 NEHEMIAH_PROVIDER_IMAGE_ID \
  NEHEMIAH_PROVIDER_IMAGE_SLUG NEHEMIAH_PROVIDER_IMAGE_VERSION \
  NEHEMIAH_PROVIDER_IMAGE_ARCH; do
  [[ -n "${!required:-}" ]] || fail_closed "$required is missing"
done
[[ -x "$PACKAGE_GUARD" ]] || fail_closed 'package guard is missing'
[[ -x "$WIREGUARD_GUARD" ]] || fail_closed 'WireGuard guard is missing'
python3 "$PACKAGE_GUARD" verify-installed \
  --arch "$NEHEMIAH_RUNTIME_ARCH" --release-version "$NEHEMIAH_RELEASE_VERSION" \
  || fail_closed 'managed package cohort has drifted'
python3 "$WIREGUARD_GUARD" verify \
  --advertise-address "$NEHEMIAH_ADVERTISE_ADDRESS" \
  --control-plane-address "$NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS" \
  --gateway-address "$NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS" \
  --guest-subnet "${NEHEMIAH_NET_SUBNET}.0/24" \
  --expected-sha256 "$NEHEMIAH_WIREGUARD_CONFIG_SHA256" \
  --path "$WIREGUARD_PATH" \
  || fail_closed 'WireGuard configuration has drifted'
if ! python3 - "$PROVIDER_IMAGE_PATH" \
  "$NEHEMIAH_PROVIDER_IMAGE_ID" "$NEHEMIAH_PROVIDER_IMAGE_SLUG" \
  "$NEHEMIAH_PROVIDER_IMAGE_VERSION" "$NEHEMIAH_PROVIDER_IMAGE_ARCH" <<'PY'
import pathlib
import sys

path, image_id, slug, version, arch = sys.argv[1:]
expected = f"provider=latitude\nid={image_id}\nslug={slug}\nversion={version}\narch={arch}\n"
if pathlib.Path(path).read_text() != expected:
    raise SystemExit(1)
PY
then
  fail_closed 'provider image evidence has drifted'
fi

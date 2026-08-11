#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TASK_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/managed-provisioning-test.XXXXXX")"
FAKE_API_PID=""
cleanup() {
  local status=$?
  if [[ -n "$FAKE_API_PID" ]]; then
    kill "$FAKE_API_PID" 2>/dev/null || true
    wait "$FAKE_API_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TASK_TEMP"
  return "$status"
}
trap cleanup EXIT
trap 'printf "managed provisioning test failed at line %s\n" "$LINENO" >&2' ERR

MINISIGN_KEY="RW$(printf 'A%.0s' {1..54})"
FLEET_TOKEN="nhe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTEL_CREDENTIAL="otel-host-test-credential-abcdef0123456789"
WIREGUARD_PRIVATE="QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="
WIREGUARD_CONFIG="[Interface]
PrivateKey = ${WIREGUARD_PRIVATE}
Address = 10.42.0.10/32

[Peer]
PublicKey = QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=
Endpoint = 192.0.2.10:51820
AllowedIPs = 10.42.0.1/32, 10.42.0.2/32
PersistentKeepalive = 25"
WIREGUARD_B64="$(printf '%s\n' "$WIREGUARD_CONFIG" | base64 --wrap=0)"
SSH_PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE4xY2hhbmdlVGhpcyBUZXN0S2V5 managed-test"
SSH_PUBLIC_KEY_B64="$(printf '%s\n' "$SSH_PUBLIC_KEY" | base64 --wrap=0)"
CONFIG_FILE="$TASK_TEMP/managed-host.env"
cat > "$CONFIG_FILE" <<EOF
NEHEMIAH_RELEASE_BASE=https://github.com/boringcomputers/nehemiah/releases/download
NEHEMIAH_RELEASE_VERSION=0.2.0-beta.0
NEHEMIAH_RELEASE_MINISIGN_KEY=${MINISIGN_KEY}
NEHEMIAH_HOST_ID=latitude-test-01
NEHEMIAH_REGION=MIA2
NEHEMIAH_PROVIDER_ID=latitude-provider-test-01
LATITUDE_OS_ID=os_test1234
LATITUDE_OS_SLUG=ubuntu_24_04_x64_lts
LATITUDE_OS_VERSION=24.04 LTS
LATITUDE_OS_ARCH=amd64
NEHEMIAH_FLEET_BOOTSTRAP_TOKEN=${FLEET_TOKEN}
NEHEMIAH_CONTROL_PLANE_URL=https://control.example.com
NEHEMIAH_TEMPLATE_OBJECT_ORIGIN=https://nehemiah-template-artifacts.objects.example.com
NEHEMIAH_ADVERTISE_ADDRESS=10.42.0.10
NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS=10.42.0.1
NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS=10.42.0.2
NEHEMIAH_WIREGUARD_CONFIG_B64=${WIREGUARD_B64}
NEHEMIAH_OTEL_ENABLED=true
NEHEMIAH_OTEL_ENDPOINT=https://otel-collector.internal.example
NEHEMIAH_OTEL_AUTHORIZATION=Basic ${OTEL_CREDENTIAL}
NEHEMIAH_SERVICE_VERSION=0.2.0-beta.0
NEHEMIAH_INSTANCE_ID=latitude-test-01
NEHEMIAH_DEPLOYMENT_ENVIRONMENT=staging
NEHEMIAH_OTEL_EXPORT_INTERVAL_MS=15000
NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS=10000
NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO=0.1
NEHEMIAH_ROOT_SSH_AUTHORIZED_KEY_B64=${SSH_PUBLIC_KEY_B64}
EOF
chmod 0600 "$CONFIG_FILE"

wireguard_validator="$REPOSITORY_ROOT/infra/latitude/wireguard-config.py"
canonical_wireguard="$(printf '%s' "$WIREGUARD_B64" \
  | python3 "$wireguard_validator" canonicalize-base64 \
      --advertise-address 10.42.0.10 \
      --control-plane-address 10.42.0.1 \
      --gateway-address 10.42.0.2 \
      --guest-subnet 10.200.0.0/24)"
[[ "$canonical_wireguard" == "$WIREGUARD_CONFIG" ]]
expect_wireguard_rejection() {
  local label="$1" raw="$2" encoded
  encoded="$(printf '%s\n' "$raw" | base64 --wrap=0)"
  if printf '%s' "$encoded" \
    | python3 "$wireguard_validator" canonicalize-base64 \
        --advertise-address 10.42.0.10 \
        --control-plane-address 10.42.0.1 \
        --gateway-address 10.42.0.2 \
        --guest-subnet 10.200.0.0/24 \
        > "$TASK_TEMP/wireguard-${label}.stdout" \
        2> "$TASK_TEMP/wireguard-${label}.stderr"; then
    echo "WireGuard parser accepted unsafe input: $label" >&2
    exit 1
  fi
}
expect_wireguard_rejection hook "${WIREGUARD_CONFIG}
PostUp = touch /root/pwned"
expect_wireguard_rejection default-route "${WIREGUARD_CONFIG/10.42.0.1\/32, 10.42.0.2\/32/0.0.0.0\/0}"
expect_wireguard_rejection duplicate-address "${WIREGUARD_CONFIG/Address = 10.42.0.10\/32/Address = 10.42.0.10\/32
Address = 10.42.0.10\/32}"
expect_wireguard_rejection dns "${WIREGUARD_CONFIG/Address = 10.42.0.10\/32/Address = 10.42.0.10\/32
DNS = 1.1.1.1}"
expect_wireguard_rejection broad-route "${WIREGUARD_CONFIG/10.42.0.1\/32, 10.42.0.2\/32/10.42.0.0\/24}"
expect_wireguard_rejection wrong-host-route "${WIREGUARD_CONFIG/10.42.0.1\/32, 10.42.0.2\/32/10.42.0.1\/32, 10.42.0.3\/32}"
expect_wireguard_rejection missing-role "${WIREGUARD_CONFIG/10.42.0.1\/32, 10.42.0.2\/32/10.42.0.1\/32}"
expect_wireguard_rejection extra-role "${WIREGUARD_CONFIG/10.42.0.1\/32, 10.42.0.2\/32/10.42.0.1\/32, 10.42.0.2\/32, 10.42.0.3\/32}"
for label_and_addresses in \
  'guest-role 10.200.0.2 10.42.0.2' \
  'duplicate-role 10.42.0.1 10.42.0.1' \
  'family-mismatch 10.42.0.1 fd00::2'; do
  read -r label control_plane gateway <<< "$label_and_addresses"
  if printf '%s' "$WIREGUARD_B64" \
    | python3 "$wireguard_validator" canonicalize-base64 \
        --advertise-address 10.42.0.10 \
        --control-plane-address "$control_plane" \
        --gateway-address "$gateway" \
        --guest-subnet 10.200.0.0/24 \
        > "$TASK_TEMP/wireguard-${label}.stdout" \
        2> "$TASK_TEMP/wireguard-${label}.stderr"; then
    echo "WireGuard parser accepted unsafe typed routes: $label" >&2
    exit 1
  fi
done
wireguard_file="$TASK_TEMP/wg0.conf"
printf '%s\n' "$canonical_wireguard" > "$wireguard_file"
chmod 0600 "$wireguard_file"
wireguard_digest="$(sha256sum "$wireguard_file" | awk '{print $1}')"
python3 "$wireguard_validator" verify \
  --advertise-address 10.42.0.10 \
  --control-plane-address 10.42.0.1 \
  --gateway-address 10.42.0.2 \
  --guest-subnet 10.200.0.0/24 \
  --expected-sha256 "$wireguard_digest" \
  --path "$wireguard_file"
chmod 0644 "$wireguard_file"
if python3 "$wireguard_validator" verify \
  --advertise-address 10.42.0.10 \
  --control-plane-address 10.42.0.1 \
  --gateway-address 10.42.0.2 \
  --guest-subnet 10.200.0.0/24 \
  --expected-sha256 "$wireguard_digest" \
  --path "$wireguard_file" >/dev/null 2>&1; then
  echo "WireGuard verifier accepted a loose configuration mode" >&2
  exit 1
fi

assert_no_secret_output() {
  local output="$1"
  for secret in "$FLEET_TOKEN" "$OTEL_CREDENTIAL" "$WIREGUARD_PRIVATE" "$SSH_PUBLIC_KEY" \
    "latitude-test-api-key-1234567890"; do
    if grep -Fq "$secret" "$output"; then
      echo "credential appeared in command output" >&2
      exit 1
    fi
  done
}

RENDERED="$TASK_TEMP/rendered.yaml"
"$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
  --config "$CONFIG_FILE" --output "$RENDERED" \
  > "$TASK_TEMP/render.stdout" 2> "$TASK_TEMP/render.stderr"
assert_no_secret_output "$TASK_TEMP/render.stdout"
assert_no_secret_output "$TASK_TEMP/render.stderr"
[[ "$(stat -c '%a' "$RENDERED")" == 600 ]]
grep -Fxq '#cloud-config' "$RENDERED"
! grep -Fq "$FLEET_TOKEN" "$RENDERED"
! grep -Fq "$WIREGUARD_PRIVATE" "$RENDERED"

python3 - "$RENDERED" "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh" \
  "$FLEET_TOKEN" "$SSH_PUBLIC_KEY" \
  "https://nehemiah-template-artifacts.objects.example.com" <<'PY'
import base64
import pathlib
import re
import sys

rendered, cloud_init, fleet_token, ssh_key, object_origin = sys.argv[1:]
document = pathlib.Path(rendered).read_text()
matches = re.findall(
    r"  - path: ([^\n]+)\n"
    r"    owner: root:root\n"
    r"    permissions: '(0[67]00)'\n"
    r"    encoding: b64\n"
    r"    content: ([A-Za-z0-9+/=]+)\n",
    document,
)
files = {path: {"permissions": permissions, "content": content} for path, permissions, content in matches}
assert set(files) == {
    "/etc/nehemiah/bootstrap.env",
    "/usr/local/sbin/nehemiah-cloud-init",
    "/usr/local/libexec/nehemiah-validate-release",
    "/usr/local/libexec/nehemiah-verify-minisign",
    "/usr/local/libexec/nehemiah-wireguard-config",
    "/root/.ssh/authorized_keys",
}
assert files["/etc/nehemiah/bootstrap.env"]["permissions"] == "0600"
assert files["/usr/local/sbin/nehemiah-cloud-init"]["permissions"] == "0700"
for helper in (
    "/usr/local/libexec/nehemiah-validate-release",
    "/usr/local/libexec/nehemiah-verify-minisign",
    "/usr/local/libexec/nehemiah-wireguard-config",
):
    assert files[helper]["permissions"] == "0700"
bootstrap = base64.b64decode(files["/etc/nehemiah/bootstrap.env"]["content"], validate=True)
assert f"NEHEMIAH_FLEET_BOOTSTRAP_TOKEN={fleet_token}\n".encode() in bootstrap
assert f"NEHEMIAH_TEMPLATE_OBJECT_ORIGIN={object_origin}\n".encode() in bootstrap
for telemetry_key in (
    "NEHEMIAH_OTEL_ENABLED",
    "NEHEMIAH_OTEL_ENDPOINT",
    "NEHEMIAH_OTEL_AUTHORIZATION",
    "NEHEMIAH_SERVICE_VERSION",
    "NEHEMIAH_INSTANCE_ID",
    "NEHEMIAH_DEPLOYMENT_ENVIRONMENT",
    "NEHEMIAH_OTEL_EXPORT_INTERVAL_MS",
    "NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS",
    "NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO",
):
    assert f"{telemetry_key}=".encode() in bootstrap
for wireguard_role_key in (
    "NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS",
    "NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS",
):
    assert f"{wireguard_role_key}=".encode() in bootstrap
installed_cloud_init = base64.b64decode(
    files["/usr/local/sbin/nehemiah-cloud-init"]["content"], validate=True
)
assert installed_cloud_init == pathlib.Path(cloud_init).read_bytes()
installed_ssh_key = base64.b64decode(
    files["/root/.ssh/authorized_keys"]["content"], validate=True
).decode().rstrip("\n")
assert installed_ssh_key == ssh_key
assert document.endswith("runcmd:\n  - [ /usr/local/sbin/nehemiah-cloud-init ]\n")
PY

before_digest="$(sha256sum "$RENDERED" | awk '{print $1}')"
if "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
  --config "$CONFIG_FILE" --output "$RENDERED" \
  > "$TASK_TEMP/overwrite.stdout" 2> "$TASK_TEMP/overwrite.stderr"; then
  echo "renderer overwrote an existing output" >&2
  exit 1
fi
[[ "$(sha256sum "$RENDERED" | awk '{print $1}')" == "$before_digest" ]]

expect_render_rejection() {
  local config="$1" label="$2"
  chmod 0600 "$config"
  if "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
    --config "$config" --output "$TASK_TEMP/rejected-${label}.yaml" >/dev/null 2>&1; then
    echo "renderer accepted invalid telemetry config: $label" >&2
    exit 1
  fi
}

sed '/^NEHEMIAH_OTEL_ENDPOINT=/d' "$CONFIG_FILE" > "$TASK_TEMP/missing-otel.env"
expect_render_rejection "$TASK_TEMP/missing-otel.env" missing
sed 's#^NEHEMIAH_OTEL_ENDPOINT=.*#NEHEMIAH_OTEL_ENDPOINT=https://192.0.2.7#' \
  "$CONFIG_FILE" > "$TASK_TEMP/ip-otel.env"
expect_render_rejection "$TASK_TEMP/ip-otel.env" ip-endpoint
sed "s#^NEHEMIAH_OTEL_AUTHORIZATION=.*#NEHEMIAH_OTEL_AUTHORIZATION=Basic ${FLEET_TOKEN}#" \
  "$CONFIG_FILE" > "$TASK_TEMP/shared-otel.env"
expect_render_rejection "$TASK_TEMP/shared-otel.env" shared-credential
sed 's/^NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS=.*/NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS=15000/' \
  "$CONFIG_FILE" > "$TASK_TEMP/timeout-otel.env"
expect_render_rejection "$TASK_TEMP/timeout-otel.env" timeout-bound
sed 's/^NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO=.*/NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO=nan/' \
  "$CONFIG_FILE" > "$TASK_TEMP/sample-otel.env"
expect_render_rejection "$TASK_TEMP/sample-otel.env" sample-bound

chmod 0644 "$CONFIG_FILE"
if "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
  --config "$CONFIG_FILE" --output "$TASK_TEMP/loose.yaml" >/dev/null 2>&1; then
  echo "renderer accepted a loose config file" >&2
  exit 1
fi
chmod 0600 "$CONFIG_FILE"
ln -s "$CONFIG_FILE" "$TASK_TEMP/config-link"
if "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
  --config "$TASK_TEMP/config-link" --output "$TASK_TEMP/link.yaml" >/dev/null 2>&1; then
  echo "renderer accepted a symlink config file" >&2
  exit 1
fi

INJECTION_CONFIG="$TASK_TEMP/injection.env"
cp "$CONFIG_FILE" "$INJECTION_CONFIG"
printf 'EVIL=$(touch %s)\n' "$TASK_TEMP/injected" >> "$INJECTION_CONFIG"
chmod 0600 "$INJECTION_CONFIG"
if "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
  --config "$INJECTION_CONFIG" --output "$TASK_TEMP/injection.yaml" >/dev/null 2>&1; then
  echo "renderer accepted an unknown shell expression" >&2
  exit 1
fi
[[ ! -e "$TASK_TEMP/injected" ]]

"$REPOSITORY_ROOT/infra/latitude/provision.sh" \
  --config "$CONFIG_FILE" --output "$TASK_TEMP/render-only.yaml" --render-only \
  > "$TASK_TEMP/render-only.stdout" 2> "$TASK_TEMP/render-only.stderr"
assert_no_secret_output "$TASK_TEMP/render-only.stdout"
assert_no_secret_output "$TASK_TEMP/render-only.stderr"

cat > "$TASK_TEMP/fake-latitude.py" <<'PY'
import base64
import http.server
import json
import pathlib
import sys

port_file, request_log = map(pathlib.Path, sys.argv[1:])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def body(self):
        length = int(self.headers.get("content-length", "0"))
        return self.rfile.read(length)

    def respond(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/vnd.api+json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record(self, event):
        with request_log.open("a") as output:
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

    def do_POST(self):
        request = json.loads(self.body())
        authorized = self.headers.get("authorization") == "Bearer latitude-test-api-key-1234567890"
        if self.path == "/user_data":
            attributes = request["data"]["attributes"]
            cloud_config = base64.b64decode(attributes["content"], validate=True)
            self.record({
                "event": "user_data_created",
                "authorized": authorized,
                "project": attributes["project"],
                "cloud_config": cloud_config.startswith(b"#cloud-config\n"),
            })
            # Deliberately echo content, matching Latitude's documented response.
            self.respond(201, {"data": {"id": "ud_test1234", "attributes": attributes}})
        elif self.path == "/servers":
            attributes = request["data"]["attributes"]
            self.record({
                "event": "server_created",
                "authorized": authorized,
                "user_data": attributes["user_data"],
                "billing": attributes["billing"],
            })
            self.respond(201, {"data": {"id": "sv_test1234", "attributes": {"status": "off"}}})
        else:
            self.respond(404, {"errors": [{"title": "not found"}]})

    def do_GET(self):
        if self.path.startswith("/plans/operating_systems?"):
            self.record({
                "event": "provider_image_read",
                "authorized": self.headers.get("authorization") == "Bearer latitude-test-api-key-1234567890",
            })
            self.respond(200, {"data": [{
                "id": "os_test1234",
                "type": "operating_system",
                "attributes": {
                    "slug": "ubuntu_24_04_x64_lts",
                    "version": "24.04 LTS",
                    "provisionable_on": ["c3-small-x86"],
                },
            }], "meta": {}})
        elif self.path == "/servers/sv_test1234":
            self.record({"event": "server_read"})
            self.respond(200, {"data": {"id": "sv_test1234", "attributes": {
                "status": "on", "primary_ipv4": "192.0.2.44"
            }}})
        else:
            self.respond(404, {"errors": [{"title": "not found"}]})

    def do_DELETE(self):
        if self.path == "/user_data/ud_test1234":
            self.record({"event": "user_data_deleted"})
            self.respond(204)
        else:
            self.respond(404)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_address[1]))
server.serve_forever()
PY
python3 "$TASK_TEMP/fake-latitude.py" \
  "$TASK_TEMP/api.port" "$TASK_TEMP/api.log" &
FAKE_API_PID=$!
for _ in {1..100}; do
  [[ -s "$TASK_TEMP/api.port" ]] && break
  sleep 0.05
done
[[ -s "$TASK_TEMP/api.port" ]]
FAKE_API_PORT="$(< "$TASK_TEMP/api.port")"

LATITUDE_API_KEY=latitude-test-api-key-1234567890 \
LATITUDE_PROJECT=proj_test1234 \
LATITUDE_SSH_KEY=ssh_test1234 \
LATITUDE_STATE_DIR="$TASK_TEMP/state" \
LATITUDE_API_BASE="http://127.0.0.1:$FAKE_API_PORT" \
LATITUDE_ALLOW_HTTP_FOR_TESTS=1 \
LATITUDE_POLL_INTERVAL_SECONDS=0 \
LATITUDE_POLL_ATTEMPTS=2 \
  "$REPOSITORY_ROOT/infra/latitude/provision.sh" --config "$CONFIG_FILE" \
  > "$TASK_TEMP/provision.stdout" 2> "$TASK_TEMP/provision.stderr"
assert_no_secret_output "$TASK_TEMP/provision.stdout"
assert_no_secret_output "$TASK_TEMP/provision.stderr"
[[ "$(stat -c '%a' "$TASK_TEMP/state/server_id")" == 600 ]]
[[ "$(< "$TASK_TEMP/state/server_id")" == sv_test1234 ]]
[[ "$(stat -c '%a' "$TASK_TEMP/state/provider-image-sv_test1234.json")" == 600 ]]

python3 - "$TASK_TEMP/api.log" <<'PY'
import json
import pathlib
import sys

events = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
assert [event["event"] for event in events] == [
    "provider_image_read",
    "user_data_created",
    "server_created",
    "server_read",
    "user_data_deleted",
]
assert events[0]["authorized"] is True
assert events[1]["authorized"] is True
assert events[1]["project"] == "proj_test1234"
assert events[1]["cloud_config"] is True
assert events[2]["authorized"] is True
assert events[2]["user_data"] == "ud_test1234"
assert events[2]["billing"] == "hourly"
PY

# A valid but unapproved opaque image id must fail before user-data creation or
# a billable server POST. The sole additional provider request is inventory GET.
sed 's/^LATITUDE_OS_ID=.*/LATITUDE_OS_ID=os_missing1234/' \
  "$CONFIG_FILE" > "$TASK_TEMP/unapproved-image.env"
chmod 0600 "$TASK_TEMP/unapproved-image.env"
events_before="$(wc -l < "$TASK_TEMP/api.log")"
if LATITUDE_API_KEY=latitude-test-api-key-1234567890 \
  LATITUDE_PROJECT=proj_test1234 \
  LATITUDE_SSH_KEY=ssh_test1234 \
  LATITUDE_STATE_DIR="$TASK_TEMP/unapproved-state" \
  LATITUDE_API_BASE="http://127.0.0.1:$FAKE_API_PORT" \
  LATITUDE_ALLOW_HTTP_FOR_TESTS=1 \
  LATITUDE_POLL_INTERVAL_SECONDS=0 \
  LATITUDE_POLL_ATTEMPTS=2 \
    "$REPOSITORY_ROOT/infra/latitude/provision.sh" \
      --config "$TASK_TEMP/unapproved-image.env" \
      > "$TASK_TEMP/unapproved.stdout" 2> "$TASK_TEMP/unapproved.stderr"; then
  echo "provisioner accepted an unapproved provider image id" >&2
  exit 1
fi
assert_no_secret_output "$TASK_TEMP/unapproved.stdout"
assert_no_secret_output "$TASK_TEMP/unapproved.stderr"
[[ "$(wc -l < "$TASK_TEMP/api.log")" -eq $((events_before + 1)) ]]
[[ "$(tail -n 1 "$TASK_TEMP/api.log")" == *'"event":"provider_image_read"'* ]]

for script in \
  bootstrap.sh build-desktop-rootfs.sh build-rootfs.sh cloud-init.sh managed-host-preflight.sh net-setup.sh \
  provision.sh render-user-data.sh verify-isolation.sh; do
  bash -n "$REPOSITORY_ROOT/infra/latitude/$script"
done
grep -Fq 'minisign -Vm' "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq '"DAEMON_ARTIFACT": f"nehemiahd_{version}_linux_{arch}.tar.gz"' \
  "$REPOSITORY_ROOT/infra/latitude/validate-managed-release.py"
grep -Fq 'host["inputs"][candidate] != RUNTIME[candidate]' \
  "$REPOSITORY_ROOT/infra/latitude/validate-managed-release.py"
grep -Fq 'exact release artifact set' "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq 'manifest["schemaVersion"] != 5' \
  "$REPOSITORY_ROOT/infra/latitude/validate-managed-release.py"
grep -Fq 'host["contractVersion"] != 4' \
  "$REPOSITORY_ROOT/infra/latitude/validate-managed-release.py"
grep -Fq 'signed-developer-ext4-v1' \
  "$REPOSITORY_ROOT/infra/latitude/validate-managed-release.py"
grep -Fq 'install_guest_image python /opt/boring/rootfs/rootfs.ext4' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq 'install_guest_image desktop /opt/boring/rootfs/desktop.ext4' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq 'gzip --test' "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq 'e2fsck -fn' "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
for key in \
  NEHEMIAH_OTEL_ENABLED NEHEMIAH_OTEL_ENDPOINT NEHEMIAH_OTEL_AUTHORIZATION \
  NEHEMIAH_SERVICE_VERSION NEHEMIAH_INSTANCE_ID NEHEMIAH_DEPLOYMENT_ENVIRONMENT \
  NEHEMIAH_OTEL_EXPORT_INTERVAL_MS NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS \
  NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO; do
  grep -Fq ": \"\${${key}:?required}\"" "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
  grep -Fq "${key}=\${${key}}" "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
done
for key in \
  NEHEMIAH_RUNTIME_COHORT_ID NEHEMIAH_RUNTIME_CONTRACT_VERSION \
  NEHEMIAH_RUNTIME_ARCH NEHEMIAH_RUNTIME_PYTHON_SHA256 \
  NEHEMIAH_RUNTIME_DESKTOP_SHA256 NEHEMIAH_RUNTIME_KERNEL_SHA256 \
  NEHEMIAH_RUNTIME_FIRECRACKER_SHA256 NEHEMIAH_RUNTIME_JAILER_SHA256; do
  grep -Fq "${key}=" "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
done
grep -Fq 'managed-host-packages.py" install' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq '"--no-download"' \
  "$REPOSITORY_ROOT/infra/latitude/managed-host-packages.py"
for managed_script in cloud-init.sh bootstrap.sh net-setup.sh; do
  if grep -Eq '\b(apt|apt-get|aptitude)[[:space:]]+(update|install|upgrade|full-upgrade|dist-upgrade)\b' \
    "$REPOSITORY_ROOT/infra/latitude/$managed_script"; then
    echo "managed runtime mutates a network package repository: $managed_script" >&2
    exit 1
  fi
done
grep -Fq 'NEHEMIAH_FIRECRACKER_ARCHIVE' "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"
grep -Fq 'NEHEMIAH_KERNEL_IMAGE' "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"
grep -Fq 'fetch_release_artifact "$FIRECRACKER_ARTIFACT"' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
grep -Fq 'fetch_release_artifact "$KERNEL_ARTIFACT"' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh"
if grep -Eq 'NEHEMIAH_(FIRECRACKER|KERNEL)_URL|download_verified|curl --fail' \
  "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"; then
  echo "managed bootstrap still downloads runtime inputs outside the signed release" >&2
  exit 1
fi

# Execute the exact bootstrap account function against a fake NSS database.
# Fresh and idempotent states succeed; name, UID, GID, account-shape, and lock
# collisions fail before a user/group mutation can be hidden.
account_fixture="$TASK_TEMP/account-fixture"
account_fake_bin="$account_fixture/bin"
mkdir -p "$account_fake_bin"
account_runner="$account_fixture/ensure-account.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf '%s\n' 'die() { printf "%s\\n" "$*" >&2; exit 1; }'
  awk '
    /^ensure_boringjail_account\(\) \{/ { copying = 1 }
    copying { print }
    copying && /^}$/ { exit }
  ' "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"
  printf '%s\n' 'ensure_boringjail_account'
} > "$account_runner"
chmod 0755 "$account_runner"
cat > "$account_fake_bin/account-command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_name="${0##*/}"
: "${FAKE_ACCOUNT_STATE:?}"
case "$command_name" in
  getent)
    database="$1"
    key="$2"
    file="$FAKE_ACCOUNT_STATE/$database"
    [[ -f "$file" ]] || : > "$file"
    awk -F: -v key="$key" '
      $1 == key || $3 == key { print; found = 1 }
      END { exit(found ? 0 : 2) }
    ' "$file"
    ;;
  groupadd)
    [[ "$1" == --gid && "$#" == 3 ]]
    printf '%s:x:%s:\n' "$3" "$2" >> "$FAKE_ACCOUNT_STATE/group"
    printf 'groupadd %s %s\n' "$3" "$2" >> "$FAKE_ACCOUNT_STATE/actions"
    ;;
  useradd)
    uid="" gid="" home="" shell="" comment="" name=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --uid) uid="$2"; shift 2 ;;
        --gid) gid="$2"; shift 2 ;;
        --no-create-home) shift ;;
        --home-dir) home="$2"; shift 2 ;;
        --shell) shell="$2"; shift 2 ;;
        --comment) comment="$2"; shift 2 ;;
        *) name="$1"; shift ;;
      esac
    done
    printf '%s:x:%s:%s:%s:%s:%s\n' "$name" "$uid" "$gid" "$comment" "$home" "$shell" \
      >> "$FAKE_ACCOUNT_STATE/passwd"
    printf 'useradd %s %s %s %s %s\n' "$name" "$uid" "$gid" "$home" "$shell" \
      >> "$FAKE_ACCOUNT_STATE/actions"
    ;;
  passwd)
    [[ "$1" == --status && "$#" == 2 ]]
    printf '%s %s 01/01/1970 0 99999 7 -1\n' "$2" "$(< "$FAKE_ACCOUNT_STATE/password-status")"
    ;;
  install)
    [[ "${*: -1}" == /srv/jailer ]]
    printf 'install-jailer\n' >> "$FAKE_ACCOUNT_STATE/actions"
    ;;
  stat)
    [[ "${*: -1}" == /srv/jailer ]]
    printf '%s\n' '755:0:0'
    ;;
  *) exit 127 ;;
esac
EOF
chmod 0755 "$account_fake_bin/account-command"
for command_name in getent groupadd useradd passwd install stat; do
  ln -s account-command "$account_fake_bin/$command_name"
done

new_account_state() {
  local name="$1"
  local state="$account_fixture/$name"
  mkdir -p "$state"
  : > "$state/group"
  : > "$state/passwd"
  : > "$state/actions"
  printf '%s\n' L > "$state/password-status"
  printf '%s\n' "$state"
}
run_account_fixture() {
  local state="$1"
  FAKE_ACCOUNT_STATE="$state" PATH="$account_fake_bin:$PATH" "$account_runner"
}
expect_account_rejection() {
  local label="$1" state="$2"
  if run_account_fixture "$state" > "$TASK_TEMP/account-${label}.stdout" \
    2> "$TASK_TEMP/account-${label}.stderr"; then
    echo "bootstrap accepted a colliding jailer account: $label" >&2
    exit 1
  fi
}

fresh_account_state="$(new_account_state fresh)"
run_account_fixture "$fresh_account_state"
grep -Fxq 'boringjail:x:30000:' "$fresh_account_state/group"
grep -Fxq 'boringjail:x:30000:30000::/nonexistent:/usr/sbin/nologin' \
  "$fresh_account_state/passwd"
: > "$fresh_account_state/actions"
run_account_fixture "$fresh_account_state"
! grep -Eq '^(groupadd|useradd)' "$fresh_account_state/actions"

group_name_collision="$(new_account_state group-name-collision)"
printf '%s\n' 'boringjail:x:29999:' > "$group_name_collision/group"
expect_account_rejection group-name "$group_name_collision"

group_id_collision="$(new_account_state group-id-collision)"
printf '%s\n' 'unrelated:x:30000:' > "$group_id_collision/group"
expect_account_rejection group-id "$group_id_collision"

uid_collision="$(new_account_state uid-collision)"
printf '%s\n' 'boringjail:x:30000:' > "$uid_collision/group"
printf '%s\n' 'unrelated:x:30000:30000::/nonexistent:/usr/sbin/nologin' > "$uid_collision/passwd"
expect_account_rejection uid "$uid_collision"

account_shape_collision="$(new_account_state account-shape-collision)"
printf '%s\n' 'boringjail:x:30000:' > "$account_shape_collision/group"
printf '%s\n' 'boringjail:x:30000:30000::/home/boringjail:/bin/bash' > "$account_shape_collision/passwd"
expect_account_rejection account-shape "$account_shape_collision"

unlocked_account="$(new_account_state unlocked-account)"
printf '%s\n' 'boringjail:x:30000:' > "$unlocked_account/group"
printf '%s\n' 'boringjail:x:30000:30000::/nonexistent:/usr/sbin/nologin' > "$unlocked_account/passwd"
printf '%s\n' P > "$unlocked_account/password-status"
expect_account_rejection unlocked "$unlocked_account"

# The dollar sign is intentionally literal; bootstrap must not expand it.
# shellcheck disable=SC2016
if grep -Fq '${SCRIPT_DIR}' "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"; then
  echo "managed bootstrap success path references an undefined SCRIPT_DIR" >&2
  exit 1
fi
grep -Fq '"ipset"' \
  "$REPOSITORY_ROOT/scripts/release/managed-host-packages-policy.json"
grep -Fxq 'port=0' "$REPOSITORY_ROOT/infra/latitude/net-setup.sh"
grep -Fxq 'KillMode=control-group' "$REPOSITORY_ROOT/infra/latitude/nehemiahd.service"

# Signed managed units must never degrade into the permissive local contract.
for managed_unit in nehemiahd.service boring-net.service; do
  managed_path="$REPOSITORY_ROOT/infra/latitude/$managed_unit"
  grep -Fxq 'AssertPathExists=/etc/boring/managed-host' "$managed_path"
  grep -Fxq 'AssertPathExists=/etc/boring/nehemiahd.env' "$managed_path"
  grep -Fxq 'EnvironmentFile=/etc/boring/nehemiahd.env' "$managed_path"
  grep -Fxq 'ExecStartPre=/opt/boring/bin/managed-host-preflight.sh' "$managed_path"
  grep -Fq 'ExecStart=/usr/bin/env NEHEMIAH_MODE=1 ' "$managed_path"
  if grep -Fq 'EnvironmentFile=-' "$managed_path"; then
    echo "managed unit contains an optional environment file: $managed_unit" >&2
    exit 1
  fi
done

preflight="$REPOSITORY_ROOT/infra/latitude/managed-host-preflight.sh"
grep -Fq "stat -c '%a:%u:%g' -- \"\$path\"" "$preflight"
grep -Fq "require_exact_file \"\$ENV_PATH\" 600:0:0" "$preflight"
grep -Fq "require_exact_file \"\$MARKER_PATH\" 400:0:0" "$preflight"
grep -Fq 'NEHEMIAH_MODE=1 "$NET_SETUP" --fail-closed' "$preflight"

# Execute the exact preflight logic against private fixture paths. Valid files
# pass; loose mode, wrong content, and (on non-root CI) wrong ownership all fail
# and invoke the network fail-closed action without exposing file contents.
preflight_env="$TASK_TEMP/preflight.env"
preflight_marker="$TASK_TEMP/preflight.marker"
preflight_net="$TASK_TEMP/preflight-net.sh"
preflight_log="$TASK_TEMP/preflight-net.log"
preflight_guard="$TASK_TEMP/preflight-guard.py"
preflight_wireguard="$TASK_TEMP/preflight-wg0.conf"
preflight_provider="$TASK_TEMP/preflight-provider-image"
cat > "$preflight_net" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$preflight_log"
EOF
chmod 0755 "$preflight_net"
cat > "$preflight_guard" <<'PY'
#!/usr/bin/env python3
import sys

if len(sys.argv) < 2:
    raise SystemExit(2)
PY
chmod 0755 "$preflight_guard"
: > "$preflight_env"
printf '%s\n' nehemiah-managed-host-v1 > "$preflight_marker"
printf '%s\n' fixture-wireguard > "$preflight_wireguard"
cat > "$preflight_provider" <<'EOF'
provider=latitude
id=os_test1234
slug=ubuntu_24_04_x64_lts
version=24.04 LTS
arch=amd64
EOF
chmod 0600 "$preflight_env"
chmod 0400 "$preflight_marker"
chmod 0600 "$preflight_wireguard" "$preflight_provider"
export NEHEMIAH_RELEASE_VERSION=0.2.0-beta.0
export NEHEMIAH_RUNTIME_ARCH=amd64
export NEHEMIAH_ADVERTISE_ADDRESS=10.42.0.10
export NEHEMIAH_NET_SUBNET=10.200.0
export NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS=10.42.0.1
export NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS=10.42.0.2
export NEHEMIAH_WIREGUARD_CONFIG_SHA256="$(sha256sum "$preflight_wireguard" | awk '{print $1}')"
export NEHEMIAH_PROVIDER_IMAGE_ID=os_test1234
export NEHEMIAH_PROVIDER_IMAGE_SLUG=ubuntu_24_04_x64_lts
export NEHEMIAH_PROVIDER_IMAGE_VERSION='24.04 LTS'
export NEHEMIAH_PROVIDER_IMAGE_ARCH=amd64
fixture_uid="$(id -u)"
fixture_gid="$(id -g)"
fixture_preflight="$TASK_TEMP/managed-host-preflight-fixture.sh"
sed \
  -e "s#^ENV_PATH=.*#ENV_PATH=$preflight_env#" \
  -e "s#^MARKER_PATH=.*#MARKER_PATH=$preflight_marker#" \
  -e "s#^NET_SETUP=.*#NET_SETUP=$preflight_net#" \
  -e "s#^PACKAGE_GUARD=.*#PACKAGE_GUARD=$preflight_guard#" \
  -e "s#^WIREGUARD_GUARD=.*#WIREGUARD_GUARD=$preflight_guard#" \
  -e "s#^WIREGUARD_PATH=.*#WIREGUARD_PATH=$preflight_wireguard#" \
  -e "s#^PROVIDER_IMAGE_PATH=.*#PROVIDER_IMAGE_PATH=$preflight_provider#" \
  -e "s#600:0:0#600:$fixture_uid:$fixture_gid#" \
  -e "s#400:0:0#400:$fixture_uid:$fixture_gid#" \
  "$preflight" > "$fixture_preflight"
chmod 0755 "$fixture_preflight"
"$fixture_preflight"
[[ ! -e "$preflight_log" ]]

chmod 0640 "$preflight_env"
if "$fixture_preflight" > "$TASK_TEMP/preflight-mode.stdout" 2> "$TASK_TEMP/preflight-mode.stderr"; then
  echo "managed preflight accepted a loose environment mode" >&2
  exit 1
fi
grep -Fxq -- '--fail-closed' "$preflight_log"
! grep -Fq 'nehemiah-managed-host-v1' "$TASK_TEMP/preflight-mode.stderr"
chmod 0600 "$preflight_env"
: > "$preflight_log"

chmod 0600 "$preflight_marker"
printf '%s\n' invalid-managed-marker > "$preflight_marker"
chmod 0400 "$preflight_marker"
if "$fixture_preflight" >/dev/null 2>&1; then
  echo "managed preflight accepted invalid marker content" >&2
  exit 1
fi
grep -Fxq -- '--fail-closed' "$preflight_log"
chmod 0600 "$preflight_marker"
printf '%s\n' nehemiah-managed-host-v1 > "$preflight_marker"
chmod 0400 "$preflight_marker"

if [[ "$fixture_uid" != 0 ]]; then
  ownership_preflight="$TASK_TEMP/managed-host-preflight-ownership.sh"
  sed \
    -e "s#^ENV_PATH=.*#ENV_PATH=$preflight_env#" \
    -e "s#^MARKER_PATH=.*#MARKER_PATH=$preflight_marker#" \
    -e "s#^NET_SETUP=.*#NET_SETUP=$preflight_net#" \
    "$preflight" > "$ownership_preflight"
  chmod 0755 "$ownership_preflight"
  : > "$preflight_log"
  if "$ownership_preflight" >/dev/null 2>&1; then
    echo "managed preflight accepted non-root ownership" >&2
    exit 1
  fi
  grep -Fxq -- '--fail-closed' "$preflight_log"
fi

grep -Fxq 'Requires=boring-net.service' \
  "$REPOSITORY_ROOT/infra/latitude/nehemiahd.service"
grep -Fxq 'BindsTo=boring-net.service' \
  "$REPOSITORY_ROOT/infra/latitude/nehemiahd.service"
grep -Fxq 'ExecStop=/usr/bin/env NEHEMIAH_MODE=1 /opt/boring/bin/net-setup.sh --fail-closed' \
  "$REPOSITORY_ROOT/infra/latitude/boring-net.service"
grep -Fxq 'ExecStopPost=/usr/bin/env NEHEMIAH_MODE=1 /opt/boring/bin/net-setup.sh --fail-closed' \
  "$REPOSITORY_ROOT/infra/latitude/boring-net.service"

# The fail-closed trap is armed before every managed validation or mutation,
# and only a fully verified end-to-end apply marks the network setup complete.
python3 - "$REPOSITORY_ROOT/infra/latitude/net-setup.sh" <<'PY'
import pathlib
import sys

script = pathlib.Path(sys.argv[1]).read_text()
armed = script.index('trap managed_fail_closed_on_exit EXIT')
bridge_validation = script.index('[[ "$BR" =~')
bridge_mutation = script.index('ip link show "$BR"')
completed = script.rindex('NETWORK_SETUP_COMPLETE=1')
done = script.rindex('log "done."')
assert armed < bridge_validation < bridge_mutation < completed < done
assert script.count('fail_closed_all_guest_ports') >= 5
assert script.count('freeze_all_guest_ports') >= 2
input_remove = script.index('while iptables -D INPUT -i "$BR" -j NEHEMIAH_INPUT')
input_insert = script.index('iptables -I INPUT 1 -i "$BR" -j NEHEMIAH_INPUT')
input_flush = script.index('iptables -F NEHEMIAH_INPUT')
forward_remove = script.index('while iptables -D FORWARD -j NEHEMIAH_FWD')
forward_insert = script.index('iptables -I FORWARD 1 -j NEHEMIAH_FWD')
forward_flush = script.index('iptables -F NEHEMIAH_FWD')
ipv6_remove = script.index('while ip6tables -D FORWARD -i "$BR" -j DROP')
ipv6_insert = script.index('ip6tables -I FORWARD 1 -i "$BR" -j DROP')
assert input_remove < input_insert < input_flush
assert forward_remove < forward_insert < forward_flush
assert ipv6_remove < ipv6_insert < completed
assert 'iptables -C FORWARD -j NEHEMIAH_FWD' not in script
assert 'ip6tables -C FORWARD -i "$BR" -j DROP' not in script
PY

# Verified cloud-init publishes the root-only marker atomically after bootstrap
# succeeds and before either managed unit can be enabled.
python3 - "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh" <<'PY'
import pathlib
import sys

script = pathlib.Path(sys.argv[1]).read_text()
bootstrap = script.index('"$ASSET_ROOT/infra/latitude/bootstrap.sh"')
marker = script.index("printf '%s\\n' nehemiah-managed-host-v1")
marker_mode = script.index('chmod 0400 "$managed_marker_tmp"')
publish = script.index('mv -fT "$managed_marker_tmp" "$MANAGED_HOST_MARKER"')
start = script.index('systemctl enable --now boring-net.service')
assert bootstrap < marker < marker_mode < publish < start
PY

# Prototype installers must deliberately install the separate permissive units;
# those files are not part of the exact signed managed-host archive allowlist.
for local_unit in nehemiahd-local.service boring-net-local.service; do
  local_path="$REPOSITORY_ROOT/infra/latitude/$local_unit"
  grep -Fq 'EnvironmentFile=-/etc/boring/' "$local_path"
  if grep -Eq 'managed-host|NEHEMIAH_MODE=1' "$local_path"; then
    echo "local unit unexpectedly carries the managed contract: $local_unit" >&2
    exit 1
  fi
done
grep -Fq '/root/infra/boring-net-local.service' "$REPOSITORY_ROOT/infra/setup.sh"
grep -Fq '/root/infra/nehemiahd-local.service' "$REPOSITORY_ROOT/infra/setup.sh"
grep -Fq '/root/infra/boring-net-local.service' "$REPOSITORY_ROOT/infra/local/setup-local.sh"
grep -Fq '/root/infra/nehemiahd-local.service' "$REPOSITORY_ROOT/infra/local/setup-local.sh"
grep -Fq '"${SCRIPT_DIR}/nehemiahd-local.service"' "$REPOSITORY_ROOT/infra/latitude/deploy.sh"
if grep -Eq '(boring-net|nehemiahd)-local\.service' "$REPOSITORY_ROOT/scripts/release/build.mjs"; then
  echo "prototype systemd unit entered the signed managed-host archive" >&2
  exit 1
fi

grep -Fq 'mount -t devpts devpts /dev/pts' "$REPOSITORY_ROOT/infra/latitude/build-rootfs.sh"
grep -Fq 'managed rootfs builds are forbidden' "$REPOSITORY_ROOT/infra/latitude/build-rootfs.sh"
if grep -Eq 'MINIROOTFS|build-rootfs\.sh' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh" \
  "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"; then
  echo "managed provisioning still has a mutable/minimal rootfs fallback" >&2
  exit 1
fi
if grep -Eq '^(server|resolv-file|dns-forward-max|cache-size)=' \
  "$REPOSITORY_ROOT/infra/latitude/net-setup.sh"; then
  echo "managed dnsmasq still owns resolver configuration" >&2
  exit 1
fi
if grep -Eq 'releases/latest|/latest/download' \
  "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh" \
  "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh"; then
  echo "managed bootstrap contains a mutable latest URL" >&2
  exit 1
fi
if grep -Fq 'nameserver 1.1.1.1' \
  "$REPOSITORY_ROOT/infra/latitude/build-desktop-rootfs.sh"; then
  echo "desktop guest bypasses managed DNS" >&2
  exit 1
fi

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    "$REPOSITORY_ROOT/infra/latitude/bootstrap.sh" \
    "$REPOSITORY_ROOT/infra/latitude/build-rootfs.sh" \
    "$REPOSITORY_ROOT/infra/latitude/cloud-init.sh" \
    "$REPOSITORY_ROOT/infra/latitude/managed-host-preflight.sh" \
    "$REPOSITORY_ROOT/infra/latitude/net-setup.sh" \
    "$REPOSITORY_ROOT/infra/latitude/provision.sh" \
    "$REPOSITORY_ROOT/infra/latitude/render-user-data.sh" \
    "$REPOSITORY_ROOT/scripts/release/fetch-managed-runtime-assets.sh" \
    "$REPOSITORY_ROOT/scripts/release/inspect-managed-runtime-assets.sh" \
    "$REPOSITORY_ROOT/scripts/release/build-guest-images.sh" \
    "$REPOSITORY_ROOT/scripts/release/guest-images/assemble-rootfs.sh" \
    "$REPOSITORY_ROOT/scripts/release/guest-images/inspect-guest-image.sh" \
    "$REPOSITORY_ROOT/scripts/release/guest-images/prepare-vulnerability-scanner.sh" \
    "$REPOSITORY_ROOT/scripts/release/guest-images/scan-final-rootfs.sh"
fi

printf 'managed Latitude provisioning tests passed\n'

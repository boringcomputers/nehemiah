#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "$#" -ne 5 ]]; then
  echo "usage: inspect-guest-image.sh POLICY ARTIFACT VERSION ARCH FLAVOR" >&2
  exit 64
fi
policy="$1"
artifact="$2"
version="$3"
arch="$4"
flavor="$5"

case "$arch" in amd64 | arm64) ;; *) echo "invalid architecture" >&2; exit 64 ;; esac
case "$flavor" in python | desktop) ;; *) echo "invalid flavor" >&2; exit 64 ;; esac
for input in "$policy" "$artifact"; do
  [[ -f "$input" && ! -L "$input" ]] || { echo "unsafe or missing input: $input" >&2; exit 1; }
done

expected_name="nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz"
[[ "$(basename "$artifact")" == "$expected_name" ]] \
  || { echo "unexpected guest image artifact name" >&2; exit 1; }
max_compressed="$(jq -er --arg flavor "$flavor" '.flavors[$flavor].maxCompressedBytes' "$policy")"
actual_compressed="$(stat -c %s "$artifact")"
(( actual_compressed > 0 && actual_compressed <= max_compressed )) \
  || { echo "compressed guest image exceeds policy" >&2; exit 1; }
gzip --test "$artifact"

inspect_dir="$(mktemp -d)"
trap 'rm -rf -- "$inspect_dir"' EXIT
image="$inspect_dir/image.ext4"
gzip -dc "$artifact" | dd of="$image" bs=4M conv=sparse status=none
expected_bytes="$(jq -er --arg flavor "$flavor" '.flavors[$flavor].imageBytes' "$policy")"
[[ "$(stat -c %s "$image")" == "$expected_bytes" ]] \
  || { echo "uncompressed guest image size does not match policy" >&2; exit 1; }
magic="$(dd if="$image" bs=1 skip=1080 count=2 status=none | od -An -tx1 | tr -d ' \n')"
[[ "$magic" == 53ef ]] || { echo "guest image is not ext4" >&2; exit 1; }
e2fsck -fn "$image" >/dev/null

dump_file() {
  local source_path="$1" destination="$2"
  debugfs -R "dump -p $source_path $destination" "$image" >/dev/null 2>&1
  [[ -f "$destination" && ! -L "$destination" ]]
}

manifest="$inspect_dir/image-manifest.json"
agent="$inspect_dir/bc-guest-agent"
node_binary="$inspect_dir/node"
init="$inspect_dir/boring-init"
dump_file /usr/share/nehemiah/image-manifest.json "$manifest"
dump_file /opt/boring/bin/bc-guest-agent "$agent"
dump_file /usr/local/bin/node "$node_binary"
dump_file /sbin/boring-init "$init"

policy_sha="$(sha256sum "$policy" | awk '{print $1}')"
base_reference="$(jq -er --arg arch "$arch" '.architectures[$arch].ociBase.reference' "$policy")"
repository_snapshot="$(jq -er '.alpineRepositorySnapshot.capturedAt' "$policy")"
main_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].main.sha256' "$policy")"
community_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].community.sha256' "$policy")"
npm_tarball_sha="$(jq -er '.npmRuntime.tarball.sha256' "$policy")"
pip_wheel_sha="$(jq -er '.pythonRuntime.pip.sha256' "$policy")"
setuptools_wheel_sha="$(jq -er '.pythonRuntime.setuptools.sha256' "$policy")"
pip_vendor_msgpack_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "msgpack") | .sha256' "$policy")"
pip_vendor_setuptools_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "setuptools") | .sha256' "$policy")"
jq --exit-status \
  --arg version "$version" --arg arch "$arch" --arg flavor "$flavor" \
  --arg policySha "$policy_sha" --arg baseReference "$base_reference" \
  --arg repositorySnapshot "$repository_snapshot" --arg mainIndexSha "$main_index_sha" \
  --arg communityIndexSha "$community_index_sha" --arg npmTarballSha "$npm_tarball_sha" \
  --arg pipWheelSha "$pip_wheel_sha" --arg setuptoolsWheelSha "$setuptools_wheel_sha" \
  --arg pipVendorMsgpackSha "$pip_vendor_msgpack_sha" \
  --arg pipVendorSetuptoolsSha "$pip_vendor_setuptools_sha" '
  .schemaVersion == 1 and
  .version == $version and
  .architecture == $arch and
  .flavor == $flavor and
  .provenance.policySha256 == $policySha and
  .provenance.baseOCIReference == $baseReference and
  .provenance.alpineRepositoryCapturedAt == $repositorySnapshot and
  .provenance.apkIndexSha256.main == $mainIndexSha and
  .provenance.apkIndexSha256.community == $communityIndexSha and
  .provenance.npmTarballSha256 == $npmTarballSha and
  .provenance.pythonRuntimeSha256.pip == $pipWheelSha and
  .provenance.pythonRuntimeSha256.setuptools == $setuptoolsWheelSha and
  .provenance.pythonRuntimeSha256.pipVendorOverlays.msgpack == $pipVendorMsgpackSha and
  .provenance.pythonRuntimeSha256.pipVendorOverlays.setuptools == $pipVendorSetuptoolsSha and
  (.provenance.baseOCIReference | test("@sha256:[0-9a-f]{64}$")) and
  ([.provenance.apkIndexSha256.main, .provenance.apkIndexSha256.community,
    .provenance.npmTarballSha256, .provenance.pythonRuntimeSha256.pip,
    .provenance.pythonRuntimeSha256.setuptools,
    .provenance.pythonRuntimeSha256.pipVendorOverlays.msgpack,
    .provenance.pythonRuntimeSha256.pipVendorOverlays.setuptools] |
    all(test("^[0-9a-f]{64}$"))) and
  (.installedPackages | type == "array" and length > 0) and
  (.installedPackages | all(
    (.name | type == "string" and length > 0) and
    (.version | type == "string" and length > 0)
  ))
  ' "$manifest" >/dev/null

agent_description="$(file -b "$agent")"
node_description="$(file -b "$node_binary")"
expected_machine='x86-64'
[[ "$arch" == arm64 ]] && expected_machine='ARM aarch64'
[[ "$agent_description" == *'ELF 64-bit LSB'* && "$agent_description" == *"$expected_machine"* && \
   "$agent_description" == *'statically linked'* ]] \
  || { echo "guest agent is not a static $arch ELF" >&2; exit 1; }
[[ "$node_description" == *'ELF 64-bit LSB'* && "$node_description" == *"$expected_machine"* ]] \
  || { echo "Node runtime is not an $arch ELF" >&2; exit 1; }

for required in ca-certificates curl git; do
  jq -e --arg package "$required" '.installedPackages | any(.name == $package)' \
    "$manifest" >/dev/null || { echo "guest image is missing $required" >&2; exit 1; }
done
for required_path in \
  /bin/sh \
  /usr/bin/python3 \
  /usr/local/bin/pip \
  /usr/local/bin/npm \
  /usr/local/lib/node_modules/npm/bin/npm-cli.js \
  /opt/boring/bin/bc-guest-agent; do
  debugfs -R "stat $required_path" "$image" 2>&1 | grep -q 'Inode:' \
    || { echo "guest image is missing $required_path" >&2; exit 1; }
done
grep -q 'bc-guest-agent' "$init"
grep -q 'rm -f /run/bc-guest-agent.ready' "$init"
grep -q '/proc/net/pnp' "$init"
if grep -Eq 'nameserver (1\.1\.1\.1|8\.8\.8\.8)' "$init"; then
  echo "guest init bypasses managed DNS" >&2
  exit 1
fi
if grep -q '/run/nehemiah/guest-agent.ready' "$init"; then
  echo "guest init removes the wrong readiness marker" >&2
  exit 1
fi
if [[ "$flavor" == desktop ]]; then
	grep -q 'VSOCK-LISTEN:5900' "$init"
	# The dollar sign is intentionally literal: this is the one launch line.
	# shellcheck disable=SC2016
	[[ "$(grep -c '^"\$chromium_bin" ' "$init")" == 1 ]] \
	  || { echo "desktop init must launch Chromium exactly once" >&2; exit 1; }
  for required_path in /usr/bin/Xvfb /usr/bin/openbox /usr/bin/x11vnc /usr/bin/chromium /usr/bin/socat; do
    debugfs -R "stat $required_path" "$image" 2>&1 | grep -q 'Inode:' \
      || { echo "desktop image is missing $required_path" >&2; exit 1; }
  done
fi

printf 'verified %s: compressed=%s bytes, ext4=%s bytes\n' \
  "$expected_name" "$actual_compressed" "$expected_bytes"

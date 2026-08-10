#!/usr/bin/env bash
# Build production guest rootfs artifacts. Unlike infra/latitude/build-*.sh,
# this path accepts only the immutable policy committed with release tooling.
set -euo pipefail
export LC_ALL=C
umask 022

usage() {
  echo "usage: build-guest-images.sh --version V --arch ARCH --output DIR --source-date-epoch EPOCH --guest-agent PATH" >&2
  exit 64
}

version=
arch=
output=
source_date_epoch=
guest_agent=
while [[ "$#" -gt 0 ]]; do
  [[ "$#" -ge 2 ]] || usage
  case "$1" in
    --version) version="$2" ;;
    --arch) arch="$2" ;;
    --output) output="$2" ;;
    --source-date-epoch) source_date_epoch="$2" ;;
    --guest-agent) guest_agent="$2" ;;
    *) usage ;;
  esac
  shift 2
done

[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?$ ]] || usage
case "$arch" in amd64 | arm64) ;; *) usage ;; esac
[[ "$source_date_epoch" =~ ^[1-9][0-9]*$ ]] || usage
[[ -n "$output" && "$output" != / && "$output" != "$HOME" ]] || usage
[[ -f "$guest_agent" && ! -L "$guest_agent" && -x "$guest_agent" ]] || { echo "guest agent must be an executable regular file" >&2; exit 1; }
guest_agent="$(cd "$(dirname "$guest_agent")" && pwd)/$(basename "$guest_agent")"
for command in curl date docker jq python3 sha256sum file; do
  command -v "$command" >/dev/null || { echo "missing build dependency: $command" >&2; exit 1; }
done

case "$(uname -m)" in
  x86_64) native_arch=amd64 ;;
  aarch64 | arm64) native_arch=arm64 ;;
  *) echo "unsupported native builder architecture" >&2; exit 1 ;;
esac
[[ "$native_arch" == "$arch" ]] || {
  echo "production guest images require a native $arch runner (found $native_arch)" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
assets_dir="$script_dir/guest-images"
policy="$assets_dir/policy.json"
jq -e '.contractVersion == 1 and .rootfsProfile == "signed-developer-ext4-v1"' "$policy" >/dev/null
base_image="$(jq -er --arg arch "$arch" '.architectures[$arch].ociBase.reference' "$policy")"
[[ "$base_image" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "OCI base is not digest-pinned" >&2; exit 1; }
alpine_release="$(jq -er '.alpineRepositorySnapshot.release' "$policy")"
[[ "$alpine_release" == v3.23 ]] || { echo "unsupported Alpine guest release policy" >&2; exit 1; }
snapshot_captured_at="$(jq -er '.alpineRepositorySnapshot.capturedAt' "$policy")"
max_index_age_hours="$(jq -er '.alpineRepositorySnapshot.maxIndexAgeHours' "$policy")"
snapshot_epoch="$(date -u -d "$snapshot_captured_at" +%s 2>/dev/null)" \
  || { echo "invalid Alpine repository capture timestamp" >&2; exit 1; }
now_epoch="$(date -u +%s)"
[[ "$max_index_age_hours" =~ ^[1-9][0-9]*$ ]] \
  || { echo "invalid Alpine repository freshness policy" >&2; exit 1; }
(( snapshot_epoch <= now_epoch && now_epoch - snapshot_epoch <= max_index_age_hours * 3600 )) \
  || { echo "Alpine repository snapshot is stale or future-dated" >&2; exit 1; }
apk_arch="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].apkArchitecture' "$policy")"
[[ ( "$arch" == amd64 && "$apk_arch" == x86_64 ) || ( "$arch" == arm64 && "$apk_arch" == aarch64 ) ]] \
  || { echo "invalid Alpine repository architecture" >&2; exit 1; }
apk_main_index_url="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].main.url' "$policy")"
apk_community_index_url="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].community.url' "$policy")"
apk_main_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].main.sha256' "$policy")"
apk_community_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].community.sha256' "$policy")"
for repository in main community; do
  url_variable="apk_${repository}_index_url"
  sha_variable="apk_${repository}_index_sha"
  url="${!url_variable}"
  sha="${!sha_variable}"
  [[ "$url" == "https://dl-cdn.alpinelinux.org/alpine/${alpine_release}/${repository}/${apk_arch}/APKINDEX.tar.gz" ]] \
    || { echo "unsafe Alpine $repository index URL" >&2; exit 1; }
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "Alpine $repository index is not digest-pinned" >&2; exit 1; }
  published_at="$(jq -er --arg arch "$arch" --arg repository "$repository" \
    '.alpineRepositorySnapshot.architectures[$arch][$repository].publishedAt' "$policy")"
  published_epoch="$(date -u -d "$published_at" +%s 2>/dev/null)" \
    || { echo "invalid Alpine $repository publication timestamp" >&2; exit 1; }
  (( published_epoch <= snapshot_epoch && snapshot_epoch - published_epoch <= max_index_age_hours * 3600 )) \
    || { echo "Alpine $repository index publication is stale or future-dated" >&2; exit 1; }
done
apk_main_repository="${apk_main_index_url%/"$apk_arch"/APKINDEX.tar.gz}"
apk_community_repository="${apk_community_index_url%/"$apk_arch"/APKINDEX.tar.gz}"
common_packages="$(jq -er '.commonPackages | if length > 0 and all(test("^[a-z0-9][a-z0-9+.-]*$")) then join(" ") else error("unsafe common package allowlist") end' "$policy")"
desktop_packages="$(jq -er '.desktopPackages | if length > 0 and all(test("^[a-z0-9][a-z0-9+.-]*$")) then join(" ") else error("unsafe desktop package allowlist") end' "$policy")"
node_version="$(jq -er --arg arch "$arch" '.architectures[$arch].ociBase.nodeVersion' "$policy")"
npm_version="$(jq -er '.npmRuntime.version' "$policy")"
npm_tarball_url="$(jq -er '.npmRuntime.tarball.url' "$policy")"
npm_tarball_sha="$(jq -er '.npmRuntime.tarball.sha256' "$policy")"
brace_expansion_version="$(jq -er '.npmRuntime.overlays[] | select(.name == "brace-expansion") | .version' "$policy")"
brace_expansion_url="$(jq -er '.npmRuntime.overlays[] | select(.name == "brace-expansion") | .url' "$policy")"
brace_expansion_sha="$(jq -er '.npmRuntime.overlays[] | select(.name == "brace-expansion") | .sha256' "$policy")"
ip_address_version="$(jq -er '.npmRuntime.overlays[] | select(.name == "ip-address") | .version' "$policy")"
ip_address_url="$(jq -er '.npmRuntime.overlays[] | select(.name == "ip-address") | .url' "$policy")"
ip_address_sha="$(jq -er '.npmRuntime.overlays[] | select(.name == "ip-address") | .sha256' "$policy")"
pip_version="$(jq -er '.pythonRuntime.pip.version' "$policy")"
pip_wheel_url="$(jq -er '.pythonRuntime.pip.url' "$policy")"
pip_wheel_sha="$(jq -er '.pythonRuntime.pip.sha256' "$policy")"
setuptools_version="$(jq -er '.pythonRuntime.setuptools.version' "$policy")"
setuptools_wheel_url="$(jq -er '.pythonRuntime.setuptools.url' "$policy")"
setuptools_wheel_sha="$(jq -er '.pythonRuntime.setuptools.sha256' "$policy")"
pip_vendor_msgpack_version="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "msgpack" and .format == "sdist") | .version' "$policy")"
pip_vendor_msgpack_url="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "msgpack" and .format == "sdist") | .url' "$policy")"
pip_vendor_msgpack_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "msgpack" and .format == "sdist") | .sha256' "$policy")"
pip_vendor_setuptools_version="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "setuptools" and .format == "wheel") | .version' "$policy")"
pip_vendor_setuptools_url="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "setuptools" and .format == "wheel") | .url' "$policy")"
pip_vendor_setuptools_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "setuptools" and .format == "wheel") | .sha256' "$policy")"
[[ "$node_version" =~ ^24\.[0-9]+\.[0-9]+$ && "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "invalid Node/npm runtime policy" >&2; exit 1; }
[[ "$pip_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$setuptools_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "invalid Python runtime policy" >&2; exit 1; }
[[ "$pip_vendor_msgpack_version" == 1.2.1 && "$pip_vendor_setuptools_version" == 80.9.0 ]] \
  || { echo "invalid pip vendor security overlay policy" >&2; exit 1; }
for input in \
  "$npm_tarball_url|$npm_tarball_sha|npm" \
  "$brace_expansion_url|$brace_expansion_sha|brace-expansion" \
  "$ip_address_url|$ip_address_sha|ip-address"; do
  IFS='|' read -r url sha name <<< "$input"
  [[ "$url" =~ ^https://registry\.npmjs\.org/[a-z0-9-]+/-/[a-z0-9.-]+\.tgz$ && "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "unsafe or unpinned $name runtime input" >&2; exit 1; }
done
for input in \
  "$pip_vendor_msgpack_url|$pip_vendor_msgpack_sha|msgpack-$pip_vendor_msgpack_version.tar.gz" \
  "$pip_vendor_setuptools_url|$pip_vendor_setuptools_sha|setuptools-$pip_vendor_setuptools_version-py3-none-any.whl"; do
  IFS='|' read -r url sha filename <<< "$input"
  [[ "$url" =~ ^https://files\.pythonhosted\.org/packages/[0-9a-f/]+/[A-Za-z0-9._-]+$ && \
      "${url##*/}" == "$filename" && "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "unsafe or unpinned pip vendor security overlay" >&2; exit 1; }
done
for input in \
  "$pip_wheel_url|$pip_wheel_sha|pip-$pip_version-py3-none-any.whl" \
  "$setuptools_wheel_url|$setuptools_wheel_sha|setuptools-$setuptools_version-py3-none-any.whl"; do
  IFS='|' read -r url sha filename <<< "$input"
  [[ "$url" =~ ^https://files\.pythonhosted\.org/packages/[0-9a-f/]+/[A-Za-z0-9._-]+$ && \
      "${url##*/}" == "$filename" && "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "unsafe or unpinned Python runtime input" >&2; exit 1; }
done

mkdir -p "$output"
[[ -d "$output" && ! -L "$output" ]] || { echo "output must be a non-symlink directory" >&2; exit 1; }
output="$(cd "$output" && pwd)"
scratch_parent="${NEHEMIAH_GUEST_IMAGE_TMPDIR:-${TMPDIR:-/tmp}}"
[[ -d "$scratch_parent" && ! -L "$scratch_parent" ]] \
  || { echo "guest image scratch parent must be a non-symlink directory" >&2; exit 1; }
scratch_parent="$(cd "$scratch_parent" && pwd)"
[[ "$scratch_parent" != / && "$scratch_parent" != "$HOME" ]] \
  || { echo "unsafe guest image scratch parent" >&2; exit 1; }
work_root="$(mktemp -d "$scratch_parent/nehemiah-guest-images.XXXXXX")"
declare -a created_containers=() created_tags=()
cleanup() {
  local container tag
  for container in "${created_containers[@]-}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  for tag in "${created_tags[@]-}"; do docker image rm "$tag" >/dev/null 2>&1 || true; done
  # Docker export preserves root ownership. Clean the exact private mktemp
  # mount from a root container so interrupts never leave undeletable files.
  if [[ -d "$work_root" && "$work_root" == "$scratch_parent/nehemiah-guest-images."* ]]; then
    docker run --rm --network none --entrypoint /bin/sh \
      --volume "$work_root:/work:rw" "$base_image" \
      -c 'rm -rf -- /work/* /work/.[!.]* /work/..?*' >/dev/null 2>&1 || true
    rm -rf -- "$work_root" || true
  fi
}
trap cleanup EXIT

scanner_root="$work_root/scanner"
"$assets_dir/prepare-vulnerability-scanner.sh" "$policy" "$arch" "$scanner_root"

agent_description="$(file -b "$guest_agent")"
expected_machine='x86-64'
[[ "$arch" == arm64 ]] && expected_machine='ARM aarch64'
[[ "$agent_description" == *'ELF 64-bit LSB'* && "$agent_description" == *"$expected_machine"* && \
   "$agent_description" == *'statically linked'* ]] \
  || { echo "guest agent is not a static $arch ELF" >&2; exit 1; }

build_one() {
  local flavor="$1" repetition="$2"
  local work="$work_root/${flavor}-${repetition}"
  local tag="nehemiah-guest-build:${version//+/-}-${arch}-${flavor}-${repetition}-$$"
  local container export_tar packages image init_script artifact
  mkdir -p "$work"
  created_tags+=("$tag")
  docker build --pull --platform "linux/$arch" --target "$flavor" \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "APK_MAIN_REPOSITORY=$apk_main_repository" \
    --build-arg "APK_COMMUNITY_REPOSITORY=$apk_community_repository" \
    --build-arg "APK_MAIN_INDEX_SHA256=$apk_main_index_sha" \
    --build-arg "APK_COMMUNITY_INDEX_SHA256=$apk_community_index_sha" \
    --build-arg "COMMON_PACKAGES=$common_packages" \
    --build-arg "DESKTOP_PACKAGES=$desktop_packages" \
    --build-arg "NODE_VERSION=$node_version" \
    --build-arg "NPM_VERSION=$npm_version" \
    --build-arg "NPM_TARBALL_URL=$npm_tarball_url" \
    --build-arg "NPM_TARBALL_SHA256=$npm_tarball_sha" \
    --build-arg "BRACE_EXPANSION_VERSION=$brace_expansion_version" \
    --build-arg "BRACE_EXPANSION_URL=$brace_expansion_url" \
    --build-arg "BRACE_EXPANSION_SHA256=$brace_expansion_sha" \
    --build-arg "IP_ADDRESS_VERSION=$ip_address_version" \
    --build-arg "IP_ADDRESS_URL=$ip_address_url" \
    --build-arg "IP_ADDRESS_SHA256=$ip_address_sha" \
    --build-arg "PIP_VERSION=$pip_version" \
    --build-arg "PIP_WHEEL_URL=$pip_wheel_url" \
    --build-arg "PIP_WHEEL_SHA256=$pip_wheel_sha" \
    --build-arg "SETUPTOOLS_VERSION=$setuptools_version" \
    --build-arg "SETUPTOOLS_WHEEL_URL=$setuptools_wheel_url" \
    --build-arg "SETUPTOOLS_WHEEL_SHA256=$setuptools_wheel_sha" \
    --build-arg "PIP_VENDOR_MSGPACK_VERSION=$pip_vendor_msgpack_version" \
    --build-arg "PIP_VENDOR_MSGPACK_URL=$pip_vendor_msgpack_url" \
    --build-arg "PIP_VENDOR_MSGPACK_SHA256=$pip_vendor_msgpack_sha" \
    --build-arg "PIP_VENDOR_SETUPTOOLS_VERSION=$pip_vendor_setuptools_version" \
    --build-arg "PIP_VENDOR_SETUPTOOLS_URL=$pip_vendor_setuptools_url" \
    --build-arg "PIP_VENDOR_SETUPTOOLS_SHA256=$pip_vendor_setuptools_sha" \
    --tag "$tag" --file "$assets_dir/Dockerfile" "$assets_dir"

  container="$(docker create "$tag")"
  created_containers+=("$container")
  export_tar="$work/rootfs.tar"
  docker export --output "$export_tar" "$container"
  docker rm "$container" >/dev/null
  created_containers=("${created_containers[@]/$container}")

  packages="$work/packages.json"
  docker run --rm --network none --entrypoint /bin/bash "$tag" -o pipefail -c \
    'awk '\''/^P:/ { name=substr($0, 3) } /^V:/ { print name "\t" substr($0, 3) }'\'' /lib/apk/db/installed | LC_ALL=C sort | jq -Rn '\''[inputs | select(length > 0) | split("\t") | {name: .[0], version: .[1]}]'\''' \
    > "$packages"

  init_script="$assets_dir/headless-init"
  [[ "$flavor" == desktop ]] && init_script="$assets_dir/desktop-init"
  image="$work/nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4"
  docker run --rm --network none \
    --entrypoint /bin/bash \
    --env "SOURCE_DATE_EPOCH=$source_date_epoch" \
    --env "OUTPUT_UID=$(id -u)" --env "OUTPUT_GID=$(id -g)" \
    --volume "$work:/work:rw" \
    --volume "$guest_agent:/input/bc-guest-agent:ro" \
    --volume "$init_script:/input/boring-init:ro" \
    --volume "$policy:/input/policy.json:ro" \
    --volume "$assets_dir/assemble-rootfs.sh:/input/assemble-rootfs.sh:ro" \
    "$tag" /input/assemble-rootfs.sh \
      /work/rootfs.tar /input/bc-guest-agent /input/boring-init \
      /input/policy.json /work/packages.json "/work/$(basename "$image")" \
      "$flavor" "$arch" "$version"
  artifact="${image}.gz"
  "$assets_dir/inspect-guest-image.sh" "$policy" "$artifact" "$version" "$arch" "$flavor"
  if [[ "$repetition" == 1 ]]; then
    artifact_sha="$(sha256sum "$artifact" | awk '{print $1}')"
    docker run --rm --network none \
      --entrypoint /bin/bash \
      --env "OUTPUT_UID=$(id -u)" --env "OUTPUT_GID=$(id -g)" \
      --volume "$work:/work:rw" \
      --volume "$scanner_root/trivy:/input/trivy:ro" \
      --volume "$scanner_root/cache:/input/trivy-cache:rw" \
      --volume "$scanner_root/database-evidence.json:/input/database-evidence.json:ro" \
      --volume "$policy:/input/policy.json:ro" \
      --volume "$assets_dir/vulnerability-allowlist.json:/input/vulnerability-allowlist.json:ro" \
      --volume "$assets_dir/scan-final-rootfs.sh:/input/scan-final-rootfs.sh:ro" \
      "$tag" /input/scan-final-rootfs.sh \
        /input/trivy /input/trivy-cache /input/database-evidence.json \
        /input/policy.json /input/vulnerability-allowlist.json /work/rootfs \
        "$flavor" "$arch" "$artifact_sha" /work/scan-evidence.json
  fi
  built_artifact="$artifact"
}

for flavor in python desktop; do
  built_artifact=""
  build_one "$flavor" 1
  first="$built_artifact"
  built_artifact=""
  build_one "$flavor" 2
  second="$built_artifact"
  first_sha="$(sha256sum "$first" | awk '{print $1}')"
  second_sha="$(sha256sum "$second" | awk '{print $1}')"
  [[ "$first_sha" == "$second_sha" ]] || {
    echo "$flavor guest image build is not deterministic" >&2
    exit 1
  }
  destination="$output/nehemiah-guest-${flavor}_${version}_linux_${arch}.ext4.gz"
  install -m 0644 "$first" "$destination"
  "$assets_dir/inspect-guest-image.sh" "$policy" "$destination" "$version" "$arch" "$flavor"
  printf 'built %s sha256=%s\n' "$destination" "$first_sha"
done

scan_artifact="$output/nehemiah-guest-scan_${version}_linux_${arch}.json"
policy_sha="$(sha256sum "$policy" | awk '{print $1}')"
jq -n \
  --arg version "$version" --arg architecture "$arch" --arg policySha256 "$policy_sha" \
  --slurpfile scanner "$scanner_root/database-evidence.json" \
  --slurpfile pythonSummary "$work_root/python-1/scan-evidence.json" \
  --rawfile pythonReport "$work_root/python-1/scan-evidence.json.trivy.json" \
  --slurpfile desktopSummary "$work_root/desktop-1/scan-evidence.json" \
  --rawfile desktopReport "$work_root/desktop-1/scan-evidence.json.trivy.json" '
  {
    schemaVersion: 1,
    version: $version,
    architecture: $architecture,
    policySha256: $policySha256,
    scanner: $scanner[0],
    scans: [
      {summary: $pythonSummary[0], report: $pythonReport},
      {summary: $desktopSummary[0], report: $desktopReport}
    ]
  }' > "$scan_artifact"
max_evidence_bytes="$(jq -er '.vulnerabilityScan.maxEvidenceBytes' "$policy")"
(( $(stat -c %s "$scan_artifact") <= max_evidence_bytes )) \
  || { echo "guest vulnerability evidence exceeds policy" >&2; exit 1; }
printf 'built %s sha256=%s\n' "$scan_artifact" "$(sha256sum "$scan_artifact" | awk '{print $1}')"

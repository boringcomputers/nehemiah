#!/usr/bin/env bash
# Runs inside the digest-pinned guest build image. It does not use the network.
set -euo pipefail
export LC_ALL=C
umask 022

if [[ "$#" -ne 9 ]]; then
  echo "usage: assemble-rootfs.sh EXPORT AGENT INIT POLICY PACKAGES IMAGE FLAVOR ARCH VERSION" >&2
  exit 64
fi

export_tar="$1"
guest_agent="$2"
init_script="$3"
policy_path="$4"
packages_path="$5"
image_path="$6"
flavor="$7"
arch="$8"
version="$9"

case "$flavor" in python | desktop) ;; *) echo "invalid flavor" >&2; exit 64 ;; esac
case "$arch" in amd64 | arm64) ;; *) echo "invalid architecture" >&2; exit 64 ;; esac
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?$ ]] \
  || { echo "invalid version" >&2; exit 64; }
for input in "$export_tar" "$guest_agent" "$init_script" "$policy_path" "$packages_path"; do
  [[ -f "$input" && ! -L "$input" ]] || { echo "unsafe or missing input: $input" >&2; exit 1; }
done

work_dir="$(dirname "$image_path")"
root_dir="$work_dir/rootfs"
[[ ! -e "$root_dir" ]] || { echo "rootfs staging path already exists" >&2; exit 1; }
mkdir -p "$root_dir"
tar --extract --file "$export_tar" --directory "$root_dir" --numeric-owner --same-owner \
  --exclude='./dev/*' --exclude='dev/*'

rm -rf "${root_dir:?}/dev" "$root_dir/proc" "$root_dir/run" "$root_dir/sys" "$root_dir/tmp"
install -d -m 0755 \
  "$root_dir/dev" "$root_dir/dev/pts" "$root_dir/proc" "$root_dir/run" \
  "$root_dir/sys" "$root_dir/tmp" "$root_dir/workspace" \
  "$root_dir/opt/boring/bin" "$root_dir/usr/share/nehemiah"
chmod 1777 "$root_dir/tmp"
install -m 0755 "$guest_agent" "$root_dir/opt/boring/bin/bc-guest-agent"
install -m 0755 "$init_script" "$root_dir/sbin/boring-init"
if [[ "$flavor" == python ]]; then
  ln -sfn boring-init "$root_dir/sbin/init"
fi

policy_sha="$(sha256sum "$policy_path" | awk '{print $1}')"
base_reference="$(jq -er --arg arch "$arch" '.architectures[$arch].ociBase.reference' "$policy_path")"
repository_snapshot="$(jq -er '.alpineRepositorySnapshot.capturedAt' "$policy_path")"
main_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].main.sha256' "$policy_path")"
community_index_sha="$(jq -er --arg arch "$arch" '.alpineRepositorySnapshot.architectures[$arch].community.sha256' "$policy_path")"
npm_tarball_sha="$(jq -er '.npmRuntime.tarball.sha256' "$policy_path")"
pip_wheel_sha="$(jq -er '.pythonRuntime.pip.sha256' "$policy_path")"
setuptools_wheel_sha="$(jq -er '.pythonRuntime.setuptools.sha256' "$policy_path")"
pip_vendor_msgpack_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "msgpack") | .sha256' "$policy_path")"
pip_vendor_setuptools_sha="$(jq -er '.pythonRuntime.pipVendorOverlays[] | select(.name == "setuptools") | .sha256' "$policy_path")"
source_date_epoch="${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH is required}"
jq -n \
  --arg version "$version" \
  --arg arch "$arch" \
  --arg flavor "$flavor" \
  --arg baseReference "$base_reference" \
  --arg repositorySnapshot "$repository_snapshot" \
  --arg mainIndexSha256 "$main_index_sha" \
  --arg communityIndexSha256 "$community_index_sha" \
  --arg npmTarballSha256 "$npm_tarball_sha" \
  --arg pipWheelSha256 "$pip_wheel_sha" \
  --arg setuptoolsWheelSha256 "$setuptools_wheel_sha" \
  --arg pipVendorMsgpackSha256 "$pip_vendor_msgpack_sha" \
  --arg pipVendorSetuptoolsSha256 "$pip_vendor_setuptools_sha" \
  --arg policySha256 "$policy_sha" \
  --argjson sourceDateEpoch "$source_date_epoch" \
  --slurpfile requestedPolicy "$policy_path" \
  --slurpfile installedPackages "$packages_path" \
  '{
    schemaVersion: 1,
    version: $version,
    architecture: $arch,
    flavor: $flavor,
    sourceDateEpoch: $sourceDateEpoch,
    provenance: {
      baseOCIReference: $baseReference,
      alpineRepositoryCapturedAt: $repositorySnapshot,
      apkIndexSha256: {
        main: $mainIndexSha256,
        community: $communityIndexSha256
      },
      npmTarballSha256: $npmTarballSha256,
      pythonRuntimeSha256: {
        pip: $pipWheelSha256,
        setuptools: $setuptoolsWheelSha256,
        pipVendorOverlays: {
          msgpack: $pipVendorMsgpackSha256,
          setuptools: $pipVendorSetuptoolsSha256
        }
      },
      policySha256: $policySha256
    },
    requestedPolicy: $requestedPolicy[0],
    installedPackages: $installedPackages[0]
  }' > "$root_dir/usr/share/nehemiah/image-manifest.json"
chmod 0644 "$root_dir/usr/share/nehemiah/image-manifest.json"

# Package scripts and container export can create build-time timestamps. The
# release timestamp is the sole timestamp allowed into the ext4 payload.
find "$root_dir" -xdev -exec touch -h -d "@${source_date_epoch}" '{}' +

image_bytes="$(jq -er --arg flavor "$flavor" '.flavors[$flavor].imageBytes' "$policy_path")"
filesystem_uuid="$(jq -er --arg arch "$arch" --arg flavor "$flavor" \
  '.architectures[$arch].filesystemUUIDs[$flavor]' "$policy_path")"
[[ "$image_bytes" =~ ^[1-9][0-9]*$ && $((image_bytes % 4096)) -eq 0 ]] \
  || { echo "invalid image size policy" >&2; exit 1; }
[[ "$filesystem_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || { echo "invalid filesystem UUID policy" >&2; exit 1; }

truncate --size "$image_bytes" "$image_path"
export E2FSPROGS_FAKE_TIME="$source_date_epoch"
mke2fs -q -F -t ext4 -b 4096 -d "$root_dir" \
  -U "$filesystem_uuid" -L "bc-${flavor}" -O '^has_journal' \
  -E "lazy_itable_init=0,lazy_journal_init=0,hash_seed=${filesystem_uuid}" \
  "$image_path"
e2fsck -fn "$image_path" >/dev/null

# gzip's header is normalized and the output owner is restored to the caller.
gzip -n -9 "$image_path"
chown "${OUTPUT_UID:?}:${OUTPUT_GID:?}" "${image_path}.gz"
chown -R "${OUTPUT_UID}:${OUTPUT_GID}" "$root_dir"

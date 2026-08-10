#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "$#" -ne 1 ]]; then
  echo "usage: fetch-managed-runtime-assets.sh OUTPUT_DIRECTORY" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy="$script_dir/managed-runtime-policy.json"
requested_output="$1"

[[ -f "$policy" && ! -L "$policy" ]] \
  || { echo "managed runtime policy is missing or unsafe" >&2; exit 1; }
output_name="$(basename -- "$requested_output")"
output_parent="$(cd "$(dirname -- "$requested_output")" && pwd -P)"
[[ "$output_name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$ && \
    "$output_name" != . && "$output_name" != .. ]] \
  || { echo "unsafe managed runtime output name" >&2; exit 1; }
output="$output_parent/$output_name"
[[ ! -e "$output" && ! -L "$output" ]] \
  || { echo "managed runtime output already exists" >&2; exit 1; }

jq --exit-status '
  .contractVersion == 1 and
  ((.architectures | keys | sort) == ["amd64", "arm64"]) and
  ([.architectures | to_entries[] as $arch |
    ($arch.value | to_entries[]) as $component |
    {arch: $arch.key, component: $component.key, input: $component.value}] |
    length == 4 and all(
      (.component == "firecracker" or .component == "kernel") and
      ((.input | keys | sort) ==
        (if .component == "firecracker" then
          ["artifact", "firecrackerSha256", "format", "jailerSha256", "maxBytes", "sha256", "sourceUrl", "version"]
        else
          ["artifact", "format", "maxBytes", "sha256", "sourceUrl", "version"]
        end)) and
      (.input.version | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")) and
      (.input.artifact | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")) and
      (.input.format == (if .component == "firecracker" then "tgz" else "linux-kernel" end)) and
      (.input.maxBytes | type == "number" and . > 0 and . <= 67108864) and
      (.input.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (if .component == "firecracker" then
        (.input.firecrackerSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
        (.input.jailerSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      else true end) and
      (.input.sourceUrl | type == "string" and
        test("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/[A-Za-z0-9._~%+,:=@/-]+$") and
        (contains("/latest") | not))
    ))
' "$policy" >/dev/null || {
  echo "managed runtime policy is malformed or mutable" >&2
  exit 1
}

staging="$(mktemp -d "$output_parent/.${output_name}.partial.XXXXXX")"
partial=""
cleanup() {
  local status=$?
  if [[ -n "$staging" && -d "$staging" && \
        "$staging" == "$output_parent/.${output_name}.partial."* ]]; then
    rm -rf -- "$staging"
  fi
  return "$status"
}
trap cleanup EXIT

for arch in amd64 arm64; do
  for component in firecracker kernel; do
    artifact="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].artifact' "$policy")"
    source_url="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].sourceUrl' "$policy")"
    expected_sha="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].sha256' "$policy")"
    max_bytes="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].maxBytes' "$policy")"
    partial="$staging/.${artifact}.partial"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --retry-all-errors --max-filesize "$max_bytes" \
      "$source_url" -o "$partial"
    [[ -f "$partial" && ! -L "$partial" && -s "$partial" && \
        "$(stat -c %s "$partial")" -le "$max_bytes" ]] \
      || { echo "$arch $component download violates the size policy" >&2; exit 1; }
    printf '%s  %s\n' "$expected_sha" "$partial" \
      | sha256sum --check --strict --status \
      || { echo "$arch $component download checksum mismatch" >&2; exit 1; }
    chmod 0644 "$partial"
    mv -T -- "$partial" "$staging/$artifact"
    partial=""
  done
done

"$script_dir/inspect-managed-runtime-assets.sh" "$policy" "$staging"
[[ ! -e "$output" && ! -L "$output" ]] \
  || { echo "managed runtime output appeared during the build" >&2; exit 1; }
mv -T -- "$staging" "$output"
staging=""
printf 'retained managed runtime assets in %s\n' "$output"

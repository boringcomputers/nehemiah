#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "$#" -ne 2 ]]; then
  echo "usage: inspect-managed-runtime-assets.sh POLICY DIRECTORY" >&2
  exit 64
fi
policy="$1"
directory="$2"
[[ -f "$policy" && ! -L "$policy" && -d "$directory" && ! -L "$directory" ]] \
  || { echo "unsafe or missing managed runtime input" >&2; exit 1; }

mapfile -t expected_names < <(jq -er \
  '[.architectures[][] | .artifact] | sort | .[]' "$policy")
mapfile -t actual_names < <(find "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[[ "${#expected_names[@]}" -eq 4 && \
    "$(printf '%s\n' "${expected_names[@]}")" == "$(printf '%s\n' "${actual_names[@]}")" ]] \
  || { echo "managed runtime directory does not contain the exact artifact set" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/managed-runtime-inspect.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
for arch in amd64 arm64; do
  expected_machine='x86-64'
  [[ "$arch" == arm64 ]] && expected_machine='ARM aarch64'
  for component in firecracker kernel; do
    artifact="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].artifact' "$policy")"
    expected_sha="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].sha256' "$policy")"
    max_bytes="$(jq -er --arg arch "$arch" --arg component "$component" \
      '.architectures[$arch][$component].maxBytes' "$policy")"
    input="$directory/$artifact"
    [[ -f "$input" && ! -L "$input" && "$expected_sha" =~ ^[0-9a-f]{64}$ && \
        "$max_bytes" =~ ^[1-9][0-9]*$ && "$(stat -c %s "$input")" -le "$max_bytes" ]] \
      || { echo "unsafe $arch $component runtime artifact" >&2; exit 1; }
    printf '%s  %s\n' "$expected_sha" "$input" | sha256sum --check --strict --status \
      || { echo "$arch $component runtime checksum mismatch" >&2; exit 1; }

    if [[ "$component" == firecracker ]]; then
      extracted="$work/$arch"
      mkdir -p "$extracted"
      python3 - "$input" "$extracted" <<'PY'
import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if not members or len(members) > 128 or sum(m.size for m in members) > 256 * 1024 * 1024:
        raise SystemExit("Firecracker archive exceeds inspection bounds")
    seen = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        canonical = str(path)
        if (
            path.is_absolute()
            or ".." in path.parts
            or canonical in seen
            or not (member.isdir() or member.isfile())
        ):
            raise SystemExit("Firecracker archive contains an unsafe entry")
        seen.add(canonical)
    bundle.extractall(destination, members=members, filter="data")
PY
      mapfile -t firecracker_bins < <(find "$extracted" -type f -name "firecracker-*" ! -name '*.debug' | sort)
      mapfile -t jailer_bins < <(find "$extracted" -type f -name "jailer-*" ! -name '*.debug' | sort)
      [[ "${#firecracker_bins[@]}" -eq 1 && "${#jailer_bins[@]}" -eq 1 ]] \
        || { echo "$arch Firecracker archive has an unexpected executable set" >&2; exit 1; }
      firecracker_sha="$(jq -er --arg arch "$arch" '.architectures[$arch].firecracker.firecrackerSha256' "$policy")"
      jailer_sha="$(jq -er --arg arch "$arch" '.architectures[$arch].firecracker.jailerSha256' "$policy")"
      printf '%s  %s\n' "$firecracker_sha" "${firecracker_bins[0]}" \
        | sha256sum --check --strict --status \
        || { echo "$arch installed Firecracker digest mismatch" >&2; exit 1; }
      printf '%s  %s\n' "$jailer_sha" "${jailer_bins[0]}" \
        | sha256sum --check --strict --status \
        || { echo "$arch installed jailer digest mismatch" >&2; exit 1; }
      for binary in "${firecracker_bins[0]}" "${jailer_bins[0]}"; do
        description="$(file -b "$binary")"
        [[ "$description" == *'ELF 64-bit LSB'* && "$description" == *"$expected_machine"* ]] \
          || { echo "$arch Firecracker archive contains a wrong-architecture binary" >&2; exit 1; }
      done
    else
      description="$(file -b "$input")"
      if [[ "$arch" == amd64 ]]; then
        [[ "$description" == *'Linux kernel x86 boot executable'* || \
            ( "$description" == *'ELF 64-bit LSB'* && "$description" == *'x86-64'* ) ]] \
          || { echo "amd64 kernel has an invalid executable type" >&2; exit 1; }
      else
        [[ "$description" == *'Linux kernel ARM64 boot executable'* || \
            ( "$description" == *'ELF 64-bit LSB'* && "$description" == *'ARM aarch64'* ) ]] \
          || { echo "arm64 kernel has an invalid executable type" >&2; exit 1; }
      fi
    fi
  done
done

printf 'verified exact managed runtime artifact set in %s\n' "$directory"

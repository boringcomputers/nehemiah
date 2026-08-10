#!/usr/bin/env bash
# Trusted release-build entry point. Network package resolution is permitted
# only here; managed hosts consume the resulting signed flat repository offline.
set -euo pipefail
export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/managed_host_packages.py" build "$@"

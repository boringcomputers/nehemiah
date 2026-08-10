#!/usr/bin/env bash
# This inspector is deliberately network-free. It verifies bytes, Debian
# identity metadata, architecture and the complete empty-host APT closure.
set -euo pipefail
export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/managed_host_packages.py" inspect "$@"

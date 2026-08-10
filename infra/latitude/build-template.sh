#!/usr/bin/env bash
#
# build-template.sh - Build a snapshot template for fast VM restore.
#
#   sudo bash build-template.sh [template_name]     (default: python)
#
# Boots a microVM from the base kernel + rootfs, waits for the NEHEMIAH_READY
# marker on the guest serial console, pauses the VM, and takes a Full snapshot
# into /opt/boring/templates/<name>/ :
#     snapshot_file   (VM state)
#     mem_file        (guest memory)
#     rootfs.ext4     (copy of the rootfs used for the snapshot)
#
# This is BEST-EFFORT / OPTIONAL. nehemiahd falls back to cold boot when a
# template is missing or a restore fails. A failure here is not catastrophic.
#
set -euo pipefail

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
NEHEMIAH_ROOT="/opt/boring"
BIN="${NEHEMIAH_ROOT}/bin/firecracker"
KERNEL="${NEHEMIAH_ROOT}/kernel/vmlinux"
BASE_ROOTFS="${NEHEMIAH_ROOT}/rootfs/rootfs.ext4"

TEMPLATE_NAME="${1:-python}"
OUT_DIR="${NEHEMIAH_ROOT}/templates/${TEMPLATE_NAME}"

BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux random.trust_cpu=on"
VCPU_COUNT="${VCPU_COUNT:-1}"
MEM_MIB="${MEM_MIB:-256}"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-30}"

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
log()  { printf '\033[1;34m[template]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[template:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[template:error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -x "${BIN}" ]      || die "firecracker not found at ${BIN} (run bootstrap.sh first)"
[ -s "${KERNEL}" ]   || die "kernel not found at ${KERNEL} (run bootstrap.sh first)"
[ -s "${BASE_ROOTFS}" ] || die "base rootfs not found at ${BASE_ROOTFS} (run build-rootfs.sh first)"

# --------------------------------------------------------------------------
# Working state + cleanup
# --------------------------------------------------------------------------
WORK="$(mktemp -d /tmp/boring-template.XXXXXX)"
SOCK="${WORK}/fc.sock"
VSOCK="${WORK}/vsock"
STDOUT_LOG="${WORK}/console.log"
# Boot (and snapshot) from the template's OWN stable rootfs path so the path
# baked into the snapshot still exists at restore time. nehemiahd restores by
# loading the snapshot, then rebinding the drive to a per-machine overlay.
WORK_ROOTFS="${OUT_DIR}/rootfs.ext4"
FC_PID=""

cleanup() {
  local rc=$?
  if [ -n "${FC_PID}" ] && kill -0 "${FC_PID}" 2>/dev/null; then
    kill -KILL "${FC_PID}" 2>/dev/null || true
    wait "${FC_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK}" 2>/dev/null || true
  return $rc
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------
# firecracker API helper (raw HTTP over the unix socket via curl)
# --------------------------------------------------------------------------
api() {
  # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local args=(--fail-with-body -sS --unix-socket "${SOCK}" -X "${method}"
              "http://localhost${path}")
  if [ -n "${body}" ]; then
    args+=(-H 'Content-Type: application/json' -d "${body}")
  fi
  curl "${args[@]}"
}

wait_for_socket() {
  local i=0
  while [ ! -S "${SOCK}" ]; do
    i=$((i + 1))
    [ "${i}" -gt 100 ] && return 1   # ~5s
    sleep 0.05
  done
  return 0
}

wait_for_ready() {
  local deadline=$(( $(date +%s) + READY_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if grep -q "NEHEMIAH_READY" "${STDOUT_LOG}" 2>/dev/null; then
      return 0
    fi
    # Bail early if firecracker died.
    if ! kill -0 "${FC_PID}" 2>/dev/null; then
      return 2
    fi
    sleep 0.1
  done
  return 1
}

# --------------------------------------------------------------------------
# 1. Prepare a working copy of the rootfs (reflink where supported)
# --------------------------------------------------------------------------
log "Preparing template rootfs (stable path for snapshot restore)..."
mkdir -p "${OUT_DIR}"
cp --reflink=auto "${BASE_ROOTFS}" "${WORK_ROOTFS}"

# --------------------------------------------------------------------------
# 2. Launch firecracker with piped stdio (guest serial -> STDOUT_LOG)
# --------------------------------------------------------------------------
log "Launching firecracker..."
rm -f "${SOCK}"
# Keep stdin open (guest serial input) via a FIFO so the child does not see EOF.
FIFO="${WORK}/stdin.fifo"
mkfifo "${FIFO}"
# Hold the write end open for the life of the script.
exec 3<>"${FIFO}"
"${BIN}" --api-sock "${SOCK}" --id "${TEMPLATE_NAME}" \
  <"${FIFO}" >"${STDOUT_LOG}" 2>&1 &
FC_PID=$!

wait_for_socket || die "firecracker API socket did not appear"

# --------------------------------------------------------------------------
# 3. Configure the VM via the API
# --------------------------------------------------------------------------
log "Configuring boot-source, drive, machine-config, and guest-agent vsock..."
api PUT /boot-source \
  "{\"kernel_image_path\":\"${KERNEL}\",\"boot_args\":\"${BOOT_ARGS}\"}" >/dev/null
api PUT /drives/rootfs \
  "{\"drive_id\":\"rootfs\",\"path_on_host\":\"${WORK_ROOTFS}\",\"is_root_device\":true,\"is_read_only\":false}" >/dev/null
api PUT /machine-config \
  "{\"vcpu_count\":${VCPU_COUNT},\"mem_size_mib\":${MEM_MIB}}" >/dev/null
api PUT /vsock \
  "{\"guest_cid\":3,\"uds_path\":\"${VSOCK}\"}" >/dev/null

log "Starting instance..."
api PUT /actions '{"action_type":"InstanceStart"}' >/dev/null

# --------------------------------------------------------------------------
# 4. Wait for NEHEMIAH_READY
# --------------------------------------------------------------------------
log "Waiting for NEHEMIAH_READY (timeout ${READY_TIMEOUT_S}s)..."
if ! wait_for_ready; then
  warn "Guest never reported NEHEMIAH_READY. Console tail:"
  tail -n 30 "${STDOUT_LOG}" >&2 || true
  die "template build aborted (best-effort; nehemiahd will cold boot)"
fi
log "Guest is ready."

# --------------------------------------------------------------------------
# 5. Pause + snapshot
# --------------------------------------------------------------------------
log "Pausing VM..."
api PATCH /vm '{"state":"Paused"}' >/dev/null

mkdir -p "${OUT_DIR}"
SNAP_FILE="${OUT_DIR}/snapshot_file"
MEM_FILE="${OUT_DIR}/mem_file"

log "Creating Full snapshot into ${OUT_DIR}..."
api PUT /snapshot/create \
  "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"${SNAP_FILE}\",\"mem_file_path\":\"${MEM_FILE}\"}" >/dev/null

# rootfs already lives at ${OUT_DIR}/rootfs.ext4 (we booted from it), and that is
# the exact path baked into the snapshot — nehemiahd loads the snapshot then
# rebinds the drive to a per-machine overlay copied from this file.

# --------------------------------------------------------------------------
# 6. Shut down the VM (cleanup trap kills the child regardless)
# --------------------------------------------------------------------------
log "Stopping VM..."
kill -KILL "${FC_PID}" 2>/dev/null || true
wait "${FC_PID}" 2>/dev/null || true
FC_PID=""
exec 3>&-   # close FIFO write end

# --------------------------------------------------------------------------
# 7. Report
# --------------------------------------------------------------------------
[ -s "${SNAP_FILE}" ] || die "snapshot_file not written"
[ -s "${MEM_FILE}" ]  || die "mem_file not written"

log "Template '${TEMPLATE_NAME}' built:"
log "  ${SNAP_FILE}       ($(du -h "${SNAP_FILE}" | cut -f1))"
log "  ${MEM_FILE}        ($(du -h "${MEM_FILE}" | cut -f1))"
log "  ${OUT_DIR}/rootfs.ext4 ($(du -h "${OUT_DIR}/rootfs.ext4" | cut -f1))"
log "Done. nehemiahd can now restore mode=snapshot for template '${TEMPLATE_NAME}'."

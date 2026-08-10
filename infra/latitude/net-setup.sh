#!/usr/bin/env bash
#
# net-setup.sh - Host networking for guest internet egress (idempotent).
#
# Creates a bridge (boring0, 10.200.0.1/24) that nehemiahd attaches per-VM taps to,
# runs dnsmasq for DHCP only, NATs guest traffic out the uplink, and
# installs a strict EGRESS FIREWALL. This box runs untrusted public code, so the
# firewall must hold: guests may reach the public internet, but NOT the cloud
# metadata endpoint, private ranges, the host, other guests, or SMTP, and their
# new-connection rate is capped to blunt scanning/abuse.
#
# Run as root on the box. Safe to re-run.
#
set -euo pipefail

BR="${NEHEMIAH_NET_BRIDGE:-boring0}"
SUBNET="${NEHEMIAH_NET_SUBNET:-10.200.0}"
STATE_PATH="${NEHEMIAH_STATE_PATH:-/var/lib/nehemiahd/state.json}"
MANAGED_MODE="${NEHEMIAH_MODE:-0}"
NETWORK_SETUP_COMPLETE=0
ACTION="${1:-apply}"

log() { printf '\033[1;34m[net]\033[0m %s\n' "$*"; }

fail_closed_guest_port() {
  local tap="$1" status=0
  ip link set "$tap" down >/dev/null 2>&1 || status=1
  ip link set "$tap" nomaster >/dev/null 2>&1 || status=1
  return "$status"
}

fail_closed_all_guest_ports() {
  local tap_path tap_name status=0
  for tap_path in /sys/class/net/bt*; do
    [[ -e "$tap_path" ]] || continue
    tap_name="${tap_path##*/}"
    [[ "$tap_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || continue
    fail_closed_guest_port "$tap_name" || status=1
  done
  return "$status"
}

freeze_all_guest_ports() {
  local tap_path tap_name status=0
  for tap_path in /sys/class/net/bt*; do
    [[ -e "$tap_path" ]] || continue
    tap_name="${tap_path##*/}"
    [[ "$tap_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || continue
    ip link set "$tap_name" down >/dev/null 2>&1 || status=1
  done
  return "$status"
}

managed_fail_closed_on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 || "$NETWORK_SETUP_COMPLETE" -ne 1 ]]; then
    fail_closed_all_guest_ports || true
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}

# A managed network restart starts by disabling every guest port. The EXIT trap
# repeats that operation after every unsuccessful path, including validation,
# missing-tool, partial-firewall, dnsmasq, and isolation failures. Only the fully
# verified success path below disarms the fail-closed behavior.
if [[ "$MANAGED_MODE" == "1" ]]; then
  trap managed_fail_closed_on_exit EXIT
  if ! fail_closed_all_guest_ports; then
    echo "failed to disable one or more guest taps before managed setup" >&2
    exit 1
  fi
  : "${NEHEMIAH_RELEASE_VERSION:?managed release version is required}"
  : "${NEHEMIAH_RUNTIME_ARCH:?managed runtime architecture is required}"
  : "${NEHEMIAH_ADVERTISE_ADDRESS:?managed advertised address is required}"
  : "${NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS:?managed control-plane overlay address is required}"
  : "${NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS:?managed gateway overlay address is required}"
  : "${NEHEMIAH_WIREGUARD_CONFIG_SHA256:?managed WireGuard digest is required}"
  python3 /opt/boring/bin/managed-host-packages verify-installed \
    --arch "$NEHEMIAH_RUNTIME_ARCH" --release-version "$NEHEMIAH_RELEASE_VERSION"
  python3 /opt/boring/bin/wireguard-config verify \
    --advertise-address "$NEHEMIAH_ADVERTISE_ADDRESS" \
    --control-plane-address "$NEHEMIAH_WIREGUARD_CONTROL_PLANE_ADDRESS" \
    --gateway-address "$NEHEMIAH_WIREGUARD_GATEWAY_ADDRESS" \
    --guest-subnet "${SUBNET}.0/24" \
    --expected-sha256 "$NEHEMIAH_WIREGUARD_CONFIG_SHA256" \
    --path /etc/wireguard/wg0.conf
fi

[[ "$#" -le 1 ]] || { echo "usage: net-setup.sh [--fail-closed]" >&2; exit 2; }
case "$ACTION" in
  apply) ;;
  --fail-closed)
    if ! fail_closed_all_guest_ports; then
      echo "failed to disable one or more guest taps" >&2
      exit 1
    fi
    NETWORK_SETUP_COMPLETE=1
    exit 0
    ;;
  *) echo "usage: net-setup.sh [--fail-closed]" >&2; exit 2 ;;
esac

[[ "$BR" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || { echo "invalid bridge name" >&2; exit 1; }
[[ "$SUBNET" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}$|^172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}$|^192\.168\.[0-9]{1,3}$ ]] || { echo "guest subnet must be a private IPv4 /24 prefix" >&2; exit 1; }
CIDR="${SUBNET}.0/24"
for required_command in awk bridge dnsmasq ip iptables ip6tables jq sha1sum; do
  command -v "$required_command" >/dev/null 2>&1 || { echo "missing required command: ${required_command}" >&2; exit 1; }
done
UPLINK="$(ip route show default | awk '{print $5; exit}')"
[ -n "$UPLINK" ] || { echo "no default route uplink"; exit 1; }

guest_mac_for_id() {
  local id="$1" digest
  digest="$(printf '%s' "$id" | sha1sum | awk '{print $1}')"
  printf '06:00:%s:%s:%s:%s\n' "${digest:0:2}" "${digest:2:2}" "${digest:4:2}" "${digest:6:2}"
}

guest_ip_is_usable() {
  local address="$1" suffix
  [[ "$address" == "${SUBNET}."* ]] || return 1
  suffix="${address##*.}"
  [[ "$suffix" =~ ^[0-9]+$ ]] || return 1
  (( 10#$suffix >= 2 && 10#$suffix <= 254 ))
}

fdb_selects_port() {
  local mac="$1" tap="$2" output
  output="$(bridge fdb get "$mac" dev "$tap" master 2>/dev/null)" || return 1
  awk -v wanted_mac="${mac,,}" -v wanted_tap="$tap" -v wanted_bridge="$BR" '
    tolower($1) == wanted_mac {
      for (i = 1; i <= NF; i++) {
        if ($i == "dev" && $(i + 1) == wanted_tap) dev_ok = 1
        if ($i == "master" && $(i + 1) == wanted_bridge) master_ok = 1
        if ($i == "static") static_ok = 1
      }
    }
    END { exit !(dev_ok && master_ok && static_ok) }
  ' <<<"$output"
}

secure_guest_port() {
  local tap="$1" mac="$2" address="${3:-}" neighbor port_state
  [[ "$tap" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || return 1
  [[ "$mac" =~ ^06:00:([[:xdigit:]]{2}:){3}[[:xdigit:]]{2}$ ]] || return 1

  # The port is down before it joins the bridge, so there is no window where a
  # live guest can send ordinary shared-L2 traffic before isolation is active.
  ip link set "$tap" down || return 1
  if ! ip link set "$tap" master "$BR" ||
    ! bridge link set dev "$tap" isolated on locked on learning off flood off guard on hairpin off ||
    ! bridge fdb replace "$mac" dev "$tap" master static; then
    fail_closed_guest_port "$tap" || true
    return 1
  fi

  port_state="$(bridge -j -details link show dev "$tap")" || {
    fail_closed_guest_port "$tap" || true
    return 1
  }
  jq -e --arg bridge "$BR" 'length == 1 and .[0].master == $bridge and .[0].isolated == true and .[0].locked == true and .[0].learning == false and .[0].flood == false and .[0].hairpin == false and .[0].guard == true' <<<"$port_state" >/dev/null || {
    fail_closed_guest_port "$tap" || true
    return 1
  }
  fdb_selects_port "$mac" "$tap" || {
    fail_closed_guest_port "$tap" || true
    return 1
  }

  if [[ -n "$address" ]]; then
    guest_ip_is_usable "$address" || {
      fail_closed_guest_port "$tap" || true
      return 1
    }
    ip neigh replace "$address" lladdr "$mac" nud permanent dev "$BR" || {
      fail_closed_guest_port "$tap" || true
      return 1
    }
    neighbor="$(ip neigh get "$address" dev "$BR")" || {
      fail_closed_guest_port "$tap" || true
      return 1
    }
    grep -Eiq "lladdr ${mac}([[:space:]]|$).*PERMANENT" <<<"$neighbor" || {
      fail_closed_guest_port "$tap" || true
      return 1
    }
  fi
  ip link set "$tap" up || {
    fail_closed_guest_port "$tap" || true
    return 1
  }
}

# --- bridge -----------------------------------------------------------------
ip link show "$BR" >/dev/null 2>&1 || ip link add "$BR" type bridge
ip addr replace "${SUBNET}.1/24" dev "$BR"
ip link set "$BR" up
sysctl -qw net.ipv4.ip_forward=1
# Make bridged guest-to-guest frames traverse the same FORWARD policy as routed
# egress. Without bridge netfilter, two taps can bypass iptables at layer 2.
modprobe br_netfilter 2>/dev/null || [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]
sysctl -qw net.bridge.bridge-nf-call-iptables=1
sysctl -qw "net.ipv6.conf.${BR}.disable_ipv6=1"
log "bridge $BR up at ${SUBNET}.1/24, uplink=$UPLINK"

# Freeze existing guest taps before rebuilding shared firewall/bridge state.
# Local prototype reruns retain the authenticated FDB entry used by the narrow
# state-save race fallback; managed setup already detached every port above.
if ! freeze_all_guest_ports; then
  echo "failed to disable one or more guest taps before firewall rebuild" >&2
  exit 1
fi

# --- dnsmasq (DHCP only; nehemiahd exclusively owns managed DNS on :53) -----
mkdir -p /etc/dnsmasq.d
cat > /etc/dnsmasq.d/boring.conf <<EOF
interface=${BR}
bind-interfaces
except-interface=lo
port=0
# .200-.250 is reserved for statically-addressed forks (nehemiahd assigns those).
dhcp-range=${SUBNET}.10,${SUBNET}.199,255.255.255.0,1h
dhcp-option=option:router,${SUBNET}.1
dhcp-option=option:dns-server,${SUBNET}.1
EOF
# Port 53 is a security boundary owned by nehemiahd's policy-aware DNS proxy.
# Starting the daemon with dnsmasq DNS enabled would either fail or bypass the
# answer-to-egress binding, so keep this explicit and acceptance-tested.
systemctl enable dnsmasq >/dev/null 2>&1 || true
systemctl restart dnsmasq
log "dnsmasq serving DHCP only on $BR; nehemiahd owns ${SUBNET}.1:53"

# --- NAT --------------------------------------------------------------------
iptables -t nat -C POSTROUTING -s "$CIDR" -o "$UPLINK" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "$CIDR" -o "$UPLINK" -j MASQUERADE

# --- INPUT: guests may only reach the host for DHCP + rate-limited DNS ------
# Allow replies to host-initiated connections (e.g. the preview proxy reaching a
# guest's port) — without this the blanket DROP below kills those return packets.
iptables -N NEHEMIAH_INPUT 2>/dev/null || true
# Remove rules emitted by older versions of this script, then ensure our chain
# is first so an existing broad host ACCEPT cannot bypass the guest policy.
while iptables -D INPUT -i "$BR" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "$BR" -p udp -m multiport --dports 67,53 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "$BR" -p tcp --dport 53 -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -i "$BR" -j DROP 2>/dev/null; do :; done
while iptables -D INPUT -i "$BR" -j NEHEMIAH_INPUT 2>/dev/null; do :; done
iptables -I INPUT 1 -i "$BR" -j NEHEMIAH_INPUT
iptables -F NEHEMIAH_INPUT
iptables -A NEHEMIAH_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A NEHEMIAH_INPUT -p udp --dport 67 -j ACCEPT
# DNS query flood protection is per guest IP, for both UDP and TCP fallback.
for proto in udp tcp; do
  limit_name="neh-dns-${proto:0:1}"
  iptables -A NEHEMIAH_INPUT -p "$proto" --dport 53 \
    -m hashlimit --hashlimit-above 50/sec --hashlimit-burst 100 \
    --hashlimit-mode srcip --hashlimit-name "$limit_name" -j DROP
  iptables -A NEHEMIAH_INPUT -p "$proto" --dport 53 -j ACCEPT
done
iptables -A NEHEMIAH_INPUT -j DROP

# --- FORWARD: the egress firewall ------------------------------------------
iptables -N NEHEMIAH_FWD 2>/dev/null || true
while iptables -D FORWARD -j NEHEMIAH_FWD 2>/dev/null; do :; done
iptables -I FORWARD 1 -j NEHEMIAH_FWD
iptables -F NEHEMIAH_FWD
# return traffic to guests
iptables -A NEHEMIAH_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# only guest-sourced traffic is filtered below; anything else falls through
iptables -A NEHEMIAH_FWD ! -s "$CIDR" -j RETURN
# Non-overridable hard floor: metadata, current/future private space,
# loopback/link-local, CGNAT, benchmarking networks, multicast and broadcast.
# The RFC1918 blocks also prevent guest↔guest and guest→bridge traffic.
for net in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  224.0.0.0/4 \
  240.0.0.0/4; do
  iptables -A NEHEMIAH_FWD -s "$CIDR" -d "$net" -j DROP
done
# no spam
iptables -A NEHEMIAH_FWD -s "$CIDR" -p tcp --dport 25 -j DROP
# cap new-connection rate per guest (anti-scan / anti-abuse)
iptables -A NEHEMIAH_FWD -s "$CIDR" -p tcp --syn \
  -m hashlimit --hashlimit-above 80/sec --hashlimit-burst 120 \
  --hashlimit-mode srcip --hashlimit-name boringrate -j DROP
# Bound connectionless abuse as well; DNS to the bridge was already handled by
# NEHEMIAH_INPUT and never reaches this chain.
iptables -A NEHEMIAH_FWD -s "$CIDR" -p udp \
  -m hashlimit --hashlimit-above 200/sec --hashlimit-burst 400 \
  --hashlimit-mode srcip --hashlimit-name nehemiah-udp -j DROP
iptables -A NEHEMIAH_FWD -s "$CIDR" -p icmp \
  -m hashlimit --hashlimit-above 20/sec --hashlimit-burst 40 \
  --hashlimit-mode srcip --hashlimit-name nehemiah-icmp -j DROP
# everything else out to the public internet is allowed
iptables -A NEHEMIAH_FWD -s "$CIDR" -j ACCEPT
# Managed machines attach a NIC for host-initiated preview/file traffic, but
# outbound guest forwarding is off unless a separately verified allowlist is
# installed. Rebuild per-tap deny rules when this oneshot is rerun so flushing
# the shared chain can never silently grant egress to already-running VMs.
declare -A tap_macs=()
declare -A tap_ips=()
if [[ -r "$STATE_PATH" ]]; then
  while IFS=$'\t' read -r machine_id persisted_tap persisted_ip; do
    [[ -n "$machine_id" && -n "$persisted_tap" ]] || continue
    [[ "$persisted_tap" == "bt$(printf '%s' "$machine_id" | sha1sum | awk '{print substr($1,1,8)}')" ]] || continue
    tap_macs["$persisted_tap"]="$(guest_mac_for_id "$machine_id")"
    tap_ips["$persisted_tap"]="$persisted_ip"
  done < <(jq -r '.machines[]? | select(.runtime.tap? != null and .runtime.tap != "") | [.id, .runtime.tap, (.runtime.ip // "")] | @tsv' "$STATE_PATH")
fi

tap_isolation_failed=0
for tap_path in /sys/class/net/bt*; do
  [[ -e "$tap_path" ]] || continue
  tap_name="${tap_path##*/}"
  [[ "$tap_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || continue
  if [[ "$MANAGED_MODE" == "1" ]]; then
    iptables -I NEHEMIAH_FWD 1 -i "$tap_name" -j DROP
  fi
  expected_mac="${tap_macs[$tap_name]:-}"
  expected_ip="${tap_ips[$tap_name]:-}"
  if [[ -z "$expected_mac" ]]; then
    # A port created by the new daemon already has a static authenticated FDB
    # entry. This fallback makes a manual network-service restart idempotent
    # even if it races the next atomic state save. Old unauthenticated ports
    # have no such entry and remain down/detached below.
    expected_mac="$(bridge fdb show br "$BR" brport "$tap_name" state static 2>/dev/null | awk 'tolower($1) ~ /^06:00:([[:xdigit:]]{2}:){3}[[:xdigit:]]{2}$/ { print tolower($1); exit }')"
  fi
  if [[ -z "$expected_mac" ]] || ! secure_guest_port "$tap_name" "$expected_mac" "$expected_ip"; then
    fail_closed_guest_port "$tap_name" || true
    log "ERROR: tap ${tap_name} has no verifiable isolated identity; left down and detached"
    tap_isolation_failed=1
  else
    log "tap ${tap_name} isolated and locked to ${expected_mac}"
  fi
done
# Guests have no IPv6 egress path; make that a fail-closed invariant if IPv6 is
# enabled elsewhere on the host in the future.
while ip6tables -D FORWARD -i "$BR" -j DROP 2>/dev/null; do :; done
ip6tables -I FORWARD 1 -i "$BR" -j DROP
log "egress firewall installed (metadata/private/peer/multicast blocked; DNS + egress rate-capped)"
if [[ "$tap_isolation_failed" -ne 0 ]]; then
  fail_closed_all_guest_ports || true
  echo "one or more guest taps failed bridge isolation" >&2
  exit 1
fi
NETWORK_SETUP_COMPLETE=1
log "done."

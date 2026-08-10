#!/usr/bin/env bash
# Verify the non-overridable Nehemiah host-isolation floor.
#
# Default mode is read-only and safe on a live host. `--active` creates two
# short-lived network namespaces on boring0 and performs connection probes; use
# that mode only on a disposable Latitude staging host with no addresses in the
# reserved .252-.253 range.
set -euo pipefail

BR="${NEHEMIAH_NET_BRIDGE:-boring0}"
SUBNET="${NEHEMIAH_NET_SUBNET:-10.200.0}"
CIDR="${SUBNET}.0/24"
STATE_PATH="${NEHEMIAH_STATE_PATH:-/var/lib/nehemiahd/state.json}"
ACTIVE=0
[[ "${1:-}" == "--active" ]] && ACTIVE=1

pass_count=0
fail_count=0
pass() { printf '[PASS] %s\n' "$*"; pass_count=$((pass_count + 1)); }
fail() { printf '[FAIL] %s\n' "$*" >&2; fail_count=$((fail_count + 1)); }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { fail "missing command: $1"; return 1; }; }

check_cmd() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
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

[[ "$(id -u)" -eq 0 ]] || { echo "run as root" >&2; exit 2; }
prerequisites_ok=1
for command in awk bridge ip iptables iptables-save ip6tables jq sha1sum sysctl systemctl; do
  require_cmd "$command" || prerequisites_ok=0
done
[[ "$prerequisites_ok" -eq 1 ]] || { echo "required isolation verification tools are unavailable" >&2; exit 2; }

check_cmd "bridge ${BR} exists" ip link show "$BR"
if ip -4 address show dev "$BR" | grep -Fq "inet ${SUBNET}.1/24"; then pass "bridge has gateway ${SUBNET}.1/24"; else fail "bridge gateway missing"; fi
if [[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" == "1" ]]; then pass "IPv4 forwarding enabled"; else fail "IPv4 forwarding disabled"; fi
if [[ "$(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null)" == "1" ]]; then pass "bridged peer traffic enters iptables"; else fail "bridge netfilter disabled"; fi

check_cmd "guest INPUT policy is hooked" iptables -C INPUT -i "$BR" -j NEHEMIAH_INPUT
check_cmd "guest INPUT defaults to drop" iptables -C NEHEMIAH_INPUT -j DROP
if iptables-save | grep -q -- '--hashlimit-name neh-dns-u'; then pass "UDP DNS rate limit present"; else fail "UDP DNS rate limit missing"; fi
if iptables-save | grep -q -- '--hashlimit-name neh-dns-t'; then pass "TCP DNS rate limit present"; else fail "TCP DNS rate limit missing"; fi
check_cmd "egress policy is hooked" iptables -C FORWARD -j NEHEMIAH_FWD
declare -A tap_macs=()
declare -A tap_ips=()
if [[ -r "$STATE_PATH" ]]; then
  while IFS=$'\t' read -r machine_id persisted_tap persisted_ip; do
    [[ -n "$machine_id" && -n "$persisted_tap" ]] || continue
    digest="$(printf '%s' "$machine_id" | sha1sum | awk '{print $1}')"
    expected_tap="bt${digest:0:8}"
    [[ "$persisted_tap" == "$expected_tap" ]] || {
      fail "state tap ${persisted_tap} does not match machine ${machine_id}"
      continue
    }
    tap_macs["$persisted_tap"]="06:00:${digest:0:2}:${digest:2:2}:${digest:4:2}:${digest:6:2}"
    tap_ips["$persisted_tap"]="$persisted_ip"
  done < <(jq -r '.machines[]? | select(.runtime.tap? != null and .runtime.tap != "") | [.id, .runtime.tap, (.runtime.ip // "")] | @tsv' "$STATE_PATH")
fi
for tap_path in /sys/class/net/bt*; do
  [[ -e "$tap_path" ]] || continue
  tap_name="${tap_path##*/}"
  check_cmd "managed tap ${tap_name} defaults to no egress" \
    iptables -C NEHEMIAH_FWD -i "$tap_name" -j DROP
  port_state="$(bridge -j -details link show dev "$tap_name" 2>/dev/null || true)"
  if jq -e --arg bridge "$BR" 'length == 1 and .[0].master == $bridge and .[0].isolated == true and .[0].locked == true and .[0].learning == false and .[0].flood == false and .[0].hairpin == false and .[0].guard == true' <<<"$port_state" >/dev/null 2>&1; then
    pass "managed tap ${tap_name} has fail-closed isolated/locked bridge flags"
  else
    fail "managed tap ${tap_name} lacks fail-closed isolated/locked bridge flags"
  fi
  expected_mac="${tap_macs[$tap_name]:-}"
  if [[ -n "$expected_mac" ]]; then
    check_cmd "managed tap ${tap_name} has its expected static FDB identity" \
      fdb_selects_port "$expected_mac" "$tap_name"
    expected_ip="${tap_ips[$tap_name]:-}"
    if [[ -n "$expected_ip" ]]; then
      neighbor="$(ip neigh get "$expected_ip" dev "$BR" 2>/dev/null || true)"
      if grep -Eiq "lladdr ${expected_mac}([[:space:]]|$).*PERMANENT" <<<"$neighbor"; then
        pass "managed tap ${tap_name} host neighbor is permanently pinned"
      else
        fail "managed tap ${tap_name} host neighbor is not permanently pinned"
      fi
    fi
  else
    fail "managed tap ${tap_name} has no expected identity in daemon state"
  fi
done

for destination in \
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
  check_cmd "blocked destination ${destination}" iptables -C NEHEMIAH_FWD -s "$CIDR" -d "$destination" -j DROP
done
check_cmd "SMTP egress blocked" iptables -C NEHEMIAH_FWD -s "$CIDR" -p tcp --dport 25 -j DROP
check_cmd "IPv6 guest forwarding blocked" ip6tables -C FORWARD -i "$BR" -j DROP

DNSMASQ_CONF=/etc/dnsmasq.d/boring.conf
if grep -Fxq 'port=0' "$DNSMASQ_CONF" 2>/dev/null; then
  pass "dnsmasq DNS is disabled"
else
  fail "dnsmasq must be DHCP-only with port=0"
fi
if grep -Eq '^(server|resolv-file|dns-forward-max|cache-size)=' "$DNSMASQ_CONF" 2>/dev/null; then
  fail "dnsmasq still contains DNS resolver configuration"
else
  pass "dnsmasq has no resolver upstream"
fi

if [[ -x /opt/boring/bin/jailer ]]; then pass "jailer installed"; else fail "jailer missing"; fi
if [[ -e "$STATE_PATH" ]]; then
  if [[ "$(stat -c '%a' "$STATE_PATH" 2>/dev/null)" == "600" ]]; then pass "state file is owner-only"; else fail "state file permissions are not 600"; fi
else
  pass "state file not created yet"
fi
if [[ "$(systemctl show nehemiahd.service -p Delegate --value 2>/dev/null)" == "yes" ]]; then pass "cgroup delegation enabled"; else fail "cgroup delegation missing"; fi
if [[ "$(systemctl show nehemiahd.service -p KillMode --value 2>/dev/null)" == "control-group" ]]; then pass "daemon cgroup is fully cleaned while sibling VMM scopes survive"; else fail "KillMode is not control-group"; fi
if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then pass "systemd transient-scope tools installed"; else fail "systemd transient-scope tools missing"; fi
if pgrep -a firecracker 2>/dev/null | grep -q -- '--no-seccomp'; then
  fail "a Firecracker process disabled seccomp"
else
  pass "no Firecracker process disables seccomp"
fi

if [[ "$ACTIVE" -eq 1 ]]; then
  active_prerequisites_ok=1
  for command in curl python3; do
    require_cmd "$command" || active_prerequisites_ok=0
  done
  [[ "$active_prerequisites_ok" -eq 1 ]] || { echo "active isolation verification tools are unavailable" >&2; exit 2; }
  suffix="$$"
  ns_a="nehemiah-a-${suffix}"
  ns_b="nehemiah-b-${suffix}"
  va="nva${suffix: -6}"
  vb="nvb${suffix: -6}"
  pa="npa${suffix: -6}"
  pb="npb${suffix: -6}"
  mac_a="06:00:00:00:fc:01"
  mac_b="06:00:00:00:fd:01"
  peer_pid=""
  cleanup() {
    if [[ -n "$peer_pid" ]]; then kill "$peer_pid" >/dev/null 2>&1 || true; fi
    ip neigh del "${SUBNET}.253" lladdr "$mac_b" dev "$BR" >/dev/null 2>&1 || true
    ip link del "$va" >/dev/null 2>&1 || true
    ip link del "$vb" >/dev/null 2>&1 || true
    while iptables -D NEHEMIAH_FWD -i "$va" -j DROP >/dev/null 2>&1; do :; done
    while iptables -D NEHEMIAH_FWD -i "$va" ! -s "${SUBNET}.252/32" -j DROP >/dev/null 2>&1; do :; done
    ip netns del "$ns_a" >/dev/null 2>&1 || true
    ip netns del "$ns_b" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  ip netns add "$ns_a"
  ip netns add "$ns_b"
  ip link add "$va" type veth peer name "$pa"
  ip link add "$vb" type veth peer name "$pb"
  ip link set "$pa" netns "$ns_a"
  ip link set "$pb" netns "$ns_b"
  ip link set "$va" master "$BR"
  ip link set "$vb" master "$BR"
  ip -n "$ns_a" link set "$pa" address "$mac_a"
  ip -n "$ns_b" link set "$pb" address "$mac_b"
  bridge link set dev "$va" isolated on locked on learning off flood off guard on hairpin off
  bridge link set dev "$vb" isolated on locked on learning off flood off guard on hairpin off
  bridge fdb replace "$mac_a" dev "$va" master static
  bridge fdb replace "$mac_b" dev "$vb" master static
  ip neigh replace "${SUBNET}.253" lladdr "$mac_b" nud permanent dev "$BR"
  ip link set "$va" up
  ip link set "$vb" up
  ip -n "$ns_a" link set lo up
  ip -n "$ns_b" link set lo up
  ip -n "$ns_a" addr add "${SUBNET}.252/24" dev "$pa"
  ip -n "$ns_b" addr add "${SUBNET}.253/24" dev "$pb"
  ip -n "$ns_a" link set "$pa" up
  ip -n "$ns_b" link set "$pb" up
  ip -n "$ns_a" route add default via "${SUBNET}.1"
  ip -n "$ns_b" route add default via "${SUBNET}.1"

  ip netns exec "$ns_b" python3 -m http.server 18080 --bind "${SUBNET}.253" >/dev/null 2>&1 &
  peer_pid=$!
  for _ in 1 2 3 4 5; do
    ip netns exec "$ns_b" curl -fsS --max-time 1 "http://${SUBNET}.253:18080/" >/dev/null 2>&1 && break
    sleep 0.1
  done
  if ! ip netns exec "$ns_b" curl -fsS --max-time 1 "http://${SUBNET}.253:18080/" >/dev/null 2>&1; then
    fail "peer test listener failed to start"
  fi

  if curl -fsS --connect-timeout 1 --max-time 2 "http://${SUBNET}.253:18080/" >/dev/null 2>&1; then
    pass "host-initiated preview path reaches an isolated guest"
  else
    fail "host-initiated preview path cannot reach an isolated guest"
  fi

  blocked_probe() {
    local description="$1" target="$2"
    if ip netns exec "$ns_a" curl -fsS --connect-timeout 1 --max-time 2 "$target" >/dev/null 2>&1; then
      fail "$description"
    else
      pass "$description"
    fi
  }
  blocked_probe "guest cannot contact peer guest" "http://${SUBNET}.253:18080/"
  blocked_probe "guest cannot contact host daemon" "http://${SUBNET}.1:8080/healthz"
  blocked_probe "guest cannot contact metadata" "http://169.254.169.254/"
  blocked_probe "guest cannot contact RFC1918 services" "http://192.168.1.1/"

  # Send two forged gratuitous ARP replies from guest A: one uses A's admitted
  # MAC while claiming B's IP, and one spoofs B's MAC outright. The permanent
  # neighbor must not move, the locked FDB must still select B's port, and a
  # host preview must continue reaching B.
  for forged_mac in "$mac_a" "$mac_b"; do
    ip netns exec "$ns_a" python3 - "$pa" "$forged_mac" "${SUBNET}.253" <<'PY'
import socket
import struct
import sys

interface, source_text, claimed_ip = sys.argv[1:]
source = bytes.fromhex(source_text.replace(":", ""))
target_ip = socket.inet_aton(claimed_ip)
ethernet = b"\xff" * 6 + source + struct.pack("!H", 0x0806)
arp = struct.pack("!HHBBH6s4s6s4s", 1, 0x0800, 6, 4, 2, source, target_ip, b"\x00" * 6, target_ip)
sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
sock.bind((interface, 0))
for _ in range(3):
    sock.send(ethernet + arp)
sock.close()
PY
  done
  sleep 0.2
  neighbor="$(ip neigh get "${SUBNET}.253" dev "$BR" 2>/dev/null || true)"
  if grep -Eiq "lladdr ${mac_b}([[:space:]]|$).*PERMANENT" <<<"$neighbor"; then
    pass "forged ARP cannot move the host's permanent guest neighbor"
  else
    fail "forged ARP changed the host guest neighbor: ${neighbor}"
  fi
  check_cmd "foreign source MAC cannot move the static FDB selection" \
    fdb_selects_port "$mac_b" "$vb"
  if fdb_selects_port "$mac_b" "$va"; then
    fail "victim MAC was also selected on the attacker port"
  else
    pass "victim MAC is absent from the attacker port"
  fi
  if curl -fsS --connect-timeout 1 --max-time 2 "http://${SUBNET}.253:18080/" >/dev/null 2>&1; then
    pass "host preview still selects the victim after forged ARP"
  else
    fail "forged ARP diverted the host preview path"
  fi
  if ip netns exec "$ns_a" curl -kfsS --connect-timeout 3 --max-time 8 https://1.1.1.1/cdn-cgi/trace >/dev/null 2>&1; then
    pass "host firewall can carry explicitly allowed public egress"
  else
    fail "host firewall public egress path failed"
  fi
  # Mirror the daemon's first per-tap policy rule, then prove a root guest
  # cannot rotate source addresses to multiply machine-scoped abuse buckets.
  iptables -I NEHEMIAH_FWD 1 -i "$va" ! -s "${SUBNET}.252/32" -j DROP
  ip -n "$ns_a" addr add "${SUBNET}.251/24" dev "$pa"
  if ip netns exec "$ns_a" curl -kfsS --interface "${SUBNET}.251" --connect-timeout 2 --max-time 4 https://1.1.1.1/cdn-cgi/trace >/dev/null 2>&1; then
    fail "spoofed guest source IPv4 bypassed the per-tap identity binding"
  else
    pass "per-tap identity binding drops spoofed guest source IPv4"
  fi
  ip -n "$ns_a" addr del "${SUBNET}.251/24" dev "$pa"
  while iptables -D NEHEMIAH_FWD -i "$va" ! -s "${SUBNET}.252/32" -j DROP >/dev/null 2>&1; do :; done
  iptables -I NEHEMIAH_FWD 1 -i "$va" -j DROP
  if ip netns exec "$ns_a" curl -kfsS --connect-timeout 2 --max-time 4 https://1.1.1.1/cdn-cgi/trace >/dev/null 2>&1; then
    fail "managed per-tap default deny allowed public egress"
  else
    pass "managed per-tap default deny blocks public egress"
  fi
fi

printf '\nIsolation verification: %d passed, %d failed\n' "$pass_count" "$fail_count"
[[ "$fail_count" -eq 0 ]]

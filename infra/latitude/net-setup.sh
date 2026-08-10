#!/usr/bin/env bash
#
# net-setup.sh - Host networking for guest internet egress (idempotent).
#
# Creates a bridge (boring0, 10.200.0.1/24) that nehemiahd attaches per-VM taps to,
# runs dnsmasq for DHCP + DNS on it, NATs guest traffic out the uplink, and
# installs a strict EGRESS FIREWALL. This box runs untrusted public code, so the
# firewall must hold: guests may reach the public internet, but NOT the cloud
# metadata endpoint, private ranges, the host, other guests, or SMTP, and their
# new-connection rate is capped to blunt scanning/abuse.
#
# Run as root on the box. Safe to re-run.
#
set -euo pipefail

BR="boring0"
SUBNET="10.200.0"
CIDR="${SUBNET}.0/24"
UPLINK="$(ip route show default | awk '{print $5; exit}')"
[ -n "$UPLINK" ] || { echo "no default route uplink"; exit 1; }

log() { printf '\033[1;34m[net]\033[0m %s\n' "$*"; }

# --- bridge -----------------------------------------------------------------
ip link show "$BR" >/dev/null 2>&1 || ip link add "$BR" type bridge
ip addr replace "${SUBNET}.1/24" dev "$BR"
ip link set "$BR" up
sysctl -qw net.ipv4.ip_forward=1
log "bridge $BR up at ${SUBNET}.1/24, uplink=$UPLINK"

# --- dnsmasq (DHCP + DNS on the bridge only) --------------------------------
command -v dnsmasq >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq dnsmasq >/dev/null; }
mkdir -p /etc/dnsmasq.d
cat > /etc/dnsmasq.d/boring.conf <<EOF
interface=${BR}
bind-interfaces
except-interface=lo
# .200-.250 is reserved for statically-addressed forks (nehemiahd assigns those).
dhcp-range=${SUBNET}.10,${SUBNET}.199,255.255.255.0,1h
dhcp-option=option:router,${SUBNET}.1
dhcp-option=option:dns-server,${SUBNET}.1
server=1.1.1.1
server=8.8.8.8
no-resolv
EOF
# Don't let dnsmasq grab :53 on all interfaces; it's bound to the bridge only.
systemctl enable dnsmasq >/dev/null 2>&1 || true
systemctl restart dnsmasq
log "dnsmasq serving DHCP+DNS on $BR"

# --- NAT --------------------------------------------------------------------
iptables -t nat -C POSTROUTING -s "$CIDR" -o "$UPLINK" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "$CIDR" -o "$UPLINK" -j MASQUERADE

# --- INPUT: guests may only reach the host for DHCP + DNS -------------------
# Allow replies to host-initiated connections (e.g. the preview proxy reaching a
# guest's port) — without this the blanket DROP below kills those return packets.
iptables -C INPUT -i "$BR" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -i "$BR" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -C INPUT -i "$BR" -p udp -m multiport --dports 67,53 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -i "$BR" -p udp -m multiport --dports 67,53 -j ACCEPT
iptables -C INPUT -i "$BR" -p tcp --dport 53 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -i "$BR" -p tcp --dport 53 -j ACCEPT
iptables -C INPUT -i "$BR" -j DROP 2>/dev/null \
  || iptables -A INPUT -i "$BR" -j DROP

# --- FORWARD: the egress firewall ------------------------------------------
iptables -N NEHEMIAH_FWD 2>/dev/null || true
iptables -C FORWARD -j NEHEMIAH_FWD 2>/dev/null || iptables -I FORWARD -j NEHEMIAH_FWD
iptables -F NEHEMIAH_FWD
# return traffic to guests
iptables -A NEHEMIAH_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# only guest-sourced traffic is filtered below; anything else falls through
iptables -A NEHEMIAH_FWD ! -s "$CIDR" -j RETURN
# block the cloud metadata endpoint + private/link-local/loopback + guest↔guest
for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 100.64.0.0/10; do
  iptables -A NEHEMIAH_FWD -s "$CIDR" -d "$net" -j DROP
done
# no spam
iptables -A NEHEMIAH_FWD -s "$CIDR" -p tcp --dport 25 -j DROP
# cap new-connection rate per guest (anti-scan / anti-abuse)
iptables -A NEHEMIAH_FWD -s "$CIDR" -p tcp --syn \
  -m hashlimit --hashlimit-above 80/sec --hashlimit-burst 120 \
  --hashlimit-mode srcip --hashlimit-name boringrate -j DROP
# everything else out to the public internet is allowed
iptables -A NEHEMIAH_FWD -s "$CIDR" -j ACCEPT
log "egress firewall installed (metadata + private + SMTP blocked, rate-capped)"
log "done."

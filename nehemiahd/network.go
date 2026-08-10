package main

import (
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var networkInterfacePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)
var managedTapPattern = regexp.MustCompile(`^bt[0-9a-f]{8}$`)

// tapName derives a stable host tap device name for a machine. Kept short
// (≤15 chars): "bt" + 8 hex = 10.
func tapName(id string) string {
	h := sha1.Sum([]byte(id))
	return fmt.Sprintf("bt%x", h[:4])
}

// guestMAC derives a stable locally-administered MAC for a machine.
func guestMAC(id string) string {
	h := sha1.Sum([]byte(id))
	return fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", h[0], h[1], h[2], h[3])
}

// makeTap creates a tap owned by uid (the jailed firecracker uid, so it can open
// the device) and brings it up — but does NOT attach it to a bridge. A fork
// restores its NIC before it has a unique MAC/IP, so it must stay off the bridge
// until re-addressed (else it would collide with the source).
func makeTap(name string, uid int) error {
	if !networkInterfacePattern.MatchString(name) {
		return fmt.Errorf("unsafe tap interface name %q", name)
	}
	add := []string{"tuntap", "add", name, "mode", "tap"}
	if uid > 0 {
		add = append(add, "user", fmt.Sprint(uid))
	}
	if out, err := exec.Command("ip", add...).CombinedOutput(); err != nil {
		return fmt.Errorf("tap add: %v: %s", err, out)
	}
	if out, err := exec.Command("ip", "link", "set", name, "up").CombinedOutput(); err != nil {
		exec.Command("ip", "link", "del", name).Run()
		return fmt.Errorf("tap up: %v: %s", err, out)
	}
	return nil
}

type networkCommand struct {
	name string
	args []string
}

func tapBridgeIsolationCommands(name, bridge, mac string) ([]networkCommand, error) {
	canonicalMAC, err := validateTapIdentity(name, bridge, mac)
	if err != nil {
		return nil, err
	}
	return []networkCommand{
		// Keep the port down until every isolation control and its static FDB
		// identity is installed. This removes the attach-then-isolate race.
		{name: "ip", args: []string{"link", "set", name, "down"}},
		{name: "ip", args: []string{"link", "set", name, "master", bridge}},
		// isolated blocks all unicast, multicast and broadcast forwarding to
		// another isolated guest port. locked + learning off only admits the
		// machine's assigned source MAC, so a guest cannot impersonate a peer.
		{name: "bridge", args: []string{"link", "set", "dev", name, "isolated", "on", "locked", "on", "learning", "off", "flood", "off", "guard", "on", "hairpin", "off"}},
		{name: "bridge", args: []string{"fdb", "replace", canonicalMAC, "dev", name, "master", "static"}},
	}, nil
}

func validateTapIdentity(name, bridge, mac string) (string, error) {
	if !networkInterfacePattern.MatchString(name) || !networkInterfacePattern.MatchString(bridge) {
		return "", fmt.Errorf("unsafe tap or bridge interface name")
	}
	hardwareAddress, err := net.ParseMAC(mac)
	if err != nil || len(hardwareAddress) != 6 || hardwareAddress[0]&1 != 0 || hardwareAddress[0]&2 == 0 {
		return "", fmt.Errorf("unsafe guest MAC address %q", mac)
	}
	return hardwareAddress.String(), nil
}

func failClosedTapBridge(name string) {
	// A partially configured bridge port must never be left forwarding. Keep it
	// down first, then detach it. Callers may delete the tap or retry safely.
	_ = exec.Command("ip", "link", "set", name, "down").Run()
	_ = exec.Command("ip", "link", "set", name, "nomaster").Run()
}

func verifyTapBridgeIsolation(name, bridge string) error {
	output, err := exec.Command("bridge", "-j", "-details", "link", "show", "dev", name).CombinedOutput()
	if err != nil {
		return fmt.Errorf("read bridge-port isolation: %v: %s", err, output)
	}
	var ports []struct {
		Master   string `json:"master"`
		Isolated bool   `json:"isolated"`
		Locked   bool   `json:"locked"`
		Learning bool   `json:"learning"`
		Flood    bool   `json:"flood"`
		Hairpin  bool   `json:"hairpin"`
		Guard    bool   `json:"guard"`
	}
	if err := json.Unmarshal(output, &ports); err != nil || len(ports) != 1 {
		return fmt.Errorf("decode bridge-port isolation: %w", err)
	}
	port := ports[0]
	if port.Master != bridge || !port.Isolated || !port.Locked || port.Learning || port.Flood || port.Hairpin || !port.Guard {
		return fmt.Errorf("bridge port is not fail-closed: master=%q isolated=%t locked=%t learning=%t flood=%t hairpin=%t guard=%t",
			port.Master, port.Isolated, port.Locked, port.Learning, port.Flood, port.Hairpin, port.Guard)
	}
	return nil
}

// attachTapBridge joins a tap to the shared host bridge as an isolated, locked
// port. Isolated ports may talk to the bridge's host stack (DHCP, DNS and
// host-initiated previews), but never to another guest port at layer 2. The tap
// stays down and is detached on any error, making unsupported kernels fail
// closed instead of silently falling back to an ordinary shared bridge.
func attachTapBridge(name, bridge, mac string, denyEgress bool) error {
	commands, err := tapBridgeIsolationCommands(name, bridge, mac)
	if err != nil {
		return err
	}
	for _, command := range commands {
		if out, commandErr := exec.Command(command.name, command.args...).CombinedOutput(); commandErr != nil {
			failClosedTapBridge(name)
			return fmt.Errorf("secure tap bridge (%s %s): %v: %s", command.name, strings.Join(command.args, " "), commandErr, out)
		}
	}
	if err := verifyTapBridgeIsolation(name, bridge); err != nil {
		failClosedTapBridge(name)
		return fmt.Errorf("verify tap bridge isolation: %w", err)
	}
	if denyEgress {
		// Install the managed-host forwarding deny while the tap is still down.
		// A restored live guest therefore never gets an attach-to-DROP race.
		if err := denyTapEgress(name); err != nil {
			failClosedTapBridge(name)
			removeTapEgressRule(name)
			return err
		}
	}
	if out, err := exec.Command("ip", "link", "set", name, "up").CombinedOutput(); err != nil {
		failClosedTapBridge(name)
		if denyEgress {
			removeTapEgressRule(name)
		}
		return fmt.Errorf("bring isolated tap up: %v: %s", err, out)
	}
	return nil
}

func guestNeighborCommands(name, bridge, subnet, address, mac string) ([]networkCommand, error) {
	canonicalMAC, err := validateTapIdentity(name, bridge, mac)
	if err != nil {
		return nil, err
	}
	prefix, err := netip.ParsePrefix(subnet + ".0/24")
	if err != nil || !prefix.Addr().Is4() {
		return nil, fmt.Errorf("unsafe guest subnet %q", subnet)
	}
	ip, err := netip.ParseAddr(address)
	if err != nil || !ip.Is4() || !prefix.Contains(ip) || ip == prefix.Addr() || ip == netip.MustParseAddr(subnet+".1") || ip == netip.MustParseAddr(subnet+".255") {
		return nil, fmt.Errorf("guest IP %q is outside the usable guest subnet", address)
	}
	return []networkCommand{
		// Replacing the FDB entry makes the expected tap authoritative even if
		// a hostile port previously tried to advertise the machine's MAC.
		{name: "bridge", args: []string{"fdb", "replace", canonicalMAC, "dev", name, "master", "static"}},
		// A permanent host neighbor prevents gratuitous/forged ARP from moving a
		// preview connection for this IP onto another guest's legitimate MAC.
		{name: "ip", args: []string{"neigh", "replace", address, "lladdr", canonicalMAC, "nud", "permanent", "dev", bridge}},
	}, nil
}

// pinGuestNeighbor is called immediately before every host-initiated guest
// connection. Bridge port isolation stops guest-to-guest frames, while this
// permanent L3-to-L2 binding closes the remaining host-neighbor ARP-poisoning
// path. Any missing isolation primitive makes the connection fail closed.
func pinGuestNeighbor(name, bridge, subnet, address, mac string) error {
	commands, err := guestNeighborCommands(name, bridge, subnet, address, mac)
	if err != nil {
		return err
	}
	if err := verifyTapBridgeIsolation(name, bridge); err != nil {
		return err
	}
	for _, command := range commands {
		if out, commandErr := exec.Command(command.name, command.args...).CombinedOutput(); commandErr != nil {
			return fmt.Errorf("pin guest network identity (%s %s): %v: %s", command.name, strings.Join(command.args, " "), commandErr, out)
		}
	}
	canonicalMAC, _ := validateTapIdentity(name, bridge, mac)
	fdb, err := exec.Command("bridge", "fdb", "get", canonicalMAC, "dev", name, "master").CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify guest FDB binding: %v: %s", err, fdb)
	}
	if !fdbSelectsTap(fdb, name, bridge) {
		return fmt.Errorf("guest FDB does not select expected tap %s: %s", name, strings.TrimSpace(string(fdb)))
	}
	neighbor, err := exec.Command("ip", "neigh", "get", address, "dev", bridge).CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify guest neighbor binding: %v: %s", err, neighbor)
	}
	if !neighborPermanentlyBinds(neighbor, canonicalMAC) {
		return fmt.Errorf("guest neighbor is not permanently bound to %s: %s", canonicalMAC, strings.TrimSpace(string(neighbor)))
	}
	return nil
}

func fdbSelectsTap(output []byte, name, bridge string) bool {
	fdbFields := strings.Fields(strings.ToLower(string(output)))
	devFound, masterFound, staticFound := false, false, false
	for index, field := range fdbFields {
		if field == "dev" && index+1 < len(fdbFields) && fdbFields[index+1] == name {
			devFound = true
		}
		if field == "master" && index+1 < len(fdbFields) && fdbFields[index+1] == bridge {
			masterFound = true
		}
		if field == "static" {
			staticFound = true
		}
	}
	return devFound && masterFound && staticFound
}

func neighborPermanentlyBinds(output []byte, canonicalMAC string) bool {
	fields := strings.Fields(strings.ToLower(string(output)))
	macFound, permanentFound := false, false
	for index, field := range fields {
		if field == "lladdr" && index+1 < len(fields) && fields[index+1] == canonicalMAC {
			macFound = true
		}
		if field == "permanent" {
			permanentFound = true
		}
	}
	return macFound && permanentFound
}

func removePinnedGuestNeighbor(bridge, subnet, address, mac string) {
	if address == "" {
		return
	}
	// Reuse the strict validator and include the expected MAC in the delete so
	// teardown cannot remove a newer machine's replacement binding.
	commands, err := guestNeighborCommands("bt00000000", bridge, subnet, address, mac)
	if err != nil {
		return
	}
	canonicalMAC := commands[0].args[2]
	_ = exec.Command("ip", "neigh", "del", address, "lladdr", canonicalMAC, "dev", bridge).Run()
}

// createTap makes a tap and attaches it to the bridge (the normal cold-boot path).
func createTap(name string, uid int, bridge, mac string, denyEgress bool) error {
	if err := makeTap(name, uid); err != nil {
		return err
	}
	if err := attachTapBridge(name, bridge, mac, denyEgress); err != nil {
		exec.Command("ip", "link", "del", name).Run()
		return err
	}
	return nil
}

func tapEgressRuleArgs(name string, insert bool) ([]string, error) {
	if !networkInterfacePattern.MatchString(name) {
		return nil, fmt.Errorf("unsafe tap interface name %q", name)
	}
	action := "-D"
	if insert {
		action = "-I"
	}
	args := []string{action, "NEHEMIAH_FWD"}
	if insert {
		args = append(args, "1")
	}
	return append(args, "-i", name, "-j", "DROP"), nil
}

// denyTapEgress gives a managed guest a NIC for host-initiated preview/file
// traffic while keeping guest-initiated forwarding off by default. DHCP and DNS
// terminate on the host's INPUT chain and remain available; no public or private
// destination is forwarded until an explicit per-machine policy is installed.
func denyTapEgress(name string) error {
	return denyTapEgressWithRunner(name, nil)
}

func denyTapEgressWithRunner(name string, run egressCommandRunner) error {
	if !networkInterfacePattern.MatchString(name) {
		return fmt.Errorf("unsafe tap interface name %q", name)
	}
	if run == nil {
		run = func(command string, args ...string) ([]byte, error) {
			return exec.Command(command, args...).CombinedOutput()
		}
	}
	check := []string{"-C", "NEHEMIAH_FWD", "-i", name, "-j", "DROP"}
	if _, err := run("iptables", check...); err == nil {
		return nil
	}
	args, err := tapEgressRuleArgs(name, true)
	if err != nil {
		return err
	}
	if out, err := run("iptables", args...); err != nil {
		return fmt.Errorf("install fail-closed egress rule: %v: %s", err, out)
	}
	return nil
}

func removeTapEgressRule(name string) {
	args, err := tapEgressRuleArgs(name, false)
	if err != nil {
		return
	}
	// Delete any duplicates left by a recovered/retried setup.
	for exec.Command("iptables", args...).Run() == nil {
	}
}

// teardownTap removes a tap device (best-effort).
func teardownTap(name string) {
	if name != "" {
		// Stop the port before dismantling its chain. Cleanup is idempotent and
		// also handles artifacts left by a daemon which died mid-policy update.
		_ = exec.Command("ip", "link", "set", name, "down").Run()
		removeTapEgressPolicy(name, nil)
		removeTapEgressRule(name)
		exec.Command("ip", "link", "del", name).Run()
	}
}

// cleanupOrphanGuestNetwork removes tap/FDB state and permanent guest neighbors
// which do not belong to the inventory accepted by startup reconciliation.
func cleanupOrphanGuestNetwork(cfg Config, keep map[string]struct{}) int {
	if !cfg.NetEnable {
		return 0
	}
	keepTaps := make(map[string]struct{}, len(keep))
	keepMACs := make(map[string]struct{}, len(keep))
	for id := range keep {
		if !validMachineID(id) {
			continue
		}
		keepTaps[tapName(id)] = struct{}{}
		keepMACs[guestMAC(id)] = struct{}{}
	}

	removed := 0
	if entries, err := os.ReadDir("/sys/class/net"); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if !managedTapPattern.MatchString(name) {
				continue
			}
			if _, ok := keepTaps[name]; ok {
				continue
			}
			teardownTap(name)
			removed++
		}
	}

	prefix, prefixErr := netip.ParsePrefix(cfg.NetSubnet + ".0/24")
	neighbors, neighborsErr := exec.Command("ip", "neigh", "show", "dev", cfg.NetBridge, "nud", "permanent").Output()
	if prefixErr != nil || neighborsErr != nil {
		return removed
	}
	for _, line := range strings.Split(string(neighbors), "\n") {
		fields := strings.Fields(strings.ToLower(line))
		if len(fields) < 4 {
			continue
		}
		address, err := netip.ParseAddr(fields[0])
		if err != nil || !prefix.Contains(address) {
			continue
		}
		mac := ""
		for index, field := range fields {
			if field == "lladdr" && index+1 < len(fields) {
				mac = fields[index+1]
				break
			}
		}
		if !strings.HasPrefix(mac, "06:00:") {
			continue
		}
		if _, ok := keepMACs[mac]; ok {
			continue
		}
		if exec.Command("ip", "neigh", "del", address.String(), "lladdr", mac, "dev", cfg.NetBridge).Run() == nil {
			removed++
		}
	}
	return removed
}

// cleanupOrphanGuestNetworkStrict is the managed-startup variant. Every
// orphan tap removal is verified by isolateManagedTap, every command error is
// authoritative, and a final inventory proves no stale managed neighbor was
// left behind before the host can become schedulable.
func cleanupOrphanGuestNetworkStrict(cfg Config, keep map[string]struct{}) (int, error) {
	if !cfg.NetEnable {
		return 0, nil
	}
	keepTaps := make(map[string]struct{}, len(keep))
	keepMACs := make(map[string]struct{}, len(keep))
	for id := range keep {
		if !validMachineID(id) {
			return 0, errors.New("managed network keep inventory contains an unsafe machine id")
		}
		keepTaps[tapName(id)] = struct{}{}
		keepMACs[guestMAC(id)] = struct{}{}
	}
	taps, err := managedTapInterfaces()
	if err != nil {
		return 0, fmt.Errorf("list managed orphan taps: %w", err)
	}
	removed := 0
	for _, tap := range taps {
		if _, retained := keepTaps[tap]; retained {
			continue
		}
		if err := isolateManagedTap(tap); err != nil {
			return removed, fmt.Errorf("isolate managed orphan tap %s: %w", tap, err)
		}
		removed++
	}
	remainingTaps, err := managedTapInterfaces()
	if err != nil {
		return removed, fmt.Errorf("verify managed orphan taps: %w", err)
	}
	for _, tap := range remainingTaps {
		if _, retained := keepTaps[tap]; !retained {
			return removed, fmt.Errorf("managed orphan tap %s remains", tap)
		}
	}

	orphans, err := managedOrphanPermanentNeighbors(cfg, keepMACs)
	if err != nil {
		return removed, err
	}
	for _, neighbor := range orphans {
		if output, err := exec.Command("ip", "neigh", "del", neighbor.address, "lladdr", neighbor.mac, "dev", cfg.NetBridge).CombinedOutput(); err != nil {
			return removed, fmt.Errorf("delete managed orphan neighbor: %w: %s", err, output)
		}
		removed++
	}
	remainingNeighbors, err := managedOrphanPermanentNeighbors(cfg, keepMACs)
	if err != nil {
		return removed, err
	}
	if len(remainingNeighbors) != 0 {
		return removed, fmt.Errorf("%d managed orphan neighbor(s) remain", len(remainingNeighbors))
	}
	return removed, nil
}

type managedOrphanNeighbor struct {
	address string
	mac     string
}

func managedOrphanPermanentNeighbors(cfg Config, keepMACs map[string]struct{}) ([]managedOrphanNeighbor, error) {
	prefix, err := netip.ParsePrefix(cfg.NetSubnet + ".0/24")
	if err != nil {
		return nil, fmt.Errorf("parse managed guest subnet: %w", err)
	}
	output, err := exec.Command("ip", "neigh", "show", "dev", cfg.NetBridge, "nud", "permanent").Output()
	if err != nil {
		return nil, fmt.Errorf("list managed permanent neighbors: %w", err)
	}
	orphans := make([]managedOrphanNeighbor, 0)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(strings.ToLower(line))
		if len(fields) == 0 {
			continue
		}
		address, parseErr := netip.ParseAddr(fields[0])
		if parseErr != nil || !prefix.Contains(address) {
			continue
		}
		mac := ""
		for index, field := range fields {
			if field == "lladdr" && index+1 < len(fields) {
				mac = fields[index+1]
				break
			}
		}
		if !strings.HasPrefix(mac, "06:00:") {
			continue
		}
		if _, retained := keepMACs[mac]; retained {
			continue
		}
		orphans = append(orphans, managedOrphanNeighbor{address: address.String(), mac: mac})
	}
	return orphans, nil
}

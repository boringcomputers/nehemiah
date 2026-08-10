package main

import (
	"context"
	"crypto/sha1"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	egressModeOff       = "off"
	egressModeAllowlist = "allowlist"
	egressMinTTL        = 5 * time.Second
	egressMaxTTL        = 5 * time.Minute
	maxEgressRules      = 64
	maxDuplicateRules   = 128
	managedEgressRate   = "64mbit"
	managedEgressBurst  = "1mb"
	managedTCPConnLimit = "128"
)

// networkPolicyDeclaration is the durable, control-plane supplied network
// intent. A NIC does not imply egress: the zero value is the off policy.
type networkPolicyDeclaration struct {
	Mode      string   `json:"mode"`
	Hostnames []string `json:"hostnames,omitempty"`
	CIDRs     []string `json:"cidrs,omitempty"`
}

type managedEgressPolicy struct {
	declaration networkPolicyDeclaration
	hostnames   []string
	cidrs       []netip.Prefix
}

var immutableEgressDenyCIDRs = []string{
	"0.0.0.0/8",      // this network / unspecified
	"10.0.0.0/8",     // RFC1918
	"100.64.0.0/10",  // carrier-grade NAT
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local and cloud metadata
	"172.16.0.0/12",  // RFC1918
	"192.0.0.0/24",   // IETF protocol assignments
	"192.168.0.0/16", // RFC1918
	"198.18.0.0/15",  // benchmarking / provider-internal use
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reserved and broadcast
	"::/128",         // unspecified
	"::1/128",        // loopback
	"fc00::/7",       // unique-local
	"fe80::/10",      // link-local
	"ff00::/8",       // multicast
}

func normalizeNetworkPolicy(input networkPolicyDeclaration) (managedEgressPolicy, error) {
	mode := strings.ToLower(strings.TrimSpace(input.Mode))
	if mode == "" {
		mode = egressModeOff
	}
	if mode != egressModeOff && mode != egressModeAllowlist {
		return managedEgressPolicy{}, fmt.Errorf("network mode must be %q or %q", egressModeOff, egressModeAllowlist)
	}
	if len(input.Hostnames) > maxEgressRules || len(input.CIDRs) > maxEgressRules {
		return managedEgressPolicy{}, fmt.Errorf("network allowlist is limited to %d hostnames and CIDRs", maxEgressRules)
	}
	hostnameSet := make(map[string]struct{}, len(input.Hostnames))
	for _, raw := range input.Hostnames {
		hostname, err := normalizeHostnameRule(raw)
		if err != nil {
			return managedEgressPolicy{}, err
		}
		hostnameSet[hostname] = struct{}{}
	}
	prefixSet := make(map[netip.Prefix]struct{}, len(input.CIDRs))
	for _, raw := range input.CIDRs {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || prefix.Addr().Zone() != "" {
			return managedEgressPolicy{}, fmt.Errorf("invalid network allowlist CIDR %q", raw)
		}
		prefix = prefix.Masked()
		// The managed bridge is deliberately IPv4-only. IPv6 has a stricter
		// host-wide DROP and cannot be selectively enabled until routing, DHCPv6
		// and an equivalent per-tap firewall are deployed together.
		if !prefix.Addr().Is4() {
			return managedEgressPolicy{}, fmt.Errorf("IPv6 egress CIDR %q is unsupported while managed IPv6 is disabled", raw)
		}
		prefixSet[prefix] = struct{}{}
	}
	hostnames := make([]string, 0, len(hostnameSet))
	for hostname := range hostnameSet {
		hostnames = append(hostnames, hostname)
	}
	sort.Strings(hostnames)
	cidrs := make([]netip.Prefix, 0, len(prefixSet))
	for prefix := range prefixSet {
		cidrs = append(cidrs, prefix)
	}
	sort.Slice(cidrs, func(i, j int) bool { return cidrs[i].String() < cidrs[j].String() })
	if mode == egressModeOff && (len(hostnames) != 0 || len(cidrs) != 0) {
		return managedEgressPolicy{}, errors.New("network allowlists require mode=allowlist")
	}
	if mode == egressModeAllowlist && len(hostnames) == 0 && len(cidrs) == 0 {
		return managedEgressPolicy{}, errors.New("allowlist mode requires at least one hostname or CIDR")
	}
	canonicalCIDRs := make([]string, 0, len(cidrs))
	for _, prefix := range cidrs {
		canonicalCIDRs = append(canonicalCIDRs, prefix.String())
	}
	declaration := networkPolicyDeclaration{Mode: mode, Hostnames: hostnames, CIDRs: canonicalCIDRs}
	return managedEgressPolicy{declaration: declaration, hostnames: hostnames, cidrs: cidrs}, nil
}

func normalizeHostnameRule(raw string) (string, error) {
	hostname := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasSuffix(hostname, ".") {
		hostname = strings.TrimSuffix(hostname, ".")
	}
	wildcard := strings.HasPrefix(hostname, "*.")
	plain := hostname
	if wildcard {
		plain = strings.TrimPrefix(hostname, "*.")
	}
	if len(plain) == 0 || len(plain) > 253 || net.ParseIP(plain) != nil || strings.Count(plain, ".") < 1 {
		return "", fmt.Errorf("invalid network hostname rule %q", raw)
	}
	labels := strings.Split(plain, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("invalid network hostname rule %q", raw)
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return "", fmt.Errorf("invalid network hostname rule %q", raw)
			}
		}
	}
	last := labels[len(labels)-1]
	if len(last) < 2 {
		return "", fmt.Errorf("invalid network hostname rule %q", raw)
	}
	for _, character := range last {
		if character < 'a' || character > 'z' {
			return "", fmt.Errorf("invalid network hostname rule %q", raw)
		}
	}
	return hostname, nil
}

func normalizeDNSName(raw string) (string, error) {
	name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
	if strings.HasPrefix(name, "*.") {
		return "", errors.New("DNS question cannot be a wildcard")
	}
	// Reuse the strict hostname grammar without allowing an actual wildcard.
	if _, err := normalizeHostnameRule(name); err != nil {
		return "", err
	}
	return name, nil
}

func (policy managedEgressPolicy) allowsHostname(hostname string) bool {
	if policy.declaration.Mode != egressModeAllowlist {
		return false
	}
	normalized, err := normalizeDNSName(hostname)
	if err != nil {
		return false
	}
	for _, rule := range policy.hostnames {
		if strings.HasPrefix(rule, "*.") {
			suffix := strings.TrimPrefix(rule, "*")
			if strings.HasSuffix(normalized, suffix) && normalized != strings.TrimPrefix(rule, "*.") {
				return true
			}
			continue
		}
		if normalized == rule {
			return true
		}
	}
	return false
}

func (policy managedEgressPolicy) allowsCIDRAddress(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range policy.cidrs {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

type learnedEgressAddress struct {
	hostname  string
	expiresAt time.Time
}

type installedEgressPolicy struct {
	machineID string
	tap       string
	address   netip.Addr
	policy    managedEgressPolicy
}

type egressCommandRunner func(name string, args ...string) ([]byte, error)

type egressController struct {
	cfg Config

	refreshMu sync.Mutex
	mu        sync.Mutex
	installed map[string]installedEgressPolicy
	learned   map[string]map[netip.Addr]learnedEgressAddress
	hardDeny  []netip.Prefix

	run     egressCommandRunner
	now     func() time.Time
	resolve func(context.Context, string) ([]netip.Addr, error)
}

func newEgressController(cfg Config) *egressController {
	controller := &egressController{
		cfg:       cfg,
		installed: make(map[string]installedEgressPolicy),
		learned:   make(map[string]map[netip.Addr]learnedEgressAddress),
		run: func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		},
		now: time.Now,
		resolve: func(ctx context.Context, hostname string) ([]netip.Addr, error) {
			addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", hostname)
			if err != nil {
				return nil, err
			}
			out := make([]netip.Addr, 0, len(addresses))
			for _, address := range addresses {
				out = append(out, address.Unmap())
			}
			return out, nil
		},
	}
	controller.hardDeny = configuredHardDenyPrefixes(cfg)
	return controller
}

func configuredHardDenyPrefixes(cfg Config) []netip.Prefix {
	values := append([]string(nil), immutableEgressDenyCIDRs...)
	values = append(values, cfg.EgressDenyCIDRs...)
	prefixes := make([]netip.Prefix, 0, len(values)+8)
	seen := make(map[netip.Prefix]struct{}, len(values)+8)
	add := func(prefix netip.Prefix) {
		prefix, ok := canonicalEgressPrefix(prefix)
		if !ok {
			return
		}
		if _, exists := seen[prefix]; exists {
			return
		}
		seen[prefix] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	for _, value := range values {
		if prefix, err := netip.ParsePrefix(value); err == nil {
			add(prefix)
		}
	}
	// Every host-connected subnet is part of the floor, including a public
	// provider or peer-tenant L2 range. A customer CIDR can never override it.
	if addresses, err := net.InterfaceAddrs(); err == nil {
		for _, raw := range addresses {
			if prefix, err := netip.ParsePrefix(raw.String()); err == nil {
				add(prefix)
			}
		}
	}
	sort.Slice(prefixes, func(i, j int) bool { return prefixes[i].String() < prefixes[j].String() })
	return prefixes
}

func (controller *egressController) isHardDenied(address netip.Addr) bool {
	address = address.Unmap()
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return addressDeniedByPrefixes(address, controller.hardDeny)
}

func canonicalEgressPrefix(prefix netip.Prefix) (netip.Prefix, bool) {
	if !prefix.IsValid() || prefix.Addr().Zone() != "" {
		return netip.Prefix{}, false
	}
	if prefix.Addr().Is4In6() {
		if prefix.Bits() < 96 {
			return netip.Prefix{}, false
		}
		prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
	}
	return prefix.Masked(), true
}

func addressDeniedByPrefixes(address netip.Addr, prefixes []netip.Prefix) bool {
	address = address.Unmap()
	for _, prefix := range prefixes {
		candidate := prefix.Addr().Unmap()
		if candidate.BitLen() != address.BitLen() {
			continue
		}
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (controller *egressController) refreshHardFloor(ctx context.Context) error {
	controller.refreshMu.Lock()
	defer controller.refreshMu.Unlock()
	succeeded := false
	defer func() {
		if !succeeded {
			if err := controller.failClosedAll(); err != nil {
				logManagedHostEvent(managedHostEventEgressFailClosedFailed, managedHostLogFields{Err: err})
			}
		}
	}()

	prefixes := configuredHardDenyPrefixes(controller.cfg)
	controlHostname := ""
	if parsed, err := url.Parse(controller.cfg.ControlPlaneURL); err == nil {
		controlHostname = parsed.Hostname()
	}
	if controlHostname != "" {
		if parsed, err := netip.ParseAddr(controlHostname); err == nil {
			if parsed.Zone() != "" {
				return errors.New("control-plane address cannot contain an IPv6 zone")
			}
			parsed = parsed.Unmap()
			prefixes = append(prefixes, netip.PrefixFrom(parsed, parsed.BitLen()))
		} else {
			addresses, resolveErr := controller.resolve(ctx, controlHostname)
			if resolveErr != nil {
				return fmt.Errorf("resolve control-plane hostname for immutable egress floor: %w", resolveErr)
			}
			if len(addresses) == 0 {
				return errors.New("control-plane hostname resolved without an address")
			}
			for _, address := range addresses {
				if !address.IsValid() || address.Zone() != "" {
					return fmt.Errorf("control-plane hostname returned invalid address %q", address)
				}
				address = address.Unmap()
				prefixes = append(prefixes, netip.PrefixFrom(address, address.BitLen()))
			}
		}
	}
	seen := make(map[netip.Prefix]struct{}, len(prefixes))
	canonical := make([]netip.Prefix, 0, len(prefixes))
	for _, prefix := range prefixes {
		prefix = prefix.Masked()
		if _, exists := seen[prefix]; exists {
			continue
		}
		seen[prefix] = struct{}{}
		canonical = append(canonical, prefix)
	}
	if err := controller.ensureHardFloorSets(canonical); err != nil {
		return err
	}
	controller.mu.Lock()
	controller.hardDeny = canonical
	controller.mu.Unlock()
	succeeded = true
	return nil
}

func (controller *egressController) failClosedAll() error {
	controller.mu.Lock()
	taps := make([]string, 0, len(controller.installed))
	for _, installed := range controller.installed {
		taps = append(taps, installed.tap)
	}
	controller.mu.Unlock()
	var failures []error
	for _, tap := range taps {
		if err := controller.failClosedTap(tap); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (controller *egressController) failClosedTap(tap string) error {
	if err := denyTapEgressWithRunner(tap, controller.run); err == nil {
		return nil
	} else if output, downErr := controller.run("ip", "link", "set", tap, "down"); downErr != nil {
		return fmt.Errorf("tap %s: install DROP: %v; force link down: %v: %s", tap, err, downErr, output)
	}
	return nil
}

const (
	hardFloorSet4 = "neh_hard4"
	hardFloorSet6 = "neh_hard6"
)

func (controller *egressController) ensureHardFloorSets(prefixes []netip.Prefix) error {
	const next4 = "neh_h4_next"
	const next6 = "neh_h6_next"
	for _, command := range []networkCommand{
		{name: "ipset", args: []string{"create", hardFloorSet4, "hash:net", "family", "inet", "maxelem", "4096", "-exist"}},
		{name: "ipset", args: []string{"create", hardFloorSet6, "hash:net", "family", "inet6", "maxelem", "4096", "-exist"}},
		{name: "ipset", args: []string{"create", next4, "hash:net", "family", "inet", "maxelem", "4096", "-exist"}},
		{name: "ipset", args: []string{"flush", next4}},
		{name: "ipset", args: []string{"create", next6, "hash:net", "family", "inet6", "maxelem", "4096", "-exist"}},
		{name: "ipset", args: []string{"flush", next6}},
	} {
		if output, err := controller.run(command.name, command.args...); err != nil {
			return fmt.Errorf("initialize immutable egress floor (%s): %v: %s", strings.Join(command.args, " "), err, output)
		}
	}
	for _, prefix := range prefixes {
		set := next6
		if prefix.Addr().Is4() {
			set = next4
		}
		args := []string{"add", set, prefix.String(), "-exist"}
		if output, err := controller.run("ipset", args...); err != nil {
			return fmt.Errorf("extend immutable egress floor (%s): %v: %s", strings.Join(args, " "), err, output)
		}
	}
	// Swap populated staging sets into the names referenced by iptables. The
	// old floor remains active throughout preparation; a failed refresh cannot
	// expose a destination. Stale dynamic control/host entries are removed when
	// the old set is destroyed after the atomic per-family swap.
	for _, pair := range [][2]string{{next4, hardFloorSet4}, {next6, hardFloorSet6}} {
		if output, err := controller.run("ipset", "swap", pair[0], pair[1]); err != nil {
			return fmt.Errorf("activate immutable egress floor (%s): %v: %s", strings.Join(pair[:], " "), err, output)
		}
		_, _ = controller.run("ipset", "destroy", pair[0])
	}
	return nil
}

type tapEgressNames struct {
	chain   string
	input   string
	cidrs   string
	learned string
}

func egressNamesForTap(tap string) (tapEgressNames, error) {
	if !managedTapPattern.MatchString(tap) {
		return tapEgressNames{}, fmt.Errorf("unsafe managed tap name %q", tap)
	}
	digest := sha1.Sum([]byte(tap))
	suffix := fmt.Sprintf("%x", digest[:4])
	return tapEgressNames{chain: "NEH_" + suffix, input: "NEI_" + suffix, cidrs: "neh_c_" + suffix, learned: "neh_d_" + suffix}, nil
}

func validateManagedGuestAddress(subnet, raw string) (netip.Addr, error) {
	prefix, err := netip.ParsePrefix(subnet + ".0/24")
	if err != nil || !prefix.Addr().Is4() {
		return netip.Addr{}, fmt.Errorf("unsafe managed guest subnet %q", subnet)
	}
	address, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return netip.Addr{}, fmt.Errorf("managed guest has no assigned IPv4 address")
	}
	address = address.Unmap()
	if !address.Is4() || !prefix.Contains(address) || address == prefix.Addr() || address == netip.MustParseAddr(subnet+".1") || address == netip.MustParseAddr(subnet+".255") {
		return netip.Addr{}, fmt.Errorf("guest IP %q is outside the usable managed subnet", raw)
	}
	return address, nil
}

// prepareTapInputIdentity binds host-directed traffic to the exact DHCP/static
// identity assigned to this bridge port. The DHCP bootstrap exception is kept
// narrow enough for a guest to renew/reacquire its existing lease; every other
// spoofed source is dropped before it reaches DNS or another host service.
func (controller *egressController) prepareTapInputIdentity(tap string, guestAddress netip.Addr) error {
	names, err := egressNamesForTap(tap)
	if err != nil {
		return err
	}
	removeTapInputIdentity(tap, controller.run)
	_, _ = controller.run("iptables", "-N", names.input)
	if output, flushErr := controller.run("iptables", "-F", names.input); flushErr != nil {
		return fmt.Errorf("flush tap input identity chain: %v: %s", flushErr, output)
	}
	rules := [][]string{
		{"-A", names.input, "-s", "0.0.0.0/32", "-p", "udp", "--sport", "68", "--dport", "67", "-j", "RETURN"},
		{"-A", names.input, "-s", guestAddress.String() + "/32", "-j", "RETURN"},
		{"-A", names.input, "-j", "DROP"},
	}
	for _, args := range rules {
		if output, ruleErr := controller.run("iptables", args...); ruleErr != nil {
			removeTapInputIdentity(tap, controller.run)
			return fmt.Errorf("install tap input identity rule (%s): %v: %s", strings.Join(args, " "), ruleErr, output)
		}
	}
	hook := []string{"-m", "physdev", "--physdev-in", tap, "-j", names.input}
	if output, hookErr := controller.run("iptables", append([]string{"-I", "NEHEMIAH_INPUT", "1"}, hook...)...); hookErr != nil {
		removeTapInputIdentity(tap, controller.run)
		return fmt.Errorf("activate tap input identity: %v: %s", hookErr, output)
	}
	return nil
}

func (controller *egressController) apply(machineID, tap, address string, declaration networkPolicyDeclaration) error {
	policy, err := normalizeNetworkPolicy(declaration)
	if err != nil {
		return err
	}
	guestAddress, err := validateManagedGuestAddress(controller.cfg.NetSubnet, address)
	if err != nil {
		if denyErr := denyTapEgressWithRunner(tap, controller.run); denyErr != nil {
			return fmt.Errorf("invalid managed guest address: %v (fail closed: %w)", err, denyErr)
		}
		removeTapEgressPolicy(tap, controller.run)
		return err
	}
	if controller.cfg.NehemiahMode && len(policy.hostnames) != 0 {
		// DNS-to-IP learning cannot distinguish another SNI/HTTP Host or protocol
		// on the same public address. Never restore or activate that weaker policy
		// on a managed host.
		if denyErr := denyTapEgressWithRunner(tap, controller.run); denyErr != nil {
			return fmt.Errorf("reject hostname egress policy: %w", denyErr)
		}
		removeTapEgressPolicy(tap, controller.run)
		return errors.New("hostname egress rules require connection-aware enforcement")
	}
	if policy.declaration.Mode == egressModeOff {
		if err := denyTapEgressWithRunner(tap, controller.run); err != nil {
			return err
		}
		removeTapEgressPolicy(tap, controller.run)
		if err := controller.prepareTapInputIdentity(tap, guestAddress); err != nil {
			removeTapInputIdentity(tap, controller.run)
			return err
		}
		controller.mu.Lock()
		controller.installed[machineID] = installedEgressPolicy{machineID: machineID, tap: tap, address: guestAddress, policy: policy}
		delete(controller.learned, machineID)
		controller.mu.Unlock()
		return nil
	}
	// Reassert the direct tap DROP before resolving or changing any shared
	// floor/set state. This also safely replaces a previously active policy.
	if err := denyTapEgressWithRunner(tap, controller.run); err != nil {
		return err
	}
	refreshCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := controller.refreshHardFloor(refreshCtx); err != nil {
		_ = denyTapEgressWithRunner(tap, controller.run)
		return err
	}
	if err := controller.prepareTapInputIdentity(tap, guestAddress); err != nil {
		removeTapEgressPolicy(tap, controller.run)
		return err
	}
	if err := controller.prepareTapBandwidth(tap); err != nil {
		removeTapEgressPolicy(tap, controller.run)
		return err
	}
	if err := controller.prepareTapPolicy(tap, guestAddress, policy); err != nil {
		removeTapEgressPolicy(tap, controller.run)
		return err
	}
	names, _ := egressNamesForTap(tap)
	// The direct DROP is already active. Replace any stale jump, insert the new
	// policy ahead of the DROP, then remove the DROP. There is no allow-all gap.
	jump := []string{"-i", tap, "-j", names.chain}
	for attempts := 0; attempts < maxDuplicateRules; attempts++ {
		if _, err := controller.run("iptables", append([]string{"-D", "NEHEMIAH_FWD"}, jump...)...); err != nil {
			break
		}
	}
	if output, err := controller.run("iptables", append([]string{"-I", "NEHEMIAH_FWD", "1"}, jump...)...); err != nil {
		removeTapEgressPolicy(tap, controller.run)
		return fmt.Errorf("activate tap egress policy: %v: %s", err, output)
	}
	drop, _ := tapEgressRuleArgs(tap, false)
	removedDrop := false
	for attempts := 0; attempts < maxDuplicateRules; attempts++ {
		if _, err := controller.run("iptables", drop...); err != nil {
			if !removedDrop {
				removeTapEgressPolicy(tap, controller.run)
				return fmt.Errorf("remove fail-closed tap rule after policy activation: %w", err)
			}
			break
		}
		removedDrop = true
		if attempts == maxDuplicateRules-1 {
			removeTapEgressPolicy(tap, controller.run)
			return errors.New("too many duplicate fail-closed tap rules")
		}
	}
	controller.mu.Lock()
	controller.installed[machineID] = installedEgressPolicy{machineID: machineID, tap: tap, address: guestAddress, policy: policy}
	controller.learned[machineID] = make(map[netip.Addr]learnedEgressAddress)
	controller.mu.Unlock()
	return nil
}

func (controller *egressController) prepareTapBandwidth(tap string) error {
	if !managedTapPattern.MatchString(tap) {
		return fmt.Errorf("unsafe managed tap name %q", tap)
	}
	commands := []networkCommand{
		{name: "tc", args: []string{"qdisc", "replace", "dev", tap, "clsact"}},
		{name: "tc", args: []string{"filter", "replace", "dev", tap, "ingress", "protocol", "ip", "pref", "100", "flower", "action", "police", "rate", managedEgressRate, "burst", managedEgressBurst, "conform-exceed", "drop"}},
	}
	for _, command := range commands {
		if output, err := controller.run(command.name, command.args...); err != nil {
			return fmt.Errorf("install per-tap bandwidth limit (%s): %v: %s", strings.Join(command.args, " "), err, output)
		}
	}
	return nil
}

func (controller *egressController) prepareTapPolicy(tap string, guestAddress netip.Addr, policy managedEgressPolicy) error {
	names, err := egressNamesForTap(tap)
	if err != nil {
		return err
	}
	commands := []networkCommand{
		{name: "ipset", args: []string{"create", names.cidrs, "hash:net", "family", "inet", "maxelem", "256", "-exist"}},
		{name: "ipset", args: []string{"flush", names.cidrs}},
		{name: "ipset", args: []string{"create", names.learned, "hash:ip", "family", "inet", "timeout", strconv.Itoa(int(egressMaxTTL.Seconds())), "maxelem", "1024", "-exist"}},
		{name: "ipset", args: []string{"flush", names.learned}},
	}
	for _, prefix := range policy.cidrs {
		commands = append(commands, networkCommand{name: "ipset", args: []string{"add", names.cidrs, prefix.String(), "-exist"}})
	}
	for _, command := range commands {
		if output, commandErr := controller.run(command.name, command.args...); commandErr != nil {
			return fmt.Errorf("prepare tap egress set (%s): %v: %s", strings.Join(command.args, " "), commandErr, output)
		}
	}
	// Creating an existing chain fails; flushing proves either the old or newly
	// created chain is usable before the direct tap DROP is removed.
	_, _ = controller.run("iptables", "-N", names.chain)
	if output, err := controller.run("iptables", "-F", names.chain); err != nil {
		return fmt.Errorf("flush tap egress chain: %v: %s", err, output)
	}
	chainRules := [][]string{
		// A bridge port's locked MAC prevents MAC rotation, but it does not bind
		// L3 source identity. Reject every forwarded packet whose source is not
		// the address durably assigned to this exact tap before any rate or allow
		// rule. The per-tap chain also makes hash limits machine-scoped.
		{"-A", names.chain, "!", "-s", guestAddress.String() + "/32", "-j", "DROP"},
		{"-A", names.chain, "-m", "set", "--match-set", hardFloorSet4, "dst", "-j", "DROP"},
		// Guest DNS must terminate at the host interceptor. Direct UDP/TCP DNS
		// and DNS-over-TLS cannot bypass hostname answer validation.
		{"-A", names.chain, "-p", "udp", "-m", "multiport", "--dports", "53,853", "-j", "DROP"},
		{"-A", names.chain, "-p", "tcp", "-m", "multiport", "--dports", "53,853", "-j", "DROP"},
		{"-A", names.chain, "-p", "tcp", "--syn", "-m", "connlimit", "--connlimit-above", managedTCPConnLimit, "--connlimit-mask", "32", "-j", "DROP"},
		{"-A", names.chain, "-p", "tcp", "--syn", "-m", "hashlimit", "--hashlimit-above", "80/sec", "--hashlimit-burst", "120", "--hashlimit-name", "neh-t-" + names.chain[4:], "-j", "DROP"},
		{"-A", names.chain, "-p", "udp", "-m", "hashlimit", "--hashlimit-above", "200/sec", "--hashlimit-burst", "400", "--hashlimit-name", "neh-u-" + names.chain[4:], "-j", "DROP"},
		{"-A", names.chain, "-p", "icmp", "--icmp-type", "echo-request", "-m", "hashlimit", "--hashlimit-above", "20/sec", "--hashlimit-burst", "40", "--hashlimit-name", "neh-i-" + names.chain[4:], "-j", "DROP"},
		{"-A", names.chain, "-m", "set", "--match-set", names.cidrs, "dst", "-j", "ACCEPT"},
		{"-A", names.chain, "-m", "set", "--match-set", names.learned, "dst", "-j", "ACCEPT"},
		{"-A", names.chain, "-j", "DROP"},
	}
	for _, args := range chainRules {
		if output, err := controller.run("iptables", args...); err != nil {
			return fmt.Errorf("install tap egress chain (%s): %v: %s", strings.Join(args, " "), err, output)
		}
	}
	return nil
}

func clampEgressTTL(ttl time.Duration) time.Duration {
	if ttl < egressMinTTL {
		return egressMinTTL
	}
	if ttl > egressMaxTTL {
		return egressMaxTTL
	}
	return ttl.Truncate(time.Second)
}

type dnsLearnedAddress struct {
	address netip.Addr
	ttl     time.Duration
}

func (controller *egressController) learn(machineID, hostname string, answers []dnsLearnedAddress) error {
	controller.mu.Lock()
	installed, ok := controller.installed[machineID]
	controller.mu.Unlock()
	if !ok || !installed.policy.allowsHostname(hostname) || len(answers) == 0 {
		return errors.New("DNS hostname is not allowed for this machine")
	}
	validated := make([]dnsLearnedAddress, 0, len(answers))
	seen := make(map[netip.Addr]struct{}, len(answers))
	for _, answer := range answers {
		address := answer.address.Unmap()
		if !address.IsValid() || !address.Is4() || controller.isHardDenied(address) {
			return fmt.Errorf("DNS response contains a hard-denied or unsupported address %q", answer.address)
		}
		if _, duplicate := seen[address]; duplicate {
			continue
		}
		seen[address] = struct{}{}
		validated = append(validated, dnsLearnedAddress{address: address, ttl: clampEgressTTL(answer.ttl)})
	}
	// Mixed responses are validated in full above before the first kernel rule
	// is changed. Any command failure reinstalls the direct per-tap DROP.
	names, _ := egressNamesForTap(installed.tap)
	for _, answer := range validated {
		seconds := max(int(answer.ttl.Seconds()), 1)
		args := []string{"add", names.learned, answer.address.String(), "timeout", strconv.Itoa(seconds), "-exist"}
		if output, err := controller.run("ipset", args...); err != nil {
			closeErr := controller.failClosedTap(installed.tap)
			return fmt.Errorf("learn DNS egress address: %v: %s (fail closed: %v)", err, output, closeErr)
		}
	}
	now := controller.now().UTC()
	controller.mu.Lock()
	learned := controller.learned[machineID]
	if learned == nil {
		learned = make(map[netip.Addr]learnedEgressAddress)
		controller.learned[machineID] = learned
	}
	for _, answer := range validated {
		learned[answer.address] = learnedEgressAddress{hostname: hostname, expiresAt: now.Add(answer.ttl)}
	}
	controller.mu.Unlock()
	return nil
}

func (controller *egressController) allowsAddress(machineID string, address netip.Addr, now time.Time) bool {
	address = address.Unmap()
	if controller.isHardDenied(address) {
		return false
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	installed, ok := controller.installed[machineID]
	if !ok || installed.policy.declaration.Mode != egressModeAllowlist {
		return false
	}
	if installed.policy.allowsCIDRAddress(address) {
		return true
	}
	entry, ok := controller.learned[machineID][address]
	if !ok || !entry.expiresAt.After(now) {
		delete(controller.learned[machineID], address)
		return false
	}
	return true
}

func (controller *egressController) remove(machineID, tap string) {
	controller.mu.Lock()
	delete(controller.installed, machineID)
	delete(controller.learned, machineID)
	controller.mu.Unlock()
	removeTapEgressPolicy(tap, controller.run)
}

// allowedEgressBytes reads only ACCEPT counters from the machine's private
// enforcement chain. Dropped/spoofed traffic and host-input traffic are never
// included in the customer-egress high-water.
func (controller *egressController) allowedEgressBytes(machineID, tap string) (uint64, error) {
	controller.mu.Lock()
	installed, ok := controller.installed[machineID]
	controller.mu.Unlock()
	if ok && installed.policy.declaration.Mode == egressModeOff {
		return 0, nil
	}
	return allowedEgressBytesForTap(tap, controller.run)
}

func allowedEgressBytesForTap(tap string, run egressCommandRunner) (uint64, error) {
	if run == nil {
		run = func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		}
	}
	names, err := egressNamesForTap(tap)
	if err != nil {
		return 0, err
	}
	output, err := run("iptables", "-L", names.chain, "-n", "-v", "-x")
	if err != nil {
		return 0, fmt.Errorf("read allowed egress counter: %w", err)
	}
	var total uint64
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[2] != "ACCEPT" {
			continue
		}
		bytes, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			return 0, fmt.Errorf("parse allowed egress counter: %w", parseErr)
		}
		if ^uint64(0)-total < bytes {
			return 0, errors.New("allowed egress counter overflow")
		}
		total += bytes
	}
	return total, nil
}

func removeTapInputIdentity(tap string, run egressCommandRunner) {
	if run == nil {
		run = func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		}
	}
	names, err := egressNamesForTap(tap)
	if err != nil {
		return
	}
	hook := []string{"-D", "NEHEMIAH_INPUT", "-m", "physdev", "--physdev-in", tap, "-j", names.input}
	for attempts := 0; attempts < maxDuplicateRules; attempts++ {
		if _, err := run("iptables", hook...); err != nil {
			break
		}
	}
	_, _ = run("iptables", "-F", names.input)
	_, _ = run("iptables", "-X", names.input)
}

func removeTapEgressPolicy(tap string, run egressCommandRunner) {
	if run == nil {
		run = func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		}
	}
	names, err := egressNamesForTap(tap)
	if err != nil {
		return
	}
	removeTapInputIdentity(tap, run)
	// Install DROP first. Even if cleanup is interrupted, the tap cannot fall
	// through to the shared chain's public-internet ACCEPT.
	if err := denyTapEgressWithRunner(tap, run); err != nil {
		// Do not remove the restrictive policy jump unless the replacement DROP
		// is proven. Link-down is the independent fail-closed fallback.
		_, _ = run("ip", "link", "set", tap, "down")
		return
	}
	jump := []string{"-D", "NEHEMIAH_FWD", "-i", tap, "-j", names.chain}
	for attempts := 0; attempts < maxDuplicateRules; attempts++ {
		if _, err := run("iptables", jump...); err != nil {
			break
		}
	}
	_, _ = run("iptables", "-F", names.chain)
	_, _ = run("iptables", "-X", names.chain)
	_, _ = run("ipset", "destroy", names.cidrs)
	_, _ = run("ipset", "destroy", names.learned)
	_, _ = run("tc", "qdisc", "del", "dev", tap, "clsact")
}

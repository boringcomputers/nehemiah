package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"regexp"
	"strings"
)

var managedPolicyChainPattern = regexp.MustCompile(`^NE[HI]_[0-9a-f]{8}$`)

type managedNetworkRuntimeOps struct {
	run        func(string, ...string) ([]byte, error)
	listTaps   func() ([]string, error)
	isolateTap func(string) error
}

type managedTapRuntimeExpectation struct {
	address string
	mac     string
	policy  managedEgressPolicy
}

type managedNetworkInventory struct {
	active       map[string]managedTapRuntimeExpectation
	provisioning map[string]struct{}
	hardDeny     []netip.Prefix
}

func defaultManagedNetworkRuntimeOps() managedNetworkRuntimeOps {
	return managedNetworkRuntimeOps{
		run: func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		},
		listTaps:   managedTapInterfaces,
		isolateTap: isolateManagedTap,
	}
}

func (ops managedNetworkRuntimeOps) valid() bool {
	return ops.run != nil && ops.listTaps != nil && ops.isolateTap != nil
}

func validateManagedNetworkRuntime(cfg Config, ops managedNetworkRuntimeOps, expectedInventories ...managedNetworkInventory) error {
	if !cfg.NehemiahMode || !cfg.NetEnable {
		return nil
	}
	if !ops.valid() {
		return errors.New("managed network runtime operations are incomplete")
	}
	run := func(name string, args ...string) (string, error) {
		output, err := ops.run(name, args...)
		if err != nil {
			return "", fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
		}
		return strings.TrimSpace(string(output)), nil
	}
	for _, setting := range []string{
		"net.ipv4.ip_forward",
		"net.bridge.bridge-nf-call-iptables",
		"net.ipv6.conf." + cfg.NetBridge + ".disable_ipv6",
	} {
		value, err := run("sysctl", "-n", setting)
		if err != nil {
			return err
		}
		if value != "1" {
			return fmt.Errorf("managed network sysctl %s is %q, want 1", setting, value)
		}
	}
	input, err := run("iptables", "-S", "INPUT")
	if err != nil {
		return err
	}
	if err := validateUniqueFirstHook(input, "INPUT", []string{"-i", cfg.NetBridge, "-j", "NEHEMIAH_INPUT"}); err != nil {
		return fmt.Errorf("managed INPUT hook: %w", err)
	}
	forward, err := run("iptables", "-S", "FORWARD")
	if err != nil {
		return err
	}
	if err := validateUniqueFirstHook(forward, "FORWARD", []string{"-j", "NEHEMIAH_FWD"}); err != nil {
		return fmt.Errorf("managed FORWARD hook: %w", err)
	}
	inputChain, err := run("iptables", "-S", "NEHEMIAH_INPUT")
	if err != nil {
		return err
	}
	if err := validateManagedInputChain(inputChain); err != nil {
		return err
	}
	forwardChain, err := run("iptables", "-S", "NEHEMIAH_FWD")
	if err != nil {
		return err
	}
	if err := validateManagedForwardChain(forwardChain, cfg.NetSubnet+".0/24"); err != nil {
		return err
	}
	inputBindings, err := managedInputBindings(inputChain)
	if err != nil {
		return err
	}
	forwardBindings, err := managedForwardBindings(forwardChain)
	if err != nil {
		return err
	}
	if err := validateUniqueManagedPolicyTargets(inputBindings, forwardBindings); err != nil {
		return err
	}
	liveTaps, err := ops.listTaps()
	if err != nil {
		return fmt.Errorf("list managed taps for policy validation: %w", err)
	}
	live := make(map[string]struct{}, len(liveTaps))
	for _, tap := range liveTaps {
		if !managedTapPattern.MatchString(tap) {
			return errors.New("managed tap inventory contains an unsafe identifier")
		}
		if _, duplicate := live[tap]; duplicate {
			return fmt.Errorf("managed tap inventory contains duplicate %s", tap)
		}
		live[tap] = struct{}{}
	}
	var expected *managedNetworkInventory
	if len(expectedInventories) > 1 {
		return errors.New("managed network runtime received ambiguous inventories")
	}
	if len(expectedInventories) == 1 {
		expected = &expectedInventories[0]
		if err := validateManagedTapInventory(live, inputBindings, forwardBindings, *expected); err != nil {
			return err
		}
	} else {
		if len(inputBindings) != len(live) || len(forwardBindings) != len(live) {
			return fmt.Errorf("managed tap policy inventory is not one-to-one: taps=%d input=%d forward=%d", len(live), len(inputBindings), len(forwardBindings))
		}
		for tap := range live {
			if inputBindings[tap] == "" || forwardBindings[tap] == "" {
				return fmt.Errorf("managed tap %s has no exact INPUT/FORWARD binding", tap)
			}
		}
	}
	allPolicies, err := run("iptables", "-S")
	if err != nil {
		return err
	}
	definitions, err := managedPolicyChainDefinitions(allPolicies)
	if err != nil {
		return err
	}
	referenced := make(map[string]struct{}, len(inputBindings)+len(forwardBindings))
	validatedTaps := live
	if expected != nil {
		validatedTaps = make(map[string]struct{}, len(expected.active))
		for tap := range expected.active {
			validatedTaps[tap] = struct{}{}
		}
		// A tap may be between creation and its final policy hook. Only the two
		// deterministic chain names for that durably reserved machine are ignored;
		// every unrelated managed chain remains an orphan and fails closed.
		for tap := range expected.provisioning {
			names, namesErr := egressNamesForTap(tap)
			if namesErr != nil {
				return namesErr
			}
			delete(definitions, names.input)
			delete(definitions, names.chain)
		}
	}
	validatedHardFloor := false
	for tap := range validatedTaps {
		inputTarget := inputBindings[tap]
		referenced[inputTarget] = struct{}{}
		inputPolicy, inputErr := run("iptables", "-S", inputTarget)
		if inputErr != nil {
			return inputErr
		}
		inputAddress, inputErr := validateManagedTapInputPolicy(inputPolicy, inputTarget, cfg.NetSubnet)
		if inputErr != nil {
			return fmt.Errorf("managed tap %s INPUT policy: %w", tap, inputErr)
		}
		forwardTarget := forwardBindings[tap]
		if expected != nil {
			want := expected.active[tap]
			if inputAddress != want.address+"/32" {
				return fmt.Errorf("managed tap %s INPUT source %s does not match durable address %s", tap, inputAddress, want.address)
			}
			if want.policy.declaration.Mode == egressModeOff {
				if forwardTarget != "DROP" {
					return fmt.Errorf("managed tap %s has egress despite a durable off policy", tap)
				}
			} else {
				names, namesErr := egressNamesForTap(tap)
				if namesErr != nil || forwardTarget != names.chain {
					return fmt.Errorf("managed tap %s is not bound to its durable allowlist chain", tap)
				}
			}
		}
		if forwardTarget == "DROP" {
			continue
		}
		referenced[forwardTarget] = struct{}{}
		forwardPolicy, forwardErr := run("iptables", "-S", forwardTarget)
		if forwardErr != nil {
			return forwardErr
		}
		forwardAddress, forwardErr := validateManagedTapForwardPolicy(forwardPolicy, tap, forwardTarget, cfg.NetSubnet)
		if forwardErr != nil {
			return fmt.Errorf("managed tap %s FORWARD policy: %w", tap, forwardErr)
		}
		if inputAddress != forwardAddress {
			return fmt.Errorf("managed tap %s INPUT/FORWARD source identities differ", tap)
		}
		if expected != nil {
			want := expected.active[tap]
			names, _ := egressNamesForTap(tap)
			if !validatedHardFloor {
				hardFloor, hardFloorErr := run("ipset", "save", hardFloorSet4)
				if hardFloorErr != nil {
					return hardFloorErr
				}
				if err := validateManagedIPSet(hardFloor, hardFloorSet4, "hash:net", ipv4PrefixStrings(expected.hardDeny)); err != nil {
					return fmt.Errorf("managed immutable egress floor: %w", err)
				}
				validatedHardFloor = true
			}
			cidrSet, cidrErr := run("ipset", "save", names.cidrs)
			if cidrErr != nil {
				return cidrErr
			}
			if err := validateManagedIPSet(cidrSet, names.cidrs, "hash:net", prefixStrings(want.policy.cidrs)); err != nil {
				return fmt.Errorf("managed tap %s CIDR policy set: %w", tap, err)
			}
			learnedSet, learnedErr := run("ipset", "save", names.learned)
			if learnedErr != nil {
				return learnedErr
			}
			if err := validateManagedIPSet(learnedSet, names.learned, "hash:ip", nil); err != nil {
				return fmt.Errorf("managed tap %s learned-address set: %w", tap, err)
			}
		}
	}
	if len(definitions) != len(referenced) {
		return fmt.Errorf("managed policy chain inventory has %d definition(s), want %d", len(definitions), len(referenced))
	}
	for chain := range referenced {
		if definitions[chain] != 1 {
			return fmt.Errorf("managed policy chain %s definition count is %d, want 1", chain, definitions[chain])
		}
	}
	if expected != nil {
		if err := validateManagedL2Inventory(run, cfg, expected.active); err != nil {
			return err
		}
	}
	ipv6Forward, err := run("ip6tables", "-S", "FORWARD")
	if err != nil {
		return err
	}
	if err := validateUniqueFirstHook(ipv6Forward, "FORWARD", []string{"-i", cfg.NetBridge, "-j", "DROP"}); err != nil {
		return fmt.Errorf("managed IPv6 bridge DROP: %w", err)
	}
	return nil
}

func prefixStrings(prefixes []netip.Prefix) []string {
	values := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		values = append(values, prefix.Masked().String())
	}
	return values
}

func ipv4PrefixStrings(prefixes []netip.Prefix) []string {
	values := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		if prefix.Addr().Unmap().Is4() {
			values = append(values, prefix.Masked().String())
		}
	}
	return values
}

func validateManagedIPSet(output, name, setType string, expectedMembers []string) error {
	if name == "" || strings.ContainsAny(name, " \t\r\n") {
		return errors.New("unsafe managed ipset name")
	}
	created := 0
	observed := make(map[string]struct{})
	for _, raw := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(raw)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "create":
			if len(fields) < 5 || fields[1] != name || fields[2] != setType || fields[3] != "family" || fields[4] != "inet" {
				return errors.New("ipset has an unexpected type, family, or name")
			}
			created++
		case "add":
			if len(fields) != 3 || fields[1] != name {
				return errors.New("ipset has a non-canonical member")
			}
			if _, duplicate := observed[fields[2]]; duplicate {
				return errors.New("ipset has a duplicate member")
			}
			observed[fields[2]] = struct{}{}
		default:
			return errors.New("ipset save output contains an unexpected command")
		}
	}
	if created != 1 {
		return fmt.Errorf("ipset create record count is %d, want 1", created)
	}
	want := make(map[string]struct{}, len(expectedMembers))
	for _, raw := range expectedMembers {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil || !prefix.Addr().Is4() {
			return errors.New("durable ipset expectation is not canonical IPv4")
		}
		want[prefix.Masked().String()] = struct{}{}
	}
	if len(observed) != len(want) {
		return fmt.Errorf("ipset member count is %d, want %d", len(observed), len(want))
	}
	for member := range observed {
		prefix, err := netip.ParsePrefix(member)
		if err != nil || prefix.Masked().String() != member {
			return fmt.Errorf("ipset member %q is not a canonical IPv4 prefix", member)
		}
		if _, expected := want[member]; !expected {
			return fmt.Errorf("ipset has unexpected member %s", member)
		}
	}
	return nil
}

type managedBridgeLink struct {
	IfName   string `json:"ifname"`
	Master   string `json:"master"`
	State    string `json:"state"`
	Hairpin  *bool  `json:"hairpin"`
	Guard    *bool  `json:"guard"`
	Learning *bool  `json:"learning"`
	Flood    *bool  `json:"flood"`
	Isolated *bool  `json:"isolated"`
	Locked   *bool  `json:"locked"`
}

type managedBridgeFDBEntry struct {
	MAC    string   `json:"mac"`
	IfName string   `json:"ifname"`
	Master string   `json:"master"`
	State  string   `json:"state"`
	Flags  []string `json:"flags"`
	VLAN   *int     `json:"vlan"`
}

type managedNeighborEntry struct {
	Destination string   `json:"dst"`
	Device      string   `json:"dev"`
	LinkAddress string   `json:"lladdr"`
	State       []string `json:"state"`
}

func validateManagedL2Inventory(run func(string, ...string) (string, error), cfg Config, expected map[string]managedTapRuntimeExpectation) error {
	if len(expected) == 0 {
		return nil
	}
	linksJSON, err := run("bridge", "-j", "-details", "link", "show")
	if err != nil {
		return err
	}
	var links []managedBridgeLink
	if err := json.Unmarshal([]byte(linksJSON), &links); err != nil {
		return fmt.Errorf("decode managed bridge links: %w", err)
	}
	linksByName := make(map[string]managedBridgeLink, len(links))
	for _, link := range links {
		if _, duplicate := linksByName[link.IfName]; duplicate {
			return fmt.Errorf("bridge link inventory contains duplicate %s", link.IfName)
		}
		linksByName[link.IfName] = link
	}

	fdbJSON, err := run("bridge", "-j", "fdb", "show")
	if err != nil {
		return err
	}
	var fdb []managedBridgeFDBEntry
	if err := json.Unmarshal([]byte(fdbJSON), &fdb); err != nil {
		return fmt.Errorf("decode managed bridge FDB: %w", err)
	}
	neighborsJSON, err := run("ip", "-j", "neigh", "show", "dev", cfg.NetBridge)
	if err != nil {
		return err
	}
	var neighbors []managedNeighborEntry
	if err := json.Unmarshal([]byte(neighborsJSON), &neighbors); err != nil {
		return fmt.Errorf("decode managed neighbor inventory: %w", err)
	}

	for tap, expectation := range expected {
		link, exists := linksByName[tap]
		if !exists || link.Master != cfg.NetBridge || link.State != "forwarding" ||
			!exactBool(link.Isolated, true) || !exactBool(link.Locked, true) ||
			!exactBool(link.Learning, false) || !exactBool(link.Flood, false) ||
			!exactBool(link.Hairpin, false) || !exactBool(link.Guard, true) {
			return fmt.Errorf("managed tap %s bridge isolation flags are missing or mutated", tap)
		}
		parsedMAC, parseErr := net.ParseMAC(expectation.mac)
		if parseErr != nil || parsedMAC.String() != expectation.mac {
			return fmt.Errorf("managed tap %s has an invalid durable MAC", tap)
		}
		fdbMatches := 0
		for _, entry := range fdb {
			if !strings.EqualFold(entry.MAC, expectation.mac) {
				continue
			}
			if entry.IfName != tap || entry.Master != cfg.NetBridge || entry.State != "permanent" || len(entry.Flags) != 0 || entry.VLAN != nil {
				return fmt.Errorf("managed guest MAC %s selects an unexpected bridge port", expectation.mac)
			}
			fdbMatches++
		}
		if fdbMatches != 1 {
			return fmt.Errorf("managed guest MAC %s has %d exact FDB selections, want 1", expectation.mac, fdbMatches)
		}
		neighborMatches := 0
		for _, neighbor := range neighbors {
			if neighbor.Destination != expectation.address {
				continue
			}
			if neighbor.Device != cfg.NetBridge || !strings.EqualFold(neighbor.LinkAddress, expectation.mac) || len(neighbor.State) != 1 || neighbor.State[0] != "PERMANENT" {
				return fmt.Errorf("managed guest address %s has a mutated permanent neighbor", expectation.address)
			}
			neighborMatches++
		}
		if neighborMatches != 1 {
			return fmt.Errorf("managed guest address %s has %d exact permanent neighbors, want 1", expectation.address, neighborMatches)
		}
	}
	return nil
}

func exactBool(value *bool, expected bool) bool {
	return value != nil && *value == expected
}

func validateManagedTapInventory(live map[string]struct{}, inputBindings, forwardBindings map[string]string, expected managedNetworkInventory) error {
	if expected.active == nil || expected.provisioning == nil {
		return errors.New("managed network inventory is incomplete")
	}
	for tap := range expected.active {
		if !managedTapPattern.MatchString(tap) {
			return errors.New("durable managed tap inventory contains an unsafe identifier")
		}
		if _, overlap := expected.provisioning[tap]; overlap {
			return fmt.Errorf("managed tap %s is both active and provisioning", tap)
		}
		if _, present := live[tap]; !present {
			return fmt.Errorf("durable managed tap %s is missing from the host", tap)
		}
		if inputBindings[tap] == "" || forwardBindings[tap] == "" {
			return fmt.Errorf("durable managed tap %s has no exact INPUT/FORWARD binding", tap)
		}
	}
	for tap := range expected.provisioning {
		if !managedTapPattern.MatchString(tap) {
			return errors.New("provisioning managed tap inventory contains an unsafe identifier")
		}
	}
	for tap := range live {
		if _, active := expected.active[tap]; active {
			continue
		}
		if _, provisioning := expected.provisioning[tap]; !provisioning {
			return fmt.Errorf("managed tap %s has no durable machine owner", tap)
		}
	}
	for tap, target := range inputBindings {
		if _, active := expected.active[tap]; active {
			continue
		}
		if _, provisioning := expected.provisioning[tap]; !provisioning {
			return fmt.Errorf("managed INPUT binding for %s has no durable machine owner", tap)
		}
		names, err := egressNamesForTap(tap)
		if err != nil || target != names.input {
			return fmt.Errorf("provisioning managed tap %s has an unexpected INPUT target", tap)
		}
	}
	for tap, target := range forwardBindings {
		if _, active := expected.active[tap]; active {
			continue
		}
		if _, provisioning := expected.provisioning[tap]; !provisioning {
			return fmt.Errorf("managed FORWARD binding for %s has no durable machine owner", tap)
		}
		names, err := egressNamesForTap(tap)
		if err != nil || target != "DROP" && target != names.chain {
			return fmt.Errorf("provisioning managed tap %s has an unexpected FORWARD target", tap)
		}
	}
	return nil
}

func validateUniqueManagedPolicyTargets(inputBindings, forwardBindings map[string]string) error {
	inputOwners := make(map[string]string, len(inputBindings))
	for tap, target := range inputBindings {
		if owner, duplicate := inputOwners[target]; duplicate && owner != tap {
			return fmt.Errorf("managed INPUT policy target %s is shared by %s and %s", target, owner, tap)
		}
		inputOwners[target] = tap
	}
	forwardOwners := make(map[string]string, len(forwardBindings))
	for tap, target := range forwardBindings {
		if target == "DROP" {
			continue
		}
		if owner, duplicate := forwardOwners[target]; duplicate && owner != tap {
			return fmt.Errorf("managed FORWARD policy target %s is shared by %s and %s", target, owner, tap)
		}
		forwardOwners[target] = tap
	}
	return nil
}

func (mgr *Manager) managedNetworkInventory() (managedNetworkInventory, error) {
	inventory := managedNetworkInventory{
		active:       make(map[string]managedTapRuntimeExpectation),
		provisioning: make(map[string]struct{}),
	}
	if mgr == nil || !mgr.cfg.NehemiahMode || !mgr.cfg.NetEnable {
		return inventory, nil
	}
	if err := func() error {
		mgr.mu.Lock()
		defer mgr.mu.Unlock()
		for machineID, machine := range mgr.machines {
			if machine == nil || !validMachineID(machineID) || machine.ID != machineID {
				return errors.New("managed machine inventory contains an invalid entry")
			}
			if machine.networkProvisioning {
				inventory.provisioning[tapName(machineID)] = struct{}{}
			}
			driver := machine.driver
			policy, err := normalizeNetworkPolicy(machine.NetworkPolicy)
			if err != nil || policy.declaration.Mode != egressModeOff {
				return fmt.Errorf("managed machine %s does not use the private-beta off network policy", machineID)
			}
			if driver == nil {
				continue
			}
			if driver.tap == "" {
				if driver.network {
					return fmt.Errorf("managed machine %s reports networking without a tap", machineID)
				}
				continue
			}
			if machine.networkProvisioning {
				continue
			}
			if !driver.network || driver.tap != tapName(machineID) {
				return fmt.Errorf("managed machine %s has an unexpected tap identity", machineID)
			}
			address, err := validateManagedGuestAddress(mgr.cfg.NetSubnet, driver.ip)
			if err != nil {
				return fmt.Errorf("managed machine %s has an invalid durable guest address: %w", machineID, err)
			}
			if _, duplicate := inventory.active[driver.tap]; duplicate {
				return fmt.Errorf("managed tap %s is shared by multiple machines", driver.tap)
			}
			inventory.active[driver.tap] = managedTapRuntimeExpectation{
				address: address.String(), mac: guestMAC(machineID), policy: policy,
			}
		}
		// Registry removal precedes slow process/tap teardown. The durable jailer
		// reservation remains until teardown proves every object absent, so it is
		// also the authoritative bounded allowance for that retiring tap name. A
		// failed teardown makes identity health sticky-unhealthy and keeps the host
		// closed; it never turns the retired identity into reusable capacity.
		for machineID := range mgr.jailerIdentities {
			if _, liveMachine := mgr.machines[machineID]; !liveMachine {
				inventory.provisioning[tapName(machineID)] = struct{}{}
			}
		}
		return nil
	}(); err != nil {
		return managedNetworkInventory{}, err
	}
	if mgr.egress == nil {
		return managedNetworkInventory{}, errors.New("managed egress inventory is unavailable")
	}
	mgr.egress.mu.Lock()
	inventory.hardDeny = append([]netip.Prefix(nil), mgr.egress.hardDeny...)
	mgr.egress.mu.Unlock()
	return inventory, nil
}

func isolateManagedNetworkRuntime(ops managedNetworkRuntimeOps) error {
	if !ops.valid() {
		return errors.New("managed network runtime operations are incomplete")
	}
	taps, err := ops.listTaps()
	if err != nil {
		return fmt.Errorf("list managed taps: %w", err)
	}
	var failures []error
	for _, tap := range taps {
		if !managedTapPattern.MatchString(tap) {
			failures = append(failures, errors.New("unsafe managed tap identifier"))
			continue
		}
		if err := ops.isolateTap(tap); err != nil {
			failures = append(failures, fmt.Errorf("isolate managed tap %s: %w", tap, err))
		}
	}
	remaining, verifyErr := ops.listTaps()
	if verifyErr != nil {
		failures = append(failures, fmt.Errorf("verify managed taps: %w", verifyErr))
	} else if len(remaining) != 0 {
		failures = append(failures, fmt.Errorf("%d managed tap(s) remain after isolation", len(remaining)))
	}
	return errors.Join(failures...)
}

// validateManagedHostRuntime is called before every outbound synchronization.
// Health is sticky for the daemon lifetime: after drift, taps have been
// detached and only a full startup reconciliation may safely reopen admission.
func (mgr *Manager) validateManagedHostRuntime() error {
	if mgr == nil || !mgr.cfg.NehemiahMode {
		return nil
	}
	cohortCheck := mgr.runtimeCohortCheck
	var cohortErr error
	if cohortCheck != nil {
		cohortErr = cohortCheck(mgr.cfg)
	} else {
		cohortErr = mgr.runtimeAssetGuard.ValidateMetadata(mgr.cfg)
	}
	inventory, inventoryErr := mgr.managedNetworkInventory()
	var networkErr error
	if inventoryErr != nil {
		networkErr = inventoryErr
	} else {
		networkErr = validateManagedNetworkRuntime(mgr.cfg, mgr.networkRuntime, inventory)
	}
	if cohortErr == nil && networkErr == nil {
		return nil
	}
	mgr.mu.Lock()
	if cohortErr != nil {
		mgr.runtimeCohortHealthy = false
	}
	if networkErr != nil {
		mgr.networkHealthy = false
	}
	mgr.mu.Unlock()
	isolationErr := isolateManagedNetworkRuntime(mgr.networkRuntime)
	return errors.Join(
		wrapError("managed runtime cohort", cohortErr),
		wrapError("managed network policy", networkErr),
		wrapError("managed guest isolation", isolationErr),
	)
}

func (mgr *Manager) managedAdmissionHealthyLocked() bool {
	return mgr.stateHealthy && mgr.networkHealthy && mgr.runtimeCohortHealthy && mgr.identityHealthy
}

func policyRuleFields(output, chain string) [][]string {
	var rules [][]string
	for _, raw := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(raw))
		if len(fields) >= 3 && fields[0] == "-A" && fields[1] == chain {
			rules = append(rules, fields)
		}
	}
	return rules
}

func validateUniqueFirstHook(output, chain string, suffix []string) error {
	rules := policyRuleFields(output, chain)
	want := append([]string{"-A", chain}, suffix...)
	if len(rules) == 0 || !sameFields(rules[0], want) {
		return errors.New("required hook is not first")
	}
	matches := 0
	for _, rule := range rules {
		if sameFields(rule, want) {
			matches++
		}
	}
	if matches != 1 {
		return fmt.Errorf("required hook count is %d, want 1", matches)
	}
	return nil
}

func validateManagedInputChain(output string) error {
	rules := policyRuleFields(output, "NEHEMIAH_INPUT")
	for len(rules) > 0 && validDynamicInputRule(rules[0]) {
		rules = rules[1:]
	}
	for index := range rules {
		rules[index] = normalizeIPTablesRule(rules[index])
	}
	if len(rules) != 7 {
		return fmt.Errorf("managed INPUT chain has %d static rule(s), want 7", len(rules))
	}
	want := [][]string{
		{"-A", "NEHEMIAH_INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "NEHEMIAH_INPUT", "-p", "udp", "--dport", "67", "-j", "ACCEPT"},
		{"-A", "NEHEMIAH_INPUT", "-p", "udp", "--dport", "53", "-m", "hashlimit", "--hashlimit-above", "50/sec", "--hashlimit-burst", "100", "--hashlimit-mode", "srcip", "--hashlimit-name", "neh-dns-u", "-j", "DROP"},
		{"-A", "NEHEMIAH_INPUT", "-p", "udp", "--dport", "53", "-j", "ACCEPT"},
		{"-A", "NEHEMIAH_INPUT", "-p", "tcp", "--dport", "53", "-m", "hashlimit", "--hashlimit-above", "50/sec", "--hashlimit-burst", "100", "--hashlimit-mode", "srcip", "--hashlimit-name", "neh-dns-t", "-j", "DROP"},
		{"-A", "NEHEMIAH_INPUT", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"},
		{"-A", "NEHEMIAH_INPUT", "-j", "DROP"},
	}
	for index := range want {
		observed := rules[index]
		if index == 0 && len(observed) == len(want[index]) && observed[5] == "RELATED,ESTABLISHED" {
			observed = append([]string(nil), observed...)
			observed[5] = "ESTABLISHED,RELATED"
		}
		if !sameFields(observed, want[index]) {
			return fmt.Errorf("managed INPUT static rule %d is missing or mutated", index+1)
		}
	}
	return nil
}

func validateManagedForwardChain(output, cidr string) error {
	rules := policyRuleFields(output, "NEHEMIAH_FWD")
	for len(rules) > 0 && validDynamicForwardRule(rules[0]) {
		rules = rules[1:]
	}
	for index := range rules {
		rules[index] = normalizeIPTablesRule(rules[index])
	}
	denied := []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
		"172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
	}
	wantCount := 2 + len(denied) + 5
	if len(rules) != wantCount {
		return fmt.Errorf("managed FORWARD chain has %d static rule(s), want %d", len(rules), wantCount)
	}
	wantReturn := []string{"-A", "NEHEMIAH_FWD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"}
	observedReturn := rules[0]
	if len(observedReturn) == len(wantReturn) && observedReturn[5] == "RELATED,ESTABLISHED" {
		observedReturn = append([]string(nil), observedReturn...)
		observedReturn[5] = "ESTABLISHED,RELATED"
	}
	if !sameFields(observedReturn, wantReturn) {
		return errors.New("managed FORWARD return-traffic rule is missing or mutated")
	}
	if !sameFields(rules[1], []string{"-A", "NEHEMIAH_FWD", "!", "-s", cidr, "-j", "RETURN"}) {
		return errors.New("managed FORWARD non-guest return rule is missing or mutated")
	}
	for index, destination := range denied {
		want := []string{"-A", "NEHEMIAH_FWD", "-s", cidr, "-d", destination, "-j", "DROP"}
		if !sameFields(rules[2+index], want) {
			return fmt.Errorf("managed FORWARD hard-deny rule %s is missing or mutated", destination)
		}
	}
	offset := 2 + len(denied)
	if !sameFields(rules[offset], []string{"-A", "NEHEMIAH_FWD", "-s", cidr, "-p", "tcp", "--dport", "25", "-j", "DROP"}) {
		return errors.New("managed FORWARD SMTP deny is missing or mutated")
	}
	rateRules := [][]string{
		{"-A", "NEHEMIAH_FWD", "-s", cidr, "-p", "tcp", "--syn", "-m", "hashlimit", "--hashlimit-above", "80/sec", "--hashlimit-burst", "120", "--hashlimit-mode", "srcip", "--hashlimit-name", "boringrate", "-j", "DROP"},
		{"-A", "NEHEMIAH_FWD", "-s", cidr, "-p", "udp", "-m", "hashlimit", "--hashlimit-above", "200/sec", "--hashlimit-burst", "400", "--hashlimit-mode", "srcip", "--hashlimit-name", "nehemiah-udp", "-j", "DROP"},
		{"-A", "NEHEMIAH_FWD", "-s", cidr, "-p", "icmp", "-m", "hashlimit", "--hashlimit-above", "20/sec", "--hashlimit-burst", "40", "--hashlimit-mode", "srcip", "--hashlimit-name", "nehemiah-icmp", "-j", "DROP"},
	}
	for index, want := range rateRules {
		if !sameFields(rules[offset+1+index], want) {
			return fmt.Errorf("managed FORWARD rate-limit rule %d is missing or mutated", index+1)
		}
	}
	if !sameFields(rules[offset+4], []string{"-A", "NEHEMIAH_FWD", "-s", cidr, "-j", "ACCEPT"}) {
		return errors.New("managed FORWARD terminal public-egress rule is missing or mutated")
	}
	return nil
}

func validDynamicInputRule(rule []string) bool {
	if len(rule) != 8 || !sameFields(rule[:5], []string{"-A", "NEHEMIAH_INPUT", "-m", "physdev", "--physdev-in"}) ||
		!managedTapPattern.MatchString(rule[5]) || rule[6] != "-j" {
		return false
	}
	names, err := egressNamesForTap(rule[5])
	return err == nil && rule[7] == names.input
}

func validDynamicForwardRule(rule []string) bool {
	if len(rule) != 6 || rule[0] != "-A" || rule[1] != "NEHEMIAH_FWD" || rule[2] != "-i" || !managedTapPattern.MatchString(rule[3]) || rule[4] != "-j" {
		return false
	}
	if rule[5] == "DROP" {
		return true
	}
	names, err := egressNamesForTap(rule[3])
	return err == nil && rule[5] == names.chain
}

func managedInputBindings(output string) (map[string]string, error) {
	bindings := make(map[string]string)
	for _, rule := range policyRuleFields(output, "NEHEMIAH_INPUT") {
		if !validDynamicInputRule(rule) {
			break
		}
		tap := rule[5]
		if _, duplicate := bindings[tap]; duplicate {
			return nil, fmt.Errorf("managed INPUT has duplicate binding for %s", tap)
		}
		bindings[tap] = rule[7]
	}
	return bindings, nil
}

func managedForwardBindings(output string) (map[string]string, error) {
	bindings := make(map[string]string)
	for _, rule := range policyRuleFields(output, "NEHEMIAH_FWD") {
		if !validDynamicForwardRule(rule) {
			break
		}
		tap := rule[3]
		if _, duplicate := bindings[tap]; duplicate {
			return nil, fmt.Errorf("managed FORWARD has duplicate binding for %s", tap)
		}
		bindings[tap] = rule[5]
	}
	return bindings, nil
}

func managedPolicyChainDefinitions(output string) (map[string]int, error) {
	definitions := make(map[string]int)
	for _, raw := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(raw))
		if len(fields) != 2 || fields[0] != "-N" || !managedPolicyChainPattern.MatchString(fields[1]) {
			continue
		}
		definitions[fields[1]]++
		if definitions[fields[1]] > 1 {
			return nil, fmt.Errorf("managed policy chain %s is defined more than once", fields[1])
		}
	}
	return definitions, nil
}

func validateManagedTapInputPolicy(output, chain, subnet string) (string, error) {
	rules := policyRuleFields(output, chain)
	for index := range rules {
		rules[index] = normalizeIPTablesRule(rules[index])
	}
	if len(rules) != 3 {
		return "", fmt.Errorf("chain has %d rule(s), want 3", len(rules))
	}
	if !sameFields(rules[0], []string{"-A", chain, "-s", "0.0.0.0/32", "-p", "udp", "--sport", "68", "--dport", "67", "-j", "RETURN"}) {
		return "", errors.New("DHCP bootstrap identity rule is missing or mutated")
	}
	if len(rules[1]) != 6 || rules[1][0] != "-A" || rules[1][1] != chain || rules[1][2] != "-s" || rules[1][4] != "-j" || rules[1][5] != "RETURN" || !strings.HasSuffix(rules[1][3], "/32") {
		return "", errors.New("guest source identity rule is missing or mutated")
	}
	address, err := validateManagedGuestAddress(subnet, strings.TrimSuffix(rules[1][3], "/32"))
	if err != nil {
		return "", err
	}
	if !sameFields(rules[2], []string{"-A", chain, "-j", "DROP"}) {
		return "", errors.New("terminal INPUT identity DROP is missing or mutated")
	}
	return address.String() + "/32", nil
}

func validateManagedTapForwardPolicy(output, tap, chain, subnet string) (string, error) {
	names, err := egressNamesForTap(tap)
	if err != nil || names.chain != chain {
		return "", errors.New("tap is bound to an unexpected egress chain")
	}
	rules := policyRuleFields(output, chain)
	for index := range rules {
		rules[index] = normalizeIPTablesRule(rules[index])
	}
	if len(rules) != 11 {
		return "", fmt.Errorf("chain has %d rule(s), want 11", len(rules))
	}
	if len(rules[0]) != 7 || !sameFields(rules[0][:4], []string{"-A", chain, "!", "-s"}) || rules[0][5] != "-j" || rules[0][6] != "DROP" || !strings.HasSuffix(rules[0][4], "/32") {
		return "", errors.New("guest source anti-spoof rule is missing or mutated")
	}
	address, err := validateManagedGuestAddress(subnet, strings.TrimSuffix(rules[0][4], "/32"))
	if err != nil {
		return "", err
	}
	wantAddress := address.String() + "/32"
	suffix := chain[4:]
	expected := [][]string{
		{"-A", chain, "-m", "set", "--match-set", hardFloorSet4, "dst", "-j", "DROP"},
		{"-A", chain, "-p", "udp", "-m", "multiport", "--dports", "53,853", "-j", "DROP"},
		{"-A", chain, "-p", "tcp", "-m", "multiport", "--dports", "53,853", "-j", "DROP"},
		{"-A", chain, "-p", "tcp", "--syn", "-m", "connlimit", "--connlimit-above", managedTCPConnLimit, "--connlimit-mask", "32", "-j", "DROP"},
		{"-A", chain, "-p", "tcp", "--syn", "-m", "hashlimit", "--hashlimit-above", "80/sec", "--hashlimit-burst", "120", "--hashlimit-name", "neh-t-" + suffix, "-j", "DROP"},
		{"-A", chain, "-p", "udp", "-m", "hashlimit", "--hashlimit-above", "200/sec", "--hashlimit-burst", "400", "--hashlimit-name", "neh-u-" + suffix, "-j", "DROP"},
		{"-A", chain, "-p", "icmp", "--icmp-type", "echo-request", "-m", "hashlimit", "--hashlimit-above", "20/sec", "--hashlimit-burst", "40", "--hashlimit-name", "neh-i-" + suffix, "-j", "DROP"},
		{"-A", chain, "-m", "set", "--match-set", names.cidrs, "dst", "-j", "ACCEPT"},
		{"-A", chain, "-m", "set", "--match-set", names.learned, "dst", "-j", "ACCEPT"},
		{"-A", chain, "-j", "DROP"},
	}
	if rules[0][4] != wantAddress {
		return "", errors.New("egress source address is not canonical")
	}
	for index, want := range expected {
		observed := rules[index+1]
		if index == 6 && len(observed) > 5 && observed[5] == "8" {
			observed = append([]string(nil), observed...)
			observed[5] = "echo-request"
		}
		if !sameFields(observed, want) {
			return "", fmt.Errorf("egress rule %d is missing or mutated", index+2)
		}
	}
	return wantAddress, nil
}

func normalizeIPTablesRule(rule []string) []string {
	normalized := make([]string, 0, len(rule))
	for index := 0; index < len(rule); index++ {
		if index+1 < len(rule) && rule[index] == "-m" && (rule[index+1] == "tcp" || rule[index+1] == "udp" || rule[index+1] == "icmp") {
			index++
			continue
		}
		if index+2 < len(rule) && rule[index] == "--tcp-flags" && rule[index+2] == "SYN" && tcpSynMask(rule[index+1]) {
			normalized = append(normalized, "--syn")
			index += 2
			continue
		}
		normalized = append(normalized, rule[index])
	}
	return normalized
}

func tcpSynMask(value string) bool {
	parts := strings.Split(value, ",")
	want := map[string]bool{"FIN": true, "SYN": true, "RST": true, "ACK": true}
	if len(parts) != len(want) {
		return false
	}
	for _, part := range parts {
		if !want[part] {
			return false
		}
	}
	return true
}

func validDNSRateRule(rule []string, protocol, name string) bool {
	return ruleHas(rule, "-p", protocol, "--dport", "53", "-m", "hashlimit", "--hashlimit-above", "50/sec", "--hashlimit-burst", "100", "--hashlimit-mode", "srcip", "--hashlimit-name", name) && ruleEnds(rule, "-j", "DROP")
}

func validForwardRateRule(rule []string, cidr, protocol, above, burst, name string) bool {
	return ruleHas(rule, "-s", cidr, "-p", protocol) &&
		ruleHas(rule, "-m", "hashlimit", "--hashlimit-above", above, "--hashlimit-burst", burst, "--hashlimit-mode", "srcip", "--hashlimit-name", name) &&
		ruleEnds(rule, "-j", "DROP")
}

func sameFields(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func ruleHas(rule []string, sequence ...string) bool {
	for index := 0; index+len(sequence) <= len(rule); index++ {
		if sameFields(rule[index:index+len(sequence)], sequence) {
			return true
		}
	}
	return false
}

func ruleHasEither(rule []string, values ...string) bool {
	for _, field := range rule {
		for _, value := range values {
			if field == value {
				return true
			}
		}
	}
	return false
}

func ruleEnds(rule []string, suffix ...string) bool {
	return len(rule) >= len(suffix) && sameFields(rule[len(rule)-len(suffix):], suffix)
}

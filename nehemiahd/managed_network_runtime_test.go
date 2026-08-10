package main

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

type managedNetworkFixture struct {
	cfg     Config
	outputs map[string]string
	taps    []string
}

func newManagedNetworkFixture(t *testing.T, tap string, allowlist bool) managedNetworkFixture {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.NetEnable = true
	cfg.NetBridge = "boring0"
	cfg.NetSubnet = "10.200.0"
	fixture := managedNetworkFixture{cfg: cfg, outputs: make(map[string]string)}
	fixture.outputs["sysctl -n net.ipv4.ip_forward"] = "1"
	fixture.outputs["sysctl -n net.bridge.bridge-nf-call-iptables"] = "1"
	fixture.outputs["sysctl -n net.ipv6.conf.boring0.disable_ipv6"] = "1"
	fixture.outputs["iptables -S INPUT"] = strings.Join([]string{
		"-P INPUT ACCEPT",
		"-A INPUT -i boring0 -j NEHEMIAH_INPUT",
		"-A INPUT -j ACCEPT",
	}, "\n")
	fixture.outputs["iptables -S FORWARD"] = strings.Join([]string{
		"-P FORWARD ACCEPT",
		"-A FORWARD -j NEHEMIAH_FWD",
		"-A FORWARD -j ACCEPT",
	}, "\n")
	fixture.outputs["ip6tables -S FORWARD"] = strings.Join([]string{
		"-P FORWARD ACCEPT",
		"-A FORWARD -i boring0 -j DROP",
	}, "\n")

	input := make([]string, 0, 8)
	forward := make([]string, 0, 20)
	definitions := make([]string, 0, 2)
	if tap != "" {
		fixture.taps = []string{tap}
		names, err := egressNamesForTap(tap)
		if err != nil {
			t.Fatal(err)
		}
		input = append(input, fmt.Sprintf("-A NEHEMIAH_INPUT -m physdev --physdev-in %s -j %s", tap, names.input))
		forwardTarget := "DROP"
		if allowlist {
			forwardTarget = names.chain
		}
		forward = append(forward, fmt.Sprintf("-A NEHEMIAH_FWD -i %s -j %s", tap, forwardTarget))
		definitions = append(definitions, "-N "+names.input)
		fixture.outputs["iptables -S "+names.input] = strings.Join([]string{
			"-N " + names.input,
			fmt.Sprintf("-A %s -s 0.0.0.0/32 -p udp -m udp --sport 68 --dport 67 -j RETURN", names.input),
			fmt.Sprintf("-A %s -s 10.200.0.42/32 -j RETURN", names.input),
			fmt.Sprintf("-A %s -j DROP", names.input),
		}, "\n")
		if allowlist {
			definitions = append(definitions, "-N "+names.chain)
			suffix := names.chain[4:]
			fixture.outputs["iptables -S "+names.chain] = strings.Join([]string{
				"-N " + names.chain,
				fmt.Sprintf("-A %s ! -s 10.200.0.42/32 -j DROP", names.chain),
				fmt.Sprintf("-A %s -m set --match-set %s dst -j DROP", names.chain, hardFloorSet4),
				fmt.Sprintf("-A %s -p udp -m udp -m multiport --dports 53,853 -j DROP", names.chain),
				fmt.Sprintf("-A %s -p tcp -m tcp -m multiport --dports 53,853 -j DROP", names.chain),
				fmt.Sprintf("-A %s -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -m connlimit --connlimit-above %s --connlimit-mask 32 -j DROP", names.chain, managedTCPConnLimit),
				fmt.Sprintf("-A %s -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -m hashlimit --hashlimit-above 80/sec --hashlimit-burst 120 --hashlimit-name neh-t-%s -j DROP", names.chain, suffix),
				fmt.Sprintf("-A %s -p udp -m udp -m hashlimit --hashlimit-above 200/sec --hashlimit-burst 400 --hashlimit-name neh-u-%s -j DROP", names.chain, suffix),
				fmt.Sprintf("-A %s -p icmp -m icmp --icmp-type 8 -m hashlimit --hashlimit-above 20/sec --hashlimit-burst 40 --hashlimit-name neh-i-%s -j DROP", names.chain, suffix),
				fmt.Sprintf("-A %s -m set --match-set %s dst -j ACCEPT", names.chain, names.cidrs),
				fmt.Sprintf("-A %s -m set --match-set %s dst -j ACCEPT", names.chain, names.learned),
				fmt.Sprintf("-A %s -j DROP", names.chain),
			}, "\n")
		}
	}
	input = append(input,
		"-A NEHEMIAH_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
		"-A NEHEMIAH_INPUT -p udp -m udp --dport 67 -j ACCEPT",
		"-A NEHEMIAH_INPUT -p udp -m udp --dport 53 -m hashlimit --hashlimit-above 50/sec --hashlimit-burst 100 --hashlimit-mode srcip --hashlimit-name neh-dns-u -j DROP",
		"-A NEHEMIAH_INPUT -p udp -m udp --dport 53 -j ACCEPT",
		"-A NEHEMIAH_INPUT -p tcp -m tcp --dport 53 -m hashlimit --hashlimit-above 50/sec --hashlimit-burst 100 --hashlimit-mode srcip --hashlimit-name neh-dns-t -j DROP",
		"-A NEHEMIAH_INPUT -p tcp -m tcp --dport 53 -j ACCEPT",
		"-A NEHEMIAH_INPUT -j DROP",
	)
	forward = append(forward,
		"-A NEHEMIAH_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
		"-A NEHEMIAH_FWD ! -s 10.200.0.0/24 -j RETURN",
	)
	for _, destination := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
		"172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
	} {
		forward = append(forward, fmt.Sprintf("-A NEHEMIAH_FWD -s 10.200.0.0/24 -d %s -j DROP", destination))
	}
	forward = append(forward,
		"-A NEHEMIAH_FWD -s 10.200.0.0/24 -p tcp -m tcp --dport 25 -j DROP",
		"-A NEHEMIAH_FWD -s 10.200.0.0/24 -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -m hashlimit --hashlimit-above 80/sec --hashlimit-burst 120 --hashlimit-mode srcip --hashlimit-name boringrate -j DROP",
		"-A NEHEMIAH_FWD -s 10.200.0.0/24 -p udp -m udp -m hashlimit --hashlimit-above 200/sec --hashlimit-burst 400 --hashlimit-mode srcip --hashlimit-name nehemiah-udp -j DROP",
		"-A NEHEMIAH_FWD -s 10.200.0.0/24 -p icmp -m icmp -m hashlimit --hashlimit-above 20/sec --hashlimit-burst 40 --hashlimit-mode srcip --hashlimit-name nehemiah-icmp -j DROP",
		"-A NEHEMIAH_FWD -s 10.200.0.0/24 -j ACCEPT",
	)
	fixture.outputs["iptables -S NEHEMIAH_INPUT"] = strings.Join(input, "\n")
	fixture.outputs["iptables -S NEHEMIAH_FWD"] = strings.Join(forward, "\n")
	fixture.outputs["iptables -S"] = strings.Join(definitions, "\n")
	return fixture
}

func (fixture managedNetworkFixture) ops() managedNetworkRuntimeOps {
	return managedNetworkRuntimeOps{
		run: func(name string, args ...string) ([]byte, error) {
			key := strings.Join(append([]string{name}, args...), " ")
			output, exists := fixture.outputs[key]
			if !exists {
				return nil, fmt.Errorf("unexpected command %s", key)
			}
			return []byte(output), nil
		},
		listTaps:   func() ([]string, error) { return append([]string(nil), fixture.taps...), nil },
		isolateTap: func(string) error { return nil },
	}
}

func (fixture managedNetworkFixture) installRuntimeObjects(inventory managedNetworkInventory) {
	linkRecords := make([]string, 0, len(inventory.active))
	fdbRecords := make([]string, 0, len(inventory.active))
	neighborRecords := make([]string, 0, len(inventory.active))
	for tap, expectation := range inventory.active {
		linkRecords = append(linkRecords, fmt.Sprintf(
			`{"ifname":%q,"master":%q,"state":"forwarding","hairpin":false,"guard":true,"learning":false,"flood":false,"isolated":true,"locked":true}`,
			tap, fixture.cfg.NetBridge,
		))
		fdbRecords = append(fdbRecords, fmt.Sprintf(
			`{"mac":%q,"ifname":%q,"master":%q,"state":"permanent","flags":[]}`,
			expectation.mac, tap, fixture.cfg.NetBridge,
		))
		neighborRecords = append(neighborRecords, fmt.Sprintf(
			`{"dst":%q,"dev":%q,"lladdr":%q,"state":["PERMANENT"]}`,
			expectation.address, fixture.cfg.NetBridge, expectation.mac,
		))
		if expectation.policy.declaration.Mode == egressModeAllowlist {
			names, _ := egressNamesForTap(tap)
			fixture.outputs["ipset save "+names.cidrs] = managedIPSetFixture(names.cidrs, "hash:net", prefixStrings(expectation.policy.cidrs))
			fixture.outputs["ipset save "+names.learned] = managedIPSetFixture(names.learned, "hash:ip", nil)
		}
	}
	fixture.outputs["bridge -j -details link show"] = "[" + strings.Join(linkRecords, ",") + "]"
	fixture.outputs["bridge -j fdb show"] = "[" + strings.Join(fdbRecords, ",") + "]"
	fixture.outputs["ip -j neigh show dev "+fixture.cfg.NetBridge] = "[" + strings.Join(neighborRecords, ",") + "]"
	fixture.outputs["ipset save "+hardFloorSet4] = managedIPSetFixture(hardFloorSet4, "hash:net", ipv4PrefixStrings(inventory.hardDeny))
}

func managedIPSetFixture(name, setType string, members []string) string {
	lines := []string{"create " + name + " " + setType + " family inet maxelem 4096"}
	for _, member := range members {
		lines = append(lines, "add "+name+" "+member)
	}
	return strings.Join(lines, "\n")
}

func TestValidateManagedNetworkRuntimeRequiresExactLiveTapPolicies(t *testing.T) {
	for _, test := range []struct {
		name      string
		tap       string
		allowlist bool
	}{
		{name: "empty inventory"},
		{name: "deny-only tap", tap: "bt0123abcd"},
		{name: "allowlist tap", tap: "bt0123abcd", allowlist: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newManagedNetworkFixture(t, test.tap, test.allowlist)
			if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops()); err != nil {
				t.Fatalf("valid managed policy rejected: %v", err)
			}
		})
	}
}

func TestValidateManagedNetworkRuntimeBindsDurableMachineInventory(t *testing.T) {
	fixture := newManagedNetworkFixture(t, "bt0123abcd", true)
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.0/24"}})
	if err != nil {
		t.Fatal(err)
	}
	inventory := managedNetworkInventory{
		active: map[string]managedTapRuntimeExpectation{
			"bt0123abcd": {address: "10.200.0.42", mac: "06:00:01:23:ab:cd", policy: policy},
		},
		provisioning: map[string]struct{}{},
		hardDeny:     []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")},
	}
	fixture.installRuntimeObjects(inventory)
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), inventory); err != nil {
		t.Fatalf("durably bound managed policy rejected: %v", err)
	}

	wrongAddress := inventory
	wrongAddress.active = map[string]managedTapRuntimeExpectation{
		"bt0123abcd": {address: "10.200.0.43", mac: "06:00:01:23:ab:cd", policy: policy},
	}
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), wrongAddress); err == nil {
		t.Fatal("kernel policy with the wrong durable guest address was accepted")
	}

	off, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeOff})
	if err != nil {
		t.Fatal(err)
	}
	wrongMode := inventory
	wrongMode.active = map[string]managedTapRuntimeExpectation{
		"bt0123abcd": {address: "10.200.0.42", mac: "06:00:01:23:ab:cd", policy: off},
	}
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), wrongMode); err == nil {
		t.Fatal("kernel allowlist chain for a durable off policy was accepted")
	}
}

func TestValidateManagedNetworkRuntimeRejectsDurableKernelObjectDrift(t *testing.T) {
	fixture := newManagedNetworkFixture(t, "bt0123abcd", true)
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.0/24"}})
	if err != nil {
		t.Fatal(err)
	}
	inventory := managedNetworkInventory{
		active: map[string]managedTapRuntimeExpectation{
			"bt0123abcd": {address: "10.200.0.42", mac: "06:00:01:23:ab:cd", policy: policy},
		},
		provisioning: map[string]struct{}{},
		hardDeny:     []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")},
	}
	fixture.installRuntimeObjects(inventory)
	names, err := egressNamesForTap("bt0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{name: "bridge isolation cleared", mutate: func(outputs map[string]string) {
			outputs["bridge -j -details link show"] = strings.Replace(outputs["bridge -j -details link show"], `"isolated":true`, `"isolated":false`, 1)
		}},
		{name: "bridge master changed", mutate: func(outputs map[string]string) {
			outputs["bridge -j -details link show"] = strings.Replace(outputs["bridge -j -details link show"], `"master":"boring0"`, `"master":"other0"`, 1)
		}},
		{name: "fdb selects another tap", mutate: func(outputs map[string]string) {
			outputs["bridge -j fdb show"] = strings.Replace(outputs["bridge -j fdb show"], `"ifname":"bt0123abcd"`, `"ifname":"btdeadbeef"`, 1)
		}},
		{name: "duplicate guest mac selection", mutate: func(outputs map[string]string) {
			outputs["bridge -j fdb show"] = strings.TrimSuffix(outputs["bridge -j fdb show"], "]") + `,{"mac":"06:00:01:23:ab:cd","ifname":"btdeadbeef","master":"boring0","state":"permanent","flags":[]}]`
		}},
		{name: "neighbor no longer permanent", mutate: func(outputs map[string]string) {
			outputs["ip -j neigh show dev boring0"] = strings.Replace(outputs["ip -j neigh show dev boring0"], `"PERMANENT"`, `"STALE"`, 1)
		}},
		{name: "immutable floor member removed", mutate: func(outputs map[string]string) {
			outputs["ipset save "+hardFloorSet4] = "create " + hardFloorSet4 + " hash:net family inet maxelem 4096"
		}},
		{name: "allowlist cidr substituted", mutate: func(outputs map[string]string) {
			outputs["ipset save "+names.cidrs] = strings.Replace(outputs["ipset save "+names.cidrs], "8.8.8.0/24", "9.9.9.0/24", 1)
		}},
		{name: "learned set unexpectedly populated", mutate: func(outputs map[string]string) {
			outputs["ipset save "+names.learned] += "\nadd " + names.learned + " 8.8.8.8/32"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := managedNetworkFixture{cfg: fixture.cfg, taps: append([]string(nil), fixture.taps...), outputs: make(map[string]string, len(fixture.outputs))}
			for key, value := range fixture.outputs {
				candidate.outputs[key] = value
			}
			test.mutate(candidate.outputs)
			if err := validateManagedNetworkRuntime(candidate.cfg, candidate.ops(), inventory); err == nil {
				t.Fatal("drifted durable kernel network object was accepted")
			}
		})
	}
}

func TestValidateManagedNetworkRuntimeAllowsOnlyKnownProvisioningTapTransition(t *testing.T) {
	fixture := newManagedNetworkFixture(t, "bt0123abcd", false)
	inputLines := strings.Split(fixture.outputs["iptables -S NEHEMIAH_INPUT"], "\n")
	fixture.outputs["iptables -S NEHEMIAH_INPUT"] = strings.Join(inputLines[1:], "\n")
	fixture.outputs["iptables -S"] = ""
	inventory := managedNetworkInventory{
		active:       map[string]managedTapRuntimeExpectation{},
		provisioning: map[string]struct{}{"bt0123abcd": {}},
	}
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), inventory); err != nil {
		t.Fatalf("known fail-closed provisioning tap rejected: %v", err)
	}
	delete(inventory.provisioning, "bt0123abcd")
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), inventory); err == nil {
		t.Fatal("tap without a durable or provisioning machine owner was accepted")
	}
}

func TestManagedNetworkInventoryUsesExactPublishedDriverAndPolicy(t *testing.T) {
	const machineID = "m-0123abcd"
	tap := tapName(machineID)
	fixture := newManagedNetworkFixture(t, tap, false)
	mgr := NewManager(fixture.cfg)
	mgr.machines[machineID] = &Machine{
		ID: machineID, NetworkPolicy: networkPolicyDeclaration{Mode: egressModeOff},
		driver: &fcDriver{id: machineID, tap: tap, ip: "10.200.0.42", network: true},
	}
	inventory, err := mgr.managedNetworkInventory()
	if err != nil {
		t.Fatal(err)
	}
	fixture.installRuntimeObjects(inventory)
	if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops(), inventory); err != nil {
		t.Fatalf("published machine inventory rejected: %v", err)
	}
	mgr.machines[machineID].NetworkPolicy = networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.0/24"}}
	if _, err := mgr.managedNetworkInventory(); err == nil {
		t.Fatal("managed private-beta allowlist entered the runtime inventory")
	}
	mgr.machines[machineID].NetworkPolicy = networkPolicyDeclaration{Mode: egressModeOff}
	mgr.machines[machineID].driver.tap = "btdeadbeef"
	if _, err := mgr.managedNetworkInventory(); err == nil {
		t.Fatal("published machine with a mismatched deterministic tap was accepted")
	}
}

func TestManagedNetworkInventoryAllowsOnlyDurablyHeldRetiringTap(t *testing.T) {
	fixture := newManagedNetworkFixture(t, "", false)
	mgr := NewManager(fixture.cfg)
	const machineID = "m-0123abcd"
	mgr.jailerIdentities[machineID] = jailerIdentity{
		UID: 30000, GID: 30000, ReservationID: "0123456789abcdef0123456789abcdef",
	}
	inventory, err := mgr.managedNetworkInventory()
	if err != nil {
		t.Fatal(err)
	}
	if _, allowed := inventory.provisioning[tapName(machineID)]; !allowed {
		t.Fatal("durably held retiring identity did not authorize its bounded tap teardown transition")
	}
	delete(mgr.jailerIdentities, machineID)
	inventory, err = mgr.managedNetworkInventory()
	if err != nil {
		t.Fatal(err)
	}
	if _, allowed := inventory.provisioning[tapName(machineID)]; allowed {
		t.Fatal("released identity continued to authorize a tap transition")
	}
}

func TestManagedPolicyTargetsCannotBeSharedAcrossTaps(t *testing.T) {
	if err := validateUniqueManagedPolicyTargets(
		map[string]string{"bt0123abcd": "NEI_deadbeef", "bt0123abce": "NEI_deadbeef"},
		map[string]string{"bt0123abcd": "DROP", "bt0123abce": "DROP"},
	); err == nil {
		t.Fatal("two taps sharing one INPUT identity chain were accepted")
	}
	if err := validateUniqueManagedPolicyTargets(
		map[string]string{"bt0123abcd": "NEI_0123abcd", "bt0123abce": "NEI_0123abce"},
		map[string]string{"bt0123abcd": "NEH_deadbeef", "bt0123abce": "NEH_deadbeef"},
	); err == nil {
		t.Fatal("two taps sharing one egress chain were accepted")
	}
}

func TestValidateManagedNetworkRuntimeRejectsDrift(t *testing.T) {
	base := newManagedNetworkFixture(t, "bt0123abcd", true)
	names, err := egressNamesForTap("bt0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*managedNetworkFixture)
	}{
		{name: "forward hook not first", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S FORWARD"] = "-A FORWARD -j ACCEPT\n-A FORWARD -j NEHEMIAH_FWD"
		}},
		{name: "empty shared input", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S NEHEMIAH_INPUT"] = "-N NEHEMIAH_INPUT"
		}},
		{name: "negated smtp source", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S NEHEMIAH_FWD"] = strings.Replace(f.outputs["iptables -S NEHEMIAH_FWD"], "-s 10.200.0.0/24 -p tcp -m tcp --dport 25", "! -s 10.200.0.0/24 -p tcp -m tcp --dport 25", 1)
		}},
		{name: "wrong tap target", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S NEHEMIAH_FWD"] = strings.Replace(f.outputs["iptables -S NEHEMIAH_FWD"], "-j "+names.chain, "-j NEH_deadbeef", 1)
		}},
		{name: "missing live tap jump", mutate: func(f *managedNetworkFixture) {
			lines := strings.Split(f.outputs["iptables -S NEHEMIAH_FWD"], "\n")
			f.outputs["iptables -S NEHEMIAH_FWD"] = strings.Join(lines[1:], "\n")
		}},
		{name: "empty input identity chain", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S "+names.input] = "-N " + names.input
		}},
		{name: "empty egress chain", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S "+names.chain] = "-N " + names.chain
		}},
		{name: "different input source", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S "+names.input] = strings.Replace(f.outputs["iptables -S "+names.input], "10.200.0.42/32", "10.200.0.43/32", 1)
		}},
		{name: "orphan policy chain", mutate: func(f *managedNetworkFixture) {
			f.outputs["iptables -S"] += "\n-N NEH_deadbeef"
		}},
		{name: "ipv6 drop removed", mutate: func(f *managedNetworkFixture) {
			f.outputs["ip6tables -S FORWARD"] = "-P FORWARD ACCEPT"
		}},
		{name: "bridge netfilter disabled", mutate: func(f *managedNetworkFixture) {
			f.outputs["sysctl -n net.bridge.bridge-nf-call-iptables"] = "0"
		}},
		{name: "terminal egress drop removed", mutate: func(f *managedNetworkFixture) {
			lines := strings.Split(f.outputs["iptables -S "+names.chain], "\n")
			f.outputs["iptables -S "+names.chain] = strings.Join(lines[:len(lines)-1], "\n")
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := managedNetworkFixture{cfg: base.cfg, taps: append([]string(nil), base.taps...), outputs: make(map[string]string, len(base.outputs))}
			for key, value := range base.outputs {
				fixture.outputs[key] = value
			}
			test.mutate(&fixture)
			if err := validateManagedNetworkRuntime(fixture.cfg, fixture.ops()); err == nil {
				t.Fatal("drifted managed policy was accepted")
			}
		})
	}
}

func TestManagedRuntimeDriftIsolatesTapsAndClosesAdmission(t *testing.T) {
	fixture := newManagedNetworkFixture(t, "bt0123abcd", true)
	names, err := egressNamesForTap("bt0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	fixture.outputs["iptables -S "+names.chain] = "-N " + names.chain
	live := map[string]bool{"bt0123abcd": true}
	var isolated []string
	ops := fixture.ops()
	ops.listTaps = func() ([]string, error) {
		var taps []string
		for tap, present := range live {
			if present {
				taps = append(taps, tap)
			}
		}
		return taps, nil
	}
	ops.isolateTap = func(tap string) error {
		isolated = append(isolated, tap)
		delete(live, tap)
		return nil
	}
	mgr := NewManager(fixture.cfg)
	mgr.runtimeCohortCheck = func(Config) error { return nil }
	mgr.networkRuntime = ops
	if err := mgr.validateManagedHostRuntime(); err == nil {
		t.Fatal("network drift was hidden")
	}
	if len(isolated) != 1 || isolated[0] != "bt0123abcd" || live["bt0123abcd"] {
		t.Fatalf("isolated=%v live=%v, want exact tap removed", isolated, live)
	}
	if mgr.networkHealthy {
		t.Fatal("network health reopened after drift")
	}
	_, _, createErr := mgr.CreateInternalWithRuntimeExpectation(
		"python", 120, false, false, "internal", "runtime-drift-create", "lease-runtime-drift", 1,
		nil, 0, 0, 0, networkPolicyDeclaration{},
		managedRuntimeExpectation{CohortID: fixture.cfg.RuntimeCohort.ID, RootfsSHA256: fixture.cfg.RuntimeCohort.PythonRootfsSHA256},
	)
	if !errors.Is(createErr, ErrHostUnhealthy) {
		t.Fatalf("create error=%v, want ErrHostUnhealthy", createErr)
	}
	status := mgr.HostStatus(staticHostProbe{hostResources{Architecture: "x86_64", KVM: true, Jailer: true, TotalCPU: 8, TotalMemoryMB: 8192, AvailableMemoryMB: 8192}})
	if status.State != "unhealthy" || !containsString(status.UnhealthyReasons, "managed_network_policy_drift") {
		t.Fatalf("host status=%+v, want sticky network unhealthy", status)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

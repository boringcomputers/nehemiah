package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestNetworkPolicyDefaultsOffAndCanonicalizes(t *testing.T) {
	off, err := normalizeNetworkPolicy(networkPolicyDeclaration{})
	if err != nil || off.declaration.Mode != egressModeOff || off.allowsHostname("api.example.com") {
		t.Fatalf("omitted policy = %+v, %v; want off", off, err)
	}
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{
		Mode:      " ALLOWLIST ",
		Hostnames: []string{"*.Example.COM.", "api.example.com", "api.example.com"},
		CIDRs:     []string{"8.8.8.8/32", "8.8.8.8/32", "203.0.113.4/24"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := networkPolicyDeclaration{
		Mode:      egressModeAllowlist,
		Hostnames: []string{"*.example.com", "api.example.com"},
		CIDRs:     []string{"203.0.113.0/24", "8.8.8.8/32"},
	}
	if !reflect.DeepEqual(policy.declaration, want) {
		t.Fatalf("canonical policy = %#v, want %#v", policy.declaration, want)
	}
	if !policy.allowsHostname("api.example.com.") || !policy.allowsHostname("sub.example.com") || policy.allowsHostname("example.com") || policy.allowsHostname("notexample.com") {
		t.Fatal("exact/wildcard hostname matching is not boundary-safe")
	}
	for _, invalid := range []networkPolicyDeclaration{
		{Mode: "off", Hostnames: []string{"api.example.com"}},
		{Mode: "allowlist"},
		{Mode: "allowlist", Hostnames: []string{"example"}},
		{Mode: "allowlist", Hostnames: []string{"*.*.example.com"}},
		{Mode: "allowlist", CIDRs: []string{"not-a-cidr"}},
		{Mode: "allowlist", CIDRs: []string{"2001:4860:4860::8888/128"}},
	} {
		if _, err := normalizeNetworkPolicy(invalid); err == nil {
			t.Errorf("invalid policy accepted: %#v", invalid)
		}
	}
}

func TestImmutableEgressDenyFloorOverridesBroadAllow(t *testing.T) {
	controller := newEgressController(Config{EgressDenyCIDRs: []string{"203.0.113.0/24"}})
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"0.0.0.0/0"}})
	if err != nil {
		t.Fatal(err)
	}
	controller.installed["m-01020304"] = installedEgressPolicy{machineID: "m-01020304", tap: tapName("m-01020304"), policy: policy}
	controller.learned["m-01020304"] = make(map[netip.Addr]learnedEgressAddress)
	for _, raw := range []string{
		"0.0.0.0", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254",
		"172.16.0.1", "192.168.4.5", "198.18.0.1", "224.0.0.1", "255.255.255.255",
		"203.0.113.7", "::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:169.254.169.254",
	} {
		address := netip.MustParseAddr(raw)
		if !controller.isHardDenied(address) || controller.allowsAddress("m-01020304", address, time.Now()) {
			t.Errorf("hard-denied address %s was allowed", raw)
		}
	}
	if !controller.allowsAddress("m-01020304", netip.MustParseAddr("8.8.8.8"), time.Now()) {
		t.Fatal("broad CIDR did not allow a public address outside the hard floor")
	}
}

func TestManagedEgressConfigValidation(t *testing.T) {
	cfg := validNehemiahConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid egress config rejected: %v", err)
	}
	for name, mutate := range map[string]func(*Config){
		"wrong listener":     func(cfg *Config) { cfg.EgressDNSListen = "0.0.0.0:53" },
		"private upstream":   func(cfg *Config) { cfg.EgressDNSUpstream = "10.0.0.2:53" },
		"hostname upstream":  func(cfg *Config) { cfg.EgressDNSUpstream = "dns.example.com:53" },
		"zero upstream port": func(cfg *Config) { cfg.EgressDNSUpstream = "9.9.9.9:0" },
		"alternate upstream": func(cfg *Config) { cfg.EgressDNSUpstream = "9.9.9.9:53" },
		"extra deny":         func(cfg *Config) { cfg.EgressDenyCIDRs = []string{"203.0.113.0/24"} },
		"malformed deny":     func(cfg *Config) { cfg.EgressDenyCIDRs = []string{"not-a-cidr"} },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := cfg
			mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("unsafe egress configuration was accepted")
			}
		})
	}
}

func TestInternalNetworkPolicyContractDefaultsOffAndPersists(t *testing.T) {
	var omitted internalCreateRequest
	if err := json.Unmarshal([]byte(`{"net":true,"lease_id":"lease-1"}`), &omitted); err != nil {
		t.Fatal(err)
	}
	policy, err := normalizeNetworkPolicy(omitted.NetworkPolicy)
	if err != nil || policy.declaration.Mode != egressModeOff {
		t.Fatalf("omitted network_policy = %+v, %v; want off", policy.declaration, err)
	}

	declaration := networkPolicyDeclaration{
		Mode:      egressModeAllowlist,
		Hostnames: []string{"api.example.test"},
		CIDRs:     []string{"8.8.8.8/32"},
	}
	legacyFingerprint := createFingerprint("python", 120, true, false, "lease-1", nil, 1, 256, 5120)
	if got := createFingerprintWithPolicy("python", 120, true, false, "lease-1", nil, 1, 256, 5120, networkPolicyDeclaration{Mode: egressModeOff}); got != legacyFingerprint {
		t.Fatalf("off-policy fingerprint changed across upgrade: %s != %s", got, legacyFingerprint)
	}
	if got := createFingerprintWithPolicy("python", 120, true, false, "lease-1", nil, 1, 256, 5120, declaration); got == legacyFingerprint {
		t.Fatal("allowlist did not participate in the idempotency fingerprint")
	}

	mgr := NewManager(internalTestConfig(t))
	mgr.mu.Lock()
	mgr.machines["m-01020304"] = &Machine{ID: "m-01020304", NetworkPolicy: declaration}
	snapshot := mgr.snapshotLocked()
	mgr.mu.Unlock()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var decoded machineStateSnapshot
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Machines) != 1 || !reflect.DeepEqual(decoded.Machines[0].NetworkPolicy, declaration) {
		t.Fatalf("persisted network policy = %+v", decoded.Machines)
	}
	view, err := json.Marshal((&Machine{NetworkPolicy: networkPolicyDeclaration{}}).InternalView())
	if err != nil || !bytes.Contains(view, []byte(`"network_policy":{"mode":"off"}`)) {
		t.Fatalf("off policy response = %s, %v", view, err)
	}

	cfg := internalTestConfig(t)
	server := NewServer(cfg, NewManager(cfg))
	request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken, bytes.NewBufferString(
		`{"net":false,"lease_id":"lease-1","network_policy":{"mode":"allowlist","hostnames":["api.example.test"]}}`,
	))
	request.Header.Set("Idempotency-Key", "policy-without-network")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || !bytes.Contains(response.Body.Bytes(), []byte(`"invalid_resources"`)) {
		t.Fatalf("allowlist without managed net response = %d %s", response.Code, response.Body.String())
	}
}

func TestManagedInternalCreateRejectsAllowlistBeforeBoot(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.NetEnable = true
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	mgr := NewManager(cfg)
	var boots atomic.Int32
	mgr.boot = func(cfg Config, id string, template Template, _ string, _ bool, network bool, diskMB int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, network: network, tap: tapName(id), ip: "10.200.0.10", diskMB: diskMB}, "coldboot", 2, nil
	}
	server := NewServer(cfg, mgr)
	payload := fmt.Sprintf(`{"template":"python","net":true,"persistent":true,"lease_id":"lease-policy-1","runtime_cohort_id":%q,"rootfs_sha256":%q,"network_policy":{"mode":"allowlist","cidrs":["8.8.8.9/24"]}}`, cfg.RuntimeCohort.ID, cfg.RuntimeCohort.PythonRootfsSHA256)
	request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken, bytes.NewBufferString(payload))
	request.Header.Set("Idempotency-Key", "create-policy-1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"invalid_resources"`)) || boots.Load() != 0 {
		t.Fatalf("managed allowlist response=%d boots=%d body=%s", response.Code, boots.Load(), response.Body.String())
	}
}

func TestManagedForkRejectsAllowlistSourceBeforeSnapshot(t *testing.T) {
	mgr, source, requested, _, _ := managedForkManager(t, func(context.Context, string) error { return nil })
	mgr.cfg.NehemiahMode = true
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.0/24"}})
	if err != nil {
		t.Fatal(err)
	}
	source.NetworkPolicy = policy.declaration
	var snapshots atomic.Int32
	mgr.createSnapshot = func(_ *fcDriver, _ string) (string, error) {
		snapshots.Add(1)
		return "", errors.New("snapshot must not run")
	}
	if _, _, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-policy-inheritance", requested); !errors.Is(err, ErrInvalidResources) {
		t.Fatalf("fork result = %v", err)
	}
	if snapshots.Load() != 0 {
		t.Fatalf("invalid managed policy reached snapshot %d time(s)", snapshots.Load())
	}
}

func TestManagedRecoveryRejectsPersistedAllowlist(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	persisted := persistedMachine{
		ID: "m-01020304",
		NetworkPolicy: networkPolicyDeclaration{
			Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.8/32"},
		},
		Runtime: &persistedRuntime{PID: 2, Network: true},
	}
	if validPersistedMachine(cfg, persisted, jailerIdentity{}) {
		t.Fatal("managed recovery accepted a persisted allowlist")
	}
}

func TestRestoredGuestUsesInterceptedBridgeDNS(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NetEnable = true
	cfg.NetSubnet = "10.211.7"
	mgr := NewManager(cfg)
	command, err := mgr.prepareForkReaddress("m-01020304", &fcDriver{}, true, "10.211.7.200", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(command, "nameserver 10.211.7.1") || strings.Contains(command, "nameserver 1.1.1.1") {
		t.Fatalf("restored guest DNS command bypasses interceptor: %q", command)
	}
}

func TestControlPlaneResolutionIsRequiredAndFloorSwapIsStaged(t *testing.T) {
	controller := newEgressController(Config{ControlPlaneURL: "https://control.example.test"})
	controller.resolve = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("203.0.113.44")}, nil
	}
	var commands []string
	controller.run = func(name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil, nil
	}
	if err := controller.refreshHardFloor(context.Background()); err != nil {
		t.Fatal(err)
	}
	add := slices.Index(commands, "ipset add neh_h4_next 203.0.113.44/32 -exist")
	swap := slices.Index(commands, "ipset swap neh_h4_next neh_hard4")
	if add < 0 || swap < 0 || add >= swap {
		t.Fatalf("control-plane floor was not staged before atomic swap: %v", commands)
	}
	if !controller.isHardDenied(netip.MustParseAddr("203.0.113.44")) {
		t.Fatal("resolved control-plane address missing from in-memory floor")
	}

	failed := newEgressController(Config{ControlPlaneURL: "https://control.example.test"})
	failed.resolve = func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("injected DNS outage") }
	var mutations int
	failed.run = func(string, ...string) ([]byte, error) { mutations++; return nil, nil }
	if err := failed.refreshHardFloor(context.Background()); err == nil || mutations != 0 {
		t.Fatalf("resolution failure = %v, mutations=%d; want fail closed before set mutation", err, mutations)
	}
	failed.resolve = func(context.Context, string) ([]netip.Addr, error) { return nil, nil }
	if err := failed.refreshHardFloor(context.Background()); err == nil {
		t.Fatal("empty control-plane resolution was accepted")
	}
}

func TestDNSLearningValidatesWholeAnswerAndClampsTTL(t *testing.T) {
	controller := testInstalledEgressController(t, []string{"api.example.test"})
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	controller.now = func() time.Time { return now }
	var commands []string
	controller.run = func(name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil, nil
	}
	if err := controller.learn("m-01020304", "api.example.test", []dnsLearnedAddress{
		{address: netip.MustParseAddr("8.8.8.8"), ttl: time.Second},
		{address: netip.MustParseAddr("10.0.0.1"), ttl: time.Minute},
	}); err == nil || len(commands) != 0 {
		t.Fatalf("mixed answer was partially installed: err=%v commands=%v", err, commands)
	}
	if err := controller.learn("m-01020304", "api.example.test", []dnsLearnedAddress{{address: netip.MustParseAddr("8.8.8.8"), ttl: time.Second}}); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || !strings.Contains(commands[0], "timeout 5") {
		t.Fatalf("minimum TTL was not applied to kernel set: %v", commands)
	}
	if !controller.allowsAddress("m-01020304", netip.MustParseAddr("8.8.8.8"), now.Add(4*time.Second)) || controller.allowsAddress("m-01020304", netip.MustParseAddr("8.8.8.8"), now.Add(6*time.Second)) {
		t.Fatal("learned address lifetime did not match the clamped TTL")
	}
	commands = nil
	if err := controller.learn("m-01020304", "api.example.test", []dnsLearnedAddress{{address: netip.MustParseAddr("1.1.1.1"), ttl: 24 * time.Hour}}); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || !strings.Contains(commands[0], "timeout 300") {
		t.Fatalf("maximum TTL was not applied to kernel set: %v", commands)
	}
}

func TestTapPolicyActivatesWithoutAllowAllWindow(t *testing.T) {
	controller := newEgressController(Config{NetSubnet: "10.200.0"})
	controller.resolve = func(context.Context, string) ([]netip.Addr, error) { return nil, nil }
	var commands []string
	dropPresent := false
	controller.run = func(name string, args ...string) ([]byte, error) {
		command := name + " " + strings.Join(args, " ")
		commands = append(commands, command)
		if name == "iptables" && len(args) > 0 {
			if args[0] == "-C" {
				if dropPresent {
					return nil, nil
				}
				return nil, errors.New("missing")
			}
			if args[0] == "-I" && args[len(args)-1] == "DROP" {
				dropPresent = true
			}
			if args[0] == "-D" {
				if args[len(args)-1] == "DROP" && dropPresent {
					dropPresent = false
					return nil, nil
				}
				return nil, errors.New("missing")
			}
		}
		return nil, nil
	}
	declaration := networkPolicyDeclaration{Mode: egressModeAllowlist, CIDRs: []string{"8.8.8.0/24"}}
	if err := controller.apply("m-01020304", "bt01020304", "10.200.0.10", declaration); err != nil {
		t.Fatal(err)
	}
	directDrop := commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1 -i bt01020304 -j DROP")
	activate := commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1 -i bt01020304 -j NEH_")
	hardDrop := commandIndexContaining(commands, "--match-set neh_hard4 dst -j DROP")
	sourceDrop := commandIndexContaining(commands, "! -s 10.200.0.10/32 -j DROP")
	bandwidth := commandIndexContaining(commands, "tc filter replace dev bt01020304 ingress")
	connectionCap := commandIndexContaining(commands, "--connlimit-above 128")
	cidrAccept := commandIndexContaining(commands, "--match-set neh_c_")
	finalDrop := commandIndexContaining(commands, "iptables -A NEH_")
	if directDrop < 0 || activate < 0 || sourceDrop < 0 || bandwidth < 0 || connectionCap < 0 || hardDrop < 0 || cidrAccept < 0 || directDrop >= activate || sourceDrop >= cidrAccept || hardDrop >= cidrAccept || finalDrop < 0 {
		t.Fatalf("unsafe tap policy command order: %v", commands)
	}
	if dropPresent {
		t.Fatal("direct DROP remained after a fully installed policy")
	}
}

func TestManagedHostnamePolicyIsRejectedWithTapClosed(t *testing.T) {
	controller := newEgressController(Config{NehemiahMode: true, NetSubnet: "10.200.0"})
	var commands []string
	dropPresent := false
	controller.run = func(name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		if name == "iptables" && len(args) > 0 {
			switch args[0] {
			case "-C":
				if dropPresent {
					return nil, nil
				}
				return nil, errors.New("missing")
			case "-I":
				if args[len(args)-1] == "DROP" {
					dropPresent = true
				}
			case "-D":
				return nil, errors.New("missing")
			}
		}
		return nil, nil
	}
	err := controller.apply(
		"m-01020304",
		"bt01020304",
		"10.200.0.10",
		networkPolicyDeclaration{Mode: egressModeAllowlist, Hostnames: []string{"api.example.test"}},
	)
	if err == nil || !strings.Contains(err.Error(), "connection-aware") {
		t.Fatalf("managed hostname policy error = %v", err)
	}
	if !dropPresent || commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1 -i bt01020304 -j DROP") < 0 || commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1 -i bt01020304 -j NEH_") >= 0 {
		t.Fatalf("managed hostname rejection did not leave a direct DROP: %v", commands)
	}
}

func TestPolicyAndLearningFailuresForceTapClosed(t *testing.T) {
	controller := newEgressController(Config{ControlPlaneURL: "https://control.example.test", NetSubnet: "10.200.0"})
	controller.resolve = func(context.Context, string) ([]netip.Addr, error) {
		return nil, errors.New("injected resolver outage")
	}
	var commands []string
	dropPresent := false
	controller.run = func(name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		if name == "iptables" && len(args) > 0 && args[0] == "-C" {
			if dropPresent {
				return nil, nil
			}
			return nil, errors.New("missing")
		}
		if name == "iptables" && len(args) > 0 && args[0] == "-I" && args[len(args)-1] == "DROP" {
			dropPresent = true
		}
		if name == "iptables" && len(args) > 0 && args[0] == "-D" {
			return nil, errors.New("missing")
		}
		return nil, nil
	}
	if err := controller.apply("m-01020304", "bt01020304", "10.200.0.10", networkPolicyDeclaration{Mode: egressModeAllowlist, Hostnames: []string{"api.example.test"}}); err == nil {
		t.Fatal("policy activated despite control-plane resolution failure")
	}
	if !dropPresent || commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1 -i bt01020304 -j DROP") < 0 || commandIndexContaining(commands, "-j NEH_") >= 0 {
		t.Fatalf("policy failure did not leave direct DROP: %v", commands)
	}

	learn := testInstalledEgressController(t, []string{"api.example.test"})
	commands = nil
	dropPresent = false
	learn.run = func(name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		if name == "ipset" && len(args) > 0 && args[0] == "add" {
			return []byte("injected failure"), errors.New("injected ipset failure")
		}
		if name == "iptables" && len(args) > 0 && args[0] == "-C" {
			return nil, errors.New("missing")
		}
		if name == "iptables" && len(args) > 0 && args[0] == "-I" && args[len(args)-1] == "DROP" {
			dropPresent = true
		}
		return nil, nil
	}
	if err := learn.learn("m-01020304", "api.example.test", []dnsLearnedAddress{{address: netip.MustParseAddr("8.8.8.8"), ttl: time.Minute}}); err == nil {
		t.Fatal("kernel learning failure was returned as success")
	}
	if !dropPresent || commandIndexContaining(commands, "iptables -I NEHEMIAH_FWD 1") < 0 {
		t.Fatalf("learning failure did not force tap closed: %v", commands)
	}
}

func TestDNSInterceptorAllowsValidatedAnswerAndRejectsRebinding(t *testing.T) {
	server, controller := testDNSServer(t, []string{"api.example.test"})
	query := testDNSQuery(t, "api.example.test", dnsmessage.TypeA)
	call := 0
	server.exchange = func(_ context.Context, raw []byte) ([]byte, error) {
		call++
		if call == 1 {
			return testDNSResponse(t, raw, []dnsmessage.Resource{testAResource(t, "api.example.test", "8.8.8.8", 1)}), nil
		}
		return testDNSResponse(t, raw, []dnsmessage.Resource{
			testAResource(t, "api.example.test", "8.8.8.8", 60),
			testAResource(t, "api.example.test", "169.254.169.254", 60),
		}), nil
	}
	first := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
	if first.RCode != dnsmessage.RCodeSuccess || len(first.Answers) != 1 || first.Answers[0].Header.TTL != 5 {
		t.Fatalf("validated response = %#v", first)
	}
	if !controller.allowsAddress("m-01020304", netip.MustParseAddr("8.8.8.8"), controller.now().Add(4*time.Second)) {
		t.Fatal("validated public answer was not learned")
	}
	second := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
	if second.RCode != dnsmessage.RCodeServerFailure || len(second.Answers) != 0 {
		t.Fatalf("mixed rebinding response was not rejected atomically: %#v", second)
	}
	if controller.allowsAddress("m-01020304", netip.MustParseAddr("169.254.169.254"), controller.now()) {
		t.Fatal("rebinding answer opened metadata access")
	}
}

func TestCIDRPolicyAllowsDNSOnlyWhenEveryAnswerFits(t *testing.T) {
	server, controller := testDNSServerForPolicy(t, networkPolicyDeclaration{
		Mode:  egressModeAllowlist,
		CIDRs: []string{"8.8.8.0/24"},
	})
	query := testDNSQuery(t, "api.example.test", dnsmessage.TypeA)
	call := 0
	server.exchange = func(_ context.Context, raw []byte) ([]byte, error) {
		call++
		address := "8.8.8.8"
		if call == 2 {
			address = "1.1.1.1"
		}
		return testDNSResponse(t, raw, []dnsmessage.Resource{
			testAResource(t, "api.example.test", address, 60),
		}), nil
	}
	allowed := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
	if allowed.RCode != dnsmessage.RCodeSuccess || len(allowed.Answers) != 1 {
		t.Fatalf("CIDR-contained DNS answer = %#v", allowed)
	}
	if !controller.allowsAddress("m-01020304", netip.MustParseAddr("8.8.8.8"), controller.now()) {
		t.Fatal("explicit CIDR did not authorize its address")
	}
	refused := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
	if refused.RCode != dnsmessage.RCodeRefused || len(refused.Answers) != 0 {
		t.Fatalf("DNS answer outside the explicit CIDR was accepted: %#v", refused)
	}
}

func TestDNSInterceptorValidatesCNAMEChainAndSourcePolicy(t *testing.T) {
	server, controller := testDNSServer(t, []string{"api.example.test"})
	query := testDNSQuery(t, "api.example.test", dnsmessage.TypeA)
	server.exchange = func(_ context.Context, raw []byte) ([]byte, error) {
		return testDNSResponse(t, raw, []dnsmessage.Resource{
			testCNAMEResource(t, "api.example.test", "edge.example.net", 30),
			testAResource(t, "edge.example.net", "1.1.1.1", 120),
		}), nil
	}
	response := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
	if response.RCode != dnsmessage.RCodeSuccess || len(response.Answers) != 2 || response.Answers[1].Header.TTL != 30 {
		t.Fatalf("CNAME response = %#v", response)
	}
	if !controller.allowsAddress("m-01020304", netip.MustParseAddr("1.1.1.1"), controller.now().Add(29*time.Second)) || controller.allowsAddress("m-01020304", netip.MustParseAddr("1.1.1.1"), controller.now().Add(31*time.Second)) {
		t.Fatal("learned CNAME address did not use the chain's shortest TTL")
	}

	var upstreamCalls int
	server.exchange = func(context.Context, []byte) ([]byte, error) {
		upstreamCalls++
		return nil, errors.New("must not be called")
	}
	disallowed := testDNSQuery(t, "other.example.test", dnsmessage.TypeA)
	refused := unpackDNSResponse(t, server.handle(disallowed, netip.MustParseAddr("10.200.0.42")))
	unknownSource := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.99")))
	if refused.RCode != dnsmessage.RCodeRefused || unknownSource.RCode != dnsmessage.RCodeRefused || upstreamCalls != 0 {
		t.Fatalf("policy/source refusal failed: refused=%s unknown=%s calls=%d", refused.RCode, unknownSource.RCode, upstreamCalls)
	}
}

func TestDNSInterceptorRejectsMalformedChainsAndMappedPrivateAAAA(t *testing.T) {
	tests := []struct {
		name    string
		qtype   dnsmessage.Type
		answers func(*testing.T) []dnsmessage.Resource
	}{
		{
			name:  "unrelated address",
			qtype: dnsmessage.TypeA,
			answers: func(t *testing.T) []dnsmessage.Resource {
				return []dnsmessage.Resource{testAResource(t, "attacker.example.test", "8.8.8.8", 60)}
			},
		},
		{
			name:  "CNAME loop",
			qtype: dnsmessage.TypeA,
			answers: func(t *testing.T) []dnsmessage.Resource {
				return []dnsmessage.Resource{
					testCNAMEResource(t, "api.example.test", "edge.example.net", 60),
					testCNAMEResource(t, "edge.example.net", "api.example.test", 60),
				}
			},
		},
		{
			name:  "IPv4-mapped metadata AAAA",
			qtype: dnsmessage.TypeAAAA,
			answers: func(t *testing.T) []dnsmessage.Resource {
				return []dnsmessage.Resource{testAAAAResource(t, "api.example.test", "::ffff:169.254.169.254", 60)}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, _ := testDNSServer(t, []string{"api.example.test"})
			query := testDNSQuery(t, "api.example.test", test.qtype)
			server.exchange = func(_ context.Context, raw []byte) ([]byte, error) {
				return testDNSResponse(t, raw, test.answers(t)), nil
			}
			response := unpackDNSResponse(t, server.handle(query, netip.MustParseAddr("10.200.0.42")))
			if response.RCode != dnsmessage.RCodeServerFailure || len(response.Answers) != 0 {
				t.Fatalf("unsafe response accepted: %#v", response)
			}
		})
	}
}

func testInstalledEgressController(t *testing.T, hostnames []string) *egressController {
	t.Helper()
	controller := newEgressController(Config{})
	policy, err := normalizeNetworkPolicy(networkPolicyDeclaration{Mode: egressModeAllowlist, Hostnames: hostnames})
	if err != nil {
		t.Fatal(err)
	}
	controller.installed["m-01020304"] = installedEgressPolicy{machineID: "m-01020304", tap: tapName("m-01020304"), policy: policy}
	controller.learned["m-01020304"] = make(map[netip.Addr]learnedEgressAddress)
	return controller
}

func testDNSServer(t *testing.T, hostnames []string) (*egressDNSServer, *egressController) {
	return testDNSServerForPolicy(t, networkPolicyDeclaration{Mode: egressModeAllowlist, Hostnames: hostnames})
}

func testDNSServerForPolicy(t *testing.T, declaration networkPolicyDeclaration) (*egressDNSServer, *egressController) {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NetSubnet = "10.200.0"
	mgr := NewManager(cfg)
	mgr.mu.Lock()
	mgr.machines["m-01020304"] = &Machine{
		ID:     "m-01020304",
		driver: &fcDriver{network: true, tap: tapName("m-01020304"), ip: "10.200.0.42"},
	}
	mgr.mu.Unlock()
	controller := newEgressController(Config{})
	policy, err := normalizeNetworkPolicy(declaration)
	if err != nil {
		t.Fatal(err)
	}
	controller.installed["m-01020304"] = installedEgressPolicy{machineID: "m-01020304", tap: tapName("m-01020304"), policy: policy}
	controller.learned["m-01020304"] = make(map[netip.Addr]learnedEgressAddress)
	controller.now = func() time.Time { return time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC) }
	controller.run = func(string, ...string) ([]byte, error) { return nil, nil }
	mgr.egress = controller
	return newEgressDNSServer(cfg, mgr, controller), controller
}

func testDNSQuery(t *testing.T, hostname string, qtype dnsmessage.Type) []byte {
	t.Helper()
	name, err := dnsmessage.NewName(hostname + ".")
	if err != nil {
		t.Fatal(err)
	}
	packed, err := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 0x1234, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: name, Type: qtype, Class: dnsmessage.ClassINET}},
	}).Pack()
	if err != nil {
		t.Fatal(err)
	}
	return packed
}

func testDNSResponse(t *testing.T, requestBytes []byte, answers []dnsmessage.Resource) []byte {
	t.Helper()
	var request dnsmessage.Message
	if err := request.Unpack(requestBytes); err != nil {
		t.Fatal(err)
	}
	packed, err := (&dnsmessage.Message{
		Header: dnsmessage.Header{
			ID:                 request.ID,
			Response:           true,
			RecursionDesired:   request.RecursionDesired,
			RecursionAvailable: true,
		},
		Questions: request.Questions,
		Answers:   answers,
	}).Pack()
	if err != nil {
		t.Fatal(err)
	}
	return packed
}

func testAResource(t *testing.T, owner, address string, ttl uint32) dnsmessage.Resource {
	t.Helper()
	name, err := dnsmessage.NewName(owner + ".")
	if err != nil {
		t.Fatal(err)
	}
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: name, Class: dnsmessage.ClassINET, TTL: ttl},
		Body:   &dnsmessage.AResource{A: netip.MustParseAddr(address).As4()},
	}
}

func testAAAAResource(t *testing.T, owner, address string, ttl uint32) dnsmessage.Resource {
	t.Helper()
	name, err := dnsmessage.NewName(owner + ".")
	if err != nil {
		t.Fatal(err)
	}
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: name, Class: dnsmessage.ClassINET, TTL: ttl},
		Body:   &dnsmessage.AAAAResource{AAAA: netip.MustParseAddr(address).As16()},
	}
}

func testCNAMEResource(t *testing.T, owner, target string, ttl uint32) dnsmessage.Resource {
	t.Helper()
	ownerName, err := dnsmessage.NewName(owner + ".")
	if err != nil {
		t.Fatal(err)
	}
	targetName, err := dnsmessage.NewName(target + ".")
	if err != nil {
		t.Fatal(err)
	}
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: ownerName, Class: dnsmessage.ClassINET, TTL: ttl},
		Body:   &dnsmessage.CNAMEResource{CNAME: targetName},
	}
}

func unpackDNSResponse(t *testing.T, raw []byte) dnsmessage.Message {
	t.Helper()
	var response dnsmessage.Message
	if err := response.Unpack(raw); err != nil {
		t.Fatal(err)
	}
	return response
}

func commandIndexContaining(commands []string, needle string) int {
	for index, command := range commands {
		if strings.Contains(command, needle) {
			return index
		}
	}
	return -1
}

func Example_networkPolicyDeclaration() {
	policy, _ := normalizeNetworkPolicy(networkPolicyDeclaration{
		Mode:      "allowlist",
		Hostnames: []string{"api.example.com"},
		CIDRs:     []string{"8.8.8.8/32"},
	})
	fmt.Println(policy.declaration.Mode, policy.declaration.Hostnames, policy.declaration.CIDRs)
	// Output: allowlist [api.example.com] [8.8.8.8/32]
}

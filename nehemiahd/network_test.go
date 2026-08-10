package main

import (
	"fmt"
	"reflect"
	"sync"
	"testing"
)

func TestTapBridgeIsolationCommandsAreFailClosed(t *testing.T) {
	commands, err := tapBridgeIsolationCommands("bt0123abcd", "boring0", "06:00:01:02:03:04")
	if err != nil {
		t.Fatal(err)
	}
	want := []networkCommand{
		{name: "ip", args: []string{"link", "set", "bt0123abcd", "down"}},
		{name: "ip", args: []string{"link", "set", "bt0123abcd", "master", "boring0"}},
		{name: "bridge", args: []string{"link", "set", "dev", "bt0123abcd", "isolated", "on", "locked", "on", "learning", "off", "flood", "off", "guard", "on", "hairpin", "off"}},
		{name: "bridge", args: []string{"fdb", "replace", "06:00:01:02:03:04", "dev", "bt0123abcd", "master", "static"}},
	}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %#v, want %#v", commands, want)
	}
}

func TestTapBridgeIsolationCommandsRejectUnsafeIdentity(t *testing.T) {
	tests := []struct {
		name   string
		bridge string
		mac    string
	}{
		{name: "../../eth0", bridge: "boring0", mac: "06:00:01:02:03:04"},
		{name: "bt0123abcd", bridge: "../../br0", mac: "06:00:01:02:03:04"},
		{name: "bt0123abcd", bridge: "boring0", mac: "not-a-mac"},
		{name: "bt0123abcd", bridge: "boring0", mac: "ff:ff:ff:ff:ff:ff"},
		{name: "bt0123abcd", bridge: "boring0", mac: "00:00:01:02:03:04"},
	}
	for _, test := range tests {
		if _, err := tapBridgeIsolationCommands(test.name, test.bridge, test.mac); err == nil {
			t.Errorf("unsafe identity accepted: %+v", test)
		}
	}
}

func TestGuestNeighborCommandsPinExpectedTapAndMAC(t *testing.T) {
	commands, err := guestNeighborCommands("bt0123abcd", "boring0", "10.200.0", "10.200.0.42", "06:00:01:02:03:04")
	if err != nil {
		t.Fatal(err)
	}
	want := []networkCommand{
		{name: "bridge", args: []string{"fdb", "replace", "06:00:01:02:03:04", "dev", "bt0123abcd", "master", "static"}},
		{name: "ip", args: []string{"neigh", "replace", "10.200.0.42", "lladdr", "06:00:01:02:03:04", "nud", "permanent", "dev", "boring0"}},
	}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %#v, want %#v", commands, want)
	}
	for _, address := range []string{"10.200.0.0", "10.200.0.1", "10.200.0.255", "10.200.1.42", "169.254.169.254", "not-an-ip"} {
		if _, err := guestNeighborCommands("bt0123abcd", "boring0", "10.200.0", address, "06:00:01:02:03:04"); err == nil {
			t.Errorf("unsafe neighbor address %q accepted", address)
		}
	}
}

func TestForeignClaimsCannotSelectAnotherTap(t *testing.T) {
	const victimMAC = "06:00:01:02:03:04"
	if !fdbSelectsTap([]byte(victimMAC+" dev bt-victim master boring0 static\n"), "bt-victim", "boring0") {
		t.Fatal("expected static victim FDB binding was rejected")
	}
	if fdbSelectsTap([]byte(victimMAC+" dev bt-attacker master boring0 static\n"), "bt-victim", "boring0") {
		t.Fatal("foreign tap was accepted as the victim FDB selection")
	}
	if !neighborPermanentlyBinds([]byte("10.200.0.42 dev boring0 lladdr "+victimMAC+" PERMANENT\n"), victimMAC) {
		t.Fatal("expected permanent neighbor was rejected")
	}
	if neighborPermanentlyBinds([]byte("10.200.0.42 dev boring0 lladdr 06:00:aa:bb:cc:dd REACHABLE\n"), victimMAC) {
		t.Fatal("forged mutable neighbor was accepted")
	}
}

func TestConcurrentForkBatchesReserveUniqueIPs(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NetSubnet = "10.200.0"
	mgr := NewManager(cfg)

	const batchCount = 8
	const batchSize = 4
	results := make(chan []string, batchCount)
	var wait sync.WaitGroup
	for batch := 0; batch < batchCount; batch++ {
		batch := batch
		wait.Add(1)
		go func() {
			defer wait.Done()
			mgr.mu.Lock()
			ips := mgr.allocForkIPsLocked(batchSize)
			if len(ips) == batchSize {
				for index, ip := range ips {
					id := fmt.Sprintf("m-%08x", batch*batchSize+index+1)
					mgr.machines[id] = &Machine{ID: id, reservedIP: ip}
				}
			}
			mgr.mu.Unlock()
			results <- ips
		}()
	}
	wait.Wait()
	close(results)

	seen := make(map[string]struct{}, batchCount*batchSize)
	for batch := range results {
		if len(batch) != batchSize {
			t.Fatalf("batch reservation size = %d, want %d", len(batch), batchSize)
		}
		for _, ip := range batch {
			if _, duplicate := seen[ip]; duplicate {
				t.Fatalf("concurrent batches reused static IP %s", ip)
			}
			seen[ip] = struct{}{}
		}
	}
	if len(seen) != batchCount*batchSize {
		t.Fatalf("unique reservations = %d, want %d", len(seen), batchCount*batchSize)
	}
}

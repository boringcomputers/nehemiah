package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func managedNetworkTestConfig(t *testing.T) Config {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.JailerEnable = true
	cfg.NetEnable = true
	cfg.NetBridge = "br-nehemiah"
	cfg.NetSubnet = "10.211.7"
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	return cfg
}

// startManagedExecVsock emulates Firecracker's host-initiated vsock UDS and one
// successful guest-agent exec. The lifecycle code must use this channel even
// when the restored driver has no serial console.
func startManagedExecVsock(t *testing.T, received chan<- guestAgentFrame) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "vsock.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		line, readErr := reader.ReadString('\n')
		if readErr != nil || line != "CONNECT 2222\n" {
			t.Errorf("vsock handshake line=%q err=%v", line, readErr)
			return
		}
		if _, writeErr := conn.Write([]byte("OK 2222\n")); writeErr != nil {
			t.Errorf("vsock handshake response: %v", writeErr)
			return
		}
		request, frameErr := readGuestFrame(&bufferedConn{Conn: conn, reader: reader})
		if frameErr != nil {
			t.Errorf("read managed readdress exec: %v", frameErr)
			return
		}
		received <- request
		code := 0
		if frameErr := writeGuestFrame(conn, guestAgentFrame{Type: guestFrameResult, ExitCode: &code}); frameErr != nil {
			t.Errorf("write managed readdress result: %v", frameErr)
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("managed exec vsock did not stop")
		}
	})
	return socket
}

func stubManagedHostNetwork(mgr *Manager, attached, pinned *atomic.Int32) {
	mgr.attachRestoredTap = func(tap, bridge, mac string, denyEgress bool) error {
		if tap == "" || bridge != mgr.cfg.NetBridge || mac == "" || !denyEgress {
			return errors.New("invalid managed tap attachment")
		}
		attached.Add(1)
		return nil
	}
	mgr.pinRestoredNeighbor = func(tap, bridge, subnet, address, mac string) error {
		if tap == "" || bridge != mgr.cfg.NetBridge || subnet != mgr.cfg.NetSubnet || address == "" || mac == "" {
			return errors.New("invalid managed neighbor binding")
		}
		pinned.Add(1)
		return nil
	}
	// The off policy only verifies that the fail-closed tap DROP exists. Return
	// not-found for cleanup deletions so the test runner never loops externally.
	mgr.egress.run = func(_ string, args ...string) ([]byte, error) {
		for _, arg := range args {
			if arg == "-D" {
				return nil, errors.New("absent")
			}
		}
		return nil, nil
	}
}

func assertReaddressCommand(t *testing.T, request guestAgentFrame, id, address string) {
	t.Helper()
	if request.Type != guestFrameExec || request.Version != guestAgentProtocolVersion || request.TimeoutMS != 5000 {
		t.Fatalf("managed readdress request = %#v", request)
	}
	for _, expected := range []string{guestMAC(id), address, "ip link set eth0 down", "ip route replace default"} {
		if !strings.Contains(request.Command, expected) {
			t.Fatalf("managed readdress command %q missing %q", request.Command, expected)
		}
	}
}

func TestManagedReaddressAfterDriverReattachmentUsesLeaseBoundGuestAgent(t *testing.T) {
	cfg := managedNetworkTestConfig(t)
	mgr := NewManager(cfg)
	var attached, pinned atomic.Int32
	stubManagedHostNetwork(mgr, &attached, &pinned)
	received := make(chan guestAgentFrame, 1)
	id, lease, address := "m-01020304", "lease-current", "10.211.7.207"
	driver := &fcDriver{id: id, cfg: cfg, tap: tapName(id), vsockUDS: startManagedExecVsock(t, received)}
	mgr.mu.Lock()
	mgr.machines[id] = &Machine{
		ID: id, LeaseID: lease, Status: "running", Ready: true,
		reservedIP: address, driver: driver, // console=nil mirrors restart reattachment.
	}
	mgr.mu.Unlock()

	if err := mgr.readdressManagedFork(id, driver, true, address); err != nil {
		t.Fatal(err)
	}
	assertReaddressCommand(t, <-received, id, address)
	if driver.console != nil || attached.Load() != 1 || pinned.Load() != 1 {
		t.Fatalf("console=%v attached=%d pinned=%d", driver.console, attached.Load(), pinned.Load())
	}

	replacedClient := newManagedDriverGuestAgentClient(mgr, id, lease, driver)
	mgr.mu.Lock()
	original := mgr.machines[id]
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "booting"}
	mgr.mu.Unlock()
	if err := replacedClient.Ping(context.Background(), id); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("replaced-machine client error = %v", err)
	}

	mgr.mu.Lock()
	mgr.machines[id] = original
	mgr.mu.Unlock()
	client := newManagedDriverGuestAgentClient(mgr, id, lease, driver)
	mgr.mu.Lock()
	mgr.machines[id].LeaseID = "replacement-lease"
	mgr.mu.Unlock()
	if err := client.Ping(context.Background(), id); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("stale lease-bound client error = %v", err)
	}
}

type countingConsoleWriter struct{ writes atomic.Int32 }

func (w *countingConsoleWriter) Write(p []byte) (int, error) {
	w.writes.Add(1)
	return len(p), nil
}
func (*countingConsoleWriter) Close() error { return nil }

func TestManagedReaddressFailsClosedWithoutSerialFallback(t *testing.T) {
	cfg := managedNetworkTestConfig(t)
	mgr := NewManager(cfg)
	mgr.managedReaddressTimeout = 25 * time.Millisecond
	var attached, pinned atomic.Int32
	stubManagedHostNetwork(mgr, &attached, &pinned)
	id, lease, address := "m-11111111", "lease-current", "10.211.7.208"
	serial := &countingConsoleWriter{}
	driver := &fcDriver{
		id: id, cfg: cfg, tap: tapName(id), vsockUDS: filepath.Join(t.TempDir(), "missing.sock"),
		console: newConsole(serial),
	}
	mgr.mu.Lock()
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "booting", reservedIP: address, driver: driver}
	mgr.mu.Unlock()

	if err := mgr.readdressManagedFork(id, driver, true, address); err == nil {
		t.Fatal("managed readdress succeeded without its guest-agent channel")
	}
	if serial.writes.Load() != 0 || attached.Load() != 0 || pinned.Load() != 0 {
		t.Fatalf("managed fallback escaped: serial=%d attached=%d pinned=%d", serial.writes.Load(), attached.Load(), pinned.Load())
	}
}

func TestManagedForkReaddressesNilConsoleChildrenThroughGuestAgent(t *testing.T) {
	mgr, source, requested, snapshots, boots := managedForkManager(t, func(context.Context, string) error { return nil })
	mgr.cfg.NehemiahMode = true
	mgr.cfg.JailerEnable = true
	mgr.cfg.NetEnable = true
	mgr.cfg.NetBridge = "br-nehemiah"
	mgr.cfg.NetSubnet = "10.211.7"
	mgr.cgroups.enabled = true
	mgr.cgroups.cfg = mgr.cfg
	mgr.egress.cfg = mgr.cfg
	source.driver.tap = tapName(source.ID)
	var attached, pinned atomic.Int32
	stubManagedHostNetwork(mgr, &attached, &pinned)
	received := make(chan guestAgentFrame, len(requested))
	originalBoot := mgr.boot
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		driver, mode, bootMS, err := originalBoot(cfg, id, template, snapshot, restoreNet, network, diskMB)
		if err == nil {
			driver.tap = tapName(id)
			driver.vsockUDS = startManagedExecVsock(t, received)
			driver.console = nil
		}
		return driver, mode, bootMS, err
	}

	children, replayed, err := mgr.ForkInternal(source.ID, source.LeaseID, "fork-network-readdress", requested)
	if err != nil || replayed || len(children) != len(requested) {
		t.Fatalf("managed fork children=%d replayed=%v err=%v", len(children), replayed, err)
	}
	if snapshots.Load() != 1 || boots.Load() != int32(len(requested)) || attached.Load() != int32(len(requested)) || pinned.Load() != int32(len(requested)) {
		t.Fatalf("snapshots=%d boots=%d attached=%d pinned=%d", snapshots.Load(), boots.Load(), attached.Load(), pinned.Load())
	}
	for _, child := range children {
		if child.driver == nil || child.driver.console != nil || child.driver.ip == "" {
			t.Fatalf("managed child did not retain nil-console guest identity: %+v", child)
		}
		assertReaddressCommand(t, <-received, child.ID, child.driver.ip)
	}
}

func TestManagedNetworkTemplateReaddressesBeforePublishingNilConsoleDriver(t *testing.T) {
	cfg := managedNetworkTestConfig(t)
	cfg.TemplatesDir = t.TempDir()
	templateName := "published-network"
	templateDir := filepath.Join(cfg.TemplatesDir, templateName)
	if err := os.MkdirAll(templateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := []byte(`{"mem_size_mb":256,"vcpus":1,"vsock":true,"display":false,"had_nic":true,"source_template":"python"}`)
	if err := os.WriteFile(filepath.Join(templateDir, "meta.json"), meta, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"snapshot_file", "mem_file"} {
		if err := os.WriteFile(filepath.Join(templateDir, name), []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	mgr := NewManager(cfg)
	mgr.cgroups.enabled = true
	var attached, pinned atomic.Int32
	stubManagedHostNetwork(mgr, &attached, &pinned)
	received := make(chan guestAgentFrame, 1)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	mgr.boot = func(gotCfg Config, id string, template Template, snapshot string, restoreNet, network bool, _ int) (*fcDriver, string, int64, error) {
		if gotCfg.NehemiahMode != true || snapshot != templateDir || !restoreNet || !network || !template.RestoreNet {
			t.Fatalf("managed template boot cfg=%v snapshot=%q restore=%v network=%v template=%+v", gotCfg.NehemiahMode, snapshot, restoreNet, network, template)
		}
		return &fcDriver{
			cfg: gotCfg, id: id, tpl: template, jailed: true, network: true, tap: tapName(id),
			vsockUDS: startManagedExecVsock(t, received), startedAt: time.Now().UTC(),
		}, "snapshot", 3, nil
	}

	machine, replayed, err := mgr.CreateInternal(templateName, 120, true, true, "internal", "template-network-create", "template-lease", nil, 0, 0, 0)
	if err != nil || replayed || machine == nil {
		t.Fatalf("managed template create machine=%v replayed=%v err=%v", machine, replayed, err)
	}
	if machine.driver == nil || machine.driver.console != nil || machine.Mode != "snapshot" || attached.Load() != 1 || pinned.Load() != 1 {
		t.Fatalf("managed template result=%+v attached=%d pinned=%d", machine, attached.Load(), pinned.Load())
	}
	request := <-received
	assertReaddressCommand(t, request, machine.ID, machine.driver.ip)
	if bytes.Contains(request.Data, []byte("template-lease")) || strings.Contains(request.Command, "template-lease") {
		t.Fatal("lease credential was sent into the guest command")
	}
}

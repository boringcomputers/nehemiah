package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func managedShellHeaders(cfg Config, lease string) http.Header {
	return http.Header{
		"Authorization":       {"Bearer " + cfg.Token},
		"X-Nehemiah-Lease-ID": {lease},
	}
}

func persistManagedAgentLeaseFixture(t *testing.T, mgr *Manager, machine *Machine) (time.Time, *time.Timer, []byte) {
	t.Helper()
	expiresAt := time.Now().UTC().Add(90 * time.Second)
	timer := time.AfterFunc(time.Until(expiresAt), func() {})
	machine.ExpiresAt = expiresAt
	machine.timer = timer
	machine.Persistent = false
	mgr.mu.Lock()
	mgr.machines[machine.ID] = machine
	err := mgr.persistRequiredLocked()
	mgr.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	state, err := os.ReadFile(mgr.cfg.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		timer.Stop()
		mgr.mu.Lock()
		if current := mgr.machines[machine.ID]; current != nil && current.timer != nil {
			current.timer.Stop()
		}
		mgr.mu.Unlock()
	})
	return expiresAt, timer, state
}

func managedAgentLeaseMutation(mgr *Manager, id string, expiresAt time.Time, timer *time.Timer, persisted []byte) error {
	mgr.mu.Lock()
	machine := mgr.machines[id]
	if machine == nil {
		mgr.mu.Unlock()
		return errors.New("managed agent removed the machine")
	}
	gotExpiry := machine.ExpiresAt
	gotTimer := machine.timer
	mgr.mu.Unlock()
	if !gotExpiry.Equal(expiresAt) {
		return fmt.Errorf("managed agent changed authoritative expiry: got=%s want=%s", gotExpiry, expiresAt)
	}
	if gotTimer != timer {
		return errors.New("managed agent replaced the authoritative expiry timer")
	}
	state, err := os.ReadFile(mgr.cfg.StatePath)
	if err != nil {
		return err
	}
	if !bytes.Equal(state, persisted) {
		return errors.New("managed agent rewrote persisted lease state")
	}
	return nil

}

func assertManagedAgentLeaseUnchanged(t *testing.T, mgr *Manager, id string, expiresAt time.Time, timer *time.Timer, persisted []byte) {
	t.Helper()
	if err := managedAgentLeaseMutation(mgr, id, expiresAt, timer, persisted); err != nil {
		t.Fatal(err)
	}
}

func TestManagedAgentRoutesCheckAuthLeaseAndRejectGoalQueries(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	id, lease := "m-01020304", "lease-current"
	mgr := NewManager(cfg)
	mgr.mu.Lock()
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	mgr.mu.Unlock()
	server := NewServer(cfg, mgr)

	for _, route := range []string{"shell-agent", "agent"} {
		for _, test := range []struct {
			name    string
			token   string
			lease   string
			want    int
			contain string
		}{
			{name: "missing gateway token", lease: lease, want: http.StatusUnauthorized, contain: "unauthorized"},
			{name: "missing lease", token: cfg.Token, want: http.StatusUnauthorized, contain: "lease_required"},
			{name: "stale lease", token: cfg.Token, lease: "stale-lease", want: http.StatusConflict, contain: "lease_mismatch"},
			{name: "goal query", token: cfg.Token, lease: lease, want: http.StatusBadRequest, contain: "goal_query_not_allowed"},
		} {
			t.Run(route+"/"+test.name, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, "/v1/machines/"+id+"/"+route+"?goal=customer-secret", nil)
				if test.token != "" {
					request.Header.Set("Authorization", "Bearer "+test.token)
				}
				if test.lease != "" {
					request.Header.Set("X-Nehemiah-Lease-ID", test.lease)
				}
				response := httptest.NewRecorder()
				server.ServeHTTP(response, request)
				if response.Code != test.want || !bytes.Contains(response.Body.Bytes(), []byte(test.contain)) {
					t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestShellAgentStartFrameValidation(t *testing.T) {
	valid, err := json.Marshal(shellAgentStart{Type: "start", Version: 1, Goal: " build a site "})
	if err != nil {
		t.Fatal(err)
	}
	goal, err := parseShellAgentStart(websocket.TextMessage, valid)
	if err != nil || goal != "build a site" {
		t.Fatalf("goal=%q err=%v", goal, err)
	}
	for _, test := range []struct {
		name        string
		messageType int
		payload     []byte
	}{
		{name: "binary", messageType: websocket.BinaryMessage, payload: valid},
		{name: "wrong type", messageType: websocket.TextMessage, payload: []byte(`{"type":"go","version":1,"goal":"x"}`)},
		{name: "wrong version", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":2,"goal":"x"}`)},
		{name: "missing goal", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":1}`)},
		{name: "unknown field", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":1,"goal":"x","extra":true}`)},
		{name: "oversized goal", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":1,"goal":"` + strings.Repeat("x", shellAgentGoalLimit+1) + `"}`)},
		{name: "oversized frame", messageType: websocket.TextMessage, payload: bytes.Repeat([]byte("x"), agentControlFrameLimit+1)},
		{name: "invalid UTF-8", messageType: websocket.TextMessage, payload: []byte{'{', '"', 'g', 'o', 'a', 'l', '"', ':', '"', 0xff, '"', '}'}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseShellAgentStart(test.messageType, test.payload); err == nil {
				t.Fatal("invalid start frame accepted")
			}
		})
	}
}

func TestManagedShellAgentAfterRestartUsesLeaseBoundGuestPTYWithNilConsole(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	cfg.AgentMaxSteps = 2
	cfg.AgentMaxConcurrent = 2
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	id, lease := "m-01020304", "lease-current"
	received := make(chan guestAgentFrame, 1)
	driver := &fcDriver{id: id, cfg: cfg, console: nil, vsockUDS: startManagedExecVsock(t, received)}
	mgr := NewManager(cfg)
	// A restored daemon reattaches the persisted driver without inheriting the
	// old process's serial streams. The shell agent must not consult console.
	machine := &Machine{ID: id, LeaseID: lease, LeaseGeneration: 1, Status: "running", Ready: true, driver: driver}
	expiresAt, timer, persisted := persistManagedAgentLeaseFixture(t, mgr, machine)
	server := NewServer(cfg, mgr)
	var calls atomic.Int32
	server.shellModel = func(ctx context.Context, _ Config, _ anthropicRequest) (*apiResp, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := managedAgentLeaseMutation(mgr, id, expiresAt, timer, persisted); err != nil {
			return nil, err
		}
		if calls.Add(1) == 1 {
			tool, _ := json.Marshal(map[string]any{
				"type": "tool_use", "id": "tool-1",
				"input": map[string]any{"command": "printf managed-ok"},
			})
			return &apiResp{Content: []json.RawMessage{tool}}, nil
		}
		text, _ := json.Marshal(map[string]any{"type": "text", "text": "Done: managed command completed."})
		return &apiResp{Content: []json.RawMessage{text}}, nil
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/shell-agent"
	connection, response, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
	if err != nil {
		if response != nil {
			t.Fatalf("dial status=%d err=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: "print managed-ok"}); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	sawDone := false
	for !sawDone {
		var event map[string]any
		if err := connection.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "error" {
			t.Fatalf("unexpected event: %#v", event)
		}
		sawDone = event["type"] == "done"
	}
	select {
	case request := <-received:
		if request.Type != guestFrameExec || !request.PTY || request.Rows != 24 || request.Cols != 120 ||
			request.TimeoutMS != 30_000 || request.MaxOutput != shellAgentOutputLimit || request.Command != "printf managed-ok" {
			t.Fatalf("guest request=%#v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("managed shell agent did not use guest-agent exec")
	}
	_ = connection.Close()
	deadline := time.Now().Add(time.Second)
	for atomic.LoadInt32(&agentRuns) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	assertManagedAgentLeaseUnchanged(t, mgr, id, expiresAt, timer, persisted)
}

func TestManagedComputerAgentDoesNotExtendAuthoritativeLease(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	cfg.AgentMaxSteps = 2
	cfg.AgentMaxConcurrent = 2
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	id, lease := "m-11223344", "lease-current"
	driver := &fcDriver{id: id, cfg: cfg, console: nil, vsockUDS: startLocalRFBVsock(t)}
	mgr := NewManager(cfg)
	machine := &Machine{ID: id, LeaseID: lease, LeaseGeneration: 1, Status: "running", Ready: true, driver: driver}
	expiresAt, timer, persisted := persistManagedAgentLeaseFixture(t, mgr, machine)
	server := NewServer(cfg, mgr)
	server.shellModel = func(ctx context.Context, _ Config, _ anthropicRequest) (*apiResp, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := managedAgentLeaseMutation(mgr, id, expiresAt, timer, persisted); err != nil {
			return nil, err
		}
		text, _ := json.Marshal(map[string]any{"type": "text", "text": "Done: managed desktop task complete."})
		return &apiResp{Content: []json.RawMessage{text}}, nil
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/agent"
	connection, response, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
	if err != nil {
		if response != nil {
			t.Fatalf("dial status=%d err=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: "open a browser"}); err != nil {
		_ = connection.Close()
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var event map[string]any
		if err := connection.ReadJSON(&event); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		if event["type"] == "error" {
			_ = connection.Close()
			t.Fatalf("unexpected event: %#v", event)
		}
		if event["type"] == "done" {
			break
		}
	}
	_ = connection.Close()
	deadline := time.Now().Add(time.Second)
	for atomic.LoadInt32(&agentRuns) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	assertManagedAgentLeaseUnchanged(t, mgr, id, expiresAt, timer, persisted)
}

func TestExtendIfExpiringRemainsLocalOnly(t *testing.T) {
	cfg := internalTestConfig(t)
	id := "m-55667788"
	mgr := NewManager(cfg)
	expiresAt := time.Now().Add(10 * time.Second)
	originalTimer := time.AfterFunc(time.Until(expiresAt), func() {})
	machine := &Machine{ID: id, Status: "running", ExpiresAt: expiresAt, timer: originalTimer}
	mgr.machines[id] = machine
	t.Cleanup(func() {
		originalTimer.Stop()
		mgr.mu.Lock()
		if machine.timer != nil {
			machine.timer.Stop()
		}
		mgr.mu.Unlock()
	})

	mgr.ExtendIfExpiring(id, 2*time.Minute)
	mgr.mu.Lock()
	gotExpiry := machine.ExpiresAt
	gotTimer := machine.timer
	mgr.mu.Unlock()
	if !gotExpiry.After(expiresAt) || gotTimer == originalTimer {
		t.Fatalf("local convenience extension expiry=%s timer_reused=%t", gotExpiry, gotTimer == originalTimer)
	}

	managedCfg := cfg
	managedCfg.NehemiahMode = true
	managedCfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	managed := NewManager(managedCfg)
	managedMachine := &Machine{ID: id, LeaseID: "lease-current", LeaseGeneration: 1, Status: "running"}
	managedExpiry, managedTimer, persisted := persistManagedAgentLeaseFixture(t, managed, managedMachine)
	managed.ExtendIfExpiring(id, 2*time.Minute)
	assertManagedAgentLeaseUnchanged(t, managed, id, managedExpiry, managedTimer, persisted)
}

func TestManagedAgentStartFrameTimeoutClosesConnection(t *testing.T) {
	if testing.Short() {
		t.Skip("exercises the production first-frame deadline")
	}
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	cfg.AgentMaxConcurrent = 2
	id, lease := "m-01020304", "lease-current"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	httpServer := httptest.NewServer(NewServer(cfg, mgr))
	defer httpServer.Close()
	for _, route := range []string{"shell-agent", "agent"} {
		t.Run(route, func(t *testing.T) {
			url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/" + route
			connection, _, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			_ = connection.SetReadDeadline(time.Now().Add(shellAgentStartTimeout + 2*time.Second))
			started := time.Now()
			for {
				_, _, err = connection.ReadMessage()
				if err != nil {
					break
				}
			}
			if elapsed := time.Since(started); elapsed < shellAgentStartTimeout-time.Second || elapsed > shellAgentStartTimeout+2*time.Second {
				t.Fatalf("start-frame timeout elapsed=%s", elapsed)
			}
		})
	}
}

func TestManagedAgentRoutesRejectInvalidWebSocketStartFrames(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	cfg.AgentMaxConcurrent = 2
	id, lease := "m-01020304", "lease-current"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	httpServer := httptest.NewServer(NewServer(cfg, mgr))
	defer httpServer.Close()

	for _, route := range []string{"shell-agent", "agent"} {
		for _, test := range []struct {
			name        string
			messageType int
			payload     []byte
			wantClose   int
		}{
			{name: "wrong", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":2,"goal":"x"}`), wantClose: websocket.ClosePolicyViolation},
			{name: "missing", messageType: websocket.TextMessage, payload: []byte(`{"type":"start","version":1}`), wantClose: websocket.ClosePolicyViolation},
			{name: "binary", messageType: websocket.BinaryMessage, payload: []byte(`{"type":"start","version":1,"goal":"x"}`), wantClose: websocket.ClosePolicyViolation},
			{name: "oversized", messageType: websocket.TextMessage, payload: bytes.Repeat([]byte("x"), agentControlFrameLimit+1), wantClose: websocket.CloseMessageTooBig},
		} {
			t.Run(route+"/"+test.name, func(t *testing.T) {
				url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/" + route
				connection, _, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
				if err != nil {
					t.Fatal(err)
				}
				defer connection.Close()
				if err := connection.WriteMessage(test.messageType, test.payload); err != nil {
					t.Fatal(err)
				}
				_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
				for {
					_, _, err = connection.ReadMessage()
					if err == nil {
						continue
					}
					var closeError *websocket.CloseError
					if !errors.As(err, &closeError) || closeError.Code != test.wantClose {
						t.Fatalf("close=%v want=%d", err, test.wantClose)
					}
					break
				}
			})
		}
	}
}

func TestManagedShellCommandCancellationClosesGuestStream(t *testing.T) {
	requestSeen := make(chan guestAgentFrame, 1)
	guestClosed := make(chan struct{})
	client := pipeGuestClient(t, func(conn net.Conn) {
		request, err := readGuestFrame(conn)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		requestSeen <- request
		_, _ = readGuestFrame(conn)
		close(guestClosed)
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = runManagedShellCommand(ctx, client, "m-01020304", "sleep 30")
	}()
	select {
	case request := <-requestSeen:
		if !request.PTY || request.MaxOutput != shellAgentOutputLimit || request.TimeoutMS != 30_000 {
			t.Fatalf("request=%#v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("guest command was not started")
	}
	cancel()
	select {
	case <-guestClosed:
	case <-time.After(time.Second):
		t.Fatal("context cancellation did not close guest stream")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("managed shell command did not return after cancellation")
	}
}

func TestManagedComputerAgentUpgradesBeforeDesktopAvailability(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	cfg.AgentMaxConcurrent = 2
	id, lease := "m-01020304", "lease-current"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	httpServer := httptest.NewServer(NewServer(cfg, mgr))
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/agent"
	connection, response, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
	if err != nil {
		if response != nil {
			t.Fatalf("expected 101 before availability check, got %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: "open a browser"}); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := connection.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "error" || !strings.Contains(event["text"].(string), "desktop channel") {
		t.Fatalf("event=%#v", event)
	}
}

func startManagedInvalidRFBVsock(t *testing.T, secret string) string {
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
		line, readErr := bufio.NewReader(conn).ReadString('\n')
		if readErr != nil || line != "CONNECT 5900\n" {
			t.Errorf("vsock handshake line=%q err=%v", line, readErr)
			return
		}
		_, _ = conn.Write([]byte("OK 5900\nRFB 003.008\n"))
		_, _ = conn.Write([]byte{0})
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(secret)))
		_, _ = conn.Write(size[:])
		_, _ = conn.Write([]byte(secret))
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("invalid RFB vsock did not stop")
		}
	})
	return socket
}

func TestManagedComputerAgentRFBInitFailureIsPostUpgradeAndRedacted(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	id, lease := "m-01020304", "lease-current"
	secret := "/srv/jailer/tenant-secret.sock"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{
		ID: id, LeaseID: lease, Status: "running", Ready: true,
		driver: &fcDriver{console: nil, vsockUDS: startManagedInvalidRFBVsock(t, secret)},
	}
	httpServer := httptest.NewServer(NewServer(cfg, mgr))
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/agent"
	connection, response, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
	if err != nil {
		if response != nil {
			t.Fatalf("expected WebSocket upgrade, got %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: "open a browser"}); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := connection.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	text, _ := event["text"].(string)
	if event["type"] != "error" || text != "the desktop channel could not be initialized" || strings.Contains(text, secret) {
		t.Fatalf("event=%#v", event)
	}
}

func TestManagedShellAgentModelFailureIsRedacted(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	cfg.AnthropicKey = "test-model-key"
	id, lease := "m-01020304", "lease-current"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{ID: id, LeaseID: lease, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	server := NewServer(cfg, mgr)
	secret := "provider leaked customer-secret"
	server.shellModel = func(context.Context, Config, anthropicRequest) (*apiResp, error) {
		return nil, errors.New(secret)
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/shell-agent"
	connection, _, err := websocket.DefaultDialer.Dial(url, managedShellHeaders(cfg, lease))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: "build a site"}); err != nil {
		t.Fatal(err)
	}
	for {
		var event map[string]any
		if err := connection.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] != "error" {
			continue
		}
		text, _ := event["text"].(string)
		if text != "the agent model is temporarily unavailable" || strings.Contains(text, secret) {
			t.Fatalf("event=%#v", event)
		}
		return
	}
}

func TestLocalShellAgentStillUsesSerialAvailability(t *testing.T) {
	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	id := "m-01020304"
	mgr.mu.Lock()
	mgr.machines[id] = &Machine{ID: id, Status: "running", Ready: true, driver: &fcDriver{console: nil}}
	mgr.mu.Unlock()
	response := httptest.NewRecorder()
	NewServer(cfg, mgr).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/machines/"+id+"/shell-agent?goal=legacy", nil))
	if response.Code != http.StatusNotFound || bytes.Contains(response.Body.Bytes(), []byte("managed_shell_agent")) {
		t.Fatalf("local shell-agent response=%d body=%s", response.Code, response.Body.String())
	}
}

func startLocalRFBVsock(t *testing.T) string {
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
		if readErr != nil || line != "CONNECT 5900\n" {
			t.Errorf("vsock handshake line=%q err=%v", line, readErr)
			return
		}
		_, _ = conn.Write([]byte("OK 5900\nRFB 003.008\n"))
		clientVersion := make([]byte, 12)
		if _, err := io.ReadFull(reader, clientVersion); err != nil {
			return
		}
		_, _ = conn.Write([]byte{1, 1})
		selected := make([]byte, 1)
		if _, err := io.ReadFull(reader, selected); err != nil {
			return
		}
		_, _ = conn.Write([]byte{0, 0, 0, 0})
		shared := make([]byte, 1)
		if _, err := io.ReadFull(reader, shared); err != nil {
			return
		}
		serverInit := make([]byte, 24)
		binary.BigEndian.PutUint16(serverInit[0:2], 1)
		binary.BigEndian.PutUint16(serverInit[2:4], 1)
		_, _ = conn.Write(serverInit)
		configuration := make([]byte, 28)
		if _, err := io.ReadFull(reader, configuration); err != nil {
			return
		}
		request := make([]byte, 10)
		if _, err := io.ReadFull(reader, request); err != nil {
			return
		}
		update := make([]byte, 4+12+4)
		binary.BigEndian.PutUint16(update[2:4], 1)
		binary.BigEndian.PutUint16(update[8:10], 1)
		binary.BigEndian.PutUint16(update[10:12], 1)
		_, _ = conn.Write(update)
		_, _ = io.Copy(io.Discard, reader)
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("local RFB vsock did not stop")
		}
	})
	return socket
}

func TestLocalComputerAgentAcceptsQueryFreeStartFrame(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.AnthropicKey = "test-model-key"
	id := "m-01020304"
	mgr := NewManager(cfg)
	mgr.machines[id] = &Machine{ID: id, Status: "running", Ready: true, driver: &fcDriver{vsockUDS: startLocalRFBVsock(t)}}
	server := NewServer(cfg, mgr)
	requestSeen := make(chan anthropicRequest, 1)
	server.shellModel = func(_ context.Context, _ Config, request anthropicRequest) (*apiResp, error) {
		requestSeen <- request
		text, _ := json.Marshal(map[string]any{"type": "text", "text": "Done: local framed goal."})
		return &apiResp{Content: []json.RawMessage{text}}, nil
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	url := "ws" + httpServer.URL[len("http"):] + "/v1/machines/" + id + "/agent"
	connection, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	goal := "framed local goal"
	if err := connection.WriteJSON(shellAgentStart{Type: "start", Version: 1, Goal: goal}); err != nil {
		t.Fatal(err)
	}
	for {
		var event map[string]any
		if err := connection.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "error" {
			t.Fatalf("event=%#v", event)
		}
		if event["type"] == "done" {
			break
		}
	}
	select {
	case request := <-requestSeen:
		if !bytes.Contains(request.Messages[0], []byte(goal)) {
			t.Fatalf("model request does not contain framed goal: %s", request.Messages[0])
		}
	case <-time.After(time.Second):
		t.Fatal("local framed goal did not reach the model")
	}
}

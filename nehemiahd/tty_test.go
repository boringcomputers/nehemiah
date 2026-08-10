package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func managedTTYFixture(t *testing.T, guest func(net.Conn)) (Config, *Manager, string, string, <-chan struct{}) {
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
			return
		}
		_, _ = conn.Write([]byte("OK 2222\n"))
		guest(&bufferedConn{Conn: conn, reader: reader})
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	})

	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	id, lease := "m-01020304", "lease-current-generation"
	mgr := NewManager(cfg)
	mgr.mu.Lock()
	mgr.machines[id] = &Machine{
		ID: id, LeaseID: lease, Status: "running", Ready: true,
		driver: &fcDriver{id: id, vsockUDS: socket},
	}
	mgr.mu.Unlock()
	return cfg, mgr, id, lease, done
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func managedTTYHeaders(cfg Config, lease string) http.Header {
	return http.Header{
		"Authorization":       {"Bearer " + cfg.Token},
		"X-Nehemiah-Lease-Id": {lease},
	}
}

func TestManagedTTYUsesGuestAgentAfterDriverReattachment(t *testing.T) {
	want := []byte{0, 1, '\n', 0xff, 0xfe}
	cfg, mgr, id, lease, guestDone := managedTTYFixture(t, func(conn net.Conn) {
		open, err := readGuestFrame(conn)
		if err != nil || open.Type != guestFrameTTY {
			t.Errorf("terminal open = %#v, %v", open, err)
			return
		}
		_ = writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameTTYReady})
		input, err := readGuestFrame(conn)
		if err != nil || input.Type != guestFrameStdin || !bytes.Equal(input.Data, want) {
			t.Errorf("terminal input = %#v, %v", input, err)
			return
		}
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFramePTY, Data: want})
		_, _ = io.Copy(io.Discard, conn)
	})
	server := httptest.NewServer(NewServer(cfg, mgr))
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "/v1/machines/" + id + "/tty"
	connection, response, err := websocket.DefaultDialer.Dial(url, managedTTYHeaders(cfg, lease))
	if err != nil {
		if response != nil {
			t.Fatalf("dial terminal: %v (status %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	if err := connection.WriteMessage(websocket.BinaryMessage, want); err != nil {
		t.Fatal(err)
	}
	kind, got, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.BinaryMessage || !bytes.Equal(got, want) {
		t.Fatalf("terminal output kind=%d data=%v", kind, got)
	}
	_ = connection.Close()
	select {
	case <-guestDone:
	case <-time.After(time.Second):
		t.Fatal("guest terminal did not observe WebSocket disconnect")
	}
}

func TestManagedTTYAuthAndLeaseAreCheckedBeforeGuestDial(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.Token = "gateway-token-that-is-long-enough-for-tests"
	mgr := NewManager(cfg)
	id := "m-01020304"
	mgr.machines[id] = &Machine{ID: id, LeaseID: "lease-current", Status: "running", driver: &fcDriver{}}
	server := httptest.NewServer(NewServer(cfg, mgr))
	defer server.Close()

	for _, test := range []struct {
		name    string
		headers http.Header
		want    int
	}{
		{name: "missing gateway credential", headers: http.Header{"X-Nehemiah-Lease-Id": {"lease-current"}}, want: http.StatusUnauthorized},
		{name: "missing lease", headers: http.Header{"Authorization": {"Bearer " + cfg.Token}}, want: http.StatusUnauthorized},
		{name: "stale lease", headers: managedTTYHeaders(cfg, "lease-stale"), want: http.StatusConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/machines/"+id+"/tty", nil)
			request.Header = test.headers
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.want)
			}
		})
	}
}

func TestManagedTTYWebSocketFrameLimitClosesBeforeGuestForward(t *testing.T) {
	guestClosed := make(chan struct{})
	cfg, mgr, id, lease, _ := managedTTYFixture(t, func(conn net.Conn) {
		_, _ = readGuestFrame(conn)
		_ = writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameTTYReady})
		_, err := readGuestFrame(conn)
		if errors.Is(err, io.EOF) || err != nil {
			close(guestClosed)
		}
	})
	server := httptest.NewServer(NewServer(cfg, mgr))
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "/v1/machines/" + id + "/tty"
	connection, _, err := websocket.DefaultDialer.Dial(url, managedTTYHeaders(cfg, lease))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteMessage(websocket.BinaryMessage, make([]byte, ttyFrameLimit+1)); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, readErr := connection.ReadMessage()
	if readErr == nil {
		t.Fatal("oversized WebSocket terminal frame remained connected")
	}
	select {
	case <-guestClosed:
	case <-time.After(time.Second):
		t.Fatal("oversized WebSocket frame was forwarded or did not cancel the guest stream")
	}
}

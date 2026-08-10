package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestWebSocketUpgradeEchoesCapabilitySubprotocol proves the gateway echoes the
// capability subprotocol on the 101 response when the client offered it that way.
// Browsers fail a WebSocket handshake in which they offered subprotocols and the
// server selected none, so without this echo every dashboard "Open TTY"/"Open
// desktop" click fails in Chrome/Firefox/Safari (a Go dialer does not, which is
// why this regression hid behind the existing traversal test).
func TestWebSocketUpgradeEchoesCapabilitySubprotocol(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The gateway strips the capability subprotocol before proxying, so the
		// host sees no requested subprotocol and selects none — the exact
		// condition that leaves the browser handshake unsatisfied.
		if got := r.Header.Get("Sec-WebSocket-Protocol"); got != "" {
			t.Errorf("host unexpectedly received subprotocol %q", got)
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		kind, payload, err := connection.ReadMessage()
		if err == nil {
			_ = connection.WriteMessage(kind, payload)
		}
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, hostName, hostPort)
	cfg.StreamMaxDuration = 5 * time.Second
	g := mustGateway(t, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(withRequestTelemetry(logger, g))
	defer server.Close()

	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"tty"}, nil, time.Now()))
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/machines/" + testPublicID + "/tty"
	header := http.Header{}
	header.Set("Sec-WebSocket-Protocol", capabilityWebSocketProtocolPrefix+token)
	connection, response, err := websocket.DefaultDialer.Dial(websocketURL, header)
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial: %v (status %d, body %s)", err, response.StatusCode, mustReadAll(t, response.Body))
		}
		t.Fatal(err)
	}
	defer connection.Close()

	want := capabilityWebSocketProtocolPrefix + token
	if got := response.Header.Get("Sec-WebSocket-Protocol"); got != want {
		t.Fatalf("101 Sec-WebSocket-Protocol = %q, want %q (browsers fail the handshake when this is empty)", got, want)
	}
	// The negotiated subprotocol must also be one the client offered.
	if connection.Subprotocol() != want {
		t.Fatalf("negotiated subprotocol = %q, want %q", connection.Subprotocol(), want)
	}
}

// TestWebSocketUpgradeDoesNotEchoForHeaderAuth proves the gateway does NOT invent
// a subprotocol on the 101 when the client authenticated via the Authorization
// header and offered none — echoing an unoffered subprotocol also violates RFC 6455.
func TestWebSocketUpgradeDoesNotEchoForHeaderAuth(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		kind, payload, err := connection.ReadMessage()
		if err == nil {
			_ = connection.WriteMessage(kind, payload)
		}
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, hostName, hostPort)
	cfg.StreamMaxDuration = 5 * time.Second
	g := mustGateway(t, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(withRequestTelemetry(logger, g))
	defer server.Close()

	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"tty"}, nil, time.Now()))
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/machines/" + testPublicID + "/tty"
	header := http.Header{}
	header.Set("Authorization", "Bearer "+token)
	connection, response, err := websocket.DefaultDialer.Dial(websocketURL, header)
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial: %v (status %d, body %s)", err, response.StatusCode, mustReadAll(t, response.Body))
		}
		t.Fatal(err)
	}
	defer connection.Close()

	if got := response.Header.Get("Sec-WebSocket-Protocol"); got != "" {
		t.Fatalf("101 Sec-WebSocket-Protocol = %q, want empty for header-authenticated client", got)
	}
}

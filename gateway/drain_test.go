package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestGatewayDrainPreservesExistingWebSocketUntilForcedGrace(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			kind, payload, readErr := connection.ReadMessage()
			if readErr != nil {
				return
			}
			if writeErr := connection.WriteMessage(kind, payload); writeErr != nil {
				return
			}
		}
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	g := mustGateway(t, testConfig(t, controlPlane.URL, hostName, hostPort))
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
			t.Fatalf("websocket dial: %v (status %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if got := g.streams.active(); got != 1 {
		t.Fatalf("active streams = %d, want 1", got)
	}

	g.streams.startDrain()
	if err := connection.WriteMessage(websocket.TextMessage, []byte("still draining")); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := connection.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(payload) != "still draining" {
		t.Fatalf("existing stream did not survive drain start: kind=%d payload=%q err=%v", kind, payload, err)
	}

	second, response, err := websocket.DefaultDialer.Dial(websocketURL, header)
	if second != nil {
		_ = second.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable ||
		response.Header.Get("Retry-After") != "1" {
		t.Fatalf("new stream during drain = connection %v response %v err %v", second, response, err)
	}
	_ = response.Body.Close()

	health, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("liveness during drain = %d", health.StatusCode)
	}

	shortContext, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := g.streams.wait(shortContext); err == nil {
		t.Fatal("drain completed while the upgraded stream was still open")
	}
	g.streams.forceClose()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("forced grace expiry did not close the upgraded stream")
	}
	waitContext, waitCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer waitCancel()
	if err := g.streams.wait(waitContext); err != nil {
		t.Fatalf("stream drain did not settle: %v", err)
	}
}

func TestShutdownGraceValidation(t *testing.T) {
	controlPlane := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer controlPlane.Close()
	for _, grace := range []time.Duration{0, time.Millisecond, 11 * time.Minute} {
		cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 8080)
		cfg.ShutdownGrace = grace
		if err := cfg.Validate(); err == nil {
			t.Fatalf("ShutdownGrace %s unexpectedly validated", grace)
		}
	}
}

func TestCapabilityRevalidationIntervalValidation(t *testing.T) {
	controlPlane := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer controlPlane.Close()
	for _, interval := range []time.Duration{0, 249 * time.Millisecond, 5*time.Second + time.Millisecond, time.Minute} {
		cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 8080)
		cfg.CapabilityRevalidationInterval = interval
		if err := cfg.Validate(); err == nil {
			t.Fatalf("CapabilityRevalidationInterval %s unexpectedly validated", interval)
		}
	}
	for _, interval := range []time.Duration{250 * time.Millisecond, 5 * time.Second} {
		cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 8080)
		cfg.CapabilityRevalidationInterval = interval
		if err := cfg.Validate(); err != nil {
			t.Fatalf("CapabilityRevalidationInterval %s rejected: %v", interval, err)
		}
	}
}

func TestStreamLeaseDeadlineCancelsAndCanOnlyMoveToAuthoritativeRefresh(t *testing.T) {
	t.Parallel()
	g := &gateway{now: time.Now}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan time.Time)
	initial := time.Now().Add(80 * time.Millisecond)
	refreshed := time.Now().Add(220 * time.Millisecond)
	go g.enforceStreamLease(ctx, cancel, initial, updates)
	updates <- refreshed

	timer := time.NewTimer(120 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		t.Fatal("stream ended at the superseded lease deadline")
	case <-timer.C:
	}
	select {
	case <-ctx.Done():
	case <-time.After(300 * time.Millisecond):
		t.Fatal("stream survived the latest durable lease deadline")
	}
}

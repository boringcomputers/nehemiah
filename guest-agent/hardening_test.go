package main

import (
	"context"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

// TestSilentConnReleasesAfterHandshakeTimeout is the regression for the
// connection-slot exhaustion finding: a peer that never sends its first frame
// must not hold its connection slot forever. serveConn now bounds the initial
// handshake, so it returns (letting the caller release the slot) on timeout.
func TestSilentConnReleasesAfterHandshakeTimeout(t *testing.T) {
	old := initialFrameTimeout
	initialFrameTimeout = 100 * time.Millisecond
	defer func() { initialFrameTimeout = old }()

	s := &agentServer{}
	client, server := net.Pipe()
	defer client.Close()

	done := make(chan struct{})
	go func() { s.serveConn(server); close(done) }()

	// Never send anything on the client side.
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("serveConn did not return after the handshake timeout; the connection slot would leak")
	}
}

// TestManySilentConnsDoNotExhaustCapacity mirrors Greptile's scenario: sixteen
// incomplete-frame peers must not permanently occupy every connection slot.
// After the handshake timeout they all release, so a further connection is
// admitted rather than rejected as busy.
func TestManySilentConnsDoNotExhaustCapacity(t *testing.T) {
	old := initialFrameTimeout
	initialFrameTimeout = 100 * time.Millisecond
	defer func() { initialFrameTimeout = old }()

	s := &agentServer{}
	var conns []net.Conn
	done := make(chan struct{}, maxConcurrentAgentConnections)
	for i := 0; i < maxConcurrentAgentConnections; i++ {
		if !s.acquireConnection() {
			t.Fatalf("could not acquire connection slot %d", i)
		}
		client, server := net.Pipe()
		conns = append(conns, client)
		go func() {
			defer s.releaseConnection()
			s.serveConn(server)
			done <- struct{}{}
		}()
	}
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()

	for i := 0; i < maxConcurrentAgentConnections; i++ {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("silent connections did not release their slots after the handshake timeout")
		}
	}
	if !s.acquireConnection() {
		t.Fatal("connection capacity still exhausted after silent peers timed out")
	}
	s.releaseConnection()
}

// TestTTYDisconnectDetectedWhilePTYWriteBackpressured is the regression for the
// blocking-PTY-input finding: a client disconnect must be observed even when the
// PTY master write path is fully backpressured (a terminal process that stopped
// reading stdin). stdin is now written through a non-blocking pump, so the
// control-frame reader is never stalled and cancels promptly on disconnect.
func TestTTYDisconnectDetectedWhilePTYWriteBackpressured(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	// Deliberately never read r, so the pump's writes to w block once the pipe
	// buffer fills — emulating a terminal process that stopped reading stdin.

	client, server := net.Pipe()
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go watchTTYControlFrames(server, cancel, w, &lockedFrameWriter{w: io.Discard})

	go func() {
		payload := make([]byte, 2048)
		for i := 0; i < 200; i++ {
			if err := writeFrame(client, protocolFrame{Type: frameStdin, Data: payload}); err != nil {
				return
			}
		}
		_ = client.Close() // disconnect after flooding stdin
	}()

	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("client disconnect was not detected while the PTY write path was backpressured")
	}
}

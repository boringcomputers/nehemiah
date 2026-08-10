package main

import (
	"net"
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

type blockingWriter struct{ release chan struct{} }

func (b blockingWriter) Write(p []byte) (int, error) {
	<-b.release
	return len(p), nil
}

// TestPTYInputPumpBackpressureIsExplicitNotSilent is the regression for the
// silent-drop finding: when a terminal process stops reading stdin and the pump's
// bounded buffer fills, further input must be reported as an explicit overflow
// error (which the caller turns into a session failure) rather than accepted and
// silently discarded. The pump is non-blocking either way, so the control-frame
// reader is never stalled.
func TestPTYInputPumpBackpressureIsExplicitNotSilent(t *testing.T) {
	w := blockingWriter{release: make(chan struct{})}
	defer close(w.release)
	pump := startPTYInputPump(w)
	defer pump.close()

	accepted := 0
	var overflow error
	for i := 0; i < ttyStdinBufferedFrames+8; i++ {
		if err := pump.enqueue([]byte("x")); err != nil {
			overflow = err
			break
		}
		accepted++
	}
	if overflow == nil {
		t.Fatal("pump never reported overflow; backpressured input would be silently dropped")
	}
	if accepted < ttyStdinBufferedFrames {
		t.Fatalf("pump accepted only %d frames before overflow, want >= %d", accepted, ttyStdinBufferedFrames)
	}
}

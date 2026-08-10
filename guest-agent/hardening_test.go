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

// TestTTYOverflowReleasesWhileClientNotReading is the regression for the
// send-before-cancel finding: when input overflows and the client has stopped
// reading response frames, the session must still cancel and release its slots
// promptly — without waiting for the client to disconnect. The overflow handler
// cancels before its best-effort send, and cancellation interrupts in-flight
// writes, so teardown does not depend on the client reading.
func TestTTYOverflowReleasesWhileClientNotReading(t *testing.T) {
	conn, done := startTestConn(t)
	defer conn.Close()

	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameTTY, Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	if ready, err := readFrame(conn); err != nil || ready.Type != frameTTYReady {
		t.Fatalf("terminal handshake = %#v (err %v)", ready, err)
	}
	// Run a process that does not read stdin, so the PTY input backpressures.
	if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: []byte("sleep 30\n")}); err != nil {
		t.Fatal(err)
	}
	// Flood stdin to overflow the pump while deliberately never reading responses.
	go func() {
		payload := make([]byte, 4096)
		for i := 0; i < 500; i++ {
			if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: payload}); err != nil {
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("session did not release after input overflow while the client stopped reading responses")
	}
}

// TestTTYOverflowEmitsSingleTerminalFrame is the regression for the contradictory
// terminal-outcome finding: on input overflow the session must emit exactly one
// terminal frame (the error), never an error followed by a result for the same
// operation.
func TestTTYOverflowEmitsSingleTerminalFrame(t *testing.T) {
	conn, done := startTestConn(t)
	defer conn.Close()

	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameTTY, Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	if ready, err := readFrame(conn); err != nil || ready.Type != frameTTYReady {
		t.Fatalf("terminal handshake = %#v (err %v)", ready, err)
	}
	if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: []byte("sleep 30\n")}); err != nil {
		t.Fatal(err)
	}
	go func() {
		payload := make([]byte, 4096)
		for i := 0; i < 500; i++ {
			if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: payload}); err != nil {
				return
			}
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(6 * time.Second))
	var sawError, sawResult, frameAfterTerminal bool
	terminal := false
	for {
		f, err := readFrame(conn)
		if err != nil {
			break // conn closed after the single terminal frame
		}
		if terminal {
			frameAfterTerminal = true
		}
		switch f.Type {
		case frameError:
			sawError, terminal = true, true
		case frameResult:
			sawResult, terminal = true, true
		}
	}
	if !sawError {
		t.Fatal("expected a terminal error frame on input overflow")
	}
	if sawResult {
		t.Fatal("received both an error and a result frame for one terminal session")
	}
	if frameAfterTerminal {
		t.Fatal("a frame was delivered after the terminal frame")
	}
	<-done
}

// TestPTYExecOverflowEmitsSingleTerminalFrame is the same single-terminal-frame
// guarantee for the PTY exec path (frameExec with PTY set), which runs through
// runPTY rather than serveTTY.
func TestPTYExecOverflowEmitsSingleTerminalFrame(t *testing.T) {
	conn, done := startTestConn(t)
	defer conn.Close()

	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameExec, Command: "sleep 30", PTY: true, Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	go func() {
		payload := make([]byte, 4096)
		for i := 0; i < 500; i++ {
			if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: payload}); err != nil {
				return
			}
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(6 * time.Second))
	var sawError, sawResult, frameAfterTerminal bool
	terminal := false
	for {
		f, err := readFrame(conn)
		if err != nil {
			break
		}
		if terminal {
			frameAfterTerminal = true
		}
		switch f.Type {
		case frameError:
			sawError, terminal = true, true
		case frameResult:
			sawResult, terminal = true, true
		}
	}
	if !sawError {
		t.Fatal("expected a terminal error frame on PTY exec input overflow")
	}
	if sawResult {
		t.Fatal("received both an error and a result frame for one PTY exec operation")
	}
	if frameAfterTerminal {
		t.Fatal("a frame was delivered after the terminal frame")
	}
	<-done
}

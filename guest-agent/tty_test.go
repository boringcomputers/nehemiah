package main

import (
	"bytes"
	"io"
	"testing"
	"time"
)

func TestInteractiveTTYStreamsAndCancelsOnDisconnect(t *testing.T) {
	conn, done := startTestConn(t)
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameTTY, Rows: 31, Cols: 101}); err != nil {
		t.Fatal(err)
	}
	ready, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	if ready.Type != frameTTYReady || ready.Version != protocolVersion {
		t.Fatalf("terminal handshake = %#v", ready)
	}
	if err := writeFrame(conn, protocolFrame{Type: frameStdin, Data: []byte("printf '__TTY_RESTART_SAFE__\\n'\n")}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	var output bytes.Buffer
	for !bytes.Contains(output.Bytes(), []byte("__TTY_RESTART_SAFE__")) {
		_ = conn.SetReadDeadline(deadline)
		frame, err := readFrame(conn)
		if err != nil {
			t.Fatalf("read terminal output: %v (%q)", err, output.Bytes())
		}
		if frame.Type != framePTY {
			t.Fatalf("terminal output frame = %#v", frame)
		}
		output.Write(frame.Data)
	}
	_ = conn.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("guest terminal process survived a disconnected transport")
	}
}

func TestInteractiveTTYControlFrameBound(t *testing.T) {
	if err := applyTTYControlFrame(io.Discard, protocolFrame{Type: frameStdin, Data: make([]byte, maxTTYFrameSize)}); err != nil {
		t.Fatalf("maximum-size terminal frame rejected: %v", err)
	}
	if err := applyTTYControlFrame(io.Discard, protocolFrame{Type: frameStdin, Data: make([]byte, maxTTYFrameSize+1)}); err == nil {
		t.Fatal("oversized terminal frame accepted")
	}
	if err := applyTTYControlFrame(io.Discard, protocolFrame{Type: frameUpload}); err == nil {
		t.Fatal("unrelated operation frame accepted on terminal stream")
	}
}

func TestInteractiveTTYConcurrencyIsBounded(t *testing.T) {
	server := &agentServer{}
	for index := 0; index < maxConcurrentTTYSessions; index++ {
		if !server.acquireTTY() {
			t.Fatalf("terminal slot %d rejected", index)
		}
	}
	if server.acquireTTY() {
		t.Fatal("terminal concurrency limit was exceeded")
	}
	for index := 0; index < maxConcurrentTTYSessions; index++ {
		server.releaseTTY()
	}
}

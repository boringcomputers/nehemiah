package main

import (
	"net"
	"testing"
)

func startTestConn(t *testing.T) (net.Conn, <-chan struct{}) {
	t.Helper()
	client, guest := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&agentServer{}).serveConn(guest)
	}()
	return client, done
}

func TestPingReportsAgentReadiness(t *testing.T) {
	conn, done := startTestConn(t)
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: framePing}); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != frameReady || got.Version != protocolVersion {
		t.Fatalf("ping response = %#v", got)
	}
	_ = conn.Close()
	<-done
}

func TestAgentConnectionAndOperationCapacityIsNonQueuedAndReusable(t *testing.T) {
	server := &agentServer{}
	for index := 0; index < maxConcurrentAgentConnections; index++ {
		if !server.acquireConnection() {
			t.Fatalf("connection slot %d rejected", index)
		}
	}
	if server.acquireConnection() {
		t.Fatal("connection ceiling was exceeded")
	}
	server.releaseConnection()
	if !server.acquireConnection() {
		t.Fatal("released connection slot was not reusable")
	}
	for index := 0; index < maxConcurrentAgentConnections; index++ {
		server.releaseConnection()
	}

	for index := 0; index < maxConcurrentAgentOperations; index++ {
		if !server.acquireOperation() {
			t.Fatalf("operation slot %d rejected", index)
		}
	}
	if server.acquireOperation() {
		t.Fatal("operation ceiling was exceeded")
	}
	server.releaseOperation()
	if !server.acquireOperation() {
		t.Fatal("released operation slot was not reusable")
	}
	for index := 0; index < maxConcurrentAgentOperations; index++ {
		server.releaseOperation()
	}
}

func TestAgentRejectsWorkWhenOperationCapacityIsFull(t *testing.T) {
	server := &agentServer{}
	for index := 0; index < maxConcurrentAgentOperations; index++ {
		if !server.acquireOperation() {
			t.Fatalf("operation slot %d rejected", index)
		}
	}
	defer func() {
		for index := 0; index < maxConcurrentAgentOperations; index++ {
			server.releaseOperation()
		}
	}()

	client, guest := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.serveConn(guest)
	}()
	if err := writeFrame(client, protocolFrame{Version: protocolVersion, Type: frameExec, Command: "true"}); err != nil {
		t.Fatal(err)
	}
	response, err := readFrame(client)
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != frameError || response.Code != "busy" {
		t.Fatalf("response = %#v", response)
	}
	_ = client.Close()
	<-done
}

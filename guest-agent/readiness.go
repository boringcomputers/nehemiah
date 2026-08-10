package main

import (
	"fmt"
	"net"
	"sync"
	"time"
)

// initialFrameTimeout bounds how long a freshly accepted connection may take to
// deliver its first request frame. It stops a silent or partial-header peer from
// holding a connection slot indefinitely. It is a var so tests can shorten it.
var initialFrameTimeout = 10 * time.Second

const maxConcurrentTTYSessions = 32

const (
	maxConcurrentAgentConnections = 16
	maxConcurrentAgentOperations  = 8
)

type agentServer struct {
	ttyOnce         sync.Once
	ttySlots        chan struct{}
	connectionOnce  sync.Once
	connectionSlots chan struct{}
	operationOnce   sync.Once
	operationSlots  chan struct{}
}

func (s *agentServer) acquireConnection() bool {
	s.connectionOnce.Do(func() { s.connectionSlots = make(chan struct{}, maxConcurrentAgentConnections) })
	select {
	case s.connectionSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *agentServer) releaseConnection() { <-s.connectionSlots }

func (s *agentServer) acquireOperation() bool {
	s.operationOnce.Do(func() { s.operationSlots = make(chan struct{}, maxConcurrentAgentOperations) })
	select {
	case s.operationSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *agentServer) releaseOperation() { <-s.operationSlots }

func (s *agentServer) acquireTTY() bool {
	s.ttyOnce.Do(func() { s.ttySlots = make(chan struct{}, maxConcurrentTTYSessions) })
	select {
	case s.ttySlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *agentServer) releaseTTY() { <-s.ttySlots }

// serveConn handles one operation per connection. A fresh connection per call
// is intentional: the host can restart and reconnect without guest-side state,
// and closing an exec connection is an unambiguous cancellation signal.
func (s *agentServer) serveConn(conn net.Conn) {
	defer conn.Close()
	// A connection slot is already held on our behalf. Bound the handshake so a
	// peer that never completes the first frame releases the slot on timeout.
	_ = conn.SetReadDeadline(time.Now().Add(initialFrameTimeout))
	req, err := readFrame(conn)
	if err != nil {
		return
	}
	// The request arrived; clear the handshake deadline so long-lived operations
	// (exec/tty streaming, uploads) are not cut off.
	_ = conn.SetReadDeadline(time.Time{})
	if req.Version != 0 && req.Version != protocolVersion {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: fmt.Sprintf("unsupported protocol version %d", req.Version)})
		return
	}

	switch req.Type {
	case framePing:
		_ = writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameReady})
	case frameExec:
		if !s.acquireOperation() {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "guest operation capacity reached"})
			return
		}
		defer s.releaseOperation()
		s.serveExec(conn, req)
	case frameTTY:
		if !s.acquireOperation() {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "guest operation capacity reached"})
			return
		}
		defer s.releaseOperation()
		if !s.acquireTTY() {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "terminal capacity reached"})
			return
		}
		defer s.releaseTTY()
		s.serveTTY(conn, req)
	case frameUpload:
		if !s.acquireOperation() {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "guest operation capacity reached"})
			return
		}
		defer s.releaseOperation()
		s.serveUpload(conn, req)
	case frameDownload:
		if !s.acquireOperation() {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "guest operation capacity reached"})
			return
		}
		defer s.releaseOperation()
		s.serveDownload(conn, req)
	default:
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: "unsupported operation: " + req.Type})
	}
}

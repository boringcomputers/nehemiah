package main

import (
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	ttyFrameLimit = 64 << 10
	websocketIdle = 90 * time.Second
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     checkWebSocketOrigin,
}

// checkWebSocketOrigin validates the Origin header on WebSocket upgrades. When
// auth is token-based (the request already proved it holds the secret), any
// origin is acceptable. For open (no-token) deployments this still allows all
// origins — the same posture as before — because there is nothing to protect.
func checkWebSocketOrigin(r *http.Request) bool {
	return true // auth is enforced in each handler before Upgrade
}

// startWebSocketKeepalive bounds idle upgraded connections. WriteControl is
// safe alongside the single application writer, so VNC and agent streams can
// share this without introducing concurrent data-frame writes.
func startWebSocketKeepalive(conn *websocket.Conn) func() {
	_ = conn.SetReadDeadline(time.Now().Add(websocketIdle))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(websocketIdle))
	})
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					return
				}
			case <-stop:
				return
			}
		}
	}()
	return func() { close(stop) }
}

// handleTTY uses the restart-safe guest-agent PTY in managed mode. Local mode
// retains the historical serial console (including scrollback) for development
// and recovery compatibility.
func (s *Server) handleTTY(w http.ResponseWriter, r *http.Request) {
	// Auth was checked before upgrade (managed mode accepts headers only).
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	if s.cfg.NehemiahMode {
		s.handleGuestTTY(w, r)
		return
	}
	s.handleSerialTTY(w, r)
}

func (s *Server) handleGuestTTY(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.mgr.Get(id); !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	release, ok := s.acquireGuestOperation(w, id)
	if !ok {
		return
	}
	defer release()

	terminal, err := s.guestAgent().OpenTTY(r.Context(), id, 24, 80)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, ErrGuestAgentUnavailable) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{"error": "guest terminal unavailable"})
		return
	}
	defer terminal.Close()

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		if s.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventWebSocketUpgradeFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("tty %s: upgrade failed: %v", id, err)
		}
		return
	}
	defer conn.Close()
	conn.SetReadLimit(ttyFrameLimit)
	_ = conn.SetReadDeadline(time.Now().Add(websocketIdle))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(websocketIdle))
	})

	done := make(chan struct{})
	var doneOnce sync.Once
	finish := func() {
		doneOnce.Do(func() {
			_ = terminal.Close()
			close(done)
		})
	}
	defer finish()

	// WebSocket input and guest output are independent streams. Closing either
	// side closes the vsock stream, which unblocks the other goroutine and makes
	// disconnect cancellation deterministic inside the guest agent.
	go func() {
		defer finish()
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			_ = conn.SetReadDeadline(time.Now().Add(websocketIdle))
			if messageType != websocket.BinaryMessage && messageType != websocket.TextMessage {
				continue
			}
			if err := terminal.Write(data); err != nil {
				return
			}
		}
	}()

	type terminalRead struct {
		data []byte
		err  error
	}
	output := make(chan terminalRead, 1)
	go func() {
		for {
			data, err := terminal.Read()
			select {
			case output <- terminalRead{data: data, err: err}:
			case <-done:
				return
			}
			if err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-done:
			return
		case result := <-output:
			if result.err != nil {
				message := "terminal disconnected"
				if errors.Is(result.err, io.EOF) {
					message = "terminal exited"
				}
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseGoingAway, message),
					time.Now().Add(time.Second))
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, result.data); err != nil {
				return
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (s *Server) handleSerialTTY(w http.ResponseWriter, r *http.Request) {

	id := r.PathValue("id")
	console, ok := s.mgr.Console(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		if s.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventWebSocketUpgradeFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("tty %s: upgrade failed: %v", id, err)
		}
		return
	}
	defer conn.Close()
	conn.SetReadLimit(ttyFrameLimit)
	_ = conn.SetReadDeadline(time.Now().Add(websocketIdle))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(websocketIdle))
	})

	// Subscribe first, then replay scrollback, so no bytes are missed between
	// the snapshot and live delivery.
	scrollback, sub := console.Subscribe()
	defer console.Unsubscribe(sub)

	done := make(chan struct{})

	// Reader goroutine: client -> guest stdin.
	go func() {
		defer close(done)
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			_ = conn.SetReadDeadline(time.Now().Add(websocketIdle))
			// Accept both binary and text frames as raw serial input.
			if mt == websocket.BinaryMessage || mt == websocket.TextMessage {
				if _, err := console.Write(data); err != nil {
					return
				}
			}
		}
	}()

	// Writer path: guest stdout -> client. Replay scrollback first.
	if len(scrollback) > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, scrollback); err != nil {
			return
		}
	}

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return
		case chunk, ok := <-sub.ch:
			if !ok {
				// Console closed (machine died); notify and exit.
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseGoingAway, "machine stopped"),
					time.Now().Add(time.Second))
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				return
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

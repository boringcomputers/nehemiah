package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
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

// handleTTY upgrades to a WebSocket and bridges binary frames to/from the
// machine's guest serial console. It replays buffered scrollback on connect.
func (s *Server) handleTTY(w http.ResponseWriter, r *http.Request) {
	// Auth: header or ?token= (checked before upgrade).
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	console, ok := s.mgr.Console(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("tty %s: upgrade failed: %v", id, err)
		return
	}
	defer conn.Close()

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

package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// handleVNC upgrades to a WebSocket and bridges binary frames to/from the guest
// desktop's VNC server, reached over the machine's vsock device (guest port
// 5900). The browser speaks RFB via noVNC directly over this socket.
func (s *Server) handleVNC(w http.ResponseWriter, r *http.Request) {
	// Auth: header or ?token= (checked before upgrade).
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	// Dial the guest VNC server before upgrading so we can return a clean HTTP
	// error if it isn't a desktop machine or isn't reachable yet.
	guest, err := s.mgr.DialVsock(id, VsockPort)
	if err != nil {
		if err == ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		} else {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		}
		return
	}
	defer guest.Close()

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("vnc %s: upgrade failed: %v", id, err)
		return
	}
	defer conn.Close()

	// guest -> websocket (binary frames)
	go func() {
		defer conn.Close()
		buf := make([]byte, 32*1024)
		for {
			n, err := guest.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseGoingAway, "vnc closed"),
					time.Now().Add(time.Second))
				return
			}
		}
	}()

	// websocket -> guest
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.BinaryMessage || mt == websocket.TextMessage {
			if _, err := guest.Write(data); err != nil {
				return
			}
		}
	}
}

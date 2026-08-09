package main

import (
	"fmt"
	"net/http"
	"time"
)

// handleScreenshot captures a single PNG framebuffer of a desktop machine.
// Retried a couple of times: VNC-over-vsock can refuse briefly right after a
// snapshot restore (forks, published templates) while the guest's vsock
// re-establishes — a transient, not a dead display.
func (s *Server) handleScreenshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(400 * time.Millisecond)
		}
		png, err := s.mgr.screenshotPNG(id)
		if err == ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		if err != nil {
			lastErr = err
			continue
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(png)
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]any{"error": lastErr.Error()})
}

// screenshotPNG opens one VNC-over-vsock session and grabs a framebuffer PNG.
func (mgr *Manager) screenshotPNG(id string) ([]byte, error) {
	guest, err := mgr.DialVsock(id, VsockPort)
	if err != nil {
		return nil, err
	}
	defer guest.Close()
	cli, err := newRFBClient(guest)
	if err != nil {
		return nil, fmt.Errorf("rfb: %w", err)
	}
	png, err := cli.Screenshot()
	if err != nil {
		return nil, fmt.Errorf("screenshot: %w", err)
	}
	return png, nil
}

// handleAgent runs the computer-use loop (wired once NEHEMIAH_ANTHROPIC_KEY is set).
func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	s.runAgent(w, r)
}

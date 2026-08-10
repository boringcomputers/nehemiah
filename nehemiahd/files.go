package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path"
	"strings"
	"time"
)

// File transfer prefers the bounded vsock guest agent. Managed mode returns a
// typed failure when that agent is unavailable. Only local/self-hosted mode may
// fall back to a short serial command that starts a one-shot node TCP helper and
// streams the file over the guest network.

const fileSizeCap = 16 << 20 // 16 MiB

func sanitizeName(name string) string {
	name = path.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		default:
			return '_'
		}
	}, name)
	if name == "" || name == "." || name == ".." {
		return "upload.bin"
	}
	return name
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// xferPort picks a per-request port so back-to-back transfers don't collide on a
// lingering listener.
func xferPort() int { return 47000 + int(time.Now().UnixNano()/1e6%2000) }

// dialGuest connects to the just-started guest helper, retrying while node boots.
func dialGuest(ip string, port int) (net.Conn, error) {
	addr := net.JoinHostPort(ip, fmt.Sprint(port))
	var last error
	for i := 0; i < 25; i++ {
		if c, err := net.DialTimeout("tcp", addr, 800*time.Millisecond); err == nil {
			return c, nil
		} else {
			last = err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil, last
}

func (s *Server) guestFor(id string) (*Console, string, bool) {
	console, ok := s.mgr.Console(id)
	if !ok {
		return nil, "", false
	}
	ip, ok := s.mgr.machineIP(id)
	if !ok {
		return nil, "", false
	}
	return console, ip, true
}

// handleUpload streams a file into the guest's /root over the network.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > fileSizeCap {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too big (16 MiB max)"})
		return
	}
	name := sanitizeName(r.Header.Get("X-Filename"))
	dest := "/root/" + name
	id := r.PathValue("id")
	release, ok := s.acquireGuestOperation(w, id)
	if !ok {
		return
	}
	defer release()
	result, agentErr := s.guestAgent().Upload(r.Context(), id, dest, 0o600, r.ContentLength, r.Body)
	if agentErr == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": result.Path, "bytes": result.Size, "transport": "vsock"})
		return
	}
	if errors.Is(agentErr, ErrGuestFileTooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too big (16 MiB max)"})
		return
	}
	if s.cfg.NehemiahMode && !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeManagedGuestAgentFailed(w)
		return
	}
	if !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "guest agent upload failed: " + agentErr.Error()})
		return
	}
	if s.cfg.NehemiahMode {
		writeManagedGuestAgentUnavailable(w)
		return
	}

	console, ip, ok := s.guestFor(id)
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "file transfer needs a connected computer (turn internet on / use a desktop)"})
		return
	}
	port := xferPort()
	cmd := fmt.Sprintf(
		`node -e 'require("net").createServer(c=>{c.pipe(require("fs").createWriteStream(process.argv[1])).on("finish",()=>process.exit(0)).on("error",()=>process.exit(1))}).listen(%d)' %s 2>/dev/null &`+"\n",
		port, shellQuote(dest))
	if _, err := console.Write([]byte(cmd)); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't write to the computer's console"})
		return
	}

	conn, err := dialGuest(ip, port)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't reach the computer's uploader"})
		return
	}
	defer conn.Close()
	n, _ := io.Copy(conn, io.LimitReader(r.Body, fileSizeCap))
	if tcp, ok := conn.(*net.TCPConn); ok {
		tcp.CloseWrite() // EOF -> the receiver finishes writing and exits
	}
	io.Copy(io.Discard, conn) // wait for the receiver to close
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": dest, "bytes": n, "transport": "serial"})
}

// handleDownload streams a file out of the guest over the network.
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if p == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "path required"})
		return
	}
	id := r.PathValue("id")
	release, ok := s.acquireGuestOperation(w, id)
	if !ok {
		return
	}
	defer release()
	started := false
	_, agentErr := s.guestAgent().DownloadTo(r.Context(), id, p, w, func(result guestDownloadResult) error {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", sanitizeName(path.Base(p))))
		w.Header().Set("Content-Length", fmt.Sprint(result.Size))
		w.Header().Set("X-Nehemiah-Transport", "vsock")
		w.WriteHeader(http.StatusOK)
		started = true
		return nil
	})
	if agentErr == nil {
		return
	}
	if started {
		return
	}
	if errors.Is(agentErr, ErrGuestFileTooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too big (16 MiB max)"})
		return
	}
	var remoteErr *guestAgentRemoteError
	if errors.As(agentErr, &remoteErr) && remoteErr.Code == "not_found" {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such file"})
		return
	}
	if s.cfg.NehemiahMode && !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeManagedGuestAgentFailed(w)
		return
	}
	if !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "guest agent download failed: " + agentErr.Error()})
		return
	}
	if s.cfg.NehemiahMode {
		writeManagedGuestAgentUnavailable(w)
		return
	}

	console, ip, ok := s.guestFor(id)
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "file transfer needs a connected computer"})
		return
	}
	port := xferPort()
	cmd := fmt.Sprintf(
		`node -e 'const r=require("fs").createReadStream(process.argv[1]);r.on("error",()=>process.exit(1));require("net").createServer(c=>{r.pipe(c);c.on("close",()=>process.exit(0))}).listen(%d)' %s 2>/dev/null &`+"\n",
		port, shellQuote(p))
	if _, err := console.Write([]byte(cmd)); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't write to the computer's console"})
		return
	}

	conn, err := dialGuest(ip, port)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't reach the computer's downloader"})
		return
	}
	defer conn.Close()
	// Peek the first byte: a missing file makes node exit before sending anything.
	first := make([]byte, 1)
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	nr, _ := io.ReadFull(conn, first)
	if nr == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such file, or it's empty"})
		return
	}
	conn.SetReadDeadline(time.Time{})
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", sanitizeName(path.Base(p))))
	w.Write(first[:nr])
	io.Copy(w, conn)
}

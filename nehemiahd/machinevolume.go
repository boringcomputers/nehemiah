package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Machine ↔ volume bridge. A machine can restore a volume's snapshot into /root
// on boot ("attach") and write /root back to the volume ("save"), so work
// survives the machine's self-destruct. The master S3 credentials never touch
// the guest — nehemiahd streams the tarball through the same node-helper channel
// used for file transfer. Both flows need a connected machine (desktop or a
// shell with net).

const volumeSnapshot = "snapshot.tgz"

// pushToGuestCmd runs a node server in the guest that pipes the socket into
// `guestCmd`'s stdin, then streams r into it and waits for completion.
func pushToGuestCmd(console *Console, ip, guestCmd string, r io.Reader) error {
	port := xferPort()
	cmd := fmt.Sprintf(
		`node -e 'const{spawn}=require("child_process");require("net").createServer(c=>{const p=spawn("sh",["-c",process.argv[1]]);c.pipe(p.stdin);p.on("close",()=>process.exit(0))}).listen(%d)' %s 2>/dev/null &`+"\n",
		port, shellQuote(guestCmd))
	if _, err := console.Write([]byte(cmd)); err != nil {
		return fmt.Errorf("console write: %w", err)
	}
	conn, err := dialGuest(ip, port)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := io.Copy(conn, r); err != nil {
		return err
	}
	if tcp, ok := conn.(*net.TCPConn); ok {
		tcp.CloseWrite() // EOF → guest command finishes
	}
	io.Copy(io.Discard, conn) // wait for the guest to close
	return nil
}

// pullFromGuestCmd runs a node server that pipes `guestCmd`'s stdout to the
// socket; returns a conn to read the output from.
func pullFromGuestCmd(console *Console, ip, guestCmd string) (net.Conn, error) {
	port := xferPort()
	cmd := fmt.Sprintf(
		`node -e 'const{spawn}=require("child_process");require("net").createServer(c=>{const p=spawn("sh",["-c",process.argv[1]]);p.stdout.pipe(c);p.on("close",()=>c.end())}).listen(%d)' %s 2>/dev/null &`+"\n",
		port, shellQuote(guestCmd))
	if _, err := console.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("console write: %w", err)
	}
	return dialGuest(ip, port)
}

// attachVolume restores a volume's snapshot into the machine's /root. No-op if
// the volume has no snapshot yet.
func (s *Server) attachVolume(machineID, volumeID string) error {
	if s.storage == nil {
		return fmt.Errorf("storage not configured")
	}
	if _, err := s.storage.Get(volumeID); err != nil {
		return err
	}
	obj, err := s.storage.GetFile(volumeID, volumeSnapshot)
	if err != nil {
		return nil // nothing saved yet — attaching an empty volume is fine
	}
	defer obj.Close()
	console, ip, ok := s.guestFor(machineID)
	if !ok {
		return fmt.Errorf("volume needs a connected machine")
	}
	return pushToGuestCmd(console, ip, "tar xzf - -C /root", obj)
}

// handleSaveVolume writes the machine's /root into the volume's snapshot.
func (s *Server) handleSaveVolume(w http.ResponseWriter, r *http.Request) {
	volumeID := r.URL.Query().Get("volume")
	if volumeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "volume required"})
		return
	}
	if _, err := s.storage.Get(volumeID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such volume"})
		return
	}
	console, ip, ok := s.guestFor(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "save needs a connected machine (desktop, or a shell with net)"})
		return
	}
	// Tar /root in the guest and stream it straight into the volume snapshot,
	// skipping heavy cache dirs so snapshots stay small.
	conn, err := pullFromGuestCmd(console, ip,
		"cd /root && tar czf - --exclude=.npm --exclude=.cache --exclude=node_modules --exclude=.cargo --exclude=.local/share/cursor-agent . 2>/dev/null")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't reach the machine"})
		return
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
	// Cap the stream at the volume quota so a runaway /root can't blow past it.
	limited := io.LimitReader(conn, s.storage.quotaBytes)
	if err := s.storage.PutFile(volumeID, volumeSnapshot, limited, -1); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't save to the volume"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "volume": volumeID})
}

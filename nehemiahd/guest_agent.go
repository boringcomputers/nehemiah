package main

// guest_agent.go is the host half of the B.C guest-agent protocol. Every
// operation dials a new vsock stream, so there is no connection state to lose
// when nehemiahd restarts. Closing the stream cancels an in-flight guest exec.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

const (
	guestAgentProtocolVersion = 1
	guestAgentPort            = 2222
	guestAgentMaxFrameSize    = 1 << 20
	guestAgentChunkSize       = 32 << 10
	guestAgentDefaultOutput   = 64 << 10
	guestAgentMaxOutput       = 1 << 20
	guestAgentMaxFileSize     = 16 << 20
	guestAgentTimeoutExitCode = 124
)

const (
	guestFramePing     = "ping"
	guestFrameReady    = "ready"
	guestFrameExec     = "exec"
	guestFrameStdout   = "stdout"
	guestFrameStderr   = "stderr"
	guestFramePTY      = "pty"
	guestFrameTTY      = "tty"
	guestFrameTTYReady = "tty_ready"
	guestFrameStdin    = "stdin"
	guestFrameResize   = "resize"
	guestFrameCancel   = "cancel"
	guestFrameResult   = "result"
	guestFrameUpload   = "upload"
	guestFrameDownload = "download"
	guestFrameMeta     = "meta"
	guestFrameData     = "data"
	guestFrameEOF      = "eof"
	guestFrameError    = "error"
)

const guestAgentTTYFrameSize = 64 << 10

var (
	ErrGuestAgentUnavailable = errors.New("guest agent unavailable")
	ErrGuestFileTooLarge     = errors.New("guest file exceeds 16 MiB limit")
)

type guestAgentFrame struct {
	Version int    `json:"version,omitempty"`
	Type    string `json:"type"`

	Command   string `json:"command,omitempty"`
	TimeoutMS int64  `json:"timeout_ms,omitempty"`
	MaxOutput int64  `json:"max_output,omitempty"`
	PTY       bool   `json:"pty,omitempty"`
	Rows      uint16 `json:"rows,omitempty"`
	Cols      uint16 `json:"cols,omitempty"`

	Path string `json:"path,omitempty"`
	Mode uint32 `json:"mode,omitempty"`
	Size int64  `json:"size,omitempty"`
	Data []byte `json:"data,omitempty"`

	ExitCode  *int   `json:"exit_code,omitempty"`
	TimedOut  bool   `json:"timed_out,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Code      string `json:"code,omitempty"`
	Error     string `json:"error,omitempty"`
}

type guestAgentRemoteError struct {
	Code    string
	Message string
}

func (e *guestAgentRemoteError) Error() string { return e.Message }

func guestAgentFrameError(f guestAgentFrame) error {
	if f.Code == "too_large" {
		return fmt.Errorf("%w: %s", ErrGuestFileTooLarge, f.Error)
	}
	return &guestAgentRemoteError{Code: f.Code, Message: f.Error}
}

func writeGuestFrame(w io.Writer, f guestAgentFrame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return fmt.Errorf("encode guest-agent frame: %w", err)
	}
	if len(raw) > guestAgentMaxFrameSize {
		return fmt.Errorf("guest-agent frame is %d bytes (limit %d)", len(raw), guestAgentMaxFrameSize)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(raw)))
	if err := writeGuestAll(w, header[:]); err != nil {
		return err
	}
	return writeGuestAll(w, raw)
}

func readGuestFrame(r io.Reader) (guestAgentFrame, error) {
	var f guestAgentFrame
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return f, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > guestAgentMaxFrameSize {
		return f, fmt.Errorf("invalid guest-agent frame size %d", n)
	}
	raw := make([]byte, int(n))
	if _, err := io.ReadFull(r, raw); err != nil {
		return f, err
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return f, fmt.Errorf("decode guest-agent frame: %w", err)
	}
	if f.Type == "" {
		return f, errors.New("guest-agent frame type is required")
	}
	return f, nil
}

func writeGuestAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

type guestAgentDialFunc func(context.Context, string) (net.Conn, error)

type guestAgentClient struct {
	dial guestAgentDialFunc
}

// guestTTYSession is a framed, full-duplex PTY stream. It intentionally owns a
// single vsock connection rather than any daemon-local Firecracker stdio, so a
// newly started nehemiahd can open a fresh terminal after runtime reattachment.
type guestTTYSession struct {
	conn      net.Conn
	cleanup   func()
	mu        sync.Mutex
	closeOnce sync.Once
}

func newGuestAgentClient(mgr *Manager) *guestAgentClient {
	return &guestAgentClient{dial: func(_ context.Context, machineID string) (net.Conn, error) {
		return mgr.DialVsock(machineID, guestAgentPort)
	}}
}

// newManagedDriverGuestAgentClient binds a pre-publication or reattached driver
// to the machine's exact current lease. Managed snapshot restore must readdress
// the resumed NIC before attaching its tap to the bridge, which is earlier than
// the driver can safely be exposed through Manager.DialVsock. Revalidating the
// binding on every dial prevents a deleted/replaced lease from inheriting an
// in-flight lifecycle connection.
func newManagedDriverGuestAgentClient(mgr *Manager, machineID, leaseID string, driver *fcDriver) *guestAgentClient {
	mgr.mu.Lock()
	boundMachine := mgr.machines[machineID]
	mgr.mu.Unlock()
	return &guestAgentClient{dial: func(ctx context.Context, requestedID string) (net.Conn, error) {
		if requestedID != machineID || boundMachine == nil || driver == nil || leaseID == "" {
			return nil, ErrInvalidLease
		}
		mgr.mu.Lock()
		machine := mgr.machines[machineID]
		valid := mgr.cfg.NehemiahMode && machine == boundMachine && machine.LeaseID == leaseID &&
			(machine.driver == nil || machine.driver == driver)
		mgr.mu.Unlock()
		if !valid {
			return nil, ErrInvalidLease
		}
		return driver.DialVsockContext(ctx, guestAgentPort)
	}}
}

// guestAgent returns a stateless client. It intentionally is not kept on
// Server: only machine metadata is needed to reconnect after a daemon restart.
func (s *Server) guestAgent() *guestAgentClient { return newGuestAgentClient(s.mgr) }

func writeManagedGuestAgentUnavailable(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "guest_agent_unavailable"})
}

func writeManagedGuestAgentFailed(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadGateway, map[string]any{"error": "guest_agent_failed"})
}

func (c *guestAgentClient) connect(ctx context.Context, machineID string) (net.Conn, func(), error) {
	conn, err := c.dial(ctx, machineID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %w", ErrGuestAgentUnavailable, err)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	cleanup := func() {
		stop()
		_ = conn.Close()
	}
	return conn, cleanup, nil
}

// Ping is a guest-level readiness check. It does not infer readiness from the
// Firecracker child process or the serial console marker.
func (c *guestAgentClient) Ping(ctx context.Context, machineID string) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
	}
	conn, cleanup, err := c.connect(ctx, machineID)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFramePing}); err != nil {
		return err
	}
	f, err := readGuestFrame(conn)
	if err != nil {
		return err
	}
	if f.Type == guestFrameError {
		return guestAgentFrameError(f)
	}
	if f.Type != guestFrameReady || f.Version != guestAgentProtocolVersion {
		return fmt.Errorf("unexpected guest readiness frame %#v", f)
	}
	return nil
}

// OpenTTY starts an interactive login shell through the guest agent. The
// handshake completes before the HTTP handler upgrades its public WebSocket,
// allowing unavailable guests to fail with an ordinary bounded HTTP response.
func (c *guestAgentClient) OpenTTY(ctx context.Context, machineID string, rows, cols uint16) (*guestTTYSession, error) {
	conn, cleanup, err := c.connect(ctx, machineID)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			cleanup()
		}
	}()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := writeGuestFrame(conn, guestAgentFrame{
		Version: guestAgentProtocolVersion,
		Type:    guestFrameTTY,
		Rows:    rows,
		Cols:    cols,
	}); err != nil {
		return nil, err
	}
	frame, err := readGuestFrame(conn)
	if err != nil {
		return nil, err
	}
	if frame.Type == guestFrameError {
		return nil, guestAgentFrameError(frame)
	}
	if frame.Type != guestFrameTTYReady || frame.Version != guestAgentProtocolVersion {
		return nil, fmt.Errorf("unexpected guest terminal frame %q", frame.Type)
	}
	_ = conn.SetDeadline(time.Time{})
	failed = false
	return &guestTTYSession{conn: conn, cleanup: cleanup}, nil
}

func (s *guestTTYSession) Write(data []byte) error {
	if s == nil || s.conn == nil {
		return io.ErrClosedPipe
	}
	if len(data) > guestAgentTTYFrameSize {
		return fmt.Errorf("terminal input is %d bytes (limit %d)", len(data), guestAgentTTYFrameSize)
	}
	s.mu.Lock()
	err := writeGuestFrame(s.conn, guestAgentFrame{Type: guestFrameStdin, Data: data})
	s.mu.Unlock()
	return err
}

func (s *guestTTYSession) Read() ([]byte, error) {
	if s == nil || s.conn == nil {
		return nil, io.ErrClosedPipe
	}
	frame, err := readGuestFrame(s.conn)
	if err != nil {
		return nil, err
	}
	switch frame.Type {
	case guestFramePTY:
		if len(frame.Data) > guestAgentTTYFrameSize {
			return nil, fmt.Errorf("guest terminal output is %d bytes (limit %d)", len(frame.Data), guestAgentTTYFrameSize)
		}
		return frame.Data, nil
	case guestFrameResult:
		return nil, io.EOF
	case guestFrameError:
		return nil, guestAgentFrameError(frame)
	default:
		return nil, fmt.Errorf("unexpected guest terminal frame %q", frame.Type)
	}
}

func (s *guestTTYSession) Close() error {
	if s == nil || s.conn == nil {
		return nil
	}
	var closeErr error
	s.closeOnce.Do(func() {
		if s.cleanup != nil {
			s.cleanup()
			return
		}
		closeErr = s.conn.Close()
	})
	return closeErr
}

type guestExecRequest struct {
	Command   string
	Timeout   time.Duration
	MaxOutput int64
	PTY       bool
	Rows      uint16
	Cols      uint16
	Stdin     []byte
}

type guestExecResult struct {
	Stdout    []byte
	Stderr    []byte
	PTY       []byte
	ExitCode  int
	TimedOut  bool
	Truncated bool
}

func (c *guestAgentClient) Exec(ctx context.Context, machineID string, req guestExecRequest) (guestExecResult, error) {
	var result guestExecResult
	if req.Timeout > 0 {
		hostDeadline := time.Now().Add(req.Timeout + 5*time.Second)
		if existing, ok := ctx.Deadline(); !ok || existing.After(hostDeadline) {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, hostDeadline)
			defer cancel()
		}
	}
	conn, cleanup, err := c.connect(ctx, machineID)
	if err != nil {
		return result, err
	}
	defer cleanup()
	if req.MaxOutput <= 0 {
		req.MaxOutput = guestAgentDefaultOutput
	}
	if req.MaxOutput > guestAgentMaxOutput {
		req.MaxOutput = guestAgentMaxOutput
	}
	f := guestAgentFrame{
		Version:   guestAgentProtocolVersion,
		Type:      guestFrameExec,
		Command:   req.Command,
		TimeoutMS: req.Timeout.Milliseconds(),
		MaxOutput: req.MaxOutput,
		PTY:       req.PTY,
		Rows:      req.Rows,
		Cols:      req.Cols,
		Data:      req.Stdin,
	}
	if err := writeGuestFrame(conn, f); err != nil {
		return result, err
	}

	var captured int64
	for {
		f, err := readGuestFrame(conn)
		if err != nil {
			return result, err
		}
		switch f.Type {
		case guestFrameStdout:
			result.Stdout = append(result.Stdout, f.Data...)
			captured += int64(len(f.Data))
		case guestFrameStderr:
			result.Stderr = append(result.Stderr, f.Data...)
			captured += int64(len(f.Data))
		case guestFramePTY:
			result.PTY = append(result.PTY, f.Data...)
			captured += int64(len(f.Data))
		case guestFrameResult:
			if f.ExitCode == nil {
				return result, errors.New("guest agent omitted exec exit code")
			}
			result.ExitCode = *f.ExitCode
			result.TimedOut = f.TimedOut
			result.Truncated = f.Truncated
			return result, nil
		case guestFrameError:
			return result, guestAgentFrameError(f)
		default:
			return result, fmt.Errorf("unexpected guest exec frame %q", f.Type)
		}
		if captured > req.MaxOutput {
			return result, errors.New("guest agent exceeded requested output bound")
		}
	}
}

type guestUploadResult struct {
	Path string
	Size int64
}

func (c *guestAgentClient) Upload(ctx context.Context, machineID, path string, mode os.FileMode, size int64, src io.Reader) (guestUploadResult, error) {
	var result guestUploadResult
	if size > guestAgentMaxFileSize {
		return result, ErrGuestFileTooLarge
	}
	conn, cleanup, err := c.connect(ctx, machineID)
	if err != nil {
		return result, err
	}
	defer cleanup()
	if err := writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameUpload, Path: path, Mode: uint32(mode.Perm()), Size: size}); err != nil {
		return result, err
	}

	buf := make([]byte, guestAgentChunkSize)
	var sent int64
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			sent += int64(n)
			if sent > guestAgentMaxFileSize {
				return result, ErrGuestFileTooLarge
			}
			data := make([]byte, n)
			copy(data, buf[:n])
			if err := writeGuestFrame(conn, guestAgentFrame{Type: guestFrameData, Data: data}); err != nil {
				return result, err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return result, readErr
		}
	}
	if err := writeGuestFrame(conn, guestAgentFrame{Type: guestFrameEOF}); err != nil {
		return result, err
	}
	f, err := readGuestFrame(conn)
	if err != nil {
		return result, err
	}
	if f.Type == guestFrameError {
		return result, guestAgentFrameError(f)
	}
	if f.Type != guestFrameResult {
		return result, fmt.Errorf("unexpected guest upload frame %q", f.Type)
	}
	result.Path, result.Size = f.Path, f.Size
	return result, nil
}

type guestDownloadResult struct {
	Path string
	Mode os.FileMode
	Size int64
	Data []byte
}

func (c *guestAgentClient) Download(ctx context.Context, machineID, path string) (guestDownloadResult, error) {
	var contents bytes.Buffer
	result, err := c.DownloadTo(ctx, machineID, path, &contents, nil)
	if err != nil {
		return result, err
	}
	result.Data = contents.Bytes()
	return result, nil
}

// DownloadTo validates the guest's bounded metadata, then forwards every data
// frame directly to dst. Callers can commit response headers in onMetadata;
// file contents are never assembled in daemon memory.
func (c *guestAgentClient) DownloadTo(
	ctx context.Context,
	machineID string,
	path string,
	dst io.Writer,
	onMetadata func(guestDownloadResult) error,
) (guestDownloadResult, error) {
	var result guestDownloadResult
	conn, cleanup, err := c.connect(ctx, machineID)
	if err != nil {
		return result, err
	}
	defer cleanup()
	if err := writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameDownload, Path: path}); err != nil {
		return result, err
	}
	f, err := readGuestFrame(conn)
	if err != nil {
		return result, err
	}
	if f.Type == guestFrameError {
		return result, guestAgentFrameError(f)
	}
	if f.Type != guestFrameMeta {
		return result, fmt.Errorf("unexpected guest download frame %q", f.Type)
	}
	if f.Size < 0 || f.Size > guestAgentMaxFileSize {
		return result, ErrGuestFileTooLarge
	}
	expectedSize := f.Size
	result.Path, result.Mode, result.Size = f.Path, os.FileMode(f.Mode), expectedSize
	if onMetadata != nil {
		if err := onMetadata(result); err != nil {
			return result, err
		}
	}
	var received int64
	for {
		f, err := readGuestFrame(conn)
		if err != nil {
			return result, err
		}
		switch f.Type {
		case guestFrameData:
			received += int64(len(f.Data))
			if received > expectedSize || received > guestAgentMaxFileSize {
				return result, ErrGuestFileTooLarge
			}
			if err := writeGuestAll(dst, f.Data); err != nil {
				return result, err
			}
		case guestFrameEOF:
			if received != expectedSize {
				return result, errors.New("guest download size mismatch")
			}
			return result, nil
		case guestFrameError:
			return result, guestAgentFrameError(f)
		default:
			return result, fmt.Errorf("unexpected guest download frame %q", f.Type)
		}
	}
}

package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	timeoutExitCode       = 124
	defaultCommandTimeout = 30 * time.Second
	maxCommandTimeout     = 120 * time.Second
	// frameWriteTimeout bounds a single response-frame write. A client that stops
	// reading response frames must not be able to hold the frame mutex and stall
	// session cancellation or cleanup indefinitely.
	frameWriteTimeout = 10 * time.Second
	// teardownWriteTimeout bounds response writes once the session is cancelled.
	// It is short enough that a non-reading client cannot delay slot release, yet
	// long enough that a reading client still receives the final result frame.
	teardownWriteTimeout = 2 * time.Second
)

type lockedFrameWriter struct {
	mu               sync.Mutex
	w                io.Writer
	setWriteDeadline func(time.Time) error
	ctx              context.Context
	cancel           context.CancelFunc
}

func (w *lockedFrameWriter) send(f protocolFrame) error {
	w.mu.Lock()
	if w.setWriteDeadline != nil {
		deadline := time.Now().Add(frameWriteTimeout)
		// Once the session is cancelled, bound sends tightly so teardown does not
		// wait on a client that has stopped reading — while still leaving enough
		// time for a reading client to receive the final result frame.
		if w.ctx != nil && w.ctx.Err() != nil {
			deadline = time.Now().Add(teardownWriteTimeout)
		}
		_ = w.setWriteDeadline(deadline)
	}
	err := writeFrame(w.w, f)
	w.mu.Unlock()
	if err != nil && w.cancel != nil {
		w.cancel()
	}
	return err
}

type outputBudget struct {
	mu        sync.Mutex
	remaining int64
	truncated bool
}

func newOutputBudget(requested int64) *outputBudget {
	if requested <= 0 {
		requested = defaultOutputSize
	}
	if requested > maxOutputSize {
		requested = maxOutputSize
	}
	return &outputBudget{remaining: requested}
}

func (b *outputBudget) take(p []byte) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	if int64(len(p)) > b.remaining {
		p = p[:max(0, int(b.remaining))]
		b.truncated = true
	}
	b.remaining -= int64(len(p))
	if len(p) == 0 {
		return nil
	}
	out := make([]byte, len(p))
	copy(out, p)
	return out
}

func (b *outputBudget) wasTruncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}

func (s *agentServer) serveExec(conn net.Conn, req protocolFrame) {
	if req.Command == "" {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: "command is required"})
		return
	}

	timeout := defaultCommandTimeout
	if req.TimeoutMS > 0 {
		if req.TimeoutMS >= maxCommandTimeout.Milliseconds() {
			timeout = maxCommandTimeout
		} else {
			timeout = time.Duration(req.TimeoutMS) * time.Millisecond
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// On cancellation, interrupt any in-flight response write so teardown never
	// waits on a client that has stopped reading response frames.
	go func() { <-ctx.Done(); _ = conn.SetWriteDeadline(time.Now().Add(teardownWriteTimeout)) }()

	w := &lockedFrameWriter{w: conn, setWriteDeadline: conn.SetWriteDeadline, ctx: ctx, cancel: cancel}
	budget := newOutputBudget(req.MaxOutput)
	if req.PTY {
		s.runPTY(ctx, cancel, conn, w, budget, req)
		return
	}
	s.runPiped(ctx, cancel, conn, w, budget, req)
}

func (s *agentServer) runPiped(ctx context.Context, cancel context.CancelFunc, conn net.Conn, w *lockedFrameWriter, budget *outputBudget, req protocolFrame) {
	cmd := exec.Command("/bin/sh", "-c", req.Command)
	home := guestHome()
	cmd.Dir = home
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if len(req.Data) > 0 {
		cmd.Stdin = bytesReader(req.Data)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = w.send(protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = w.send(protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	if err := cmd.Start(); err != nil {
		_ = w.send(protocolFrame{Type: frameError, Error: err.Error()})
		return
	}

	done := make(chan struct{})
	go killProcessGroupOnCancel(ctx, cmd, done)
	go watchControlFrames(conn, cancel, nil)

	var readers sync.WaitGroup
	readers.Add(2)
	go streamOutput(&readers, stdout, frameStdout, w, budget)
	go streamOutput(&readers, stderr, frameStderr, w, budget)
	// Drain both pipes before Wait closes them. This is required for byte-exact
	// tail capture when a process exits immediately after its final write.
	readers.Wait()
	waitErr := cmd.Wait()
	close(done)

	code, timedOut := commandResult(ctx, waitErr)
	_ = w.send(protocolFrame{Type: frameResult, ExitCode: &code, TimedOut: timedOut, Truncated: budget.wasTruncated()})
}

func streamOutput(wg *sync.WaitGroup, r io.Reader, frameType string, w *lockedFrameWriter, budget *outputBudget) {
	defer wg.Done()
	buf := make([]byte, frameChunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if data := budget.take(buf[:n]); len(data) > 0 {
				_ = w.send(protocolFrame{Type: frameType, Data: data})
			}
		}
		if err != nil {
			return
		}
	}
}

func watchControlFrames(conn net.Conn, cancel context.CancelFunc, onFrame func(protocolFrame)) {
	for {
		f, err := readFrame(conn)
		if err != nil {
			cancel()
			return
		}
		if f.Type == frameCancel {
			cancel()
			return
		}
		if onFrame != nil {
			onFrame(f)
		}
	}
}

func killProcessGroupOnCancel(ctx context.Context, cmd *exec.Cmd, done <-chan struct{}) {
	select {
	case <-ctx.Done():
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Process.Kill()
		}
	case <-done:
	}
}

// killProcessGroup SIGKILLs the command's whole process group. PTY commands are
// started with Setsid (PID == PGID), so this reaps any backgrounded grandchild
// that still holds the PTY slave open after the foreground shell exits. Without
// it, the master read never sees EOF and the PTY reader goroutine — plus the
// connection and guest-operation slots it pins — wedges permanently on a command
// as ordinary as `sh -c 'myserver &'`.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

func commandResult(ctx context.Context, waitErr error) (int, bool) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return timeoutExitCode, true
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return 130, false
	}
	if waitErr == nil {
		return 0, false
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		return exitErr.ExitCode(), false
	}
	return 1, false
}

type byteReader struct {
	b []byte
}

func bytesReader(b []byte) *byteReader { return &byteReader{b: b} }

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

func guestHome() string {
	if os.Geteuid() == 0 {
		return "/root"
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home
	}
	return "/"
}

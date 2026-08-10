package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// serveTTY starts a long-lived login shell on a guest PTY. The transport is a
// fresh vsock stream, so nehemiahd can reconnect after a daemon restart without
// depending on the old daemon's Firecracker stdio file descriptors.
func (s *agentServer) serveTTY(conn net.Conn, req protocolFrame) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// On cancellation, interrupt any in-flight response write so teardown never
	// waits on a client that has stopped reading response frames.
	go func() { <-ctx.Done(); _ = conn.SetWriteDeadline(time.Now().Add(teardownWriteTimeout)) }()

	master, slave, err := openPTY(req.Rows, req.Cols)
	if err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "pty_unavailable", Error: "pty unavailable: " + err.Error()})
		return
	}
	defer master.Close()
	defer slave.Close()

	cmd := exec.Command("/bin/sh", "-l")
	home := guestHome()
	cmd.Dir = home
	cmd.Env = append(os.Environ(), "HOME="+home, "TERM=xterm-256color")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "pty_start_failed", Error: err.Error()})
		return
	}
	_ = slave.Close()

	w := &lockedFrameWriter{w: conn, setWriteDeadline: conn.SetWriteDeadline, ctx: ctx, cancel: cancel}
	if err := w.send(protocolFrame{Version: protocolVersion, Type: frameTTYReady}); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return
	}

	done := make(chan struct{})
	go killProcessGroupOnCancel(ctx, cmd, done)
	go watchTTYControlFrames(conn, cancel, master, w)

	var reader sync.WaitGroup
	reader.Add(1)
	go streamTTY(&reader, master, w)
	waitErr := cmd.Wait()
	close(done)
	killProcessGroup(cmd)
	_ = master.Close()
	reader.Wait()
	code, _ := commandResult(ctx, waitErr)
	_ = w.send(protocolFrame{Type: frameResult, ExitCode: &code})
}

const ttyStdinBufferedFrames = 64

// ptyInputPump writes terminal stdin to the PTY master on a dedicated goroutine
// so a process that stops reading can never block the control-frame reader from
// observing a client disconnect. It buffers a bounded number of frames and drops
// input under sustained backpressure. write and close are safe to call from
// different goroutines.
type ptyInputPump struct {
	ch   chan []byte
	stop chan struct{}
	once sync.Once
}

func startPTYInputPump(master io.Writer) *ptyInputPump {
	p := &ptyInputPump{ch: make(chan []byte, ttyStdinBufferedFrames), stop: make(chan struct{})}
	go func() {
		for {
			select {
			case <-p.stop:
				return
			case data := <-p.ch:
				if _, err := master.Write(data); err != nil {
					return
				}
			}
		}
	}()
	return p
}

var errPTYInputOverflow = errors.New("terminal input buffer overflow")

// enqueue submits stdin without blocking, so the caller's read loop is never
// stalled by a backpressured terminal. When the bounded buffer is full (sustained
// backpressure) it returns errPTYInputOverflow instead of silently dropping input,
// letting the caller fail the session explicitly rather than lose data.
func (p *ptyInputPump) enqueue(data []byte) error {
	select {
	case <-p.stop:
		return nil
	default:
	}
	select {
	case p.ch <- append([]byte(nil), data...):
		return nil
	case <-p.stop:
		return nil
	default:
		return errPTYInputOverflow
	}
}

// Write lets the pump stand in for the PTY master as an io.Writer; overflow is
// surfaced as a write error rather than a silent drop.
func (p *ptyInputPump) Write(data []byte) (int, error) {
	if err := p.enqueue(data); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (p *ptyInputPump) close() { p.once.Do(func() { close(p.stop) }) }

func watchTTYControlFrames(conn net.Conn, cancel context.CancelFunc, master *os.File, w *lockedFrameWriter) {
	// Terminal stdin is written through a non-blocking pump so a process that
	// stops reading cannot block this loop from observing a client disconnect.
	pump := startPTYInputPump(master)
	defer pump.close()
	for {
		frame, err := readFrame(conn)
		if err != nil {
			cancel()
			return
		}
		// Route stdin through the pump; resize needs the real *os.File master.
		target := io.Writer(pump)
		if frame.Type != frameStdin {
			target = master
		}
		if err := applyTTYControlFrame(target, frame); err != nil {
			// Cancel first: the best-effort error frame must never delay teardown
			// if the client has stopped reading responses.
			cancel()
			_ = w.send(protocolFrame{Type: frameError, Code: "invalid_tty_frame", Error: err.Error()})
			return
		}
		if frame.Type == frameCancel {
			cancel()
			return
		}
	}
}

func applyTTYControlFrame(master io.Writer, frame protocolFrame) error {
	switch frame.Type {
	case frameStdin:
		if len(frame.Data) > maxTTYFrameSize {
			return fmt.Errorf("terminal input is %d bytes (limit %d)", len(frame.Data), maxTTYFrameSize)
		}
		_, err := master.Write(frame.Data)
		return err
	case frameResize:
		file, ok := master.(*os.File)
		if !ok {
			return errors.New("terminal resize is unavailable")
		}
		return setPTYSize(file, frame.Rows, frame.Cols)
	case frameCancel:
		return nil
	default:
		return fmt.Errorf("unsupported terminal frame %q", frame.Type)
	}
}

func streamTTY(wg *sync.WaitGroup, r io.Reader, w *lockedFrameWriter) {
	defer wg.Done()
	buf := make([]byte, frameChunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := append([]byte(nil), buf[:n]...)
			if sendErr := w.send(protocolFrame{Type: framePTY, Data: data}); sendErr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *agentServer) runPTY(ctx context.Context, cancel context.CancelFunc, conn net.Conn, w *lockedFrameWriter, budget *outputBudget, req protocolFrame) {
	master, slave, err := openPTY(req.Rows, req.Cols)
	if err != nil {
		_ = w.send(protocolFrame{Type: frameError, Error: "pty unavailable: " + err.Error()})
		return
	}
	defer master.Close()
	defer slave.Close()

	cmd := exec.Command("/bin/sh", "-c", req.Command)
	home := guestHome()
	cmd.Dir = home
	cmd.Env = append(os.Environ(), "HOME="+home, "TERM=xterm-256color")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = w.send(protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	_ = slave.Close()
	if len(req.Data) > 0 {
		_, _ = master.Write(req.Data)
	}

	done := make(chan struct{})
	go killProcessGroupOnCancel(ctx, cmd, done)
	pump := startPTYInputPump(master)
	defer pump.close()
	go watchControlFrames(conn, cancel, func(f protocolFrame) {
		switch f.Type {
		case frameStdin:
			if err := pump.enqueue(f.Data); err != nil {
				// Cancel first so a client that stopped reading cannot delay teardown.
				cancel()
				_ = w.send(protocolFrame{Type: frameError, Code: "tty_input_overflow", Error: err.Error()})
			}
		case frameResize:
			_ = setPTYSize(master, f.Rows, f.Cols)
		}
	})

	var reader sync.WaitGroup
	reader.Add(1)
	go streamPTY(&reader, master, w, budget)
	waitErr := cmd.Wait()
	close(done)
	killProcessGroup(cmd)
	_ = master.Close()
	reader.Wait()
	code, timedOut := commandResult(ctx, waitErr)
	_ = w.send(protocolFrame{Type: frameResult, ExitCode: &code, TimedOut: timedOut, Truncated: budget.wasTruncated()})
}

func streamPTY(wg *sync.WaitGroup, r io.Reader, w *lockedFrameWriter, budget *outputBudget) {
	defer wg.Done()
	buf := make([]byte, frameChunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if data := budget.take(buf[:n]); len(data) > 0 {
				_ = w.send(protocolFrame{Type: framePTY, Data: data})
			}
		}
		if err != nil {
			return
		}
	}
}

func openPTY(rows, cols uint16) (*os.File, *os.File, error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	master := os.NewFile(uintptr(fd), "/dev/ptmx")
	fail := func(err error) (*os.File, *os.File, error) {
		_ = master.Close()
		return nil, nil, err
	}
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		return fail(err)
	}
	n, err := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if err != nil {
		return fail(err)
	}
	slave, err := os.OpenFile(filepath.Join("/dev/pts", strconv.Itoa(n)), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return fail(err)
	}
	if err := setPTYSize(master, rows, cols); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, nil, err
	}
	return master, slave, nil
}

func setPTYSize(master *os.File, rows, cols uint16) error {
	if rows == 0 {
		rows = 24
	}
	if cols == 0 {
		cols = 80
	}
	err := unix.IoctlSetWinsize(int(master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Row: rows, Col: cols})
	if errors.Is(err, unix.ENOTTY) {
		return nil
	}
	return err
}

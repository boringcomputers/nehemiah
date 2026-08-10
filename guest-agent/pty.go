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

	"golang.org/x/sys/unix"
)

// serveTTY starts a long-lived login shell on a guest PTY. The transport is a
// fresh vsock stream, so nehemiahd can reconnect after a daemon restart without
// depending on the old daemon's Firecracker stdio file descriptors.
func (s *agentServer) serveTTY(conn net.Conn, req protocolFrame) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

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

	w := &lockedFrameWriter{w: conn, cancel: cancel}
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

func watchTTYControlFrames(conn net.Conn, cancel context.CancelFunc, master *os.File, w *lockedFrameWriter) {
	for {
		frame, err := readFrame(conn)
		if err != nil {
			cancel()
			return
		}
		if err := applyTTYControlFrame(master, frame); err != nil {
			_ = w.send(protocolFrame{Type: frameError, Code: "invalid_tty_frame", Error: err.Error()})
			cancel()
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
	go watchControlFrames(conn, cancel, func(f protocolFrame) {
		switch f.Type {
		case frameStdin:
			_, _ = master.Write(f.Data)
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

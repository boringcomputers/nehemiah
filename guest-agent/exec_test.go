package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type capturedExec struct {
	stdout, stderr, pty []byte
	result              protocolFrame
}

func runTestExec(t *testing.T, req protocolFrame) capturedExec {
	t.Helper()
	conn, done := startTestConn(t)
	defer func() {
		_ = conn.Close()
		<-done
	}()
	req.Version = protocolVersion
	req.Type = frameExec
	if err := writeFrame(conn, req); err != nil {
		t.Fatal(err)
	}
	var got capturedExec
	for {
		f, err := readFrame(conn)
		if err != nil {
			t.Fatal(err)
		}
		switch f.Type {
		case frameStdout:
			got.stdout = append(got.stdout, f.Data...)
		case frameStderr:
			got.stderr = append(got.stderr, f.Data...)
		case framePTY:
			got.pty = append(got.pty, f.Data...)
		case frameResult:
			got.result = f
			return got
		case frameError:
			t.Fatalf("agent error: %s", f.Error)
		default:
			t.Fatalf("unexpected frame %#v", f)
		}
	}
}

func TestExecSeparatesAndPreservesStdoutStderr(t *testing.T) {
	got := runTestExec(t, protocolFrame{Command: `printf '\000\001\377'; printf '\002\376' >&2`})
	if !bytes.Equal(got.stdout, []byte{0, 1, 0xff}) {
		t.Fatalf("stdout = %v", got.stdout)
	}
	if !bytes.Equal(got.stderr, []byte{2, 0xfe}) {
		t.Fatalf("stderr = %v", got.stderr)
	}
	if got.result.ExitCode == nil || *got.result.ExitCode != 0 || got.result.TimedOut {
		t.Fatalf("result = %#v", got.result)
	}
}

func TestExecBoundsCombinedOutput(t *testing.T) {
	got := runTestExec(t, protocolFrame{Command: `head -c 4096 /dev/zero; head -c 4096 /dev/zero >&2`, MaxOutput: 1024})
	if n := len(got.stdout) + len(got.stderr); n != 1024 {
		t.Fatalf("captured %d bytes, want 1024", n)
	}
	if !got.result.Truncated {
		t.Fatal("result did not report truncation")
	}
}

func TestExecTimeoutUsesStableExitCode(t *testing.T) {
	start := time.Now()
	got := runTestExec(t, protocolFrame{Command: `sleep 5`, TimeoutMS: 75})
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
	if got.result.ExitCode == nil || *got.result.ExitCode != timeoutExitCode || !got.result.TimedOut {
		t.Fatalf("result = %#v", got.result)
	}
}

func TestDisconnectCancelsExecProcessGroup(t *testing.T) {
	dir := t.TempDir()
	started := filepath.Join(dir, "started")
	finished := filepath.Join(dir, "finished")
	conn, done := startTestConn(t)
	cmd := fmt.Sprintf("touch %q; sleep 1; touch %q", started, finished)
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameExec, Command: cmd}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	_ = conn.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("agent did not stop disconnected exec")
	}
	time.Sleep(1100 * time.Millisecond)
	if _, err := os.Stat(finished); !os.IsNotExist(err) {
		t.Fatalf("disconnected command survived: %v", err)
	}
}

func TestPTYExecutionUsesATerminal(t *testing.T) {
	got := runTestExec(t, protocolFrame{Command: `test -t 0 && printf pty-ok`, PTY: true, Rows: 30, Cols: 100})
	if !bytes.Contains(got.pty, []byte("pty-ok")) {
		t.Fatalf("PTY output = %q", got.pty)
	}
	if got.result.ExitCode == nil || *got.result.ExitCode != 0 {
		t.Fatalf("result = %#v", got.result)
	}
}

// TestPTYBackgroundChildDoesNotWedgeResult is the regression for the guest-agent
// PTY slot-leak wedge: a backgrounded process that keeps the PTY slave open after
// the foreground shell exits must not prevent the result frame. Before the fix the
// master read never saw EOF and the reader goroutine (holding the connection and
// guest-operation slots) blocked forever. The bounded wait fails fast instead of
// hanging the suite if the wedge returns.
func TestPTYBackgroundChildDoesNotWedgeResult(t *testing.T) {
	resultCh := make(chan capturedExec, 1)
	go func() {
		// The shell backgrounds sleep (which inherits and holds the PTY slave)
		// and exits immediately.
		resultCh <- runTestExec(t, protocolFrame{Command: `sleep 300 &`, PTY: true, Rows: 30, Cols: 100})
	}()
	select {
	case got := <-resultCh:
		if got.result.ExitCode == nil {
			t.Fatalf("result frame missing exit code: %#v", got.result)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("PTY result wedged: a backgrounded child held the terminal open")
	}
}

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func pipeGuestClient(t *testing.T, handler func(net.Conn)) *guestAgentClient {
	t.Helper()
	return &guestAgentClient{dial: func(context.Context, string) (net.Conn, error) {
		client, guest := net.Pipe()
		go func() {
			defer guest.Close()
			handler(guest)
		}()
		return client, nil
	}}
}

func TestGuestAgentPingReconnectsForEveryCall(t *testing.T) {
	var dials atomic.Int32
	client := pipeGuestClient(t, func(conn net.Conn) {
		dials.Add(1)
		req, err := readGuestFrame(conn)
		if err != nil {
			t.Errorf("read ping: %v", err)
			return
		}
		if req.Type != guestFramePing || req.Version != guestAgentProtocolVersion {
			t.Errorf("ping = %#v", req)
			return
		}
		_ = writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameReady})
	})
	for i := 0; i < 2; i++ {
		if err := client.Ping(context.Background(), "machine"); err != nil {
			t.Fatal(err)
		}
	}
	if got := dials.Load(); got != 2 {
		t.Fatalf("dial count = %d, want 2", got)
	}
}

func TestGuestAgentExecKeepsStreamsByteExact(t *testing.T) {
	wantOut := []byte{0, 1, 0xff, '\n'}
	wantErr := []byte{2, 0xfe, 0}
	client := pipeGuestClient(t, func(conn net.Conn) {
		req, err := readGuestFrame(conn)
		if err != nil {
			t.Errorf("read exec: %v", err)
			return
		}
		if req.Type != guestFrameExec || req.Command != "binary-output" || req.TimeoutMS != 2500 {
			t.Errorf("exec request = %#v", req)
			return
		}
		code := 7
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameStdout, Data: wantOut[:2]})
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameStderr, Data: wantErr})
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameStdout, Data: wantOut[2:]})
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameResult, ExitCode: &code})
	})
	got, err := client.Exec(context.Background(), "machine", guestExecRequest{Command: "binary-output", Timeout: 2500 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Stdout, wantOut) || !bytes.Equal(got.Stderr, wantErr) {
		t.Fatalf("stdout=%v stderr=%v", got.Stdout, got.Stderr)
	}
	if got.ExitCode != 7 {
		t.Fatalf("exit code = %d", got.ExitCode)
	}
}

func TestGuestAgentExecRejectsOutputBeyondBound(t *testing.T) {
	client := pipeGuestClient(t, func(conn net.Conn) {
		_, _ = readGuestFrame(conn)
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameStdout, Data: make([]byte, 9)})
	})
	_, err := client.Exec(context.Background(), "machine", guestExecRequest{Command: "x", MaxOutput: 8})
	if err == nil || err.Error() != "guest agent exceeded requested output bound" {
		t.Fatalf("error = %v", err)
	}
}

func TestGuestAgentContextCancellationClosesStream(t *testing.T) {
	guestSawClose := make(chan struct{})
	client := pipeGuestClient(t, func(conn net.Conn) {
		_, _ = readGuestFrame(conn)
		_, err := readGuestFrame(conn)
		if err != nil {
			close(guestSawClose)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := client.Exec(ctx, "machine", guestExecRequest{Command: "sleep"})
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Exec succeeded after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("Exec did not unblock after cancellation")
	}
	select {
	case <-guestSawClose:
	case <-time.After(time.Second):
		t.Fatal("guest did not observe the closed stream")
	}
}

func TestGuestAgentUploadAndDownload(t *testing.T) {
	want := []byte{0, 1, '\n', 0xff, 0xfe}
	var uploaded []byte
	var calls atomic.Int32
	client := pipeGuestClient(t, func(conn net.Conn) {
		switch calls.Add(1) {
		case 1:
			req, err := readGuestFrame(conn)
			if err != nil {
				t.Errorf("read upload: %v", err)
				return
			}
			if req.Type != guestFrameUpload || req.Path != "/root/persist.bin" || req.Size != int64(len(want)) {
				t.Errorf("upload request = %#v", req)
				return
			}
			for {
				f, err := readGuestFrame(conn)
				if err != nil {
					t.Errorf("read upload data: %v", err)
					return
				}
				if f.Type == guestFrameEOF {
					break
				}
				uploaded = append(uploaded, f.Data...)
			}
			_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameResult, Path: req.Path, Size: int64(len(uploaded))})
		case 2:
			req, _ := readGuestFrame(conn)
			if req.Type != guestFrameDownload || req.Path != "/root/persist.bin" {
				t.Errorf("download request = %#v", req)
				return
			}
			_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameMeta, Path: req.Path, Mode: 0o600, Size: int64(len(uploaded))})
			_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameData, Data: uploaded})
			_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameEOF})
		}
	})
	upload, err := client.Upload(context.Background(), "machine", "/root/persist.bin", 0o600, int64(len(want)), bytes.NewReader(want))
	if err != nil {
		t.Fatal(err)
	}
	if upload.Size != int64(len(want)) || !bytes.Equal(uploaded, want) {
		t.Fatalf("upload=%#v bytes=%v", upload, uploaded)
	}
	download, err := client.Download(context.Background(), "machine", "/root/persist.bin")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(download.Data, want) {
		t.Fatalf("download = %v", download.Data)
	}
}

func TestGuestAgentDownloadStreamsBeforeEOF(t *testing.T) {
	firstWritten := make(chan struct{})
	continueStream := make(chan struct{})
	client := pipeGuestClient(t, func(conn net.Conn) {
		req, _ := readGuestFrame(conn)
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameMeta, Path: req.Path, Mode: 0o600, Size: 6})
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameData, Data: []byte("abc")})
		<-continueStream
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameData, Data: []byte("def")})
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameEOF})
	})

	type signalingWriter struct {
		bytes.Buffer
		once atomic.Bool
	}
	writer := &signalingWriter{}
	done := make(chan error, 1)
	go func() {
		_, err := client.DownloadTo(context.Background(), "machine", "/root/stream.bin", writerFunc(func(p []byte) (int, error) {
			n, err := writer.Buffer.Write(p)
			if writer.once.CompareAndSwap(false, true) {
				close(firstWritten)
			}
			return n, err
		}), func(result guestDownloadResult) error {
			if result.Size != 6 || len(result.Data) != 0 {
				t.Errorf("metadata = %#v", result)
			}
			return nil
		})
		done <- err
	}()

	select {
	case <-firstWritten:
		if got := writer.String(); got != "abc" {
			t.Fatalf("first streamed bytes = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("first data frame was buffered until EOF")
	}
	close(continueStream)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := writer.String(); got != "abcdef" {
		t.Fatalf("streamed bytes = %q", got)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestGuestAgentUnavailableIsTyped(t *testing.T) {
	client := &guestAgentClient{dial: func(context.Context, string) (net.Conn, error) {
		return nil, io.EOF
	}}
	err := client.Ping(context.Background(), "machine")
	if !errors.Is(err, ErrGuestAgentUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func TestGuestAgentRemoteErrorKeepsCode(t *testing.T) {
	client := pipeGuestClient(t, func(conn net.Conn) {
		_, _ = readGuestFrame(conn)
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFrameError, Code: "not_found", Error: "missing"})
	})
	_, err := client.Download(context.Background(), "machine", "/root/missing")
	var remote *guestAgentRemoteError
	if !errors.As(err, &remote) || remote.Code != "not_found" {
		t.Fatalf("error = %#v", err)
	}
}

func TestGuestAgentInteractiveTTYIsFreshAndByteExact(t *testing.T) {
	want := []byte{0, 1, '\n', 0xff, 0xfe}
	input := []byte("echo restart-safe\n")
	client := pipeGuestClient(t, func(conn net.Conn) {
		request, err := readGuestFrame(conn)
		if err != nil {
			t.Errorf("read terminal open: %v", err)
			return
		}
		if request.Type != guestFrameTTY || request.Version != guestAgentProtocolVersion || request.Rows != 24 || request.Cols != 80 {
			t.Errorf("terminal open = %#v", request)
			return
		}
		_ = writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameTTYReady})
		stdin, err := readGuestFrame(conn)
		if err != nil {
			t.Errorf("read terminal input: %v", err)
			return
		}
		if stdin.Type != guestFrameStdin || !bytes.Equal(stdin.Data, input) {
			t.Errorf("terminal input = %#v", stdin)
			return
		}
		_ = writeGuestFrame(conn, guestAgentFrame{Type: guestFramePTY, Data: want})
	})
	session, err := client.OpenTTY(context.Background(), "m-01020304", 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if err := session.Write(input); err != nil {
		t.Fatal(err)
	}
	got, err := session.Read()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("terminal output = %v, want %v", got, want)
	}
}

func TestGuestAgentInteractiveTTYRejectsOversizedFrames(t *testing.T) {
	client := pipeGuestClient(t, func(conn net.Conn) {
		_, _ = readGuestFrame(conn)
		_ = writeGuestFrame(conn, guestAgentFrame{Version: guestAgentProtocolVersion, Type: guestFrameTTYReady})
	})
	session, err := client.OpenTTY(context.Background(), "m-01020304", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if err := session.Write(make([]byte, guestAgentTTYFrameSize+1)); err == nil {
		t.Fatal("oversized terminal input accepted")
	}
}

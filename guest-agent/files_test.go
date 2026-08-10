package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func uploadTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	conn, done := startTestConn(t)
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameUpload, Path: path, Size: int64(len(data)), Mode: 0o640}); err != nil {
		t.Fatal(err)
	}
	for len(data) > 0 {
		n := min(7, len(data))
		if err := writeFrame(conn, protocolFrame{Type: frameData, Data: data[:n]}); err != nil {
			t.Fatal(err)
		}
		data = data[n:]
	}
	if err := writeFrame(conn, protocolFrame{Type: frameEOF}); err != nil {
		t.Fatal(err)
	}
	result, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	if result.Type != frameResult {
		t.Fatalf("upload response = %#v", result)
	}
	_ = conn.Close()
	<-done
}

func downloadTestFile(t *testing.T, path string) []byte {
	t.Helper()
	conn, done := startTestConn(t)
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameDownload, Path: path}); err != nil {
		t.Fatal(err)
	}
	meta, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Type != frameMeta {
		t.Fatalf("download metadata = %#v", meta)
	}
	var data []byte
	for {
		f, err := readFrame(conn)
		if err != nil {
			t.Fatal(err)
		}
		if f.Type == frameEOF {
			break
		}
		if f.Type != frameData {
			t.Fatalf("download frame = %#v", f)
		}
		data = append(data, f.Data...)
	}
	_ = conn.Close()
	<-done
	return data
}

func TestUploadPersistsAndDownloadIsByteExact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "persistent.bin")
	want := []byte{0, 1, 2, '\n', 0xff, 0xfe, 0}
	uploadTestFile(t, path, want)

	// Download uses a new connection/agent call; the file is durable guest disk
	// state rather than connection-local state.
	got := downloadTestFile(t, path)
	if !bytes.Equal(got, want) {
		t.Fatalf("download = %v, want %v", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if gotMode := info.Mode().Perm(); gotMode != 0o640 {
		t.Fatalf("mode = %o", gotMode)
	}
}

func TestEmptyFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty")
	uploadTestFile(t, path, nil)
	if got := downloadTestFile(t, path); len(got) != 0 {
		t.Fatalf("empty download = %v", got)
	}
}

func TestDownloadMissingFileHasStableErrorCode(t *testing.T) {
	conn, done := startTestConn(t)
	missing := filepath.Join(t.TempDir(), "missing")
	if err := writeFrame(conn, protocolFrame{Version: protocolVersion, Type: frameDownload, Path: missing}); err != nil {
		t.Fatal(err)
	}
	f, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	if f.Type != frameError || f.Code != "not_found" {
		t.Fatalf("response = %#v", f)
	}
	_ = conn.Close()
	<-done
}

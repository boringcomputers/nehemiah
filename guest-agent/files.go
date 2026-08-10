package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
)

func guestPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("path is required")
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join("/root", p)
	}
	return filepath.Clean(p), nil
}

func (s *agentServer) serveUpload(conn net.Conn, req protocolFrame) {
	dest, err := guestPath(req.Path)
	if err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	if req.Size > maxFileSize {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "too_large", Error: "file exceeds 16 MiB limit"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".bc-upload-*")
	if err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()

	var written int64
	for {
		f, err := readFrame(conn)
		if err != nil {
			return
		}
		switch f.Type {
		case frameData:
			written += int64(len(f.Data))
			if written > maxFileSize {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "too_large", Error: "file exceeds 16 MiB limit"})
				return
			}
			if err := writeAll(tmp, f.Data); err != nil {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
				return
			}
		case frameEOF:
			if req.Size >= 0 && req.Size != written {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: fmt.Sprintf("size mismatch: expected %d, received %d", req.Size, written)})
				return
			}
			mode := os.FileMode(req.Mode)
			if mode == 0 {
				mode = 0o600
			}
			if err := tmp.Chmod(mode.Perm()); err != nil {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
				return
			}
			if err := tmp.Sync(); err != nil {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
				return
			}
			if err := tmp.Close(); err != nil {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
				return
			}
			if err := os.Rename(tmpName, dest); err != nil {
				_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
				return
			}
			ok = true
			_ = writeFrame(conn, protocolFrame{Type: frameResult, Path: dest, Size: written})
			return
		default:
			_ = writeFrame(conn, protocolFrame{Type: frameError, Error: "expected data or eof frame"})
			return
		}
	}
}

func (s *agentServer) serveDownload(conn net.Conn, req protocolFrame) {
	source, err := guestPath(req.Path)
	if err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
		return
	}
	info, err := os.Stat(source)
	if err != nil {
		code := "io_error"
		if os.IsNotExist(err) {
			code = "not_found"
		}
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: code, Error: err.Error()})
		return
	}
	if !info.Mode().IsRegular() {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Error: "path is not a regular file"})
		return
	}
	if info.Size() > maxFileSize {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "too_large", Error: "file exceeds 16 MiB limit"})
		return
	}
	f, err := os.Open(source)
	if err != nil {
		_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "io_error", Error: err.Error()})
		return
	}
	defer f.Close()
	if err := writeFrame(conn, protocolFrame{Type: frameMeta, Path: source, Mode: uint32(info.Mode().Perm()), Size: info.Size()}); err != nil {
		return
	}
	buf := make([]byte, frameChunkSize)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if err := writeFrame(conn, protocolFrame{Type: frameData, Data: data}); err != nil {
				return
			}
		}
		if errors.Is(err, io.EOF) {
			_ = writeFrame(conn, protocolFrame{Type: frameEOF})
			return
		}
		if err != nil {
			_ = writeFrame(conn, protocolFrame{Type: frameError, Error: err.Error()})
			return
		}
	}
}

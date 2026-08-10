package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	protocolVersion = 1
	agentPort       = 2222

	maxFrameSize      = 1 << 20
	frameChunkSize    = 32 << 10
	defaultOutputSize = 64 << 10
	maxOutputSize     = 1 << 20
	maxFileSize       = 16 << 20
)

const (
	framePing     = "ping"
	frameReady    = "ready"
	frameExec     = "exec"
	frameStdout   = "stdout"
	frameStderr   = "stderr"
	framePTY      = "pty"
	frameTTY      = "tty"
	frameTTYReady = "tty_ready"
	frameStdin    = "stdin"
	frameResize   = "resize"
	frameCancel   = "cancel"
	frameResult   = "result"
	frameUpload   = "upload"
	frameDownload = "download"
	frameMeta     = "meta"
	frameData     = "data"
	frameEOF      = "eof"
	frameError    = "error"
)

// Interactive terminal input is additionally bounded below the generic
// protocol-frame ceiling. This matches the host WebSocket limit and prevents a
// single terminal client from forcing a large base64 allocation in the guest.
const maxTTYFrameSize = 64 << 10

// protocolFrame is the single versioned wire type used in both directions.
// Frames are length-prefixed JSON. []byte fields are base64-encoded by the JSON
// package, preserving arbitrary stdout, stderr, PTY, and file bytes exactly.
type protocolFrame struct {
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

func writeFrame(w io.Writer, f protocolFrame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	if len(raw) > maxFrameSize {
		return fmt.Errorf("frame is %d bytes (limit %d)", len(raw), maxFrameSize)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(raw)))
	if err := writeAll(w, header[:]); err != nil {
		return err
	}
	return writeAll(w, raw)
}

func readFrame(r io.Reader) (protocolFrame, error) {
	var f protocolFrame
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return f, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > maxFrameSize {
		return f, fmt.Errorf("invalid frame size %d", n)
	}
	raw := make([]byte, int(n))
	if _, err := io.ReadFull(r, raw); err != nil {
		return f, err
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return f, fmt.Errorf("decode frame: %w", err)
	}
	if f.Type == "" {
		return f, errors.New("frame type is required")
	}
	return f, nil
}

func writeAll(w io.Writer, p []byte) error {
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

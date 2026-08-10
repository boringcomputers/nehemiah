package main

import (
	"bytes"
	"io"
	"testing"
)

type shortWriter struct {
	w io.Writer
}

func (w shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.w.Write(p)
}

func TestProtocolFramePreservesArbitraryBytes(t *testing.T) {
	want := protocolFrame{Version: protocolVersion, Type: frameStdout, Data: []byte{0, 1, '\n', 0xff, 0xfe}}
	var wire bytes.Buffer
	if err := writeFrame(shortWriter{w: &wire}, want); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(&wire)
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != want.Type || !bytes.Equal(got.Data, want.Data) {
		t.Fatalf("round trip = %#v, want %#v", got, want)
	}
}

func TestProtocolRejectsOversizedFrame(t *testing.T) {
	var wire bytes.Buffer
	wire.Write([]byte{0x00, 0x20, 0x00, 0x01})
	if _, err := readFrame(&wire); err == nil {
		t.Fatal("readFrame accepted an oversized frame")
	}
}

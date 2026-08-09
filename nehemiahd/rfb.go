package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"time"
)

// rfbClient is a minimal RFB (VNC) client speaking just enough of the protocol
// to drive the guest desktop for the computer-use agent: capture the framebuffer
// as a PNG and inject pointer/keyboard events. It assumes the "None" security
// type (x11vnc -nopw) and forces Raw encoding + a fixed 32bpp pixel format so
// decoding is trivial.
type rfbClient struct {
	conn          net.Conn
	r             *bufio.Reader
	width, height int
}

func newRFBClient(conn net.Conn) (*rfbClient, error) {
	c := &rfbClient{conn: conn, r: bufio.NewReaderSize(conn, 1<<20)}
	if err := c.handshake(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *rfbClient) readString32() string {
	h := make([]byte, 4)
	if _, err := io.ReadFull(c.r, h); err != nil {
		return ""
	}
	n := binary.BigEndian.Uint32(h)
	if n > 4096 {
		n = 4096
	}
	buf := make([]byte, n)
	io.ReadFull(c.r, buf)
	return string(buf)
}

func (c *rfbClient) handshake() error {
	c.conn.SetDeadline(time.Now().Add(20 * time.Second))
	defer c.conn.SetDeadline(time.Time{})

	// ProtocolVersion exchange.
	ver := make([]byte, 12)
	if _, err := io.ReadFull(c.r, ver); err != nil {
		return fmt.Errorf("read version: %w", err)
	}
	if _, err := c.conn.Write([]byte("RFB 003.008\n")); err != nil {
		return err
	}

	// Security types (3.7+): count, then that many type bytes.
	nb := make([]byte, 1)
	if _, err := io.ReadFull(c.r, nb); err != nil {
		return fmt.Errorf("read security count: %w", err)
	}
	if nb[0] == 0 {
		return fmt.Errorf("rfb security failed: %s", c.readString32())
	}
	types := make([]byte, int(nb[0]))
	if _, err := io.ReadFull(c.r, types); err != nil {
		return err
	}
	hasNone := false
	for _, t := range types {
		if t == 1 {
			hasNone = true
		}
	}
	if !hasNone {
		return fmt.Errorf("no None security type offered (got %v)", types)
	}
	if _, err := c.conn.Write([]byte{1}); err != nil {
		return err
	}
	// SecurityResult (3.8).
	res := make([]byte, 4)
	if _, err := io.ReadFull(c.r, res); err != nil {
		return err
	}
	if binary.BigEndian.Uint32(res) != 0 {
		return fmt.Errorf("rfb security result: %s", c.readString32())
	}

	// ClientInit: shared.
	if _, err := c.conn.Write([]byte{1}); err != nil {
		return err
	}
	// ServerInit: width(2) height(2) pixel-format(16) name-length(4) name.
	head := make([]byte, 24)
	if _, err := io.ReadFull(c.r, head); err != nil {
		return fmt.Errorf("read serverinit: %w", err)
	}
	c.width = int(binary.BigEndian.Uint16(head[0:2]))
	c.height = int(binary.BigEndian.Uint16(head[2:4]))
	if nameLen := binary.BigEndian.Uint32(head[20:24]); nameLen > 0 && nameLen < 4096 {
		io.CopyN(io.Discard, c.r, int64(nameLen))
	}
	if c.width == 0 || c.height == 0 || c.width > 4096 || c.height > 4096 {
		return fmt.Errorf("bad framebuffer size %dx%d", c.width, c.height)
	}

	// SetPixelFormat: 32bpp, depth 24, little-endian, true-colour, RGB at
	// shifts 16/8/0 → pixel bytes are [B,G,R,X].
	if _, err := c.conn.Write([]byte{
		0, 0, 0, 0, // msg-type + padding
		32, 24, 0, 1,
		0, 255, 0, 255, 0, 255, // r/g/b max
		16, 8, 0, // r/g/b shift
		0, 0, 0, // padding
	}); err != nil {
		return err
	}
	// SetEncodings: Raw (0) only.
	if _, err := c.conn.Write([]byte{2, 0, 0, 1, 0, 0, 0, 0}); err != nil {
		return err
	}
	return nil
}

// Screenshot requests a full framebuffer update and returns it PNG-encoded.
func (c *rfbClient) Screenshot() ([]byte, error) {
	c.conn.SetDeadline(time.Now().Add(25 * time.Second))
	defer c.conn.SetDeadline(time.Time{})

	req := make([]byte, 10)
	req[0] = 3 // FramebufferUpdateRequest
	req[1] = 0 // non-incremental (full)
	binary.BigEndian.PutUint16(req[6:], uint16(c.width))
	binary.BigEndian.PutUint16(req[8:], uint16(c.height))
	if _, err := c.conn.Write(req); err != nil {
		return nil, err
	}

	img := image.NewRGBA(image.Rect(0, 0, c.width, c.height))
	mt := make([]byte, 1)
	for {
		if _, err := io.ReadFull(c.r, mt); err != nil {
			return nil, err
		}
		switch mt[0] {
		case 0: // FramebufferUpdate
			hdr := make([]byte, 3) // padding(1) + num-rects(2)
			if _, err := io.ReadFull(c.r, hdr); err != nil {
				return nil, err
			}
			numRects := int(binary.BigEndian.Uint16(hdr[1:3]))
			for i := 0; i < numRects; i++ {
				rh := make([]byte, 12)
				if _, err := io.ReadFull(c.r, rh); err != nil {
					return nil, err
				}
				rx := int(binary.BigEndian.Uint16(rh[0:2]))
				ry := int(binary.BigEndian.Uint16(rh[2:4]))
				rw := int(binary.BigEndian.Uint16(rh[4:6]))
				rH := int(binary.BigEndian.Uint16(rh[6:8]))
				if enc := int32(binary.BigEndian.Uint32(rh[8:12])); enc != 0 {
					return nil, fmt.Errorf("unsupported encoding %d", enc)
				}
				buf := make([]byte, rw*rH*4)
				if _, err := io.ReadFull(c.r, buf); err != nil {
					return nil, err
				}
				for yy := 0; yy < rH; yy++ {
					for xx := 0; xx < rw; xx++ {
						o := (yy*rw + xx) * 4
						img.SetRGBA(rx+xx, ry+yy, color.RGBA{buf[o+2], buf[o+1], buf[o], 255})
					}
				}
			}
			var out bytes.Buffer
			if err := png.Encode(&out, img); err != nil {
				return nil, err
			}
			return out.Bytes(), nil
		case 1: // SetColourMapEntries
			m := make([]byte, 5)
			io.ReadFull(c.r, m)
			io.CopyN(io.Discard, c.r, int64(binary.BigEndian.Uint16(m[3:5]))*6)
		case 2: // Bell
		case 3: // ServerCutText
			m := make([]byte, 7)
			io.ReadFull(c.r, m)
			io.CopyN(io.Discard, c.r, int64(binary.BigEndian.Uint32(m[3:7])))
		default:
			return nil, fmt.Errorf("unknown server message %d", mt[0])
		}
	}
}

func (c *rfbClient) pointer(mask byte, x, y int) error {
	m := make([]byte, 6)
	m[0] = 5
	m[1] = mask
	binary.BigEndian.PutUint16(m[2:], uint16(x))
	binary.BigEndian.PutUint16(m[4:], uint16(y))
	_, err := c.conn.Write(m)
	return err
}

func (c *rfbClient) keyEvent(down bool, keysym uint32) error {
	m := make([]byte, 8)
	m[0] = 4
	if down {
		m[1] = 1
	}
	binary.BigEndian.PutUint32(m[4:], keysym)
	_, err := c.conn.Write(m)
	return err
}

// MoveMouse moves the pointer with no buttons pressed.
func (c *rfbClient) MoveMouse(x, y int) error { return c.pointer(0, x, y) }

// Click moves to (x,y) and presses/releases the given button (1=left, 2=middle,
// 4=right as a mask bit).
func (c *rfbClient) Click(button byte, x, y int) error {
	if err := c.pointer(0, x, y); err != nil {
		return err
	}
	time.Sleep(40 * time.Millisecond)
	if err := c.pointer(button, x, y); err != nil {
		return err
	}
	time.Sleep(60 * time.Millisecond)
	return c.pointer(0, x, y)
}

// Scroll emits wheel-button clicks (RFB buttons 4/5/6/7) at (x,y).
func (c *rfbClient) Scroll(x, y int, dir string, amount int) error {
	var mask byte
	switch dir {
	case "up":
		mask = 8
	case "down":
		mask = 16
	case "left":
		mask = 32
	case "right":
		mask = 64
	default:
		mask = 16
	}
	if amount < 1 {
		amount = 1
	}
	if amount > 10 {
		amount = 10
	}
	c.pointer(0, x, y)
	for i := 0; i < amount; i++ {
		c.pointer(mask, x, y)
		time.Sleep(15 * time.Millisecond)
		c.pointer(0, x, y)
		time.Sleep(15 * time.Millisecond)
	}
	return nil
}

// Type sends each rune as a key press/release. X11 Latin-1 keysyms equal the
// code point for printable ASCII, and x11vnc applies modifiers as needed.
func (c *rfbClient) Type(s string) error {
	for _, r := range s {
		ks := uint32(r)
		if err := c.keyEvent(true, ks); err != nil {
			return err
		}
		if err := c.keyEvent(false, ks); err != nil {
			return err
		}
		time.Sleep(25 * time.Millisecond)
	}
	return nil
}

// keysyms maps computer-use key names to X11 keysyms.
var keysyms = map[string]uint32{
	"Return": 0xff0d, "enter": 0xff0d, "KP_Enter": 0xff8d,
	"Tab": 0xff09, "BackSpace": 0xff08, "Delete": 0xffff,
	"Escape": 0xff1b, "space": 0x0020,
	"Up": 0xff52, "Down": 0xff54, "Left": 0xff51, "Right": 0xff53,
	"Home": 0xff50, "End": 0xff57, "Page_Up": 0xff55, "Page_Down": 0xff56,
	"super": 0xffeb, "Super_L": 0xffeb, "ctrl": 0xffe3, "Control_L": 0xffe3,
	"alt": 0xffe9, "Alt_L": 0xffe9, "shift": 0xffe1, "Shift_L": 0xffe1,
}

// Key presses a named key or a chorded combo like "ctrl+c" / "alt+Tab".
func (c *rfbClient) Key(name string) error {
	parts := splitPlus(name)
	syms := make([]uint32, 0, len(parts))
	for _, p := range parts {
		ks, ok := keysyms[p]
		if !ok {
			if len(p) == 1 {
				ks = uint32(p[0])
			} else {
				return fmt.Errorf("unknown key %q", p)
			}
		}
		syms = append(syms, ks)
	}
	for _, ks := range syms {
		if err := c.keyEvent(true, ks); err != nil {
			return err
		}
	}
	time.Sleep(40 * time.Millisecond)
	for i := len(syms) - 1; i >= 0; i-- {
		if err := c.keyEvent(false, syms[i]); err != nil {
			return err
		}
	}
	return nil
}

func splitPlus(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '+' && cur != "" {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

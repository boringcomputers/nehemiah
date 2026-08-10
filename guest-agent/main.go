package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func main() {
	const readyPath = "/run/bc-guest-agent.ready"
	_ = os.MkdirAll("/run", 0o755)
	_ = os.Remove(readyPath)
	listener, err := listenVsock(agentPort)
	if err != nil {
		log.Fatalf("bc guest agent: listen on vsock port %d: %v", agentPort, err)
	}
	defer listener.Close()
	if err := os.WriteFile(readyPath, []byte("ready\n"), 0o644); err != nil {
		log.Printf("bc guest agent: readiness file: %v", err)
	} else {
		defer os.Remove(readyPath)
	}
	log.Printf("bc guest agent ready on vsock port %d", agentPort)

	// One shared server owns the bounded terminal-session semaphore. Creating a
	// server per connection would make the concurrency bound ineffective.
	server := &agentServer{}
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("bc guest agent: accept: %v", err)
			continue
		}
		if !server.acquireConnection() {
			_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
			_ = writeFrame(conn, protocolFrame{Type: frameError, Code: "busy", Error: "guest connection capacity reached"})
			_ = conn.Close()
			continue
		}
		go func() {
			defer server.releaseConnection()
			server.serveConn(conn)
		}()
	}
}

// The agent is Linux-only and deliberately uses the kernel AF_VSOCK API
// directly. Keeping this tiny avoids libc/cgo in the static guest binary.
func listenVsock(port uint32) (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if err := unix.Listen(fd, 128); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &vsockListener{fd: fd, port: port}, nil
}

type vsockAddr struct {
	cid  uint32
	port uint32
}

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return fmt.Sprintf("%d:%d", a.cid, a.port) }

type vsockListener struct {
	mu     sync.Mutex
	fd     int
	port   uint32
	closed bool
}

func (l *vsockListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	fd := l.fd
	closed := l.closed
	l.mu.Unlock()
	if closed {
		return nil, net.ErrClosed
	}
	// SOCK_NONBLOCK makes the accepted fd pollable so os.NewFile registers it with
	// the runtime poller. Without it, SetReadDeadline/SetWriteDeadline on vsockConn
	// are silent no-ops and the initial-frame handshake timeout cannot fire.
	nfd, peer, err := unix.Accept4(fd, unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK)
	if err != nil {
		if errors.Is(err, syscall.EBADF) || errors.Is(err, syscall.EINVAL) {
			return nil, net.ErrClosed
		}
		return nil, err
	}
	remote := vsockAddr{}
	if vm, ok := peer.(*unix.SockaddrVM); ok {
		remote = vsockAddr{cid: vm.CID, port: vm.Port}
	}
	return &vsockConn{
		File:   os.NewFile(uintptr(nfd), "bc-guest-agent-vsock"),
		local:  vsockAddr{cid: unix.VMADDR_CID_ANY, port: l.port},
		remote: remote,
	}, nil
}

func (l *vsockListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return net.ErrClosed
	}
	l.closed = true
	err := unix.Close(l.fd)
	l.fd = -1
	return err
}

func (l *vsockListener) Addr() net.Addr {
	return vsockAddr{cid: unix.VMADDR_CID_ANY, port: l.port}
}

type vsockConn struct {
	*os.File
	local  net.Addr
	remote net.Addr
}

func (c *vsockConn) LocalAddr() net.Addr                { return c.local }
func (c *vsockConn) RemoteAddr() net.Addr               { return c.remote }
func (c *vsockConn) SetDeadline(t time.Time) error      { return c.File.SetDeadline(t) }
func (c *vsockConn) SetReadDeadline(t time.Time) error  { return c.File.SetReadDeadline(t) }
func (c *vsockConn) SetWriteDeadline(t time.Time) error { return c.File.SetWriteDeadline(t) }

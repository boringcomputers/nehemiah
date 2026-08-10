package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// readinessMarker is printed by the guest rootfs on the serial console right
// before it starts the interactive shell. boot_ms is measured up to this point.
const readinessMarker = "NEHEMIAH_READY"

// scrollbackCap bounds the retained serial scrollback replayed to new clients.
const scrollbackCap = 256 * 1024

// bootTimeout bounds how long we wait for the readiness marker before giving up
// on timing (the machine is still considered running; boot_ms is best effort).
const bootTimeout = 45 * time.Second

// ---------------------------------------------------------------------------
// Console: a broadcast tee over the firecracker child's stdio.
//
// A single pump goroutine reads the child's stdout, appends to a bounded
// scrollback buffer and fans each chunk out to every subscriber. Both the
// boot-timer and later WebSocket clients subscribe to the same stream, so
// nobody misses bytes. Writes to the guest go through Write -> child stdin.
// ---------------------------------------------------------------------------

type consoleSub struct {
	ch chan []byte
}

// Console bridges the firecracker child's stdio to many readers/one writer.
type Console struct {
	mu         sync.Mutex
	stdin      io.WriteCloser
	scrollback []byte
	subs       map[*consoleSub]struct{}
	closed     bool
}

func newConsole(stdin io.WriteCloser) *Console {
	return &Console{
		stdin: stdin,
		subs:  make(map[*consoleSub]struct{}),
	}
}

// pump reads from the child's stdout until EOF, fanning out to subscribers.
func (c *Console) pump(stdout io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			c.broadcast(chunk)
		}
		if err != nil {
			c.closeSubs()
			return
		}
	}
}

func (c *Console) broadcast(chunk []byte) {
	c.mu.Lock()
	// Append to scrollback with a cap (keep the tail).
	c.scrollback = append(c.scrollback, chunk...)
	if len(c.scrollback) > scrollbackCap {
		c.scrollback = c.scrollback[len(c.scrollback)-scrollbackCap:]
	}
	subs := make([]*consoleSub, 0, len(c.subs))
	for s := range c.subs {
		subs = append(subs, s)
	}
	c.mu.Unlock()

	for _, s := range subs {
		// Non-blocking send: a slow client must not stall the pump. Its
		// channel is buffered; if full we drop to preserve liveness.
		select {
		case s.ch <- chunk:
		default:
		}
	}
}

// Subscribe returns a snapshot of the current scrollback plus a channel that
// receives all subsequent chunks. Call Unsubscribe when done.
func (c *Console) Subscribe() ([]byte, *consoleSub) {
	c.mu.Lock()
	defer c.mu.Unlock()
	snapshot := make([]byte, len(c.scrollback))
	copy(snapshot, c.scrollback)
	s := &consoleSub{ch: make(chan []byte, 512)}
	if !c.closed {
		c.subs[s] = struct{}{}
	} else {
		close(s.ch)
	}
	return snapshot, s
}

// Unsubscribe removes a subscriber and stops delivery to it.
func (c *Console) Unsubscribe(s *consoleSub) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.subs[s]; ok {
		delete(c.subs, s)
		close(s.ch)
	}
}

// Write sends bytes to the guest serial (stdin).
func (c *Console) Write(p []byte) (int, error) {
	c.mu.Lock()
	stdin := c.stdin
	closed := c.closed
	c.mu.Unlock()
	if closed || stdin == nil {
		return 0, io.ErrClosedPipe
	}
	return stdin.Write(p)
}

func (c *Console) closeSubs() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	for s := range c.subs {
		delete(c.subs, s)
		close(s.ch)
	}
}

// ---------------------------------------------------------------------------
// fcDriver: one firecracker child process + its API socket + console.
// ---------------------------------------------------------------------------

type fcDriver struct {
	cfg            Config
	id             string
	tpl            Template
	cmd            *exec.Cmd
	console        *Console
	sock           string
	overlay        string
	vsockUDS       string // host path to the vsock UDS (set when template has a display)
	tap            string // host tap device name (set when networking is enabled)
	ip             string // guest IP (static for forks; DHCP identity cached after first host connection)
	identityPinned bool   // current daemon has proven the tap's exact IP/MAC binding
	apiClt         *http.Client
	pid            int    // retained across daemon reattachment when cmd is unavailable
	scopeUnit      string // exact sibling systemd scope in managed mode
	network        bool   // this machine requested a NIC; host networking alone is not consent
	startedAt      time.Time
	diskMB         int

	// Jailer mode: firecracker runs chrooted + unprivileged. Paths handed to the
	// firecracker API are relative to the chroot; host-side paths differ.
	jailed    bool
	chroot    string // host path of the jail's root/ dir
	apiKernel string // kernel path as seen by (possibly chrooted) firecracker
	apiRootfs string // rootfs path as seen by firecracker
	apiVsock  string // vsock uds path as seen by firecracker
}

// Console exposes the driver's console for the tty handler.
func (d *fcDriver) Console() *Console { return d.console }

// PID returns the firecracker child's process id (0 if not running).
func (d *fcDriver) PID() int {
	if d == nil {
		return 0
	}
	if d.cmd == nil || d.cmd.Process == nil {
		return d.pid
	}
	return d.cmd.Process.Pid
}

// bootMachine performs the full create flow: copy overlay, launch firecracker,
// configure it over the API socket, start it (or restore a snapshot), and time
// the boot up to the readiness marker. snapDir, if non-empty, points at a
// directory containing snapshot_file + mem_file to restore from.
func bootMachine(cfg Config, id string, tpl Template, snapDir string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
	if !validMachineID(id) {
		return nil, "", 0, fmt.Errorf("unsafe machine id %q", id)
	}
	if err := os.MkdirAll(cfg.RunDir, 0o755); err != nil {
		return nil, "", 0, fmt.Errorf("mkdir run dir: %w", err)
	}

	jailed := cfg.JailerEnable

	// Path plan differs between direct and jailed launch. In jailed mode the
	// firecracker API sees chroot-relative paths; host paths point into the jail.
	var sock, overlay, chroot string
	d := &fcDriver{cfg: cfg, id: id, tpl: tpl, jailed: jailed, network: network, diskMB: diskMB}
	if jailed {
		jailDir := filepath.Join(cfg.ChrootBase, "firecracker", id)
		chroot = filepath.Join(jailDir, "root")
		sock = filepath.Join(chroot, "run", "fc.sock")
		overlay = filepath.Join(chroot, "rootfs.ext4")
		d.chroot, d.apiKernel, d.apiRootfs, d.apiVsock = chroot, "/vmlinux", "/rootfs.ext4", "/run/vsock"
		if err := os.RemoveAll(jailDir); err != nil {
			if cfg.NehemiahMode {
				return nil, "", 0, fmt.Errorf("remove stale managed jail: %w", err)
			}
		} else if _, err := os.Lstat(jailDir); cfg.NehemiahMode && !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return nil, "", 0, fmt.Errorf("verify stale managed jail removal: %w", err)
			}
			return nil, "", 0, errors.New("stale managed jail remains after cleanup")
		}
	} else {
		sock = filepath.Join(cfg.RunDir, id+".sock")
		overlay = filepath.Join(cfg.RunDir, id+".ext4")
		d.apiKernel, d.apiRootfs, d.apiVsock = cfg.KernelPath, overlay, filepath.Join(cfg.RunDir, id+".vsock")
		_ = os.Remove(sock)
	}
	d.sock, d.overlay = sock, overlay
	if tpl.Vsock {
		d.vsockUDS = d.apiVsock
		if jailed {
			d.vsockUDS = filepath.Join(chroot, "run", "vsock")
		}
		_ = os.Remove(d.vsockUDS)
	}

	// Determine the base rootfs: the template's own rootfs by default, or a
	// snapshot template's shipped rootfs when restoring.
	baseRootfs := tpl.Rootfs
	if baseRootfs == "" {
		baseRootfs = cfg.BaseRootfs
	}
	if snapDir == "" {
		if t := filepath.Join(cfg.TemplatesDir, tpl.Name, "rootfs.ext4"); fileExists(t) {
			baseRootfs = t
		}
	} else {
		if snRoot := filepath.Join(snapDir, "rootfs.ext4"); fileExists(snRoot) {
			baseRootfs = snRoot
		}
	}
	if err := enforceOverlayQuota(baseRootfs, cfg.OverlayQuotaMB, diskMB); err != nil {
		return nil, "", 0, err
	}

	// Direct mode: stage the overlay before launch (the run dir already exists).
	// Jailed mode: the chroot only exists after jailer runs, so stage below.
	if !jailed {
		if err := copyReflink(baseRootfs, overlay); err != nil {
			_ = os.Remove(overlay)
			return nil, "", 0, fmt.Errorf("copy overlay: %w", err)
		}
		if err := resizeOverlay(overlay, diskMB); err != nil {
			_ = os.Remove(overlay)
			return nil, "", 0, err
		}
	}

	// Firecracker enables its production seccomp filters by default. The launch
	// builder deliberately has no path which can append --no-seccomp.
	ioLimit, err := cgroupIOMax(baseRootfs, cfg)
	if err != nil {
		return nil, "", 0, fmt.Errorf("derive overlay I/O limit: %w", err)
	}
	var console *Console
	var sub *consoleSub
	if cfg.NehemiahMode {
		// Managed VMMs must not inherit daemon-owned pipes: losing those file
		// descriptors on restart would make serial output hit a broken pipe and
		// customer TTY unrecoverable. systemd-run receives null stdio by default;
		// interactive customer terminals use the guest agent over vsock.
		cmd, unit, scopeErr := buildManagedScopeCommand(cfg, id, tpl, baseRootfs)
		if scopeErr != nil {
			d.Close()
			return nil, "", 0, scopeErr
		}
		d.scopeUnit = unit
		d.apiClt = newUnixClient(sock)
		if err := cmd.Start(); err != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("start managed scope: %w", err)
		}
		d.startedAt = time.Now().UTC()
		// systemd-run --scope waits for the scoped process. Reap the launcher
		// while this daemon is alive; after a daemon restart PID 1 adopts it,
		// while the VMM remains independently owned by the sibling scope.
		go func() { _ = cmd.Wait() }()
	} else {
		cmd := buildFirecrackerCommand(cfg, id, tpl, sock, ioLimit)
		stdinPipe, pipeErr := cmd.StdinPipe()
		if pipeErr != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("stdin pipe: %w", pipeErr)
		}
		stdoutPipe, pipeErr := cmd.StdoutPipe()
		if pipeErr != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("stdout pipe: %w", pipeErr)
		}
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("start: %w", err)
		}
		d.pid = cmd.Process.Pid
		d.startedAt = time.Now().UTC()
		console = newConsole(stdinPipe)
		go console.pump(stdoutPipe)
		d.cmd, d.console, d.apiClt = cmd, console, newUnixClient(sock)

		// Subscribe before the VM starts so local-mode boot timing sees the
		// complete serial stream.
		_, sub = console.Subscribe()
		defer console.Unsubscribe(sub)
	}

	socketWait := 5 * time.Second
	if jailed {
		socketWait = 12 * time.Second // jailer sets up the chroot first
	}
	if err := waitForSocket(sock, socketWait); err != nil {
		d.Close()
		return nil, "", 0, fmt.Errorf("api socket: %w", err)
	}
	if cfg.NehemiahMode {
		pid, pidErr := waitForManagedScopePID(id, d.scopeUnit, 5*time.Second)
		if pidErr != nil {
			d.Close()
			return nil, "", 0, pidErr
		}
		d.pid = pid
	}

	// Jailed mode: the chroot now exists; stage kernel + rootfs (+ snapshot
	// artefacts) into it, owned/readable by the jailed uid. Hardlinks are instant
	// so snapshot restore stays fast.
	if jailed {
		if err := stageJail(cfg, d, baseRootfs, snapDir); err != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("stage jail: %w", err)
		}
	}

	mode := "coldboot"
	var bootMS int64

	// Best-effort snapshot restore.
	if snapDir != "" {
		// If the source had a NIC (a fork of a connected/desktop machine), give
		// the fork its own tap up front — detached from the bridge, since it
		// resumes on the source's MAC/IP and must be re-addressed before it can
		// safely join the network (the caller does that).
		if restoreNet && network && cfg.NetEnable {
			tap := tapName(d.id)
			uid := 0
			if d.jailed {
				uid = d.cfg.JailerUID
			}
			if err := makeTap(tap, uid); err != nil {
				d.Close()
				return nil, "", 0, fmt.Errorf("fork tap: %w", err)
			}
			d.tap = tap
		}
		// A restored guest resumes past the NEHEMIAH_READY marker (it already
		// printed it before being snapshotted), so we time the restore call
		// itself rather than waiting for a marker that will never reappear.
		t := time.Now()
		if err := d.restoreSnapshot(snapDir, overlay); err != nil {
			if cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventSnapshotRestoreFailed, managedHostLogFields{MachineID: id, Err: err})
			} else {
				log.Printf("machine %s: snapshot restore failed, cold booting: %v", id, err)
			}
			// The child may be in a bad state; restart cleanly as cold boot.
			d.Close()
			return bootMachine(cfg, id, tpl, "", false, network, diskMB)
		}
		mode = "snapshot"
		bootMS = time.Since(t).Milliseconds()
	} else {
		start := time.Now()
		if err := d.coldBoot(); err != nil {
			d.Close()
			return nil, "", 0, fmt.Errorf("cold boot: %w", err)
		}
		if sub != nil {
			// Local mode times the serial readiness marker. Managed mode reports
			// VMM start here and independently gates customer readiness on the
			// reconnectable guest-agent probe in Manager.awaitReady.
			bootMS = waitForMarker(sub, start, bootTimeout)
		} else {
			bootMS = time.Since(start).Milliseconds()
		}
	}

	return d, mode, bootMS, nil
}

// coldBoot configures and starts a fresh VM via the firecracker API.
func (d *fcDriver) coldBoot() error {
	bootArgs := "console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux random.trust_cpu=on"
	if d.network && d.cfg.NetEnable {
		// Kernel-level DHCP brings eth0 up before init; dnsmasq hands out a lease.
		bootArgs += " ip=dhcp"
	}
	if d.tpl.InitPath != "" {
		bootArgs += " init=" + d.tpl.InitPath
	}
	if err := d.apiPut("/boot-source", map[string]any{
		"kernel_image_path": d.apiKernel,
		"boot_args":         bootArgs,
	}); err != nil {
		return err
	}
	if err := d.apiPut("/drives/rootfs", map[string]any{
		"drive_id":       "rootfs",
		"path_on_host":   d.apiRootfs,
		"is_root_device": true,
		"is_read_only":   false,
	}); err != nil {
		return err
	}
	vcpu, mem := d.tpl.VCPUs, d.tpl.MemSizeMB
	if vcpu <= 0 {
		vcpu = d.cfg.VCPUs
	}
	if mem <= 0 {
		mem = d.cfg.MemSizeMB
	}
	if err := d.apiPut("/machine-config", map[string]any{
		"vcpu_count":   vcpu,
		"mem_size_mib": mem,
	}); err != nil {
		return err
	}
	// Networking: a per-VM tap on the host bridge, NATed out. The tap is owned by
	// the jailed uid so the (unprivileged) firecracker child can open it.
	if d.network && d.cfg.NetEnable {
		tap := tapName(d.id)
		uid := 0
		if d.jailed {
			uid = d.cfg.JailerUID
		}
		if err := createTap(tap, uid, d.cfg.NetBridge, guestMAC(d.id), d.cfg.NehemiahMode); err != nil {
			return err
		}
		d.tap = tap
		if err := d.apiPut("/network-interfaces/eth0", map[string]any{
			"iface_id":      "eth0",
			"host_dev_name": tap,
			"guest_mac":     guestMAC(d.id),
		}); err != nil {
			return err
		}
	}
	// A vsock device gives the host a private channel to guest services (the
	// desktop VNC server listens on guest vsock port 5900).
	if d.vsockUDS != "" {
		if err := d.apiPut("/vsock", map[string]any{
			"guest_cid": 3,
			"uds_path":  d.apiVsock,
		}); err != nil {
			return err
		}
	}
	if err := d.apiPut("/actions", map[string]any{
		"action_type": "InstanceStart",
	}); err != nil {
		return err
	}
	return nil
}

// restoreSnapshot loads a snapshot and resumes the VM. In jailed mode the
// snapshot/mem artefacts are hardlinked into the chroot (by stageJail) and the
// firecracker API sees them at /snap and /mem.
func (d *fcDriver) restoreSnapshot(snapDir, overlay string) error {
	snapPath := filepath.Join(snapDir, "snapshot_file")
	memPath := filepath.Join(snapDir, "mem_file")
	if !fileExists(snapPath) || !fileExists(memPath) {
		return fmt.Errorf("snapshot artefacts missing in %s", snapDir)
	}
	apiSnap, apiMem := snapPath, memPath
	if d.jailed {
		apiSnap, apiMem = "/snap", "/mem"
	}
	// Load WITHOUT resuming, then rebind the block device to this machine's own
	// overlay (the snapshot baked the template's rootfs path), then resume. This
	// gives the fork an isolated, writable rootfs identical in content to the
	// template — so the resumed guest's in-memory fs state stays consistent.
	load := map[string]any{
		"snapshot_path": apiSnap,
		"mem_backend": map[string]any{
			"backend_type": "File",
			"backend_path": apiMem,
		},
		"resume_vm": false,
	}
	// A fork restores its NIC onto its own fresh tap (the snapshot baked the
	// source's tap name).
	if d.tap != "" {
		load["network_overrides"] = []any{
			map[string]any{"iface_id": "eth0", "host_dev_name": d.tap},
		}
	}
	if d.vsockUDS != "" {
		load["vsock_override"] = map[string]any{"uds_path": d.apiVsock}
	}
	if err := d.apiPut("/snapshot/load", load); err != nil {
		return err
	}
	if err := d.apiPatch("/drives/rootfs", map[string]any{
		"drive_id":     "rootfs",
		"path_on_host": d.apiRootfs,
	}); err != nil {
		return err
	}
	return d.apiPatch("/vm", map[string]any{"state": "Resumed"})
}

// CreateSnapshot pauses the running VM, writes a full snapshot into a new
// directory keyed by newID, resumes the VM, and returns the snapshot dir.
func (d *fcDriver) CreateSnapshot(newID string) (string, error) {
	snapDir := filepath.Join(d.cfg.RunDir, newID+"-snap")
	if err := os.MkdirAll(snapDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir snap dir: %w", err)
	}
	snapFile := filepath.Join(snapDir, "snapshot_file")
	memFile := filepath.Join(snapDir, "mem_file")

	// Firecracker writes to paths in its own filesystem view. Jailed: it can only
	// write inside the chroot, so use chroot-relative paths and move the artefacts
	// out afterwards. The names MUST be unique per snapshot: a snapshot-restored
	// VM's chroot already holds "snap"/"mem" — root-owned hardlinks to the shared
	// template artefacts staged for its own restore — so writing to "/snap" both
	// fails (EACCES for the jailed uid) and, if it ever succeeded, would corrupt
	// the template every other restore shares.
	apiSnap, apiMem := snapFile, memFile
	if d.jailed {
		apiSnap, apiMem = "/snap-"+newID, "/mem-"+newID
	}

	if err := d.apiPatch("/vm", map[string]any{"state": "Paused"}); err != nil {
		return "", fmt.Errorf("pause: %w", err)
	}
	if err := d.apiPutSlow("/snapshot/create", map[string]any{
		"snapshot_type": "Full",
		"snapshot_path": apiSnap,
		"mem_file_path": apiMem,
	}, 3*time.Minute); err != nil {
		// Try to resume before returning so the source stays alive.
		_ = d.apiPatch("/vm", map[string]any{"state": "Resumed"})
		_ = os.RemoveAll(snapDir)
		return "", fmt.Errorf("snapshot create: %w", err)
	}
	if err := d.apiPatch("/vm", map[string]any{"state": "Resumed"}); err != nil {
		if d.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventSnapshotResumeFailed, managedHostLogFields{MachineID: d.id, Err: err})
		} else {
			log.Printf("machine %s: resume after snapshot failed: %v", d.id, err)
		}
	}

	// Move the snapshot + memory files out of the source's chroot into snapDir.
	if d.jailed {
		for _, m := range [][2]string{
			{filepath.Join(d.chroot, "snap-"+newID), snapFile},
			{filepath.Join(d.chroot, "mem-"+newID), memFile},
		} {
			if err := os.Rename(m[0], m[1]); err != nil {
				if cerr := copyReflink(m[0], m[1]); cerr != nil {
					_ = os.RemoveAll(snapDir)
					return "", fmt.Errorf("stage snapshot out of jail: %v / %v", err, cerr)
				}
				_ = os.Remove(m[0])
			}
		}
	}

	// Give the child a copy of the current rootfs so the fork is independent.
	if err := copyReflink(d.overlay, filepath.Join(snapDir, "rootfs.ext4")); err != nil {
		if d.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventSnapshotRootfsCopyFailed, managedHostLogFields{MachineID: d.id, Err: err})
		} else {
			log.Printf("machine %s: snapshot rootfs copy failed: %v", d.id, err)
		}
	}
	return snapDir, nil
}

// apiPut issues a PUT with a JSON body to the firecracker API over the socket.
func (d *fcDriver) apiPut(path string, body any) error {
	return d.apiReq(http.MethodPut, path, body)
}

// apiPatch issues a PATCH. Firecracker uses PATCH (not PUT) for /vm state
// transitions (Paused/Resumed) and for updating a drive's backing file post-load.
func (d *fcDriver) apiPatch(path string, body any) error {
	return d.apiReq(http.MethodPatch, path, body)
}

func (d *fcDriver) apiReq(method, path string, body any) error {
	return d.apiReqClient(d.apiClt, method, path, body)
}

// apiPutSlow is apiPut with a generous timeout, for calls that legitimately
// take a while — writing a multi-GB memory snapshot outlives the default 10s
// client (a desktop's 2.5GB mem file can take tens of seconds under load).
func (d *fcDriver) apiPutSlow(path string, body any, timeout time.Duration) error {
	slow := &http.Client{Timeout: timeout, Transport: d.apiClt.Transport}
	return d.apiReqClient(slow, http.MethodPut, path, body)
}

func (d *fcDriver) apiReqClient(clt *http.Client, method, path string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(method, "http://localhost"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := clt.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s %s -> %d: %s", method, path, resp.StatusCode, string(msg))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// Close kills the firecracker child and removes its per-machine files.
func (d *fcDriver) Close() {
	if d == nil {
		return
	}
	// Best-effort graceful shutdown of the guest first.
	if d.apiClt != nil {
		_ = d.apiPut("/actions", map[string]any{"action_type": "SendCtrlAltDel"})
	}

	if d.scopeUnit != "" {
		stopManagedScope(d.cfg, d.scopeUnit)
		// If systemd could not complete the stop, a signal is permitted only
		// after re-proving both the exact machine identity and exact scope.
		killManagedScopePID(d.pid, d.id, d.scopeUnit)
	} else if d.cmd != nil && d.cmd.Process != nil {
		_ = d.cmd.Process.Kill()
		// Reap the child to avoid zombies; ignore the wait error.
		go func(c *exec.Cmd) { _ = c.Wait() }(d.cmd)
	} else if d.pid > 0 {
		if processMatchesMachine(d.pid, d.id) {
			_ = syscall.Kill(d.pid, syscall.SIGKILL)
		}
	}
	if d.console != nil {
		d.console.closeSubs()
		if d.console.stdin != nil {
			_ = d.console.stdin.Close()
		}
	}
	removePinnedGuestNeighbor(d.cfg.NetBridge, d.cfg.NetSubnet, d.ip, guestMAC(d.id))
	teardownTap(d.tap)
	if d.jailed && d.chroot != "" {
		// Remove the whole jail (root/ holds sock, overlay, kernel link, vsock).
		_ = os.RemoveAll(filepath.Dir(d.chroot))
	} else {
		_ = os.Remove(d.sock)
		_ = os.Remove(d.overlay)
		if d.vsockUDS != "" {
			_ = os.Remove(d.vsockUDS)
		}
	}
}

// Detach releases daemon-side console subscribers while intentionally leaving
// the VMM, API/vsock sockets, tap and overlay intact for restart reconciliation.
func (d *fcDriver) Detach() {
	if d == nil || d.console == nil {
		return
	}
	d.console.closeSubs()
}

// buildFirecrackerCommand is kept pure enough for security tests to inspect the
// exact jailer boundary. Resource values are passed as jailer cgroup properties;
// Firecracker's default seccomp filter remains enabled (no --no-seccomp).
func buildFirecrackerCommand(cfg Config, id string, tpl Template, sock, ioLimit string) *exec.Cmd {
	if !cfg.JailerEnable {
		return exec.Command(cfg.FirecrackerBin, "--api-sock", sock, "--id", id)
	}
	return exec.Command(cfg.JailerBin, buildJailerArgs(cfg, id, tpl, jailerParentCgroup(), ioLimit)...)
}

func buildJailerArgs(cfg Config, id string, tpl Template, parent, ioLimit string) []string {
	args := []string{
		"--id", id,
		"--exec-file", cfg.FirecrackerBin,
		"--uid", strconv.Itoa(cfg.JailerUID),
		"--gid", strconv.Itoa(cfg.JailerGID),
		"--cgroup-version", "2",
		"--chroot-base-dir", cfg.ChrootBase,
	}
	// Have the jailer create a child cgroup (with resource caps) inside
	// nehemiahd's delegated subtree. Passing --cgroup makes jailer create a
	// child cgroup named after the id rather than joining the parent directly.
	if parent != "" {
		mem := tpl.MemSizeMB
		if mem <= 0 {
			mem = cfg.MemSizeMB
		}
		args = append(args,
			"--parent-cgroup", parent,
			"--cgroup", fmt.Sprintf("cpu.max=%d 100000", cpuQuotaMicros(cfg, tpl)),
			"--cgroup", fmt.Sprintf("pids.max=%d", cfg.PidsMax),
			"--cgroup", fmt.Sprintf("memory.max=%d", (mem+128)*1024*1024),
		)
		if ioLimit != "" {
			args = append(args, "--cgroup", "io.max="+ioLimit)
		}
	}
	args = append(args, "--", "--api-sock", "/run/fc.sock")
	return args
}

func enforceOverlayQuota(path string, quotaMB, requestedMB int) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat base rootfs: %w", err)
	}
	if quotaMB <= 0 || info.Size() > int64(quotaMB)*1024*1024 {
		return fmt.Errorf("rootfs size %d bytes exceeds per-machine overlay quota of %dMB", info.Size(), quotaMB)
	}
	if requestedMB > 0 && info.Size() > int64(requestedMB)*1024*1024 {
		return fmt.Errorf("%w: disk_mb=%d is smaller than the %d-byte base image", ErrInvalidResources, requestedMB, info.Size())
	}
	return nil
}

func resizeOverlay(path string, requestedMB int) error {
	if requestedMB <= 0 {
		return nil
	}
	target := int64(requestedMB) * 1024 * 1024
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat overlay: %w", err)
	}
	if info.Size() == target {
		return nil
	}
	if info.Size() > target {
		return fmt.Errorf("%w: refusing to shrink rootfs overlay", ErrInvalidResources)
	}
	if err := os.Truncate(path, target); err != nil {
		return fmt.Errorf("grow overlay: %w", err)
	}
	if output, err := exec.Command("resize2fs", "-f", path).CombinedOutput(); err != nil {
		return fmt.Errorf("resize overlay filesystem: %w: %s", err, output)
	}
	return nil
}

// stageJail places the kernel, rootfs overlay and (when restoring) snapshot
// artefacts inside the jail chroot so the chrooted, unprivileged firecracker can
// read them. Hardlinks keep snapshot restore instant (ext4 has no reflink); the
// per-VM overlay is a copy owned by the jailed uid.
func stageJail(cfg Config, d *fcDriver, baseRootfs, snapDir string) error {
	uid, gid := cfg.JailerUID, cfg.JailerGID

	kdst := filepath.Join(d.chroot, "vmlinux")
	if err := hardlinkOrCopy(cfg.KernelPath, kdst); err != nil {
		return fmt.Errorf("kernel: %w", err)
	}
	_ = os.Chmod(kdst, 0o644)

	if err := copyReflink(baseRootfs, d.overlay); err != nil {
		return fmt.Errorf("overlay: %w", err)
	}
	if err := resizeOverlay(d.overlay, d.diskMB); err != nil {
		return err
	}
	if err := os.Chown(d.overlay, uid, gid); err != nil {
		return fmt.Errorf("chown overlay: %w", err)
	}

	if snapDir != "" {
		links := [][2]string{
			{filepath.Join(snapDir, "snapshot_file"), filepath.Join(d.chroot, "snap")},
			{filepath.Join(snapDir, "mem_file"), filepath.Join(d.chroot, "mem")},
		}
		for _, l := range links {
			if err := hardlinkOrCopy(l[0], l[1]); err != nil {
				return fmt.Errorf("snapshot artefact: %w", err)
			}
			// World-readable so the jailed uid can read it (hardlink shares the
			// inode with the template, so don't chown — just widen read perms).
			_ = os.Chmod(l[1], 0o644)
		}
		// The snapshot baked the template's absolute rootfs path; firecracker
		// opens it O_RDWR during snapshot/load (before we rebind the drive), so it
		// must resolve inside the chroot AND be writable by the jailed uid. Point
		// it at the per-VM overlay (same inode, uid-owned) rather than the shared
		// read-only template.
		baked := filepath.Join(d.chroot, snapDir, "rootfs.ext4")
		if err := os.MkdirAll(filepath.Dir(baked), 0o755); err == nil {
			_ = os.Remove(baked)
			_ = os.Link(d.overlay, baked)
		}
	}
	return nil
}

// hardlinkOrCopy hardlinks src->dst (instant, same filesystem) or falls back to
// a copy across devices.
func hardlinkOrCopy(src, dst string) error {
	_ = os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	return copyReflink(src, dst)
}

// DialVsock opens a stream to a guest vsock port through the Firecracker vsock
// UDS, performing the host-initiated "CONNECT <port>" handshake. Used to reach
// the desktop VNC server (guest vsock port 5900) for the /vnc bridge.
func (d *fcDriver) DialVsock(port int) (net.Conn, error) {
	return d.DialVsockContext(context.Background(), port)
}

// DialVsockContext is the cancellation-aware form used by managed lifecycle
// operations. A snapshot-restored VMM may exist before its driver is published
// in Manager, so those operations dial the exact driver while remaining bounded
// by their lease-scoped context.
func (d *fcDriver) DialVsockContext(ctx context.Context, port int) (net.Conn, error) {
	if d.vsockUDS == "" {
		return nil, fmt.Errorf("machine has no vsock device")
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", d.vsockUDS)
	if err != nil {
		return nil, fmt.Errorf("dial vsock uds: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = conn.SetDeadline(deadline)
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, err
	}
	// Read the "OK <port>\n" acknowledgement line before returning the raw stream.
	line := make([]byte, 0, 32)
	buf := make([]byte, 1)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("vsock connect: %w", err)
		}
		if n == 1 {
			if buf[0] == '\n' {
				break
			}
			line = append(line, buf[0])
			if len(line) > 64 {
				conn.Close()
				return nil, fmt.Errorf("vsock connect: overlong response")
			}
		}
	}
	if !bytes.HasPrefix(line, []byte("OK")) {
		conn.Close()
		return nil, fmt.Errorf("vsock connect refused: %q", string(line))
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		conn.Close()
		return nil, ctxErr
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// newUnixClient builds an http.Client that dials the given unix socket.
func newUnixClient(sock string) *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sock)
			},
		},
	}
}

// waitForSocket blocks until the unix socket exists or the timeout elapses.
func waitForSocket(sock string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fileExists(sock) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	if fileExists(sock) {
		return nil
	}
	return fmt.Errorf("socket %s did not appear", sock)
}

// waitForMarker scans the subscriber stream for the readiness marker and
// returns elapsed milliseconds from start. On timeout it returns the elapsed
// time anyway (best effort) — the machine is still usable.
func waitForMarker(sub *consoleSub, start time.Time, timeout time.Duration) int64 {
	marker := []byte(readinessMarker)
	var tail []byte
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case chunk, ok := <-sub.ch:
			if !ok {
				return time.Since(start).Milliseconds()
			}
			// Keep a small overlap so the marker can span chunk boundaries.
			tail = append(tail, chunk...)
			if bytes.Contains(tail, marker) {
				return time.Since(start).Milliseconds()
			}
			if len(tail) > 2*len(marker) {
				tail = tail[len(tail)-2*len(marker):]
			}
		case <-timer.C:
			return time.Since(start).Milliseconds()
		}
	}
}

// copyReflink copies src to dst using "cp --reflink=auto" for fast CoW copies.
func copyReflink(src, dst string) error {
	cmd := exec.Command("cp", "--reflink=auto", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cp %s %s: %w: %s", src, dst, err, string(out))
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

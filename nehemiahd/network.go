package main

import (
	"crypto/sha1"
	"fmt"
	"os/exec"
)

// tapName derives a stable host tap device name for a machine. Kept short
// (≤15 chars): "bt" + 8 hex = 10.
func tapName(id string) string {
	h := sha1.Sum([]byte(id))
	return fmt.Sprintf("bt%x", h[:4])
}

// guestMAC derives a stable locally-administered MAC for a machine.
func guestMAC(id string) string {
	h := sha1.Sum([]byte(id))
	return fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", h[0], h[1], h[2], h[3])
}

// makeTap creates a tap owned by uid (the jailed firecracker uid, so it can open
// the device) and brings it up — but does NOT attach it to a bridge. A fork
// restores its NIC before it has a unique MAC/IP, so it must stay off the bridge
// until re-addressed (else it would collide with the source).
func makeTap(name string, uid int) error {
	add := []string{"tuntap", "add", name, "mode", "tap"}
	if uid > 0 {
		add = append(add, "user", fmt.Sprint(uid))
	}
	if out, err := exec.Command("ip", add...).CombinedOutput(); err != nil {
		return fmt.Errorf("tap add: %v: %s", err, out)
	}
	if out, err := exec.Command("ip", "link", "set", name, "up").CombinedOutput(); err != nil {
		exec.Command("ip", "link", "del", name).Run()
		return fmt.Errorf("tap up: %v: %s", err, out)
	}
	return nil
}

// attachTapBridge enslaves a tap to the bridge (puts it on the network).
func attachTapBridge(name, bridge string) error {
	if out, err := exec.Command("ip", "link", "set", name, "master", bridge).CombinedOutput(); err != nil {
		return fmt.Errorf("tap bridge: %v: %s", err, out)
	}
	return nil
}

// createTap makes a tap and attaches it to the bridge (the normal cold-boot path).
func createTap(name string, uid int, bridge string) error {
	if err := makeTap(name, uid); err != nil {
		return err
	}
	if err := attachTapBridge(name, bridge); err != nil {
		exec.Command("ip", "link", "del", name).Run()
		return err
	}
	return nil
}

// teardownTap removes a tap device (best-effort).
func teardownTap(name string) {
	if name != "" {
		exec.Command("ip", "link", "del", name).Run()
	}
}

---
name: testing-preview
description: Test the preview proxy feature end-to-end. Use when verifying preview URL changes, auth changes on the web proxy route, or networking-related fixes.
---

# Testing the Preview Feature

## What It Does

The preview proxy exposes a port running inside a guest Firecracker VM at a public URL. Two implementations exist:

1. **Path-based** (`/v1/machines/{id}/web/{port}/{path...}`) — works over SSH tunnel and without wildcard DNS
2. **Subdomain-based** (`<id>--<port>.<PreviewBase>`) — requires Caddy on-demand TLS + wildcard DNS

## Prerequisites

- nehemiahd must be running with `NEHEMIAH_NET=1` (enables guest networking via tap/bridge/DHCP)
- A test VM must be created with `net: true` (ensures DHCP lease is assigned)
- An HTTP server must be running inside the guest on a known port

## How to Set Up a Test VM

```bash
# Build and run nehemiahd (with auth to test the auth bypass)
cd nehemiahd && go build -o /tmp/nehemiahd .
sudo NEHEMIAH_NET=1 NEHEMIAH_JAILER=0 NEHEMIAH_TOKEN=test-token /tmp/nehemiahd &

# Create a VM with networking
curl -s http://localhost:8080/v1/machines -X POST \
  -H "Authorization: Bearer test-token" \
  -d '{"template":"python","ttl_seconds":900,"net":true}'

# Start an HTTP server inside the guest (via WebSocket TTY)
python3 -c "
import websocket, time
ws = websocket.create_connection('ws://localhost:8080/v1/machines/MACHINE_ID/tty',
    header=['Authorization: Bearer test-token'])
time.sleep(0.5)
ws.send(b'cd / && python3 -m http.server 8000 --bind 0.0.0.0 &\n')
time.sleep(2)
ws.close()
"
```

## Key Test Cases

The server above is started from `/` (`cd /`), so `http.server` serves the guest's
root filesystem — that makes the sub-path test below resolve.

1. **Preview without auth**: `curl http://localhost:8080/v1/machines/{id}/web/8000/` should return content (the `/` directory listing; no auth header needed)
2. **Other routes still require auth**: `curl http://localhost:8080/v1/machines/{id}` should return 401
3. **Sub-path routing**: `curl http://localhost:8080/v1/machines/{id}/web/8000/etc/` should show the guest's `/etc` directory listing (proves sub-paths are proxied through)
4. **Via Vite proxy**: `curl http://localhost:5173/boring/v1/machines/{id}/web/8000/` should work

## Architecture Notes

- The web proxy route is intentionally unauthenticated — preview URLs are opened via `window.open` in new browser tabs which can't add Authorization headers
- The machine ID acts as the access token (unguessable)
- `machineIP()` resolves guest IP: first checks `driver.ip` (for forks), then falls back to DHCP lease file (`/var/lib/misc/dnsmasq.leases`)
- Guest MAC is derived from machine ID via SHA1: `guestMAC(id) → 06:00:XX:XX:XX:XX`

## Common Failure Modes

- **"this computer isn't on the network"**: NEHEMIAH_NET not set, or machine created without net=true (for snapshot-eligible templates)
- **"nothing is listening on port X"**: Server not started in guest, or bound to 127.0.0.1 instead of 0.0.0.0
- **401 on preview URL**: The route might have been accidentally wrapped in `s.auth()` again
- **Machine TTL expired**: Default TTL is short; use 900s for testing

## Devin Secrets Needed

- None required for local testing (NEHEMIAH_TOKEN is set at runtime for test isolation)

# Nehemiah — Latitude.sh runbook

This is the operator runbook for the one-box prototype: a single Latitude.sh
bare-metal server running **nehemiahd**, which launches **Firecracker microVMs** you
can create over REST and drive with a live shell over WebSocket.

- **Server:** `c3.small.x86` @ **MIA2** (Miami), Ubuntu 24.04 x86_64, 6 cores / 32 GB, `/dev/kvm` present.
- **Cost:** ~**$0.52 / hr** (~$12.5/day, ~$375/mo) — see [COST](#cost).
- **IP / SSH key:** in `~/.config/latitude/server.env` (never committed).

> The server is **already provisioned**. This runbook covers everything after that:
> bootstrap → deploy → tunnel → demo → teardown.

---

## 0. Prerequisites (operator laptop)

Create `~/.config/latitude/server.env`:

```sh
# ~/.config/latitude/server.env  (chmod 600 — do NOT commit)
SERVER_IP=203.0.113.10             # public IPv4 of the box
SSH_KEY=/Users/you/.ssh/latitude   # private key that can root@ the box
NEHEMIAH_TOKEN=                      # optional bearer token for /v1/* (leave empty for tunnel-only)

# for teardown.sh (billing):
LATITUDE_API_KEY=...               # or put it in ~/.config/latitude/api_key
LATITUDE_SERVER_ID=sv_...          # or put it in ~/.config/latitude/server_id
```

All scripts here `source` this file. The API key is never printed.

---

## 1. Bootstrap the box (once)

`bootstrap.sh` (owned separately, run **on the box**) installs the Go toolchain,
downloads the Firecracker binary, an uncompressed guest kernel, and builds the
Alpine rootfs with `python3` + the `NEHEMIAH_READY` serial marker. It lays down the
fixed host paths nehemiahd expects:

```
/opt/boring/bin/firecracker         firecracker (also jailer)
/opt/boring/kernel/vmlinux          uncompressed firecracker-compatible kernel
/opt/boring/rootfs/rootfs.ext4      base Alpine rootfs (busybox init, /bin/sh on ttyS0, python3)
/opt/boring/templates/<name>/       optional snapshot template (snapshot_file, mem_file, rootfs.ext4)
/opt/boring/run/                    per-machine sockets + rootfs overlays
```

Run it once after provisioning:

```sh
scp -i "$SSH_KEY" infra/bootstrap.sh root@$SERVER_IP:/root/
ssh -i "$SSH_KEY" root@$SERVER_IP 'bash /root/bootstrap.sh'
```

Sanity check on the box: `ls -la /dev/kvm` and `/opt/boring/bin/firecracker --version`.

---

## 2. Deploy nehemiahd

From the repo root on your laptop:

```sh
infra/latitude/deploy.sh
```

This rsyncs `nehemiahd/` to `/opt/boring/src/`, builds a static binary to
`/usr/local/bin/nehemiahd`, installs `nehemiahd.service`, writes
`/etc/boring/nehemiahd.env` (with `NEHEMIAH_TOKEN` if you set one), enables the
service, and curls `localhost:8080/healthz` to confirm. Re-run any time to ship
a new build.

Logs: `ssh -i "$SSH_KEY" root@$SERVER_IP journalctl -u nehemiahd -f`

---

## 3. Open the tunnel

nehemiahd binds `0.0.0.0:8080` on the box but is **firewalled to localhost only**
(see [SECURITY](#security)). Reach it from your laptop over SSH:

```sh
infra/latitude/tunnel.sh          # localhost:8080 -> box:8080
```

Leave it running. Verify: `curl http://localhost:8080/healthz` → `{"ok":true,...}`.

---

## 4. Run the demo

In another terminal, from the repo root:

```sh
NEHEMIAH_URL=http://localhost:8080 node packages/sdk/demo.mjs
# if you set a token:
NEHEMIAH_URL=http://localhost:8080 NEHEMIAH_TOKEN=... node packages/sdk/demo.mjs
```

The demo exercises the full contract:

1. `POST /v1/machines {"template":"python","ttl_seconds":120}` → a microVM (`mode` is `coldboot` or `snapshot`, with a measured `boot_ms`).
2. Attaches to `GET /v1/machines/{id}/tty` (WebSocket, binary frames) — a **live serial shell**.
3. Runs `python3` inside the guest and prints the output.
4. `POST /v1/machines/{id}/branch` — **forks** the VM from its snapshot (best-effort; `501` if snapshots aren't available).
5. `DELETE /v1/machines/{id}` to clean up.

You can also drive it by hand:

```sh
curl -s localhost:8080/v1/machines -XPOST -H 'content-type: application/json' \
  -d '{"template":"python","ttl_seconds":120}'
curl -s localhost:8080/v1/machines
```

### HTTP/WS contract (reference)

```
GET    /healthz                      -> {"ok":true,"machines":<int>,"kvm":<bool>}     (no auth)
POST   /v1/machines                  -> 201 {"id","status","mode","boot_ms","created_at","expires_at"}
GET    /v1/machines                  -> 200 {"machines":[...]}
GET    /v1/machines/{id}             -> 200 <machine> | 404
DELETE /v1/machines/{id}             -> 204 | 404
POST   /v1/machines/{id}/branch      -> 201 <machine> | 501
GET    /v1/machines/{id}/tty         -> WebSocket, BINARY frames both ways (serial stdin/stdout)
```

Auth: if `NEHEMIAH_TOKEN` is set, send `Authorization: Bearer <token>` on `/v1/*`
(the WebSocket also accepts `?token=<token>`). `/healthz` is always open.

---

## 5. Teardown (STOP BILLING)

When you're done, **delete the server** so the meter stops:

```sh
infra/latitude/teardown.sh          # type "yes" to confirm
```

This calls `DELETE https://api.latitude.sh/servers/<id>`. It never prints the API
key. Deleting the server does not delete the (free) Latitude **project** — if it's
now empty you can remove it from the dashboard too.

---

## SECURITY

> **This platform runs untrusted, arbitrary code inside the microVMs.** Treat the
> whole box as hostile-tenant territory.

Current posture (prototype):

- **Bound to localhost / SSH tunnel only.** Do **not** expose `:8080` publicly.
  Keep the box firewalled (e.g. `ufw` default-deny inbound except `22`).
- **Set a `NEHEMIAH_TOKEN`** even behind the tunnel as defense-in-depth.
- Firecracker already gives you a KVM hardware boundary + minimal device model —
  much stronger isolation than containers.

**Hardening TODO before any public exposure (not done yet):**

- **jailer** — run each firecracker under `jailer` (chroot, `cgroups`, `pid`/`net`
  namespaces, drop to an unprivileged uid). Today nehemiahd runs firecracker as root.
- **seccomp** — enforce firecracker's seccomp filters (advanced/custom profile),
  and confine nehemiahd itself.
- **egress limits** — the demo skips guest networking entirely. If/when you add a
  tap per VM, put the guest behind a default-deny NAT with strict egress
  allow-lists and per-VM rate limits; block link-local/metadata ranges.
- **resource caps** — enforce vCPU/mem/disk quotas (already 1 vCPU / 256 MiB /
  overlay per VM), plus `NEHEMIAH_MAX` (default 20) and TTLs (15–900 s) to bound blast radius.
- **rootfs is copy-on-write per VM** (`cp --reflink=auto`) so tenants can't corrupt
  the base image, and VMs are destroyed on TTL/DELETE.

Until all of the above lands, this stays a single-operator prototype reachable
only through the SSH tunnel.

---

## COST

- **Server:** `c3.small.x86` @ MIA2 ≈ **$0.52 / hr**
  - ≈ **$12.48 / day**
  - ≈ **$375 / month** if left running 24×7.
- Billing is **hourly while the server exists** — it accrues whether or not nehemiahd
  is running or any VMs are up. The only way to stop it is `teardown.sh` (delete
  the server).
- microVMs themselves are free (they're just processes on the box); the cost is the
  bare-metal host.
- **Habit:** provision → bootstrap → deploy → demo → **teardown** in one sitting, or
  you'll pay for idle hours. Latitude projects are free; only servers bill.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `deploy.sh` | Build & deploy nehemiahd to the box; install/enable systemd unit; health-check. |
| `tunnel.sh` | SSH tunnel `localhost:8080 → box:8080` for running the demo. |
| `teardown.sh` | Delete the Latitude server via API to stop billing (confirmation required). |
| `nehemiahd.service` | systemd unit installed on the box by `deploy.sh`. |
| `README.md` | This runbook. |

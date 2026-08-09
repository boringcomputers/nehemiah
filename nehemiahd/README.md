# nehemiahd

Control plane for **Nehemiah** — a Firecracker microVM sandbox platform.

`nehemiahd` is a single Go binary that manages Firecracker microVMs on one bare-metal
Ubuntu 24.04 host (x86_64 or arm64) with `/dev/kvm`. It exposes a REST API to create/list/delete/fork
microVMs, WebSocket endpoints for a live serial shell, a VNC desktop, and AI agents that
drive them, plus guest internet, port previews, file transfer, and an OpenAI-compatible
inference gateway.

## How it works

Each machine is one `firecracker` child process launched by nehemiahd:

```
firecracker --api-sock /opt/boring/run/<id>.sock --id <id>
```

nehemiahd owns the child's **stdin/stdout** pipes. The guest kernel boots with
`console=ttyS0`, so the guest serial console is wired to firecracker's stdio:

- bytes nehemiahd writes to child **stdin**  → guest `/dev/ttyS0` (shell input)
- bytes the child writes to **stdout**     → guest serial console (shell output)

A per-machine **Console** runs one pump goroutine that reads the child's stdout, keeps a
bounded scrollback buffer, and fans each chunk out to every subscriber. The boot-timer and
every WebSocket client subscribe to the same stream, so nobody misses bytes. `boot_ms` is
measured from just-before `InstanceStart` until the guest prints `NEHEMIAH_READY` on serial.

Cold boot is the guaranteed path. Snapshot restore (`mode:"snapshot"`) and `branch` (fork
from a live snapshot) are best-effort optimizations that fall back cleanly.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/healthz` | `{"ok":true,"machines":<int>,"kvm":<bool>}` (no auth) |
| POST | `/v1/machines` | body `{"template":"python","ttl_seconds":120,"net":false}` → machine |
| GET | `/v1/machines` | `{"machines":[...]}` |
| GET | `/v1/machines/{id}` | machine or 404 |
| DELETE | `/v1/machines/{id}` | 204 or 404 |
| POST | `/v1/machines/{id}/exec` | body `{"command":"…","timeout_seconds":30}` → `{"output","exit_code","timed_out","duration_ms"}` (409 while an exec/agent holds the console) |
| POST | `/v1/machines/{id}/extend` | body `{"ttl_seconds":300}` (0/omitted → default) → machine with its new expiry |
| POST | `/v1/machines/{id}/branch` | live fork → machine (501 if snapshot unavailable). `?count=N` forks N clones from ONE snapshot → `{"machines":[…]}`; partial failures keep the successes; forks carry `"parent"` |
| POST | `/v1/machines/{id}/publish` | body `{"name":"my-tpl"}` → freeze the machine as a template; boot it later via `{"template":"my-tpl"}` in ms (400 bad/built-in name, 409 exists, 429 quota) |
| GET | `/v1/templates` | `{"templates":[…]}` — built-ins + published (name, size, display, source) |
| DELETE | `/v1/templates/{name}` | remove a published template (400 for built-ins) |
| GET | `/v1/machines/{id}/screenshot` | PNG of a desktop machine |
| POST | `/v1/machines/{id}/upload` | upload a file to `/root` (`X-Filename` header) |
| GET | `/v1/machines/{id}/download?path=` | download a file (needs a connected machine) |
| GET | `/v1/machines/{id}/tty` | WebSocket, binary frames both directions |
| GET | `/v1/machines/{id}/vnc` | WebSocket, RFB/VNC framebuffer (desktop) |
| GET | `/v1/machines/{id}/agent?goal=` | WebSocket, computer-use agent narration (JSON) |
| GET | `/v1/machines/{id}/shell-agent?goal=` | WebSocket, terminal agent narration (JSON) |
| POST | `/v1/chat/completions` | OpenAI-compatible inference gateway |
| GET | `/v1/models` | models the gateway can serve |
| POST | `/v1/volumes` | create a persistent volume (S3-backed) |
| GET/DELETE | `/v1/volumes/{id}` | volume metadata / delete |
| GET | `/v1/volumes/{id}/files` | list files |
| PUT/GET/DELETE | `/v1/volumes/{id}/file?path=` | upload / download / delete a file |
| POST | `/v1/machines/{id}/save?volume=` | save a machine's /root into a volume |

Preview: a Host of `<id>--<port>.<NEHEMIAH_PREVIEW_BASE>` reverse-proxies to the guest's
port (see `preview.go`); `GET /internal/tls-check` gates Caddy on-demand TLS.

`<machine>` = `{"id","status","mode","boot_ms","template","created_at","expires_at"}`.
`mode` is `coldboot`, `snapshot`, or `warm` (from the desktop pool). IDs look like `m-<8 hex>`.

## Auth

If `NEHEMIAH_TOKEN` is set, all `/v1/*` routes require `Authorization: Bearer <token>`.
The WebSocket route also accepts `?token=<token>`. `/healthz` is always open.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `NEHEMIAH_TOKEN` | *(unset)* | Bearer token; empty disables auth |
| `NEHEMIAH_MAX` | `20` | max live machines (429 when full) |
| `NEHEMIAH_MAX_TEMPLATES` | `10` | max user-published templates (`/publish`); `0` disables publishing |
| `NEHEMIAH_MAX_FORKS` | `8` | max clones per fleet fork (`branch?count=N`) |
| `NEHEMIAH_ALLOW_PERSISTENT` | `0` | `1` honors `"persistent": true` (no-TTL machines that run until deleted). Off by default so a public instance can't be drained. |
| `NEHEMIAH_MEM_RESERVE_MB` | `3072` | host RAM kept free; boot refused (429) rather than OOM the box (0 disables) |
| `NEHEMIAH_FIRECRACKER_BIN` | `/opt/boring/bin/firecracker` | firecracker binary |
| `NEHEMIAH_KERNEL` | `/opt/boring/kernel/vmlinux` | uncompressed kernel |
| `NEHEMIAH_ROOTFS` | `/opt/boring/rootfs/rootfs.ext4` | base rootfs |
| `NEHEMIAH_TEMPLATES` | `/opt/boring/templates` | snapshot template dir |
| `NEHEMIAH_RUN` | `/opt/boring/run` | per-machine sockets/overlays |
| `NEHEMIAH_NET` | `0` | `1` enables guest internet (per-VM NIC + NAT; see `infra/latitude/net-setup.sh`) |
| `NEHEMIAH_NET_BRIDGE` | `boring0` | host bridge for guest taps |
| `NEHEMIAH_NET_SUBNET` | `10.200.0` | guest /24 prefix (gateway `.1`) |
| `NEHEMIAH_DESKTOP_POOL` | `1` | warm desktops kept pre-booted for instant launch |
| `NEHEMIAH_PREVIEW_BASE` | *(unset)* | wildcard host for previews, e.g. `previews.example.com`; unset disables |
| `NEHEMIAH_LEASES` | `/var/lib/misc/dnsmasq.leases` | dnsmasq lease file, for guest IP lookup |
| `NEHEMIAH_ANTHROPIC_KEY` | *(unset)* | powers the agents + the gateway's Claude path |
| `NEHEMIAH_OPENROUTER_KEY` | *(unset)* | powers the gateway's non-Claude models |
| `NEHEMIAH_AGENT_MODEL` | `claude-opus-4-8` | model for the computer-use / terminal agents |
| `NEHEMIAH_AGENT_MAX_STEPS` | `18` | agent step cap (cost guard) |
| `NEHEMIAH_AGENT_MAX_CONCURRENT` | `2` | simultaneous agent runs (cost guard) |
| `NEHEMIAH_INFER_MAX_TOKENS` | `1024` | `max_tokens` clamp on the gateway |
| `NEHEMIAH_INFER_RATE` | `20` | gateway requests/min per IP |
| `NEHEMIAH_DAILY_AGENT_MAX` | `200` | global daily cap on agent runs (cost circuit breaker; 0 disables) |
| `NEHEMIAH_DAILY_INFER_MAX` | `3000` | global daily cap on inference requests (0 disables) |
| `NEHEMIAH_S3_ENDPOINT` | *(unset)* | S3 host:port for volumes (MinIO/Latitude); unset disables storage |
| `NEHEMIAH_S3_KEY` / `NEHEMIAH_S3_SECRET` | *(unset)* | S3 access key + secret |
| `NEHEMIAH_S3_BUCKET` | `boring-volumes` | bucket that holds all volumes |
| `NEHEMIAH_S3_SSL` | `0` | `1` for an https S3 endpoint |
| `NEHEMIAH_VOLUME_QUOTA_MB` | `256` | per-volume size cap |
| `NEHEMIAH_VOLUME_TTL` / `_MAX` | `86400` / `604800` | default / max volume lifetime (s) |
| `NEHEMIAH_VOLUME_RATE` | `10` | volume creations/min per IP |

TTL is clamped to `[15, 900]` seconds, default `120`.

## Run

```sh
go build -o nehemiahd ./...
NEHEMIAH_TOKEN=secret ./nehemiahd            # listens on 0.0.0.0:8080
```

Flags: `-addr` (default `0.0.0.0:8080`), `-max`.

### Quick demo

```sh
# create
curl -s -XPOST localhost:8080/v1/machines \
  -H 'Authorization: Bearer secret' \
  -d '{"template":"python","ttl_seconds":120}'

# attach a shell (needs a ws client, e.g. websocat)
websocat "ws://localhost:8080/v1/machines/<id>/tty?token=secret"
#   then type:  python3 -c 'print(2**10)'

# fork it
curl -s -XPOST localhost:8080/v1/machines/<id>/branch -H 'Authorization: Bearer secret'
```

Build/vet:

```sh
go mod tidy && go build ./... && go vet ./...
```

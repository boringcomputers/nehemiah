# nehemiahd

Control plane for **Nehemiah** — a Firecracker microVM sandbox platform.

`nehemiahd` is a single Go binary that manages Firecracker microVMs on one bare-metal
Ubuntu 24.04 host (x86_64 or arm64) with `/dev/kvm`. Managed mode exposes the private
control-plane contract plus bounded exec, terminal, VNC, preview, and file primitives;
guest egress is hard off. Local/self-hosted mode additionally exposes the legacy public
lifecycle API, AI agents, guest internet, volumes, and an OpenAI-compatible inference
gateway when an operator configures them.

## How it works

In local/self-hosted mode, each machine is one direct `firecracker` child process:

```
firecracker --api-sock /opt/boring/run/<id>.sock --id <id>
```

nehemiahd owns the child's **stdin/stdout** pipes. The guest kernel boots with
`console=ttyS0`, so the guest serial console is wired to firecracker's stdio:

- bytes nehemiahd writes to child **stdin** → guest `/dev/ttyS0` (shell input)
- bytes the child writes to **stdout** → guest serial console (shell output)

A per-machine **Console** runs one pump goroutine that reads the child's stdout, keeps a
bounded scrollback buffer, and fans each chunk out to every subscriber. The boot-timer and
every WebSocket client subscribe to the same stream, so nobody misses bytes. `boot_ms` is
measured from just-before `InstanceStart` until the guest prints `NEHEMIAH_READY` on serial.

Managed mode uses a different lifetime boundary. Jailer/Firecracker runs in an
exact sibling `nehemiah-vmm-<id>.scope` with systemd-owned CPU, memory, PID,
swap, and I/O limits and null stdio. Runtime state persists the scope, VMM PID,
API/vsock sockets, tap, overlay, and lease. After a daemon restart, reconciliation
proves that complete identity before reattaching. Customer TTY uses a bounded
guest-agent PTY over vsock, so it can reconnect without the old daemon's stdio
pipes. Serial remains local/self-hosted only; managed exec, file, and PTY paths
return a typed failure rather than falling back to it.

Cold boot is the guaranteed path. Snapshot restore (`mode:"snapshot"`) and `branch` (fork
from a live snapshot) are best-effort optimizations that fall back cleanly.

## Endpoints

Lifecycle, template-publication, screenshot, agent, inference, and volume management
routes in this section are local/self-hosted compatibility APIs unless a row says
otherwise. Managed lifecycle and exec requests use the authenticated private
control-plane API; managed tenant traffic reaches only the gateway data-plane routes.

| Method | Path                               | Description                                                                                                                                                                      |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                         | `{"ok":true,"machines":<int>,"kvm":<bool>}` (no auth)                                                                                                                            |
| POST   | `/v1/machines`                     | body `{"template":"python","ttl_seconds":120,"net":false}` → machine                                                                                                             |
| GET    | `/v1/machines`                     | `{"machines":[...]}`                                                                                                                                                             |
| GET    | `/v1/machines/{id}`                | machine or 404                                                                                                                                                                   |
| DELETE | `/v1/machines/{id}`                | 204 or 404                                                                                                                                                                       |
| POST   | `/v1/machines/{id}/exec`           | local/self-hosted public exec; managed exec uses the private control-plane contract and returns typed 503 if its guest agent is unavailable                                      |
| POST   | `/v1/machines/{id}/extend`         | body `{"ttl_seconds":300}` (0/omitted → default) → machine with its new expiry                                                                                                   |
| POST   | `/v1/machines/{id}/branch`         | live fork → machine (501 if snapshot unavailable). `?count=N` forks N clones from ONE snapshot → `{"machines":[…]}`; partial failures keep the successes; forks carry `"parent"` |
| POST   | `/v1/machines/{id}/publish`        | body `{"name":"my-tpl"}` → freeze the machine as a template; boot it later via `{"template":"my-tpl"}` in ms (400 bad/built-in name, 409 exists, 429 quota)                      |
| GET    | `/v1/templates`                    | `{"templates":[…]}` — built-ins + published (name, size, display, source)                                                                                                        |
| DELETE | `/v1/templates/{name}`             | remove a published template (400 for built-ins)                                                                                                                                  |
| GET    | `/v1/machines/{id}/screenshot`     | PNG of a desktop machine                                                                                                                                                         |
| POST   | `/v1/machines/{id}/upload`         | upload a file to `/root` (`X-Filename` header)                                                                                                                                   |
| GET    | `/v1/machines/{id}/download?path=` | download a file (needs a connected machine)                                                                                                                                      |
| GET    | `/v1/machines/{id}/tty`            | WebSocket, binary frames both directions (guest-agent PTY in managed mode; serial locally)                                                                                       |
| GET    | `/v1/machines/{id}/vnc`            | WebSocket, RFB/VNC framebuffer (desktop)                                                                                                                                         |
| GET    | `/v1/machines/{id}/agent`          | WebSocket, local/self-hosted computer-use agent narration (JSON); managed cloud does not issue this capability                                                                   |
| GET    | `/v1/machines/{id}/shell-agent`    | WebSocket, local/self-hosted terminal agent narration (JSON); managed cloud does not issue this capability                                                                       |

Agent WebSockets never accept goals in the URL in managed mode, where the routes
remain defense-in-depth dormant but the control plane issues no capability or
provider credential. Local/self-hosted clients send one text JSON frame after the
`101` upgrade and within five seconds:
`{"type":"start","version":1,"goal":"..."}`. The frame is limited to 64 KiB,
the UTF-8 goal to 4096 bytes, and the run to five minutes. Local mode accepts the
same protocol; legacy local clients may temporarily continue using `?goal=`.

Local/self-hosted mode also exposes `POST /v1/chat/completions` and `GET /v1/models`
for its operator-configured inference gateway.

The legacy volume and save endpoints are local/self-hosted only. Managed cloud
keeps volume storage and machine attach/save disabled.

Preview: a Host of `<id>--<port>.<NEHEMIAH_PREVIEW_BASE>` reverse-proxies to the guest's
port (see `preview.go`); `GET /internal/tls-check` gates Caddy on-demand TLS.

`<machine>` = `{"id","status","mode","boot_ms","template","created_at","expires_at"}`.
`mode` is `coldboot`, `snapshot`, or `warm` (from the desktop pool). IDs look like `m-<8 hex>`.

## Auth

If `NEHEMIAH_TOKEN` is set, all `/v1/*` routes require `Authorization: Bearer <token>`.
The WebSocket route also accepts `?token=<token>` in local mode only. Managed
mode requires the host gateway credential and current lease in headers;
credentials in URLs are rejected. `/healthz` is always open.

## Environment variables

Agent/inference and S3/volume settings configure local/self-hosted features only.
Managed release validation requires both provider model keys and all S3 credentials
to remain unset, even though it pins harmless dormant limit values.

| Var                                                              | Default                          | Meaning                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEHEMIAH_TOKEN`                                                 | _(unset)_                        | Bearer token; empty disables auth                                                                                                           |
| `NEHEMIAH_MAX`                                                   | `20`                             | max live machines (429 when full)                                                                                                           |
| `NEHEMIAH_MAX_TEMPLATES`                                         | `10`                             | max user-published templates (`/publish`); `0` disables publishing                                                                          |
| `NEHEMIAH_MAX_FORKS`                                             | `8`                              | max clones per fleet fork (`branch?count=N`)                                                                                                |
| `NEHEMIAH_ALLOW_PERSISTENT`                                      | `0`                              | `1` honors `"persistent": true` (no-TTL machines that run until deleted). Off by default so a public instance can't be drained.             |
| `NEHEMIAH_DEFAULT_TTL` / `NEHEMIAH_MIN_TTL` / `NEHEMIAH_MAX_TTL` | `120` / `15` / mode-specific     | machine lifetime bounds (s); max defaults to `900` locally and is pinned to `86400` in managed mode                                         |
| `NEHEMIAH_MEM_RESERVE_MB`                                        | `3072`                           | host RAM kept free; boot refused (429) rather than OOM the box (0 disables)                                                                 |
| `NEHEMIAH_FIRECRACKER_BIN`                                       | `/opt/boring/bin/firecracker`    | firecracker binary                                                                                                                          |
| `NEHEMIAH_SYSTEMD_RUN_BIN`                                       | `/usr/bin/systemd-run`           | managed transient-scope launcher                                                                                                            |
| `NEHEMIAH_SYSTEMCTL_BIN`                                         | `/usr/bin/systemctl`             | managed scope stop/reconciliation tool                                                                                                      |
| `NEHEMIAH_KERNEL`                                                | `/opt/boring/kernel/vmlinux`     | uncompressed kernel                                                                                                                         |
| `NEHEMIAH_ROOTFS`                                                | `/opt/boring/rootfs/rootfs.ext4` | base rootfs                                                                                                                                 |
| `NEHEMIAH_TEMPLATES`                                             | `/opt/boring/templates`          | snapshot template dir                                                                                                                       |
| `NEHEMIAH_RUN`                                                   | `/opt/boring/run`                | per-machine sockets/overlays                                                                                                                |
| `NEHEMIAH_NET`                                                   | `0`                              | Local: `1` enables NIC/NAT. Managed: pinned on for isolated tap plumbing while policy remains hard `off`; it does not enable public egress. |
| `NEHEMIAH_NET_BRIDGE`                                            | `boring0`                        | host bridge for guest taps                                                                                                                  |
| `NEHEMIAH_NET_SUBNET`                                            | `10.200.0`                       | guest /24 prefix (gateway `.1`)                                                                                                             |
| `NEHEMIAH_DESKTOP_POOL`                                          | `1`                              | warm desktops kept pre-booted for instant launch                                                                                            |
| `NEHEMIAH_PREVIEW_BASE`                                          | _(unset)_                        | wildcard host for previews, e.g. `previews.example.com`; unset disables                                                                     |
| `NEHEMIAH_LEASES`                                                | `/var/lib/misc/dnsmasq.leases`   | dnsmasq lease file, for guest IP lookup                                                                                                     |
| `NEHEMIAH_ANTHROPIC_KEY`                                         | _(unset)_                        | local/self-hosted agent and Claude credential; managed release policy requires it to remain empty                                           |
| `NEHEMIAH_OPENROUTER_KEY`                                        | _(unset)_                        | local/self-hosted non-Claude inference credential; managed release policy requires it to remain empty                                       |
| `NEHEMIAH_AGENT_MODEL`                                           | `claude-opus-4-8`                | model for the computer-use / terminal agents                                                                                                |
| `NEHEMIAH_AGENT_MAX_STEPS`                                       | `30`                             | agent step cap; managed mode requires `1..30`                                                                                               |
| `NEHEMIAH_AGENT_MAX_CONCURRENT`                                  | `2`                              | simultaneous agent runs (cost guard)                                                                                                        |
| `NEHEMIAH_INFER_MAX_TOKENS`                                      | `1024`                           | `max_tokens` clamp on the gateway                                                                                                           |
| `NEHEMIAH_INFER_RATE`                                            | `20`                             | gateway requests/min per IP                                                                                                                 |
| `NEHEMIAH_DAILY_AGENT_MAX`                                       | `200`                            | global daily cap on agent runs; managed mode requires `1..10000`                                                                            |
| `NEHEMIAH_DAILY_INFER_MAX`                                       | `3000`                           | global daily cap on inference requests (0 disables)                                                                                         |
| `NEHEMIAH_S3_ENDPOINT`                                           | _(unset)_                        | Local-only S3 host:port for legacy volumes; managed release policy requires storage disabled                                                |
| `NEHEMIAH_S3_KEY` / `NEHEMIAH_S3_SECRET`                         | _(unset)_                        | S3 access key + secret                                                                                                                      |
| `NEHEMIAH_S3_BUCKET`                                             | `boring-volumes`                 | bucket that holds all volumes                                                                                                               |
| `NEHEMIAH_S3_SSL`                                                | `0`                              | `1` for an https S3 endpoint                                                                                                                |
| `NEHEMIAH_VOLUME_QUOTA_MB`                                       | `256`                            | per-volume size cap                                                                                                                         |
| `NEHEMIAH_VOLUME_TTL` / `_MAX`                                   | `86400` / `604800`               | default / max volume lifetime (s)                                                                                                           |
| `NEHEMIAH_VOLUME_RATE`                                           | `10`                             | volume creations/min per IP                                                                                                                 |
| `NEHEMIAH_OTEL_ENABLED`                                          | _(unset)_                        | exact `true` enables OTLP and is mandatory on managed hosts; local mode may leave it unset or exact `false`                                 |
| `NEHEMIAH_OTEL_ENDPOINT`                                         | _(unset)_                        | origin-only HTTPS collector URL with a DNS hostname; mandatory on managed hosts                                                             |
| `NEHEMIAH_OTEL_AUTHORIZATION`                                    | _(unset)_                        | unique per-host collector authorization distinct from platform credentials; never logged                                                    |
| `NEHEMIAH_SERVICE_VERSION` / `NEHEMIAH_INSTANCE_ID`              | _(unset)_                        | immutable release and stable instance resource identity; required when enabled                                                              |
| `NEHEMIAH_DEPLOYMENT_ENVIRONMENT`                                | _(unset)_                        | `development`, `test`, `staging`, or `production`; managed hosts require `staging` or `production`                                          |
| `NEHEMIAH_OTEL_EXPORT_INTERVAL_MS` / `_TIMEOUT_MS`               | `15000` / `10000`                | bounded metric/batch export interval and timeout when enabled                                                                               |
| `NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO`                               | `0.1`                            | parent-based root sampling ratio, bounded to `[0.001,1]`                                                                                    |

Machine TTL is clamped to `[15, 900]` seconds by default in local/self-hosted
mode. Managed mode keeps the same `120`-second default and `15`-second minimum,
with a release-pinned maximum of `86400` seconds.

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

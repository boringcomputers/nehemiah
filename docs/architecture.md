# Nehemiah — architecture & thesis

## Thesis

Agents and AI products increasingly need **real computers** they can spin up in
milliseconds, run untrusted code inside, pause, fork, and throw away — thousands
at a time, colocated with the model doing the thinking. Containers are too weak an
isolation boundary for arbitrary code; full VMs are too slow and heavy to treat as
disposable. **Firecracker microVMs** hit the sweet spot: a hardware (KVM) isolation
boundary with ~100ms cold boots and a tiny memory footprint.

The bet: **the Machine is the core primitive**, and everything else is a projection
of it.

- **Sandbox = Machine.** A microVM you create over an API and drive with a shell /
  exec. Run untrusted code safely.
- **Computer = Machine + display.** The same microVM with a framebuffer/desktop and
  an action layer (click, type, screenshot) for computer-use agents.

One core, two products. Owning the Machine core — the microVM lifecycle, the
scheduler, snapshotting, volumes, the desktop, the action layer, and the SDK — is
the whole company. Everything above it is a thin skin.

## The moat

Three compounding mechanisms, all rooted in Firecracker:

1. **Snapshot-restore.** Boot a template once, snapshot RAM + device state, then
   restore new VMs from that snapshot in a few ms instead of cold-booting. A warm
   "python-ready" VM becomes an instant, forkable image.
2. **Copy-on-write branching.** Fork a running Machine from its snapshot + CoW
   rootfs overlay (`cp --reflink=auto`). Cheap divergent timelines: explore N
   branches of an agent's state from one checkpoint. This is `/v1/machines/{id}/branch`.
3. **Co-location near LLM APIs.** Place the fleet in the same region/network as the
   inference endpoints so the tool-call ↔ execution ↔ model loop is bounded by
   physics, not by cross-region round-trips. The prototype box lives in MIA2 for
   exactly this reason.

Snapshot-restore + CoW branching + co-location is the flywheel: faster, cheaper,
and stateful in a way per-request containers can't match.

## WRAP vs BUILD map

What we own vs. what we rent, and what migrates over time.

**OWN (the core — build and keep):**
- microVM lifecycle (Firecracker driver, serial-over-stdio transport)
- scheduler / placement across hosts
- snapshots (template capture + restore)
- volumes (per-VM CoW rootfs, persistent disks later)
- desktop (framebuffer + display for Computer)
- action layer (click/type/screenshot/exec)
- the SDK (the developer surface)

**WRAP — keep (best-in-class, no reason to build):**
- **R2** — object storage for images/snapshots/artifacts
- **Cloudflare edge** — CDN, DNS, DDoS, WAF in front of Nehemiah
- **Clerk** — auth / orgs / API keys
- **Stripe** — billing & metering
- **Neon** — Postgres database behind Nehemiah
- **OTel** — tracing / metrics / logs

**WRAP now, OWN later (strategic, migrate when scale justifies):**
- **compute substrate** — start on rented bare metal; grow toward owned/colocated
  hardware as unit economics and demand harden.
- **inference gateway** — wrap a provider/router first; pull it in-house as
  co-location and routing become a differentiator.

**RENT (commodity, never own):**
- **Latitude.sh bare metal** — the physical hosts. Interchangeable capacity.

## One-box prototype

Everything below runs on a **single Latitude.sh `c3.small.x86` in MIA2** (Ubuntu
24.04, 6 cores / 32 GB, `/dev/kvm`). The SvelteKit hero site is on Vercel; the
browser talks to nehemiahd over an SSH-tunneled WebSocket.

```
   ┌──────────────┐         ┌────────────────────────────────────────────────────────┐
   │  Browser     │         │  Latitude.sh c3.small.x86  @ MIA2  (Ubuntu 24.04, /dev/kvm) │
   │  (operator)  │         │                                                        │
   └──────┬───────┘         │   ┌──────────────── nehemiahd (:8080) ────────────────┐  │
          │ HTTPS           │   │  REST host API + /tty WebSocket bridge           │  │
          ▼                 │   │  registry (sync.Mutex) · TTL reaper · NEHEMIAH_MAX │  │
   ┌──────────────┐  WS/HTTP│   └───┬───────────────┬───────────────┬─────────────┘  │
   │ Vercel hero  │  (SSH   │       │ stdin/stdout  │ stdin/stdout  │ stdin/stdout   │
   │ site (Svelte)│  tunnel)│       │ (serial)      │ (serial)      │ (serial)       │
   │  ── WS ───────┼────────────────┼───────────────┼───────────────┼──────────      │
   └──────────────┘         │       ▼               ▼               ▼                │
                            │  ┌─────────┐     ┌─────────┐     ┌─────────┐           │
                            │  │firecrckr│     │firecrckr│     │firecrckr│  child     │
                            │  │ microVM │     │ microVM │     │ microVM │  processes  │
                            │  │ ttyS0   │     │ ttyS0   │     │ ttyS0   │            │
                            │  │ python3 │     │ python3 │     │ python3 │            │
                            │  └────┬────┘     └────┬────┘     └────┬────┘            │
                            │       │ API sock      │               │                │
                            │  /opt/boring/run/<id>.sock  +  <id>.ext4 (CoW overlay)  │
                            │                                                        │
                            │  base: /opt/boring/kernel/vmlinux                       │
                            │        /opt/boring/rootfs/rootfs.ext4                   │
                            │        /opt/boring/templates/<name>/ (snapshot,mem)     │
                            └────────────────────────────────────────────────────────┘
```

### How the shell works (serial-over-stdio)

Each Machine is one `firecracker` child process that nehemiahd owns:

```
firecracker --api-sock /opt/boring/run/<id>.sock --id <id>
```

The guest kernel boots with `console=ttyS0`, wiring the guest serial console to
firecracker's **stdio**. nehemiahd owns that child's stdin/stdout pipes, so:

- bytes nehemiahd writes to child **STDIN** → land on guest `/dev/ttyS0` (shell input)
- bytes the child writes to **STDOUT** → are the guest serial console (shell output)

The `/v1/machines/{id}/tty` WebSocket is just a byte pump between the client and
this child stdio (binary frames both ways). The **same transport works for both
cold-boot and snapshot-restored VMs**, which is why it's the guaranteed path.

### Boot & lifecycle

1. Copy base (or template) rootfs → `/opt/boring/run/<id>.ext4` via `cp --reflink=auto`.
2. If a template snapshot exists and `PUT /snapshot/load` succeeds → `mode="snapshot"`;
   otherwise cold boot (`mode="coldboot"` — the guaranteed path).
3. Cold boot configures firecracker over its unix socket (raw HTTP, no SDK required):
   `PUT /boot-source`, `PUT /drives/rootfs`, `PUT /machine-config`
   (1 vCPU / 256 MiB), then `PUT /actions {InstanceStart}`.
4. `boot_ms` = wall-clock from just-before-`InstanceStart` until the guest prints
   the `NEHEMIAH_READY` marker on serial. Pre- and post-marker bytes are buffered so
   the `/tty` client still gets the full scrollback.
5. Register the machine; start a TTL timer (`ttl_seconds`, default 120, clamped
   15–900). On expiry/DELETE: SIGKILL the child (+ best-effort `SendCtrlAltDel`),
   remove the sock + overlay (+ tap if any), drop it from the registry.

Concurrency: the registry is guarded by a `sync.Mutex`; `NEHEMIAH_MAX` (default 20)
caps live machines and returns `429` when full. Guest networking is intentionally
skipped in v1 — the serial shell needs none, so nothing blocks VM creation.

### Control-plane contract

nehemiahd listens on `0.0.0.0:8080`. If `NEHEMIAH_TOKEN` is set, `/v1/*` requires
`Authorization: Bearer <token>` (the `/tty` WebSocket also accepts `?token=`);
`/healthz` is always open.

```
GET    /healthz                      -> {"ok":true,"machines":<int>,"kvm":<bool>}
POST   /v1/machines                  -> 201 {"id","status","mode","boot_ms","created_at","expires_at"}
GET    /v1/machines                  -> 200 {"machines":[<machine>...]}
GET    /v1/machines/{id}             -> 200 <machine> | 404
DELETE /v1/machines/{id}             -> 204 | 404
POST   /v1/machines/{id}/branch      -> 201 <machine> | 501   (fork from snapshot; best-effort)
GET    /v1/machines/{id}/tty         -> WebSocket, BINARY frames both ways (serial stdin/stdout)
```

`<machine>` = `{"id","status","mode","boot_ms","template","created_at","expires_at"}`,
ids look like `m-<8 hex>`. See `infra/latitude/README.md` for the operator runbook
(deploy, tunnel, demo, teardown) and the security/cost posture.

## What's deliberately deferred

The prototype proves the mechanism (create → live shell → python3 → fork) on one
box. Not yet built, and required before this touches the public internet:
**jailer + seccomp confinement, guest egress controls, a multi-host scheduler,
persistent volumes, the desktop/action layer, and metering/billing.** These are
the roadmap from "one working box" to the Machine platform described above.

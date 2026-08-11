# Nehemiah

[![CI](https://github.com/boringcomputers/nehemiah/actions/workflows/ci.yml/badge.svg)](https://github.com/boringcomputers/nehemiah/actions/workflows/ci.yml)

**On-demand Linux computers you can hand to an AI.**

Each one is a real [Firecracker](https://firecracker-microvm.github.io/) microVM —
a full machine with its own kernel — that boots in milliseconds, does its thing,
and self-destructs when it's done (or stays up as long as you want).
**Open source (Apache-2.0), self-hosted with your own keys.**
[boringcomputers.com](https://boringcomputers.com) is a showcase; you run the real
thing yourself.

!["build a snake game I can play" → a warm desktop boots in seconds, the AI writes and serves the game, and you play it at a live URL](docs/demo.gif)

<details>
<summary>What a Nehemiah machine looks like</summary>

![A Nehemiah machine: a live desktop with a browser and calculator, a terminal with claude/codex/cursor/pi preinstalled, and an AI build box](docs/hero.png)

</details>

> One machine, everything on it — a live desktop with a real browser, a terminal
> with coding agents preinstalled, and an AI you can hand the whole thing to.
> Type _"build a snake game"_ and it writes it, runs it, and gives you a link to play.

## What you get

- **A computer** — a full Linux desktop (browser, terminal, apps) over VNC, or a
  fast headless shell.
- **Coding agents preinstalled** — `claude`, `codex`, `cursor`, `pi`, plus node,
  python, git and internet.
- **An AI that drives it** — say what you want. It either uses the screen
  (clicks, browses) or writes + runs code and hands you a **live URL**.
- **Files & ports** — drag files in and out; open any port through the daemon.
- **Fork** — clone a running computer, exact live state and all, in ~35 ms.
- **Storage** — persistent volumes (S3-backed) that outlive a machine.
- **Ephemeral or not** — machines self-destruct on a TTL by default; flip
  _keep alive_ and one runs until you stop it.

## Run your own

Nehemiah runs as a managed cloud: hosts are provisioned from **signed release
artifacts** onto machines the control plane enrolls, not from a local source
build. The supported path stands up one approved
[Latitude.sh](https://latitude.sh) bare-metal host from a published `v<version>`
release:

```sh
git clone https://github.com/boringcomputers/nehemiah
cd nehemiah && npm install

# provision one managed host from a signed release (needs operator inputs — see the runbook)
infra/latitude/provision.sh --config "${XDG_CONFIG_HOME:-$HOME/.config}/nehemiah/latitude-host.env"
```

Follow [`infra/latitude/README.md`](infra/latitude/README.md) for the full
managed-host runbook: the signed-release trust boundary, the one-use enrollment
grant, the WireGuard overlay, and the canary checks to run before admitting
workloads. Tear a host back down (and stop billing) with
[`infra/latitude/teardown.sh`](infra/latitude/teardown.sh).

> **The earlier self-serve one-command installers are no longer supported.**
> `infra/setup.sh` (a Linux box over SSH) and `infra/local/setup-local.sh` (an
> Apple Silicon Mac in Lima) built the host from source, but host bootstrap now
> installs Firecracker, the jailer, and the kernel only from signed
> managed-release artifacts, which those scripts cannot supply. They now exit with
> a pointer to the managed runbook above.

Then run the site against your host:

```sh
# apps/web/.env
PUBLIC_NEHEMIAH_URL=http://YOUR_HOST_IP:8080   # or a tunnel — see apps/web/.env.example
npm run dev -w web
```

Full REST + WebSocket API in the [docs](https://boringcomputers.com/docs).

**From any AI** — an MCP server
([`nehemiah-mcp`](packages/mcp)) lets Claude Desktop, Cursor, and other
agents spin up and drive your computers as a tool:

```json
{
  "mcpServers": {
    "nehemiah": {
      "command": "npx",
      "args": ["-y", "nehemiah-mcp"],
      "env": { "NEHEMIAH_URL": "http://localhost:8080" }
    }
  }
}
```

There's also an Effect-native TypeScript client,
[`nehemiah-sdk`](packages/sdk) (`npm install nehemiah-sdk`).

## How it works

Real hardware-virtualized isolation — a kernel per machine, not a shared
container. Each VM is jailed and resource-capped, restored from a memory
snapshot in ~3 ms, and self-destructs on a TTL (or runs until you stop it, when
the server enables `NEHEMIAH_ALLOW_PERSISTENT`). Guests are network-isolated
behind an egress firewall. The host daemon is [`nehemiahd/`](nehemiahd) (Go);
hosts are provisioned from a signed release via the managed runbook
([`infra/latitude/`](infra/latitude)).

## Repo

A [Turborepo](https://turbo.build/repo) monorepo (npm workspaces):

```
apps/web/          the site — SvelteKit
nehemiahd/           the host daemon — Go, runs the microVMs
packages/sdk/      nehemiah-sdk — Effect-native TypeScript client
packages/mcp/      nehemiah-mcp — MCP server
infra/latitude/    managed-host provisioning (provision/teardown), image builds, networking
```

```sh
npm install      # all workspaces
npm run dev      # the site
npm run build    # production build
npm run check    # type-check
npm run lint     # prettier + eslint
```

## Contributing & license

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under
[Apache 2.0](LICENSE).

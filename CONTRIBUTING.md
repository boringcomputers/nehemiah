# Contributing

Thanks for wanting to help make computers more boring. This is a small,
approachable codebase — most changes touch one part of it.

## Layout

| Path | What | Language |
| --- | --- | --- |
| `apps/web/` | The site — the launcher, terminal, desktop, agent, docs | TypeScript / SvelteKit |
| `nehemiahd/` | The host daemon — boots and manages the microVMs | Go |
| `packages/sdk/` | A tiny REST/WS client | TypeScript |
| `packages/mcp/` | The MCP server | JavaScript (Node) |
| `infra/latitude/` | Host setup — rootfs, kernel, networking, Caddy | shell |

## Getting started

Most of the app is the **web frontend**, and it runs against the hosted API with
no special hardware:

```sh
npm install      # all workspaces
npm run dev      # starts apps/web (talks to the public nehemiahd endpoint)
```

Point it at a different backend with `PUBLIC_NEHEMIAH_URL` (or `NEHEMIAH_URL` for the
dev proxy) in `apps/web/.env`.

**nehemiahd** and the microVMs need a Linux host with KVM + Firecracker — see
[`infra/latitude/`](infra/latitude). You don't need to run this to work on the
frontend, the SDK, the MCP server, or docs.

## Before you open a PR

```sh
npm run check    # type-check (svelte-check)
npm run lint     # prettier --check + eslint
npm run format   # prettier --write  (fixes formatting)
```

For Go changes in `nehemiahd/`, run `gofmt -w .` and `go build ./...`.

Keep changes focused, match the surrounding style, and describe what you changed
and why in the PR.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).

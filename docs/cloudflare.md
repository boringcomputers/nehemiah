# Cloudflare: the site and the edge, as code

`apps/web/alchemy.run.ts` is an [Alchemy](https://alchemy.run) stack named
`boring-computers`. One deploy builds the SvelteKit site, uploads it as a
Cloudflare Worker, and reconciles the edge resources that sit in front of the
managed cloud. Everything below is applied from `apps/web`.

## What the stack owns

| Resource                                   | Stage | Notes                                                                                         |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------- |
| Worker `Website` (SvelteKit)               | all   | Built by Alchemy's wrangler-free Cloudflare adapter; `nodejs_compat` is set automatically.    |
| Custom domain + `www` 301                  | prod  | `SITE_DOMAIN` (default `boringcomputers.com`); DNS and certificate are managed by Cloudflare. |
| Web Analytics                              | prod  | Edge-injected beacon on the zone. Replaces `@vercel/analytics`; the app ships no beacon.      |
| Tunnel `boring-computers-prod-origin`      | prod  | Ingress: `api.` → control plane, `gateway.` and `*.<preview>` → gateway, catch-all 404.       |
| DNS CNAMEs (`api`, `gateway`, `*.preview`) | prod  | Proxied, pointing at `<tunnel id>.cfargotunnel.com`.                                          |
| R2 bucket                                  | prod  | `R2_BUCKET` (default `nehemiah-artifacts`). Retained on `destroy`.                            |

The stack adopts the existing zone(s) by name for their ids and marks them
`retain`, so `alchemy destroy` never deletes a zone. Everything else in the
table is created by the stack.

Not managed here, on purpose:

- **Latitude hosts.** Firecracker needs bare metal with `/dev/kvm`; Cloudflare
  Containers top out at 4 vCPU / 12 GiB and expose no KVM. Use
  [`infra/latitude`](../infra/latitude/README.md).
- **The origin VM** running `apps/nehemiah` and `gateway/`. It sits on the
  WireGuard overlay and only needs outbound connectivity once the tunnel is up.
- Neon, Clerk, Stripe, and WAF/rate-limit rules. The Alchemy providers exist
  for the first three if they should move into the stack later.

## One-time setup

```sh
cd apps/web
npx alchemy profile edit --add Cloudflare   # browser login or an API token; stored in ~/.alchemy
npm run plan -- --stage prod                # shows the plan, changes nothing
npm run deploy -- --stage prod
```

The first deploy also creates the `alchemy-state-store` Worker in the account.
That store holds the stack state so laptops and CI see the same resources;
never fall back to local state for `prod`.

Cutting over from Vercel:

1. Delete the apex and `www` records that point at Vercel. Attaching a Worker
   custom domain requires the hostnames to be free; Alchemy then creates them.
2. `npm run deploy -- --stage prod`, then confirm `https://boringcomputers.com`
   and that `https://www.boringcomputers.com` redirects.
3. Set the CI secrets and variables below, then remove the Vercel project.

## CI

`.github/workflows/deploy-web.yml` deploys `prod` on pushes to `main` and a
`pr-<n>` preview (site only, on `workers.dev`) for pull requests from this
repository, destroying the preview when the pull request closes.

Repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`: an account-scoped token. Start from Cloudflare's
  "Edit Cloudflare Workers" template and add **Workers R2 Storage Write**,
  **Cloudflare Tunnel Write**, **Secrets Store Write** (state store), plus the
  zone permissions **DNS Write**, **Workers Routes Write**, and **SSL and
  Certificates Write** for the site and preview zones. A failed deploy names
  the missing permission in its 403.

Repository variables (all optional; blank values are not forwarded): the
`PUBLIC_*`, `PRIVATE_NEHEMIAH_URL`, and `STATUS_*` site settings from
[`apps/web/.env.example`](../apps/web/.env.example), and the edge settings
`SITE_DOMAIN`, `API_HOSTNAME`, `GATEWAY_HOSTNAME`, `CONTROL_PLANE_ORIGIN`,
`GATEWAY_ORIGIN`, `PREVIEW_BASE_DOMAIN`, `PREVIEW_ZONE_NAME`, `R2_BUCKET`.

## The origin VM behind the tunnel

The tunnel connector runs next to the control plane and gateway:

1. Take `tunnelId` from the deploy output.
2. On the VM, install `cloudflared`, mint the connector token with a logged-in
   `cloudflared` (`cloudflared tunnel login`, then
   `cloudflared tunnel token <tunnel id>`), and install
   [`infra/cloudflare/cloudflared.service`](../infra/cloudflare/cloudflared.service)
   following the comments at the top of that file.
3. Point the ingress at the local listeners: `CONTROL_PLANE_ORIGIN` defaults to
   `http://127.0.0.1:8081` (`PORT` in `apps/nehemiah`) and `GATEWAY_ORIGIN` to
   `http://127.0.0.1:8082` (`NEHEMIAH_GATEWAY_ADDR`). Bind both to loopback.
4. Requests now arrive from `cloudflared` on loopback. Configure the gateway's
   trusted-edge CIDR to that loopback address and its client-address header to
   `CF-Connecting-IP` (see `gateway/config.go`) so rate limits key on the real
   client, and keep the security checklist item "Cloudflare-to-origin
   authentication is enforced" in mind: the tunnel is the only ingress, so
   nothing else may listen on a public interface.

WebSockets (TTY, VNC, agent streams) pass through the tunnel unchanged.

## Machine previews

The control plane and gateway both require `NEHEMIAH_PREVIEW_BASE_DOMAIN` to be
a **different registrable domain** from the site. Register one, add it as a
zone in the same account, set `PREVIEW_BASE_DOMAIN` (and `PREVIEW_ZONE_NAME`
if the zone is a parent of it), and the next `prod` deploy creates the proxied
`*.<domain>` CNAME and the matching tunnel ingress. A first-level wildcard on
its own zone is covered by Universal SSL; a deeper wildcard would need Advanced
Certificate Manager.

## R2 credentials

The bucket is created here, but the control plane talks S3. Mint an R2 S3 API
token in the dashboard (R2 → Manage API tokens) scoped to the bucket and set
the control plane's S3 settings from
[`apps/nehemiah/.env.example`](../apps/nehemiah/.env.example). Managed
template transfer and volumes stay disabled until the checks in
[`nehemiah/implementation-status.md`](nehemiah/implementation-status.md) pass.

## Notes on the toolchain

- Alchemy 2 is Effect 4 based, so `apps/web` carries `effect@4` (release
  candidate) as a dev dependency. It is nested under `apps/web/node_modules`
  and does not affect the Effect 3 used by the control plane, SDK, and CLI.
- `@alchemy.run/frontend-frameworks` declares an optional peer range of
  SvelteKit 3 (pre-release) while the site runs SvelteKit 2. The mechanism it
  relies on, passing kit options to the `sveltekit()` Vite plugin and reading
  them back from the plugin API, exists since kit 2.62, and the build has been
  verified against 2.70. The root `package.json` therefore overrides that
  peer range to `^2.62.0`; drop the override when the site moves to kit 3.
- Alchemy replaces any adapter declared in `vite.config.ts` with its own, so
  the site declares none. A plain `vite build` still succeeds; it only prints
  that no adapter was specified.

## Day to day

```sh
cd apps/web
npm run deploy                     # your own stage (live_<user>): site only, workers.dev
npm run destroy                    # tear that stage down
npm run plan -- --stage prod       # diff prod without applying
npx alchemy dev                    # SvelteKit dev server with Worker-style platform.env
```

The existing `npm run dev` (Vite plus the optional SSH tunnel to a private
`nehemiahd`) is unchanged and remains the usual local loop.

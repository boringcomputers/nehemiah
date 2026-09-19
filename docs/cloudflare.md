# Cloudflare: the managed cloud, as code

`apps/web/alchemy.run.ts` is an [Alchemy](https://alchemy.run) stack named
`boring-computers`. One deploy builds the SvelteKit site, uploads it as a
Cloudflare Worker, builds and rolls out the control plane and gateway as
Cloudflare Containers behind an edge Worker, and reconciles the Access, DNS,
and R2 resources around them. Everything below is applied from `apps/web`.
The design and its trade-offs are in
[ADR 0005](nehemiah/adr/0005-cloudflare-containers-and-host-tunnels.md).

## What the stack owns

| Resource                                  | Stage | Notes                                                                                                               |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Worker `Website` (SvelteKit)              | all   | Built by Alchemy's wrangler-free Cloudflare adapter; `nodejs_compat` is set automatically.                          |
| Custom domain + `www` 301                 | prod  | `SITE_DOMAIN` (default `boringcomputers.com`); DNS and certificate are managed by Cloudflare.                       |
| Web Analytics                             | prod  | Edge-injected beacon on the zone. Replaces `@vercel/analytics`; the app ships no beacon.                            |
| R2 bucket                                 | prod  | `R2_BUCKET` (default `nehemiah-artifacts`). Retained on `destroy`.                                                  |
| Container `ControlPlane`                  | prod  | `apps/nehemiah/Dockerfile`, built from the repository root. `standard-2`, one instance (`primary`).                 |
| Container `Gateway`                       | prod  | `gateway/Dockerfile`. `standard-2`, one instance (`primary`).                                                       |
| Worker `Edge` (`apps/web/edge/worker.ts`) | prod  | Custom domains `api.` and `gateway.`; zone route `*.<preview domain>/*`. Routes by hostname to the two containers.  |
| Access service token `ServicesToken`      | prod  | Presented by the control plane and gateway to host tunnels and to `api.<site>/internal`.                            |
| Access application `HostsAccess`          | prod  | `*.<host tunnel domain>`: admits only the services token.                                                           |
| Access application `InternalRoutesAccess` | prod  | `api.<site>/internal`: admits the services token and, when `FLEET_ACCESS_TOKEN_ID` is set, the token hosts present. |
| DNS `*.<preview domain>` (proxied A)      | prod  | Placeholder target so the zone route fires; the edge Worker answers.                                                |

The stack adopts the existing zone(s) by name for their ids and marks them
`retain`, so `alchemy destroy` never deletes a zone. Everything else in the
table is created by the stack.

Not managed here, on purpose:

- **Latitude hosts.** Firecracker needs bare metal with `/dev/kvm`; Cloudflare
  Containers top out at 4 vCPU / 12 GiB and expose no KVM. Use
  [`infra/latitude`](../infra/latitude/README.md). Each host runs its own
  `cloudflared` (below); that is an operator step, like peer inventory under
  ADR 0002.
- Neon, Clerk, Stripe, and WAF/rate-limit rules. The Alchemy providers exist
  for the first three if they should move into the stack later.

## How traffic flows

- **Public clients → `api.<site>`**: Cloudflare edge → edge Worker → control
  plane container. Inside a container the TCP peer is always the Worker
  runtime, so the Worker signs `CF-Connecting-IP` with the gateway token the
  same way the gateway does when it proxies; the control plane's admission
  keys on the real caller. A request that already carries a fresh, valid
  signature (the gateway calling the control plane through this edge) passes
  through unchanged.
- **Public clients → `gateway.<site>` / previews**: edge Worker → gateway
  container. The gateway is configured with `NEHEMIAH_GATEWAY_TRUSTED_EDGE_CIDRS=0.0.0.0/0,::/0`
  and reads the caller from `CF-Connecting-IP`; the Worker is its only peer.
- **Control plane / gateway → hosts**: `https://<label>.<host tunnel domain>`
  with the services token in `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
  The label is the host's overlay address with dashes (`10.64.0.7` →
  `10-64-0-7`; IPv6 fully expanded). The host's address stays its identity in
  the database and the allowlists; only the path to it changes.
- **Hosts → control plane**: `NEHEMIAH_CONTROL_PLANE_URL=https://api.<site>`
  over the public edge, with the fleet Access token in the same two headers so
  `/internal/*` admits them.
- **Gateway → control plane**: `https://api.<site>` with the services token.

WebSockets (TTY, VNC, agent streams) pass through the edge Worker and the host
tunnels unchanged. Every stream crosses the edge twice; see the ADR for the
latency and lifetime consequences.

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

Before the first `prod` deploy:

1. Add `SITE_DOMAIN` as a zone in the account, and the preview domain's zone.
   Delete any apex and `www` records that point elsewhere; attaching a Worker
   custom domain requires the hostnames to be free.
2. Order an Advanced Certificate Manager certificate covering
   `*.<host tunnel domain>` (a wildcard below the apex is outside Universal
   SSL), or put the host tunnel domain on its own zone.
3. In Zero Trust → Access → Service Auth, create the **fleet** service token
   hosts will present, and set its id as `FLEET_ACCESS_TOKEN_ID`. Its secret
   goes only to hosts; the stack never sees it.
4. Provide the container settings listed under CI. The control plane refuses
   to start in production without a `DATABASE_URL` using `sslmode=verify-full`,
   Clerk issuer and audience, strong gateway credentials, and a complete OTel
   exporter configuration; the deploy fails on the first missing value.
5. Set the CI secrets and variables below, then remove the Vercel project.

Docker must be available to whoever runs the deploy: Alchemy builds both
images locally (`linux/amd64`) and pushes them to the account's registry.

## CI

`.github/workflows/deploy-cloudflare.yml` deploys `prod` on pushes to `main`
(after applying control-plane migrations with the migration role) and a
`pr-<n>` preview (site only, on `workers.dev`) for pull requests from this
repository, destroying the preview when the pull request closes.

Repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`: an account-scoped token.
  Start from Cloudflare's "Edit Cloudflare Workers" template and add
  **Workers R2 Storage Write**, **Containers Write** (Cloudchamber),
  **Access: Apps and Policies Write**, **Access: Service Tokens Write**,
  **Secrets Store Write** (state store), **Account Analytics Write** (Web
  Analytics), plus the zone permissions **DNS Write**, **Workers Routes
  Write**, and **SSL and Certificates Write** for the site and preview zones.
  A failed deploy names the missing permission in its 403.
- `DATABASE_URL`, `MIGRATION_DATABASE_URL`
- `NEHEMIAH_HOST_CREDENTIAL_KEY`, `NEHEMIAH_GATEWAY_TOKEN`,
  `NEHEMIAH_GATEWAY_SECRET`, `NEHEMIAH_DEVICE_CODE_PEPPER`
- `NEHEMIAH_OTEL_AUTHORIZATION`, optionally `GATEWAY_OTEL_AUTHORIZATION`
- `STRIPE_WEBHOOK_SECRET` (optional)

Repository variables: the `PUBLIC_*`, `PRIVATE_NEHEMIAH_URL`, and `STATUS_*`
site settings from [`apps/web/.env.example`](../apps/web/.env.example) (all
optional; in `prod` the control-plane and gateway URLs default to the
hostnames deployed here), and the edge and container settings `SITE_DOMAIN`,
`API_HOSTNAME`, `GATEWAY_HOSTNAME`, `PREVIEW_BASE_DOMAIN` (required),
`PREVIEW_ZONE_NAME`, `HOST_TUNNEL_DOMAIN`, `FLEET_ACCESS_TOKEN_ID`,
`R2_BUCKET`, `NEHEMIAH_SERVICE_VERSION` (required), `NEHEMIAH_OTEL_ENDPOINT`
(required), `NEHEMIAH_DEFAULT_REGION`, `NEHEMIAH_HOST_CIDRS`, `CLERK_ISSUER`
and `CLERK_AUDIENCE` (required), and the optional tuning variables named in
`alchemy.run.ts`.

## Each host behind its own tunnel

On every Latitude host, after the normal provisioning in `infra/latitude`:

1. Compute the label from `NEHEMIAH_ADVERTISE_ADDRESS`: replace `.` with `-`
   (`10.64.0.7` → `10-64-0-7`). The hostname is `<label>.<HOST_TUNNEL_DOMAIN>`
   (default `hosts.<site>`). The control plane and gateway derive the same
   name from the stored address, so there is no table to keep in sync.
2. With a logged-in `cloudflared` (`cloudflared tunnel login`):

   ```sh
   cloudflared tunnel create host-10-64-0-7
   cloudflared tunnel route dns host-10-64-0-7 10-64-0-7.hosts.boringcomputers.com
   ```

3. Install
   [`infra/cloudflare/cloudflared.service`](../infra/cloudflare/cloudflared.service)
   and the matching `config.yml` following the comments at the top of that
   file. The single ingress rule maps the hostname to
   `http://<overlay address>:8080`, `nehemiahd`'s internal API. Requests
   arrive from `cloudflared` on the host itself; nothing new listens publicly,
   and the host firewall keeps rejecting inbound traffic.
4. Add the fleet Access token to `/etc/boring/nehemiahd.env`
   (`NEHEMIAH_CONTROL_PLANE_ACCESS_CLIENT_ID`,
   `NEHEMIAH_CONTROL_PLANE_ACCESS_CLIENT_SECRET`) and point
   `NEHEMIAH_CONTROL_PLANE_URL` at `https://api.<site>`; restart `nehemiahd`.
   Both values are set or neither is; the daemon refuses a lone one.

Check from anywhere on the public internet: `curl -sI https://10-64-0-7.hosts.<site>/healthz`
must return an Access error (302 to the Access login or 403), and the same
request with the services token headers must return the daemon's answer. A
host whose tunnel is down is marked stale by the existing heartbeat logic.

## Machine previews

The control plane and gateway both require `NEHEMIAH_PREVIEW_BASE_DOMAIN` to be
a **different registrable domain** from the site, and the `prod` stage
requires `PREVIEW_BASE_DOMAIN` to be set. Register one, add it as a zone in
the same account, set `PREVIEW_BASE_DOMAIN` (and `PREVIEW_ZONE_NAME` if the
zone is a parent of it), and the deploy creates the proxied wildcard record
and the edge Worker's zone route. A first-level wildcard on its own zone is
covered by Universal SSL; the `<id>--<port>.<domain>` preview names are one
level deep, so that is sufficient.

## R2 credentials

The bucket is created here, but the control plane talks S3. Mint an R2 S3 API
token in the dashboard (R2 → Manage API tokens) scoped to the bucket and set
the control plane's S3 settings from
[`apps/nehemiah/.env.example`](../apps/nehemiah/.env.example). Managed
template transfer and volumes stay disabled until the checks in
[`nehemiah/implementation-status.md`](nehemiah/implementation-status.md) pass.

## Operating the containers

- Rotate the services token by bumping `clientSecretVersion` on
  `ServicesToken` in `alchemy.run.ts` and deploying; both containers receive
  the new value in the same apply. Rotate the fleet token host-side, then
  update `FLEET_ACCESS_TOKEN_ID`.
- Cloudflare guarantees no container instance a particular lifetime. A restart
  drops every TTY/VNC stream the gateway holds; clients reconnect through the
  existing drain logic. The control plane's interval jobs are idempotent and
  resume on the next instance. `sleepAfter` is two hours; host heartbeats keep
  the control plane awake in practice.
- Container egress addresses are not stable; nothing may allowlist them by
  CIDR. Hosts are protected by Access, not by source address.
- Logs and metrics leave through the configured OTel exporter as before.

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
- The edge Worker is type-checked against `@cloudflare/workers-types` and uses
  `@cloudflare/containers` for the Durable Object classes; `npm run check` in
  `apps/web` covers it and the stack file.

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

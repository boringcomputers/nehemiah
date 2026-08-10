---
name: testing-preview
description: Test the preview proxy feature end-to-end. Use when verifying preview URL changes, auth changes on the web proxy route, or networking-related fixes.
---

# Testing the Preview Feature

## Security contract

Managed previews are served by the gateway, never by the dashboard or the host's
legacy public preview route. Each preview is bound to all of:

- the public machine ID;
- the current lease ID;
- one TCP port;
- a short-lived `preview` capability;
- a deterministic, lease-specific hostname below `NEHEMIAH_PREVIEW_BASE_DOMAIN`.

The preview base must be on a different registrable domain from the dashboard
and API. Capability tokens must not appear in query strings. The control plane
returns a URL whose only credential is `#token=...`; fragments are not sent to
the server. Gateway bootstrap JavaScript removes the fragment from browser
history, exchanges it through `POST /v1/capability/exchange`, receives a
host-only `HttpOnly; Secure; SameSite=Strict` cookie, and reloads the clean URL.

The old unauthenticated `/v1/machines/{id}/web/{port}` flow is local/self-hosted
compatibility only. A machine ID is an identifier, not a secret.

## Automated verification

Run the gateway's real HTTP/WebSocket proxy and security tests:

```bash
cd gateway
go test -race -count=1 ./...
go vet ./...
```

The suite must cover fragment bootstrap and cookie exchange, exact host/lease/
port binding, stale and expired leases, query-token rejection, path traversal,
redirect rewriting, SSRF-resistant host routing, credential stripping, response
header stripping, and WebSocket transport.

Run the browser helper tests and production build with the pinned Chromium:

```bash
npx playwright install chromium
npm test -w web
npm run build -w web
```

These tests ensure the dashboard treats the control-plane URL as opaque,
accepts only the expected machine/port path on the isolated wildcard origin,
requires a sole token fragment, and does not reconstruct query credentials.

## Live managed-host verification

Prerequisites:

- a disposable staging host with KVM, Firecracker jailer, cgroup v2 delegation,
  WireGuard, `boring0`, dnsmasq, and managed-mode nehemiahd healthy;
- wildcard DNS and TLS for a dedicated user-content registrable domain;
- a control plane and gateway configured with that same preview base;
- a ready machine with guest networking and an HTTP server listening on the
  requested port.

From an authenticated staging session:

1. Request `POST /v1/machines/{id}/sessions` with
   `{"capabilities":["preview"],"port":8000}`.
2. Confirm the returned URL uses the expected isolated wildcard domain, exact
   `/preview/{id}/8000/` path, no query parameters, and a single `#token=`
   fragment. Confirm the response has `Cache-Control: no-store`.
3. Open the URL in a clean browser context. Confirm the fragment disappears,
   the exchange returns 204 with a host-only HttpOnly cookie, and the preview
   loads after one reload.
4. Verify nested paths, query strings, relative redirects, streaming responses,
   and WebSocket upgrades reach the guest service without leaking the
   capability or host credential.
5. Verify no token, a query token, a wrong port, a sibling preview hostname, an
   expired token, an old lease, and a stopped machine all fail closed.
6. Serve hostile guest headers including `Set-Cookie`,
   `Service-Worker-Allowed`, and `Clear-Site-Data`; confirm the gateway strips
   them and that a preview cannot register a service worker outside its isolated
   origin.

Do not run live provisioning without explicit staging credentials and authority.
Record the machine, lease, host, gateway version, and UTC timestamps for any live
result, then destroy the disposable machine.

## Common failure modes

- **401 before exchange**: missing/invalid/expired capability or a query token.
- **421 origin mismatch**: wildcard DNS/Host does not match the lease-derived
  hostname in the capability.
- **401 stale capability**: route lookup returned a different current lease.
- **404 route not found**: machine stopped/expired or its host heartbeat is stale.
- **502 route lookup/host failure**: gateway cannot reach the control plane or
  the pinned private host address.
- **Guest connection failure**: guest networking is unavailable or the service
  is not listening on `0.0.0.0` inside the guest.

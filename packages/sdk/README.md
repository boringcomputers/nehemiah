# nehemiah-sdk

An [Effect](https://effect.website)-native TypeScript client with one machine
contract for Boring Computers Cloud, local `nehemiahd`, and self-hosted
endpoints. HTTP responses are schema checked, errors are tagged, and TTY/VNC
sockets are scoped streams.

## Install

```sh
npm install nehemiah-sdk@beta
```

## Cloud

Cloud mode defaults to `https://api.boringcomputers.com`:

```ts
import { Effect } from 'effect';
import { make } from 'nehemiah-sdk';

const computers = make({
	target: 'cloud',
	apiKey: process.env.NEHEMIAH_API_KEY,
	project: process.env.NEHEMIAH_PROJECT,
	region: 'ca-tor-1'
});

const program = Effect.gen(function* () {
	const machine = yield* computers.createMachine({
		template: 'desktop',
		size: 'small',
		// Generated automatically when omitted. Reuse your own key when retrying
		// the same logical operation from another process.
		idempotencyKey: 'job-123-create'
	});

	const result = yield* computers.exec(machine.id, 'uname -a');
	const preview = yield* computers.getPreviewUrl(machine.id, 3000);
	console.log(result.stdout ?? result.output, preview);

	yield* computers.destroyMachine(machine.id);
});

Effect.runPromise(program);
```

Create accepts `project`, `region`, `architecture`, `size`, explicit
`resources`, a built-in `template` name, a published `templateId`,
`networkPolicy`, `ttlSeconds`, and `idempotencyKey`. In Cloud mode the policy
may be omitted or set only to `{ mode: 'off' }`; non-off policies fail locally
with `NotSupported` while aggregate network quotas are unavailable. Managed `ociReference`
imports are deliberately `NotSupported` before any HTTP request or persistence;
local/self-hosted machine behavior is unchanged. Network policies are
canonicalized into the create idempotency identity and default to `off`.
`listMachinesPage({ cursor, limit, project })` returns `nextCursor` plus request
and rate-limit metadata.

Managed custom-template publication is deliberately disabled in production until
aggregate tenant and host-cache quotas plus durable object/replica eviction are
enforced. `publishTemplate` fails locally with typed `NotSupported` and sends no
request. Built-in templates remain supported; existing managed template records
can be listed and selected by `templateId` only in environments where an operator
has provisioned them through a reviewed process.

The SDK retries transient failures only for safe operations: reads, idempotent
deletes, capability issuance, and managed-cloud mutations backed by durable
idempotency replay. `exec` is never retried. Public local/self-hosted
create/extend/branch/volume-allocation routes do not implement that replay, so
the SDK makes exactly one attempt and rejects an explicit `idempotencyKey` with
typed `NotSupported`. The defaults are a 30-second per-attempt timeout and two
retries; use `timeoutMs`, `maxRetries`, and `retryDelayMs` to tune safe calls.

API failures are `ResponseError`s with parsed `problem` details (RFC 9457-style),
request ID, rate-limit values, and the original response body. `RequestError`
means no valid response arrived. A valid operation missing from the selected
target is `NotSupported`; cloud fork translates an explicit `501` or
`not_supported` problem signal, while an ordinary missing/cross-tenant machine
`404` remains a `ResponseError`. The legacy local `/branch` route keeps working.

An accepted managed fork that is not terminal fails the Effect with
`ForkPending` instead of returning hidden children as if they were ready. Its
`operation` includes the durable operation ID, source, count, state, and exact
`idempotencyKey`; retry `branchMachine` or `branchMachines` with that key to
recover the terminal result safely.

## Local and self-hosted compatibility

The no-options form stays local for backward compatibility:

```ts
const local = make(); // target: local, http://localhost:8080
const remoteHost = make({
	target: 'self-hosted',
	baseUrl: 'https://machines.example.com',
	token: process.env.NEHEMIAH_TOKEN // legacy alias for apiKey
});
```

The original methods remain available: `createMachine`, `listMachines`,
`getMachine`, `exec`, `extendMachine`, `destroyMachine`, `branchMachine`,
`branchMachines`, local template operations, and local volume operations. Managed
volume methods fail locally with typed `NotSupported`: production keeps the broker
disabled until durable volume/revision-count quotas and global transfer admission
exist. Cloud-only options
on a local target and other unsupported operations return typed `NotSupported`
errors rather than changing semantics silently. The dormant, non-production
[managed volume broker contract](../../docs/nehemiah/volumes.md) documents the
prerequisites for a future reviewed enablement.

## TTY, VNC, and previews

Cloud streams first issue a short-lived, machine- and capability-bound gateway
session. Long-lived API keys are never put in gateway URLs. A reconnect issues a
fresh capability:

```ts
import { Effect, Stream } from 'effect';

yield *
	Effect.scoped(
		Effect.gen(function* () {
			const tty = yield* computers.connectTty(machine.id);
			yield* tty.send('echo ready\n');
			// Call `yield* tty.reconnect` after a dropped connection.
			yield* tty.output.pipe(
				Stream.runForEach((bytes) => Effect.sync(() => process.stdout.write(bytes)))
			);
		})
	);
```

`connectVnc` exposes the same byte-channel interface. `createSession` is also
available for file integrations; its token is secret and short lived. The
host-local `agent` capability is local/self-hosted only: cloud clients receive
`NotSupported` before transport and should run an agent inside the guest through
exec, TTY, and file primitives.
Managed socket URLs are derived only from a bare HTTPS gateway origin and have
no query or fragment. The capability travels in the
`nehemiah.capability.` WebSocket subprotocol, never in the URL.

Each TTY/VNC channel retains at most 4 MiB and 256 unread frames. A consumer
that stops draining past either bound gets a terminal, typed
`ChannelBacklogExceeded` from `output`, `send`, and `reconnect`; the SDK closes
the socket and releases retained frames. Ordinary peer disconnects keep their
existing behavior: drain `output` through its end, then call `reconnect` to
obtain a fresh capability.

## Bounded cloud file transfer

`uploadFile` and `downloadFile` issue a fresh short-lived `files` session and
then call the returned HTTPS gateway origin. The capability is sent only as a
Bearer `Authorization` header: it is never placed in a query string, redirect,
cookie, or referrer. Redirects and non-HTTPS/malformed gateway origins fail
closed.

```ts
const uploaded =
	yield *
	computers.uploadFile(machine.id, 'input.txt', new TextEncoder().encode('hello'), {
		maximumBytes: 1 << 20,
		timeoutMs: 30_000
	});

const downloaded =
	yield *
	computers.downloadFile(machine.id, '/root/output.txt', {
		maximumBytes: 1 << 20,
		timeoutMs: 30_000
	});
```

Uploads use the server's real contract: a safe filename is stored as
`/root/<name>`; arbitrary upload destinations are not implied. Downloads require
one canonical absolute guest path. Both directions are capped at 16 MiB, have a
maximum 15-minute client timeout, and abort at the capability expiry. Download
bodies are read incrementally and rejected as soon as the declared or observed
size exceeds `maximumBytes`.

For dependency injection, use `layer(options)` and the `NehemiahClient` tag.

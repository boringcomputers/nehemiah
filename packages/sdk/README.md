# nehemiah-sdk

An [Effect](https://effect.website)-native TypeScript client for the **Nehemiah**
Firecracker microVM API (`nehemiahd`). REST calls go through
`@effect/platform`'s `HttpClient` and validate responses with `Schema`; every
call is an `Effect` with typed errors; the serial console is a `Stream` with
`Scope`-based teardown.

## Install

```sh
npm install nehemiah-sdk
```

(Or from the monorepo: `npm install` at the root, then
`npm run build -w nehemiah-sdk` → `dist/`.)

## Usage

```ts
import { Effect, Stream } from 'effect';
import { make } from 'nehemiah-sdk';

const nehemiah = make({ baseUrl: 'http://localhost:8080' });

const program = Effect.gen(function* () {
	const vm = yield* nehemiah.createMachine({ template: 'python', ttlSeconds: 300 });

	// Typed errors — no throws. Catch by tag:
	const found = yield* nehemiah
		.getMachine(vm.id)
		.pipe(Effect.catchTag('ResponseError', (e) => Effect.succeed(`http ${e.status}`)));

	// The serial console is a Stream; the socket closes with the Scope.
	yield* Effect.scoped(
		Effect.gen(function* () {
			const tty = yield* nehemiah.connectTty(vm.id);
			yield* tty.send("python3 -c 'print(2 + 2)'\n");
			yield* tty.output.pipe(
				Stream.runForEach((bytes) => Effect.sync(() => process.stdout.write(bytes)))
			);
		})
	);

	yield* nehemiah.destroyMachine(vm.id);
});

Effect.runPromise(program);
```

Prefer dependency injection? Use `layer({ baseUrl })` and the `NehemiahClient` tag
(`yield* NehemiahClient`).

### API

- `make({ baseUrl?, token? }): NehemiahClient` — build a client
- `layer({ baseUrl?, token? })` + `NehemiahClient` tag — the same, as a `Layer`
- `createMachine(opts?: { template?, ttlSeconds?, net? }): Effect<Machine, NehemiahError>`
  — retries transient failures internally
- `exec(id, command, { timeoutSeconds? }): Effect<ExecResult, NehemiahError>` —
  run one command, get `{ output, exit_code, timed_out, duration_ms }`
- `extendMachine(id, ttlSeconds?): Effect<Machine, NehemiahError>` — reset the TTL
- `branchMachines(id, count): Effect<Machine[], NehemiahError>` — fleet fork: N
  live clones from one snapshot (each carries `parent`)
- `publishMachine(id, name): Effect<Template, NehemiahError>` — freeze a machine
  as a named template; boot it later with `createMachine({ template: name })`
- `listTemplates: Effect<Template[], NehemiahError>` / `deleteTemplate(name)`
- `listMachines: Effect<Machine[], NehemiahError>`
- `getMachine(id) / branchMachine(id): Effect<Machine, NehemiahError>`
- `destroyMachine(id): Effect<void, NehemiahError>`
- `connectTty(id): Effect<TtyChannel, RequestError, Scope>` — `{ output: Stream, send }`

Errors are tagged: `RequestError` (transport) and `ResponseError` (`{ status, body }`).

## Demo

`demo.mjs` boots a `python` VM and drops you into a live shell (destroyed on exit).
Build first, then:

```sh
NEHEMIAH_URL=http://localhost:8080 node demo.mjs   # Ctrl-] to quit
```

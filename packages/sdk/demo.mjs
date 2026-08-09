#!/usr/bin/env node
// Interactive demo for nehemiah-sdk (Effect).
//
//   NEHEMIAH_URL=http://localhost:8080 node demo.mjs
//
// Boots a `python` microVM (destroyed automatically on exit via acquireRelease)
// and drops you into its live serial shell. Press Ctrl-] to quit.

import { Console, Effect, Stream } from 'effect';
import { make } from './dist/index.js';

const nehemiah = make({
	baseUrl: process.env.NEHEMIAH_URL ?? process.env.BORING_URL ?? 'http://localhost:8080',
	token: process.env.NEHEMIAH_TOKEN || process.env.BORING_TOKEN || undefined
});

const program = Effect.gen(function* () {
	// The machine is torn down when this scope closes, whatever the exit path.
	const machine = yield* Effect.acquireRelease(
		nehemiah.createMachine({ template: 'python', ttlSeconds: 300 }),
		(m) => nehemiah.destroyMachine(m.id).pipe(Effect.ignore)
	);
	yield* Console.log(
		`[nehemiah] ${machine.id} ready (mode=${machine.mode}, boot_ms=${machine.boot_ms}) — Ctrl-] to quit\n`
	);

	const tty = yield* nehemiah.connectTty(machine.id);

	// Stream the guest's serial output to our stdout, in the background.
	yield* tty.output.pipe(
		Stream.runForEach((bytes) => Effect.sync(() => process.stdout.write(bytes))),
		Effect.forkScoped
	);

	// Forward our stdin to the guest until Ctrl-] (byte 0x1d).
	yield* Effect.async((resume) => {
		const stdin = process.stdin;
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', (chunk) => {
			if (chunk.length === 1 && chunk[0] === 0x1d) return resume(Effect.void);
			Effect.runSync(tty.send(new Uint8Array(chunk)));
		});
	});
});

Effect.runPromise(Effect.scoped(program))
	.catch((e) => console.error('[nehemiah] error:', e?.message ?? e))
	.finally(() => process.exit(0));

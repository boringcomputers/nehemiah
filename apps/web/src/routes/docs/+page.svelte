<script lang="ts">
	import { resolve } from '$app/paths';
	const API = 'http://localhost:8080';
</script>

<svelte:head>
	<title>Docs · Nehemiah</title>
	<meta
		name="description"
		content="Boot a Firecracker microVM in milliseconds over a plain REST + WebSocket API."
	/>
</svelte:head>

{#snippet code(text: string)}
	<pre
		class="overflow-x-auto rounded-geist border border-line bg-surface p-4 font-mono text-[12px] leading-relaxed text-ink-muted"><code
			>{text}</code
		></pre>
{/snippet}

<div class="mx-auto max-w-2xl px-5 pt-24 pb-24">
	<h1 class="text-[28px] font-semibold tracking-[-0.03em] text-ink">Docs</h1>
	<p class="mt-3 leading-relaxed text-ink-muted">
		A computer is one HTTP call away. <span class="text-ink">nehemiahd</span> boots a Firecracker
		microVM — jailed, resource-capped, network-isolated — and hands you a serial console, a VNC
		display, or an AI that drives it. Snapshot-restore means a shell is ready in
		<span class="text-ink">~3&nbsp;ms</span>. Machines self-destruct when their TTL expires — or
		pass <code class="text-ink">"persistent": true</code> to keep one running until you delete it.
	</p>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">Base URL</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		Run your own <span class="text-ink">nehemiahd</span> (see the
		<a
			href="https://github.com/boringcomputers/nehemiah"
			class="text-accent hover:underline">repo</a
		>) and point everything at your deployment. It listens on this by default:
	</p>
	<div class="mt-3">{@render code(API)}</div>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">Quickstart</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">Boot a machine and read it back:</p>
	<div class="mt-3">
		{@render code(`# boot a shell (python3 + node), 60s TTL
curl -s -X POST ${API}/v1/machines \\
  -H 'content-type: application/json' \\
  -d '{"template":"python","ttl_seconds":60}'

# → {"id":"m-1a2b3c4d","mode":"snapshot","boot_ms":3,
#    "template":"python","expires_at":"..."}`)}
	</div>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">REST</h2>
	<div class="mt-3 overflow-x-auto rounded-geist border border-line">
		<table class="w-full border-collapse font-mono text-[12px]">
			<tbody class="text-ink-muted">
				{#each [['POST', '/v1/machines', 'Boot a machine. Body: {template, ttl_seconds, net}'], ['GET', '/v1/machines', 'List running machines'], ['GET', '/v1/machines/{id}', 'Fetch one machine'], ['DELETE', '/v1/machines/{id}', 'Destroy a machine now'], ['POST', '/v1/machines/{id}/exec', 'Run one command → {output, exit_code}. Body: {command, timeout_seconds}'], ['POST', '/v1/machines/{id}/extend', "Reset a machine's TTL. Body: {ttl_seconds}"], ['POST', '/v1/machines/{id}/branch', 'Fork a running machine into a live clone. ?count=N → N clones from one snapshot'], ['POST', '/v1/machines/{id}/publish', 'Freeze the machine as a named template. Body: {name} — then launch {template: name}'], ['GET', '/v1/templates', 'List templates (built-ins + published)'], ['DELETE', '/v1/templates/{name}', 'Delete a published template'], ['GET', '/v1/machines/{id}/screenshot', 'PNG screenshot of a desktop'], ['POST', '/v1/machines/{id}/upload', 'Upload a file to /root (X-Filename header)'], ['GET', '/v1/machines/{id}/download?path=…', 'Download a file from the machine'], ['GET', '/healthz', 'Liveness + running count']] as row (row[1] + row[0])}
					<tr class="border-b border-line last:border-0">
						<td class="w-16 px-3 py-2 align-top text-accent">{row[0]}</td>
						<td class="px-3 py-2 align-top whitespace-nowrap text-ink">{row[1]}</td>
						<td class="px-3 py-2 align-top text-ink-faint">{row[2]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="mt-3 text-[13px] leading-relaxed text-ink-muted">
		Templates: <span class="text-ink">python</span> (headless shell, snapshot, ~3&nbsp;ms) and
		<span class="text-ink">desktop</span> (GUI over VNC). <code class="text-ink">ttl_seconds</code>
		is clamped to 15–900. Pass <code class="text-ink">"net": true</code> to give the machine
		internet (cold-boots instead of snapshot; <code class="text-ink">pip</code>/<code
			class="text-ink">npm</code
		>/<code class="text-ink">apk</code> install work). Guests are NAT'd and egress-firewalled. File
		transfer and previews (below) need a connected machine — a desktop, or a shell with
		<code class="text-ink">net</code>. Pass <code class="text-ink">"persistent": true</code> for a
		machine with no TTL (runs until you delete it) — honored only when the server sets
		<code class="text-ink">NEHEMIAH_ALLOW_PERSISTENT=1</code>, else it falls back to the TTL.
	</p>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">WebSockets</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		Interactive channels upgrade to WebSocket (binary frames):
	</p>
	<div class="mt-3 overflow-x-auto rounded-geist border border-line">
		<table class="w-full border-collapse font-mono text-[12px]">
			<tbody class="text-ink-muted">
				{#each [['/v1/machines/{id}/tty', 'Serial console — bytes ⇄ the guest /dev/ttyS0'], ['/v1/machines/{id}/vnc', 'RFB/VNC framebuffer for desktop machines'], ['/v1/machines/{id}/agent?goal=…', 'Computer-use agent — drives the screen; streams narration JSON'], ['/v1/machines/{id}/shell-agent?goal=…', 'Terminal agent — writes + runs code; streams narration JSON']] as row (row[0])}
					<tr class="border-b border-line last:border-0">
						<td class="px-3 py-2 align-top whitespace-nowrap text-ink">{row[0]}</td>
						<td class="px-3 py-2 align-top text-ink-faint">{row[1]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">Previews</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		Run a server inside a connected machine and open its port through nehemiahd — works locally (over
		a tunnel) and on public deployments, no wildcard DNS:
	</p>
	<div class="mt-3">
		{@render code(`${API}/v1/machines/<machine-id>/web/<port>/`)}
	</div>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">Inference</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		An OpenAI-compatible gateway — Claude runs on Anthropic, everything else routes through
		OpenRouter (set your own <code class="text-ink">NEHEMIAH_OPENROUTER_KEY</code>).
	</p>
	<div class="mt-3 overflow-x-auto rounded-geist border border-line">
		<table class="w-full border-collapse font-mono text-[12px]">
			<tbody class="text-ink-muted">
				{#each [['POST', '/v1/chat/completions', 'Chat completions (streaming + non-streaming)'], ['GET', '/v1/models', 'List available models']] as row (row[1])}
					<tr class="border-b border-line last:border-0">
						<td class="w-16 px-3 py-2 align-top text-accent">{row[0]}</td>
						<td class="px-3 py-2 align-top whitespace-nowrap text-ink">{row[1]}</td>
						<td class="px-3 py-2 align-top text-ink-faint">{row[2]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="mt-3">
		{@render code(`curl -s ${API}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'`)}
	</div>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">Storage</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		Persistent volumes (S3-backed) that outlive a machine. Create one, <code class="text-ink"
			>save</code
		>
		a machine's /root into it, then restore it into a fresh machine by passing its id as
		<code class="text-ink">volume</code> on launch. Volumes are addressed by an unguessable id and garbage-collected
		on a TTL.
	</p>
	<div class="mt-3 overflow-x-auto rounded-geist border border-line">
		<table class="w-full border-collapse font-mono text-[12px]">
			<tbody class="text-ink-muted">
				{#each [['POST', '/v1/volumes', 'Create a volume. Body: {ttl_seconds}'], ['GET', '/v1/volumes/{id}', 'Metadata + usage'], ['DELETE', '/v1/volumes/{id}', 'Delete a volume'], ['GET', '/v1/volumes/{id}/files', 'List files'], ['PUT', '/v1/volumes/{id}/file?path=…', 'Upload a file'], ['GET', '/v1/volumes/{id}/file?path=…', 'Download a file'], ['POST', '/v1/machines/{id}/save?volume=…', "Save a machine's /root into a volume"]] as row (row[1] + row[0])}
					<tr class="border-b border-line last:border-0">
						<td class="w-16 px-3 py-2 align-top text-accent">{row[0]}</td>
						<td class="px-3 py-2 align-top whitespace-nowrap text-ink">{row[1]}</td>
						<td class="px-3 py-2 align-top text-ink-faint">{row[2]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="mt-3 text-[13px] leading-relaxed text-ink-muted">
		Attach on launch: <code class="text-ink">POST /v1/machines</code> with
		<code class="text-ink">{'{"volume":"vol-…"}'}</code> restores the volume into /root first.
	</p>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">TypeScript client</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		An <a
			href="https://effect.website"
			target="_blank"
			rel="noopener"
			class="text-accent hover:underline">Effect</a
		>-native client lives in the repo at <code class="text-ink">packages/sdk</code> (not on npm) — Schema-validated
		responses, typed errors, a streaming serial console, retries built in:
	</p>
	<div class="mt-3">
		{@render code(`import { Effect, Stream } from 'effect';
import { make } from 'nehemiah-sdk';

const nehemiah = make({ baseUrl: '${API}' });

Effect.runPromise(
  Effect.gen(function* () {
    const vm = yield* nehemiah.createMachine({ template: 'python', ttlSeconds: 60 });
    console.log(vm.id, vm.mode, \`\${vm.boot_ms}ms\`);

    // the serial console is a Stream; the socket closes with the Scope
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tty = yield* nehemiah.connectTty(vm.id);
        yield* tty.send('print("hello from a microVM")\\n');
        yield* tty.output.pipe(Stream.runForEach((b) => Effect.sync(() => process.stdout.write(b))));
      })
    );

    yield* nehemiah.destroyMachine(vm.id);
  })
);`)}
	</div>
	<p class="mt-3 text-[13px] leading-relaxed text-ink-muted">
		Also: <code class="text-ink">listMachines</code>,
		<code class="text-ink">getMachine(id)</code>,
		<code class="text-ink">branchMachine(id)</code>. Errors are tagged (<code class="text-ink"
			>RequestError</code
		>, <code class="text-ink">ResponseError</code>).
	</p>

	<h2 class="mt-12 text-[15px] font-semibold text-ink">MCP server</h2>
	<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
		Let any AI — Claude Desktop, Cursor, … — spin up and drive a computer over the
		<a
			href="https://modelcontextprotocol.io"
			target="_blank"
			rel="noopener"
			class="text-accent hover:underline">Model Context Protocol</a
		>. It lives in the repo at <code class="text-ink">packages/mcp</code> (not on npm yet); run it from
		source and point your MCP client at it:
	</p>
	<div class="mt-3">
		{@render code(`{
  "mcpServers": {
    "nehemiah": { "command": "node", "args": ["/path/to/packages/mcp/index.mjs"] }
  }
}`)}
	</div>
	<p class="mt-3 text-[13px] leading-relaxed text-ink-muted">
		Tools: <code class="text-ink">launch_computer</code>,
		<code class="text-ink">run_task</code> (plain-English task → an agent writes + runs the code,
		returns a live URL), <code class="text-ink">screenshot</code>,
		<code class="text-ink">preview_url</code>, <code class="text-ink">fork_computer</code>,
		<code class="text-ink">stop_computer</code>.
	</p>

	<div class="mt-16 border-t border-line pt-6">
		<a
			href={resolve('/')}
			class="font-mono text-[12px] text-ink-subtle transition-colors hover:text-ink"
			>← back to Nehemiah</a
		>
	</div>
</div>

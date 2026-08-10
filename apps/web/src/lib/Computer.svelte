<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { onMount } from 'svelte';
	import { apiBase, createMachine, getMachine, type Machine } from '$lib/boring';
	import { createCountdown } from '$lib/countdown';
	import { copyMachineUrl } from '$lib/clipboard';
	import { setupTerminal, type TerminalHandle } from '$lib/terminal';
	import { connectAgent } from '$lib/agent-ws';

	type Phase = 'idle' | 'booting' | 'live' | 'closed' | 'error';

	let {
		onClose,
		ttl = 60,
		machineId,
		net = false
	}: { onClose?: () => void; ttl?: number; machineId?: string; net?: boolean } = $props();

	let phase = $state<Phase>('idle');
	let machine = $state<Machine | null>(null);
	let error = $state('');
	let remaining = $state(0);
	let shared = $state(false);
	let copied = $state(false);

	// AI command box: an agent that types commands into this shell to reach a goal.
	let agentGoal = $state('');
	let agentRunning = $state(false);
	let agentLine = $state('');

	let host = $state<HTMLDivElement>();
	let termHandle: TerminalHandle | null = null;
	let agentWs: WebSocket | null = null;

	const timer = createCountdown(
		() => ttl,
		(r) => (remaining = r)
	);

	// The component only mounts once the user has asked for a computer, so boot
	// immediately (bind:this on the parent isn't populated until after mount).
	onMount(() => {
		void launch();
	});

	export async function launch() {
		if (phase === 'booting' || phase === 'live') return;
		phase = 'booting';
		error = '';
		try {
			machine = machineId ? await getMachine(machineId) : await createMachine('python', ttl, net);
			termHandle = await setupTerminal({
				host: host!,
				machineId: machine!.id,
				bannerText: `\x1b[38;5;244mboring computers · ephemeral microVM · python3 + node ${net ? '· internet' : 'ready'}\x1b[0m\r\n`,
				onClose: () => {
					if (phase === 'live') {
						termHandle?.term?.write('\r\n\x1b[38;5;244m— computer stopped —\x1b[0m\r\n');
						phase = 'closed';
						timer.stop();
					}
				}
			});
			phase = 'live';
			timer.start(machine);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			phase = 'error';
		}
	}

	async function copyShare() {
		if (!machine) return;
		const ok = await copyMachineUrl(machine.id);
		if (ok) {
			shared = true;
			copied = true;
			setTimeout(() => (copied = false), 1600);
		}
	}

	function runAI() {
		const goal = agentGoal.trim();
		if (!goal || agentRunning || !machine) return;
		agentRunning = true;
		agentLine = 'thinking…';
		agentWs = connectAgent(
			machine.id,
			`/v1/machines/${machine.id}/shell-agent?goal=${encodeURIComponent(goal)}`,
			{
				onDone: (text) => {
					agentLine = text || 'done ✓';
					agentRunning = false;
				},
				onError: (text) => {
					agentLine = '⚠ ' + text;
					agentRunning = false;
				},
				onSay: (text) => (agentLine = text),
				onAction: (text) => (agentLine = text),
				onClose: () => (agentRunning = false)
			}
		);
	}

	function aiKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			runAI();
		}
	}

	export function close() {
		timer.stop();
		try {
			agentWs?.close();
		} catch {
			/* ignore */
		}
		agentWs = null;
		// Don't tear down a shared machine, or one we merely reconnected to — let it
		// live its TTL for whoever else has the link.
		if (machine && !shared && !machineId) {
			void fetch(`${apiBase}/v1/machines/${machine.id}`, { method: 'DELETE' }).catch(() => {});
		}
		termHandle?.cleanup();
		termHandle = null;
		machine = null;
		phase = 'idle';
		error = '';
		onClose?.();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && phase !== 'idle') close();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if phase !== 'idle'}
	<div class="w-full max-w-3xl">
		<!-- status bar -->
		<div
			class="flex items-center justify-between rounded-t-geist-lg border border-line bg-surface px-4 py-2.5 font-mono text-[12px]"
		>
			<div class="flex items-center gap-2 text-ink-muted">
				{#if phase === 'booting'}
					<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>booting a computer…
				{:else if phase === 'live' && machine}
					<span class="size-1.5 rounded-full bg-success"></span>
					<span class="text-ink">{machine.id}</span>
					<span class="text-ink-faint">·</span>
					booted in {machine.boot_ms}ms
					<span class="text-ink-faint">·</span>
					{machine.mode}
				{:else if phase === 'closed'}
					<span class="size-1.5 rounded-full bg-ink-faint"></span>computer stopped
				{:else if phase === 'error'}
					<span class="size-1.5 rounded-full bg-danger"></span>
					<span class="text-danger">{error}</span>
				{/if}
			</div>
			<div class="flex items-center gap-3 text-ink-faint">
				{#if phase === 'live'}
					<button
						class="text-ink-subtle transition-colors hover:text-ink"
						onclick={copyShare}
						title="Copy a link to this computer">{copied ? 'link copied ✓' : 'share'}</button
					>
					<span>self-destructs in {remaining}s</span>
				{/if}
				<button class="text-ink-subtle transition-colors hover:text-ink" onclick={close}>
					esc ✕
				</button>
			</div>
		</div>
		<!-- terminal -->
		<div
			class="border-x border-line bg-[#0a0a0a] p-3"
			class:hidden={phase === 'error'}
			class:rounded-b-geist-lg={phase !== 'live'}
			class:border-b={phase !== 'live'}
		>
			<div bind:this={host} class="h-[420px] w-full"></div>
		</div>

		<!-- AI command box: tell the computer what to do, it drives the terminal -->
		{#if phase === 'live'}
			<div class="rounded-b-geist-lg border border-t-0 border-line bg-surface px-3 py-2.5">
				<div class="flex items-center gap-2">
					<span class="font-mono text-[11px] font-semibold text-accent">AI</span>
					<input
						bind:value={agentGoal}
						onkeydown={aiKey}
						disabled={agentRunning}
						placeholder="tell the computer what to do — e.g. “build a snake game in python and run it”"
						class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-60"
					/>
					<button
						onclick={runAI}
						disabled={agentRunning || !agentGoal.trim()}
						class="rounded-geist bg-ink px-2.5 py-1 font-mono text-[11px] text-black transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						{agentRunning ? 'working…' : 'run'}
					</button>
				</div>
				{#if agentLine}
					<p class="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
						{#if agentRunning}<span class="size-1.5 animate-pulse rounded-full bg-accent"
							></span>{/if}
						<span class="truncate">{agentLine}</span>
					</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}

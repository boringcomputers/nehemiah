<script lang="ts">
	import { onMount } from 'svelte';
	import { apiBase, createMachine, type Machine } from '$lib/boring';
	import { connectVnc, type VncHandle } from '$lib/vnc';
	import { connectAgent } from '$lib/agent-ws';

	type Phase = 'compose' | 'booting' | 'connecting' | 'live' | 'done' | 'error';

	let { onClose }: { onClose?: () => void } = $props();

	// Short, friendly prompts the visitor can click to fill the box. The desktop
	// is minimal (terminal + calculator + clock), so these steer toward things it
	// can actually do — but the box is free-form; the AI does its best with anything.
	const SUGGESTIONS = [
		'Open the calculator and compute 47 × 89',
		'Print a big ASCII "BORING" banner in the terminal',
		'Add 1234 and 5678 on the calculator, then read the answer',
		'In the terminal, show today’s date and a cheerful message',
		'Use the calculator to work out 256 ÷ 8'
	];

	const TTL = 240;
	const MAX_ATTEMPTS = 10;

	let phase = $state<Phase>('compose');
	let goal = $state(SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)]);
	let activeGoal = $state('');
	let machine = $state<Machine | null>(null);
	let error = $state('');
	let caption = $state('');
	let inputEl = $state<HTMLTextAreaElement>();

	let screen = $state<HTMLDivElement>();
	let vncHandle: VncHandle | null = null;
	let ws: WebSocket | null = null;
	let attempts = 0;
	let disposed = false;
	let agentStarted = false;

	onMount(() => {
		inputEl?.focus();
		return () => close();
	});

	function run() {
		const g = goal.trim();
		if (!g || phase !== 'compose') return;
		activeGoal = g;
		caption = 'Booting a computer for the AI…';
		void launch();
	}

	async function launch() {
		phase = 'booting';
		error = '';
		try {
			machine = await createMachine('desktop', TTL);
			phase = 'connecting';
			caption = 'Starting the display…';
			// Let X paint before noVNC's first full frame; the agent starts on connect.
			setTimeout(doConnectVNC, 4500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			phase = 'error';
		}
	}

	async function doConnectVNC() {
		if (disposed || !machine || !screen) return;
		attempts += 1;
		try {
			vncHandle = await connectVnc(
				{
					screen,
					machineId: machine.id,
					viewOnly: true,
					onConnect: () => {
						if (!disposed) setTimeout(startAgent, 2500);
					},
					onDisconnect: () => {
						if (!agentStarted && attempts < MAX_ATTEMPTS) setTimeout(doConnectVNC, 1500);
					}
				},
				() => disposed
			);
		} catch {
			if (attempts < MAX_ATTEMPTS) setTimeout(doConnectVNC, 1500);
		}
	}

	function startAgent() {
		if (agentStarted || disposed || !machine) return;
		agentStarted = true;
		phase = 'live';
		caption = 'The AI is looking at the screen…';
		ws = connectAgent(machine.id, `/v1/machines/${machine.id}/agent`, activeGoal, {
			onSay: (text) => (caption = text),
			onDone: (text) => {
				phase = 'done';
				caption = text || 'The AI finished the task.';
			},
			onError: (text) => {
				phase = 'error';
				error = text || 'the agent stopped unexpectedly';
			},
			onClose: () => {
				if (phase === 'live') {
					phase = 'done';
					caption = 'The AI finished.';
				}
			}
		});
	}

	export function close() {
		disposed = true;
		try {
			ws?.close();
		} catch {
			/* ignore */
		}
		ws = null;
		vncHandle?.teardown();
		vncHandle = null;
		if (machine) {
			void fetch(`${apiBase}/v1/machines/${machine.id}`, { method: 'DELETE' }).catch(() => {});
		}
		machine = null;
		onClose?.();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			run();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="w-full max-w-3xl">
	{#if phase === 'compose'}
		<!-- Compose: tell the AI what to do -->
		<div class="rounded-geist-lg border border-line bg-surface p-4">
			<div class="mb-2 flex items-center gap-2 font-mono text-[12px] text-ink-muted">
				<span class="text-accent">✦</span> Tell the AI what to do on the computer
			</div>
			<textarea
				bind:this={inputEl}
				bind:value={goal}
				onkeydown={onInputKey}
				rows="2"
				maxlength="220"
				placeholder="e.g. open the calculator and compute 128 × 64"
				class="w-full resize-none rounded-geist border border-line bg-black px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-white/25 focus:outline-none"
			></textarea>
			<div class="mt-3 flex flex-wrap gap-1.5">
				{#each SUGGESTIONS as s (s)}
					<button
						onclick={() => (goal = s)}
						class="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-ink-subtle transition-colors hover:border-white/25 hover:text-ink"
					>
						{s}
					</button>
				{/each}
			</div>
			<div class="mt-3 flex items-center justify-between">
				<span class="font-mono text-[11px] text-ink-faint"
					>this computer has a terminal, a calculator, and a clock</span
				>
				<button
					onclick={run}
					disabled={!goal.trim()}
					class="rounded-geist bg-ink px-3 py-1.5 font-mono text-[12px] text-black transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					Run it →
				</button>
			</div>
		</div>
	{:else}
		<!-- Live: view-only desktop + caption -->
		<div
			class="flex items-center justify-between rounded-t-geist-lg border border-line bg-surface px-4 py-2.5 font-mono text-[12px]"
		>
			<div class="flex items-center gap-2 text-ink-muted">
				{#if phase === 'booting' || phase === 'connecting'}
					<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>preparing a
					computer…
				{:else if phase === 'live'}
					<span class="size-1.5 animate-pulse rounded-full bg-accent"></span>
					<span class="text-ink">an AI is using this computer</span>
				{:else if phase === 'done'}
					<span class="size-1.5 rounded-full bg-success"></span>finished
				{:else if phase === 'error'}
					<span class="size-1.5 rounded-full bg-danger"></span>
					<span class="text-danger">{error}</span>
				{/if}
			</div>
			<button class="text-ink-subtle transition-colors hover:text-ink" onclick={close}>esc ✕</button
			>
		</div>
		<div
			class="relative overflow-hidden border-x border-line bg-black"
			class:hidden={phase === 'error'}
		>
			<div bind:this={screen} class="aspect-[16/10] w-full"></div>
			{#if phase !== 'live' && phase !== 'done'}
				<div
					class="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[12px] text-ink-subtle"
				>
					allocating a computer…
				</div>
			{/if}
		</div>
		<div
			class="flex items-start gap-2.5 rounded-b-geist-lg border border-t-0 border-line bg-surface px-4 py-3 font-mono text-[12px]"
			class:hidden={phase === 'error'}
		>
			<span class="mt-px shrink-0 text-accent">✦</span>
			<div class="min-w-0 leading-relaxed">
				<div class="truncate text-ink-faint">task: {activeGoal}</div>
				<div class="text-ink-muted">{caption}</div>
			</div>
		</div>
	{/if}
</div>

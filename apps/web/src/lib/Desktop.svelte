<script lang="ts">
	import { onMount } from 'svelte';
	import { apiBase, createMachine, getMachine, type Machine } from '$lib/boring';
	import { createCountdown } from '$lib/countdown';
	import { copyMachineUrl } from '$lib/clipboard';
	import { connectVnc, type VncHandle } from '$lib/vnc';

	type Phase = 'idle' | 'booting' | 'connecting' | 'live' | 'closed' | 'error';

	let {
		onClose,
		ttl = 180,
		machineId
	}: { onClose?: () => void; ttl?: number; machineId?: string } = $props();

	let phase = $state<Phase>('idle');
	let machine = $state<Machine | null>(null);
	let error = $state('');
	let remaining = $state(0);
	let shared = $state(false);
	let copied = $state(false);

	let screen: HTMLDivElement;
	let vncHandle: VncHandle | null = null;
	let attempts = 0;
	let disposed = false;

	const MAX_ATTEMPTS = 10;
	const timer = createCountdown(
		() => ttl,
		(r) => (remaining = r)
	);

	onMount(() => {
		void launch();
		return () => close();
	});

	async function launch() {
		phase = 'booting';
		error = '';
		try {
			machine = machineId ? await getMachine(machineId) : await createMachine('desktop', ttl);
			phase = 'connecting';
			timer.start(machine);
			setTimeout(connect, machineId ? 300 : 4500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			phase = 'error';
		}
	}

	async function connect() {
		if (disposed || !machine) return;
		attempts += 1;
		try {
			vncHandle = await connectVnc(
				{
					screen,
					machineId: machine.id,
					onConnect: () => (phase = 'live'),
					onDisconnect: () => {
						if (phase !== 'live' && attempts < MAX_ATTEMPTS) {
							setTimeout(connect, 1500);
						} else if (phase === 'live') {
							phase = 'closed';
							timer.stop();
						}
					}
				},
				() => disposed
			);
		} catch (e) {
			if (attempts < MAX_ATTEMPTS) setTimeout(connect, 1500);
			else {
				error = e instanceof Error ? e.message : String(e);
				phase = 'error';
			}
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

	export function close() {
		disposed = true;
		timer.stop();
		vncHandle?.teardown();
		vncHandle = null;
		if (machine && !shared && !machineId) {
			void fetch(`${apiBase}/v1/machines/${machine.id}`, { method: 'DELETE' }).catch(() => {});
		}
		machine = null;
		phase = 'idle';
		onClose?.();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="w-full max-w-3xl">
	<div
		class="flex items-center justify-between rounded-t-geist-lg border border-line bg-surface px-4 py-2.5 font-mono text-[12px]"
	>
		<div class="flex items-center gap-2 text-ink-muted">
			{#if phase === 'booting'}
				<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>booting a desktop…
			{:else if phase === 'connecting'}
				<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>starting the display…
			{:else if phase === 'live' && machine}
				<span class="size-1.5 rounded-full bg-success"></span>
				<span class="text-ink">{machine.id}</span>
				<span class="text-ink-faint">·</span>desktop
				<span class="text-ink-faint">·</span>1280×800
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
			{/if}
			{#if phase === 'live' || phase === 'connecting'}<span>self-destructs in {remaining}s</span
				>{/if}
			<button class="text-ink-subtle transition-colors hover:text-ink" onclick={close}>esc ✕</button
			>
		</div>
	</div>
	<div
		class="relative overflow-hidden rounded-b-geist-lg border border-t-0 border-line bg-black"
		class:hidden={phase === 'error'}
	>
		<div bind:this={screen} class="aspect-[16/10] w-full"></div>
		{#if phase !== 'live'}
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[12px] text-ink-subtle"
			>
				{phase === 'booting' ? 'allocating a computer…' : 'painting the screen…'}
			</div>
		{/if}
	</div>
</div>

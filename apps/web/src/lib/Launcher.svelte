<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Workstation from '$lib/Workstation.svelte';
	import Chassis from '$lib/Chassis.svelte';
	import { listMachines, destroyMachine, type Machine } from '$lib/boring';

	// One computer with everything on it: a live desktop (browser + GUI), a real
	// terminal (its serial shell, coding agents preinstalled), and an AI prompt
	// box that drives it. `launched` flips the whole thing on.
	let launched = $state(false);
	// ?restore=vol-… launches straight into a computer with that volume attached.
	let restore = $state<string | undefined>(undefined);

	// The fleet: every machine running on this host — expand to stop any of them.
	let fleet = $state<Machine[]>([]);
	let showFleet = $state(false);
	let killing = $state<Record<string, boolean>>({});

	async function refreshFleet() {
		fleet = await listMachines();
	}
	async function kill(id: string) {
		if (killing[id]) return;
		killing[id] = true;
		try {
			await destroyMachine(id);
			fleet = fleet.filter((m) => m.id !== id);
		} finally {
			delete killing[id];
		}
	}
	async function killAll() {
		await Promise.all(fleet.map((m) => destroyMachine(m.id).catch(() => {})));
		await refreshFleet();
	}

	onMount(() => {
		const vol = new URLSearchParams(location.search).get('restore');
		if (vol) {
			restore = vol;
			launched = true;
		}
		void refreshFleet();
		const t = setInterval(refreshFleet, 4000);
		return () => clearInterval(t);
	});

	// Session length for the shell + desktop (clamped server-side to 15–900s).
	const LENGTHS = [
		{ s: 60, l: '1 min' },
		{ s: 300, l: '5 min' },
		{ s: 900, l: '15 min' }
	];
	let ttl = $state(300);
	// Keep-alive: no auto-shutdown, runs until you close it. Honored only when the
	// server has NEHEMIAH_ALLOW_PERSISTENT=1; otherwise it falls back to the TTL.
	let persistent = $state(false);

	const PRODUCTS = [
		{
			name: 'Sandboxes',
			desc: 'Headless microVMs with a serial console + an AI that drives them. python3 · node · claude, milliseconds to boot, opt-in internet.',
			live: true
		},
		{
			name: 'Computers',
			desc: 'Full Linux desktops over VNC — a real browser plus claude, codex, cursor & pi preinstalled.',
			live: true
		},
		{
			name: 'Agents',
			desc: 'An AI that sees the screen and drives the mouse & keyboard.',
			live: true
		},
		{
			name: 'Inference',
			desc: 'One OpenAI-compatible endpoint for every model — Claude on Anthropic, the rest via OpenRouter.',
			live: true
		},
		{
			name: 'Storage',
			desc: 'Persistent volumes that outlive the machine — save a computer, restore it into a fresh one.',
			live: true
		}
	];

	const HOW = [
		[
			'Firecracker microVMs',
			'Real hardware-virtualized isolation — a kernel per machine, not a shared container.'
		],
		[
			'Jailed & capped',
			'Each VM runs unprivileged and chrooted, with per-machine CPU, memory and PID limits.'
		],
		[
			'Snapshot-restore',
			'A shell resumes from a memory snapshot in ~3 ms. No cold boot, no waiting.'
		],
		[
			'Ephemeral by default',
			'Machines clean themselves up on a TTL — nothing lingers. Or flip “keep alive” and one runs until you stop it.'
		]
	];

	const STATS = [
		['~3 ms', 'snapshot boot'],
		['VM-grade', 'isolation, per machine'],
		['0', 'network egress for guests']
	];

	function onKeydown(e: KeyboardEvent) {
		const el = document.activeElement;
		if (e.key === 'Enter' && !launched) {
			if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
			if (el?.closest('.xterm')) return;
			launched = true;
		} else if (e.key === 'Escape' && launched) {
			if (el?.closest('.xterm')) return; // esc belongs to the terminal (vim etc.)
			launched = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="bg-black p-2 max-w-4xl mx-auto">
	<section class="flex flex-col px-5 pt-22 pb-12">
		<div class="flex w-full flex-col gap-10">
			<div class="flex shrink-0 flex-col gap-2">
				<h1
					class="text-[clamp(1rem,3vw,2rem)] font-semibold whitespace-nowrap tracking-[-0.03em] text-ink"
				>
					Computers that are
					<span class="text-ink-subtle">refreshingly boring.</span>
				</h1>

				<!-- launcher -->
				<div class="flex w-full flex-col items-start gap-4">
					<p class="max-w-md font-mono text-[11px] leading-relaxed text-ink-faint">
						One machine, everything on it — a live desktop with a real browser, a terminal with
						claude · codex · cursor · pi preinstalled, and an AI you can hand the whole thing to.
					</p>

					<!-- config -->
					<div class="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3 font-mono text-[11px]">
						<span class="text-ink-faint">session</span>
						<div class="flex flex-wrap gap-1">
							{#each LENGTHS as opt (opt.s)}
								<button
									onclick={() => {
										ttl = opt.s;
										persistent = false;
									}}
									class="rounded-full border px-2.5 py-0.5 transition-colors {ttl === opt.s &&
									!persistent
										? 'border-white/25 bg-white/10 text-ink'
										: 'border-line text-ink-faint hover:text-ink-muted'}"
								>
									{opt.l}
								</button>
							{/each}
							<button
								onclick={() => (persistent = true)}
								title="No auto-shutdown — runs until you close it"
								class="rounded-full border px-2.5 py-0.5 transition-colors {persistent
									? 'border-white/25 bg-white/10 text-ink'
									: 'border-line text-ink-faint hover:text-ink-muted'}"
							>
								∞ keep alive
							</button>
						</div>
					</div>

					<!-- launch -->
					<div class="flex items-center gap-3 font-mono text-[11px]">
						{#if !launched}
							<button
								onclick={() => (launched = true)}
								class="rounded-geist bg-ink px-3 py-1.5 text-[12px] font-semibold text-black transition-opacity hover:opacity-90"
							>
								Launch computer
							</button>
							<span class="text-ink-faint"
								>or press <kbd
									class="rounded-[5px] border border-line bg-surface px-1.5 py-0.5 text-ink-muted"
									>⏎</kbd
								></span
							>
						{:else}
							<button
								onclick={() => (launched = false)}
								class="rounded-geist border border-line px-3 py-1.5 text-[12px] text-ink-subtle transition-colors hover:text-ink"
							>
								Shut down
							</button>
							<span class="text-ink-faint">esc closes it too</span>
						{/if}
					</div>

					{#if fleet.length > 0}
						<div class="flex flex-col gap-1.5 font-mono text-[11px]">
							<div class="flex items-center gap-2">
								<button
									onclick={() => (showFleet = !showFleet)}
									class="text-ink-faint tabular-nums transition-colors hover:text-ink-muted"
								>
									<span class="text-success">●</span>
									{fleet.length}
									{fleet.length === 1 ? 'computer' : 'computers'} running
									<span class="text-ink-faint">{showFleet ? '▾' : '▸'}</span>
								</button>
								{#if fleet.length > 1}
									<button
										onclick={killAll}
										class="text-ink-faint transition-colors hover:text-red-400"
										title="Stop all running computers">stop all</button
									>
								{/if}
							</div>

							{#if showFleet}
								<ul class="flex flex-col gap-1">
									{#each fleet as m (m.id)}
										<li
											class="flex items-center gap-2 rounded-[5px] border border-line bg-surface px-2 py-1 text-ink-muted"
										>
											<span class="text-ink-subtle">{m.template ?? 'computer'}</span>
											<span class="text-ink-faint">{m.id}</span>
											{#if m.persistent}<span class="text-ink-faint" title="no auto-shutdown"
													>∞</span
												>{/if}
											<button
												onclick={() => kill(m.id)}
												disabled={killing[m.id]}
												class="ml-auto text-ink-subtle transition-colors hover:text-red-400 disabled:opacity-40"
												title="Stop this computer">{killing[m.id] ? '…' : 'stop ✕'}</button
											>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
				</div>
			</div>

			<div class="w-full">
				<Chassis on={launched}>
					{#if launched}
						<Workstation {ttl} {persistent} volume={restore} onClose={() => (launched = false)} />
					{:else}
						<!-- powered-down screen: click it (or press enter) to boot -->
						<button
							onclick={() => (launched = true)}
							aria-label="Launch computer"
							class="flex h-full w-full cursor-pointer items-start p-4"
						>
							<span class="h-4 w-2 animate-pulse bg-ink-subtle"></span>
						</button>
					{/if}
				</Chassis>
			</div>
		</div>
	</section>

	<!-- The lineup -->
	<section class="px-5 py-12">
		<h2 class="text-[13px] font-semibold tracking-wide text-ink-faint uppercase">The lineup</h2>
		<div
			class="mt-6 grid gap-px overflow-hidden rounded-geist-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3"
		>
			{#snippet card(p: { name: string; desc: string; live: boolean })}
				<div class="flex items-center gap-2">
					<h3 class="text-[15px] font-semibold text-ink">{p.name}</h3>
					{#if p.live}
						<span class="font-mono text-[10px] text-success">● live</span>
					{:else}
						<span class="font-mono text-[10px] text-ink-faint">soon</span>
					{/if}
				</div>
				<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">{p.desc}</p>
			{/snippet}
			{#each PRODUCTS as p (p.name)}
				{#if p.name === 'Inference'}
					<a
						href={resolve('/inference')}
						class="flex flex-col bg-black p-6 transition-colors hover:bg-surface"
						>{@render card(p)}<span class="mt-2 font-mono text-[11px] text-accent"
							>open the playground →</span
						></a
					>
				{:else}
					<div class="flex flex-col bg-black p-6">{@render card(p)}</div>
				{/if}
			{/each}
			<!-- filler so the empty grid cell stays black instead of showing the bg-line backdrop -->
			<div class="hidden bg-black sm:block"></div>
		</div>
	</section>

	<!-- How it works -->
	<section class="px-5 py-12">
		<h2 class="text-[13px] font-semibold tracking-wide text-ink-faint uppercase">How it works</h2>
		<div class="mt-6 grid gap-8 sm:grid-cols-2">
			{#each HOW as [title, body] (title)}
				<div>
					<h3 class="text-[15px] font-semibold text-ink">{title}</h3>
					<p class="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{body}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Numbers -->
	<section class="px-5 py-12">
		<div class="grid gap-8 sm:grid-cols-3">
			{#each STATS as [n, label] (label)}
				<div>
					<div class="text-[32px] font-semibold tracking-[-0.03em] text-ink">{n}</div>
					<div class="mt-1 font-mono text-[12px] text-ink-faint">{label}</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- Footer -->
	<footer class="px-5 py-12">
		<div
			class="flex flex-col gap-6 border-t border-line pt-10 sm:flex-row sm:items-center sm:justify-between"
		>
			<div>
				<div class="font-semibold text-ink">Nehemiah</div>
				<div class="mt-1 font-mono text-[12px] text-ink-faint">
					Computers that are refreshingly boring.
				</div>
			</div>
			<div class="flex items-center gap-5 font-mono text-[12px] text-ink-subtle">
				<a href={resolve('/docs')} class="transition-colors hover:text-ink">Docs</a>
				<span class="text-ink-faint">Pluto · Fabrika · Goshen Labs</span>
			</div>
		</div>
	</footer>
</div>

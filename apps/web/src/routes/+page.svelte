<script lang="ts">
	import { resolve } from '$app/paths';
	import BootDemo from '$lib/BootDemo.svelte';
	import Chassis from '$lib/Chassis.svelte';
	import Launcher from '$lib/Launcher.svelte';

	// Local dev (`npm run dev` against your own nehemiahd) gets the full interactive
	// console; the public production build is a static open-source showcase.
	const interactive = import.meta.env.DEV;

	const GITHUB = 'https://github.com/boringcomputers/nehemiah';

	const PRODUCTS = [
		{
			name: 'Sandboxes',
			desc: 'Headless microVMs with a serial console + an AI that drives them. python3 · node · claude, milliseconds to boot, opt-in internet.'
		},
		{
			name: 'Computers',
			desc: 'Full Linux desktops over VNC — a real browser plus claude, codex, cursor & pi preinstalled.'
		},
		{ name: 'Agents', desc: 'An AI that sees the screen and drives the mouse & keyboard.' },
		{
			name: 'Inference',
			desc: 'One OpenAI-compatible endpoint for every model — Claude on Anthropic, the rest via OpenRouter.'
		},
		{
			name: 'Storage',
			desc: 'Persistent volumes that outlive the machine — save a computer, restore it into a fresh one.'
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
		['Apache-2.0', 'open source, self-hostable']
	];
</script>

<svelte:head>
	<title>Nehemiah</title>
	<meta
		name="description"
		content="Open-source instant microVMs with a terminal, a browser, coding agents, and an AI that drives them. Run your own."
	/>
</svelte:head>

{#if interactive}
	<Launcher />
{:else}
	<div class="mx-auto max-w-4xl bg-black p-2">
		<!-- hero -->
		<section class="flex flex-col px-5 pt-22 pb-12">
			<div class="flex w-full flex-col gap-10">
				<div class="flex shrink-0 flex-col gap-4">
					<h1
						class="text-[clamp(1rem,3vw,2rem)] font-semibold whitespace-nowrap tracking-[-0.03em] text-ink"
					>
						Computers that are
						<span class="text-ink-subtle">refreshingly boring.</span>
					</h1>

					<p class="max-w-lg text-[13px] leading-relaxed text-ink-muted">
						Instant Firecracker microVMs — a terminal, a real browser, coding agents preinstalled,
						and an AI that drives them. <span class="text-ink">Open source.</span> Fork it and run your
						own with your own keys.
					</p>

					<div class="flex flex-wrap items-center gap-3 font-mono text-[12px]">
						<a
							href={GITHUB}
							target="_blank"
							rel="noopener"
							class="rounded-geist bg-ink px-3 py-1.5 font-semibold text-black transition-opacity hover:opacity-90"
							>Fork on GitHub ↗</a
						>
						<a
							href={resolve('/docs')}
							class="rounded-geist border border-line px-3 py-1.5 text-ink-subtle transition-colors hover:text-ink"
							>Read the docs</a
						>
					</div>
				</div>

				<!-- what the real console does, simulated on the screen of the case:
				     boot → "build a snake game" → the agent ships it → it plays -->
				<div class="w-full">
					<Chassis on={true}>
						<BootDemo />
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
				{#each PRODUCTS as p (p.name)}
					<div class="flex flex-col bg-black p-6">
						<h3 class="text-[15px] font-semibold text-ink">{p.name}</h3>
						<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">{p.desc}</p>
					</div>
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

		<!-- Run your own -->
		<section class="px-5 py-12">
			<div class="rounded-geist-lg border border-line bg-surface p-8">
				<h2 class="text-[18px] font-semibold tracking-[-0.02em] text-ink">Run your own</h2>
				<p class="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-muted">
					It's open source (Apache-2.0) and self-hosted — bring your own Anthropic + S3 keys, point
					it at a Linux box with <code class="text-ink">/dev/kvm</code> (x86_64 or arm64), or run the
					whole thing on an Apple Silicon Mac with one command. Nothing phones home.
				</p>
				<div class="mt-5 flex flex-wrap items-center gap-3 font-mono text-[12px]">
					<a
						href={GITHUB}
						target="_blank"
						rel="noopener"
						class="rounded-geist bg-ink px-3 py-1.5 font-semibold text-black transition-opacity hover:opacity-90"
						>Fork on GitHub ↗</a
					>
					<a href={resolve('/docs')} class="text-ink-subtle transition-colors hover:text-ink"
						>setup & API docs →</a
					>
				</div>
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
					<a href={GITHUB} target="_blank" rel="noopener" class="transition-colors hover:text-ink"
						>GitHub</a
					>
				</div>
			</div>
		</footer>
	</div>
{/if}

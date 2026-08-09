<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getMachine } from '$lib/boring';
	import Workstation from '$lib/Workstation.svelte';
	import Computer from '$lib/Computer.svelte';
	import Chassis from '$lib/Chassis.svelte';

	const home = resolve('/');
	const id = page.params.id ?? '';
	let status = $state<'loading' | 'shell' | 'desktop' | 'gone'>('loading');

	onMount(async () => {
		try {
			const m = await getMachine(id);
			// Desktop machines are the full computer (browser + terminal + agent);
			// a bare shell falls back to the terminal-only view.
			status = m.display ? 'desktop' : 'shell';
		} catch {
			status = 'gone';
		}
	});
</script>

<svelte:head>
	<title>a shared computer · Nehemiah</title>
</svelte:head>

{#if status === 'desktop'}
	<div class="mx-auto max-w-4xl bg-black p-2">
		<div class="flex flex-col px-5 pt-10 pb-12">
			<a
				href={home}
				class="mb-6 text-[clamp(1rem,3vw,2rem)] font-semibold tracking-[-0.03em] text-ink"
			>
				Computers that are <span class="text-ink-subtle">refreshingly boring.</span>
			</a>
			<Chassis>
				<Workstation machineId={id} onClose={() => goto(home)} />
			</Chassis>
			<p class="mt-4 font-mono text-[11px] text-ink-faint">
				someone shared this computer with you — it self-destructs when its timer runs out.
				<a href={home} class="text-ink-subtle transition-colors hover:text-ink">get your own →</a>
			</p>
		</div>
	</div>
{:else}
	<div class="flex min-h-screen flex-col items-center justify-center gap-6 bg-black px-5 py-16">
		<a
			href={home}
			class="text-center text-[clamp(1rem,3vw,2rem)] font-semibold whitespace-nowrap tracking-[-0.03em] text-ink"
		>
			Computers that are <span class="text-ink-subtle">refreshingly boring.</span>
		</a>

		{#if status === 'loading'}
			<p class="font-mono text-[12px] text-ink-faint">connecting to a shared computer…</p>
		{:else if status === 'shell'}
			<Computer machineId={id} onClose={() => goto(home)} />
		{:else}
			<div class="flex flex-col items-center gap-3">
				<p class="font-mono text-[12px] text-ink-muted">this computer has expired</p>
				<a
					href={home}
					class="font-mono text-[12px] text-ink-subtle transition-colors hover:text-ink"
					>← get your own →</a
				>
			</div>
		{/if}
	</div>
{/if}

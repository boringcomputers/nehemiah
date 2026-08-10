<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();

	const label = (status: string): string =>
		({
			operational: 'Operational',
			degraded: 'Degraded',
			outage: 'Service outage',
			unknown: 'Status unknown'
		})[status] ?? 'Status unknown';
</script>

<svelte:head>
	<title>Status · Nehemiah</title>
	<meta
		name="description"
		content="Coarse, current health signals for the Boring Computers control plane and gateway."
	/>
</svelte:head>

<main class="mx-auto min-h-screen max-w-2xl px-5 pt-24 pb-24 text-ink">
	<header class="border-b border-line pb-8">
		<p class="font-mono text-[11px] tracking-wide text-ink-faint uppercase">Public status</p>
		<div class="mt-3 flex flex-wrap items-center justify-between gap-4">
			<h1 class="text-[28px] font-semibold tracking-[-0.03em]">{label(data.status)}</h1>
			<div class="flex items-center gap-2 font-mono text-[12px]">
				{#if data.status === 'operational'}
					<span class="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true"></span>
				{:else if data.status === 'outage'}
					<span class="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true"></span>
				{:else if data.status === 'degraded'}
					<span class="h-2.5 w-2.5 rounded-full bg-amber-400" aria-hidden="true"></span>
				{:else}
					<span class="h-2.5 w-2.5 rounded-full bg-ink-faint" aria-hidden="true"></span>
				{/if}
				<span class="text-ink-muted">{label(data.status)}</span>
			</div>
		</div>
		<p class="mt-3 text-[13px] leading-relaxed text-ink-muted">
			Checked at <time class="font-mono text-ink" datetime={data.checked_at}>{data.checked_at}</time
			>.
		</p>
	</header>

	<section class="py-8" aria-labelledby="components-heading">
		<h2
			id="components-heading"
			class="text-[13px] font-semibold tracking-wide text-ink-faint uppercase"
		>
			Components
		</h2>
		<div class="mt-4 overflow-hidden rounded-geist-lg border border-line bg-surface">
			<div class="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
				<div>
					<h3 class="text-sm font-semibold">Control plane</h3>
					<p class="mt-1 text-xs text-ink-muted">API liveness and database-backed readiness</p>
				</div>
				<span class="font-mono text-xs text-ink-muted">{label(data.components.control_plane)}</span>
			</div>
			<div class="flex items-center justify-between gap-4 px-5 py-4">
				<div>
					<h3 class="text-sm font-semibold">Gateway</h3>
					<p class="mt-1 text-xs text-ink-muted">Public connection edge health</p>
				</div>
				<span class="font-mono text-xs text-ink-muted">{label(data.components.gateway)}</span>
			</div>
		</div>
	</section>

	<section class="border-t border-line py-8" aria-labelledby="meaning-heading">
		<h2 id="meaning-heading" class="text-[15px] font-semibold">What this check means</h2>
		<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
			This is a bounded, point-in-time reachability and readiness check. It is not a complete
			end-to-end test, an incident history, an availability guarantee, or a measurement of the
			service SLO. An unknown result means the public checker could not safely establish health; it
			does not prove an outage.
		</p>
	</section>

	<section class="border-t border-line py-8" aria-labelledby="incident-heading">
		<h2 id="incident-heading" class="text-[15px] font-semibold">If you are seeing an incident</h2>
		<ul class="mt-3 list-disc space-y-2 pl-5 text-[13px] leading-relaxed text-ink-muted">
			<li>Retry only operations that are documented as safe or idempotent.</li>
			<li>Preserve the UTC time and public request ID shown by your client.</li>
			<li>
				Never post API keys, access or refresh credentials, terminal contents, or private IDs.
			</li>
		</ul>
		<div class="mt-5 flex flex-wrap gap-4 font-mono text-xs">
			<a class="text-accent hover:underline" href={resolve('/support')}>Support guidance</a>
			<a class="text-ink-muted hover:text-ink" href={resolve('/docs')}>Public documentation</a>
		</div>
	</section>
</main>

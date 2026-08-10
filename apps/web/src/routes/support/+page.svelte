<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>Support · Nehemiah</title>
	<meta
		name="description"
		content="Public support guidance for Boring Computers and self-hosted Nehemiah deployments."
	/>
</svelte:head>

<main class="mx-auto min-h-screen max-w-2xl px-5 pt-24 pb-24 text-ink">
	<header class="border-b border-line pb-8">
		<p class="font-mono text-[11px] tracking-wide text-ink-faint uppercase">Public support</p>
		<h1 class="mt-3 text-[28px] font-semibold tracking-[-0.03em]">Get help</h1>
		<p class="mt-3 max-w-xl text-[13px] leading-relaxed text-ink-muted">
			Start with the public documentation and current coarse service status. This page intentionally
			does not expose private operations contacts, escalation policy, infrastructure names, or
			internal runbooks.
		</p>
	</header>

	<section class="py-8" aria-labelledby="contact-heading">
		<h2 id="contact-heading" class="text-[15px] font-semibold">Contact and documentation</h2>
		<div class="mt-4 grid gap-3 sm:grid-cols-2">
			<a
				class="rounded-geist-lg border border-line bg-surface p-5 transition-colors hover:border-ink-faint"
				href={resolve('/docs')}
			>
				<div class="text-sm font-semibold">Public docs</div>
				<div class="mt-1 text-xs leading-relaxed text-ink-muted">
					API, CLI, and self-hosting guidance
				</div>
			</a>
			<a
				class="rounded-geist-lg border border-line bg-surface p-5 transition-colors hover:border-ink-faint"
				href={resolve('/status')}
			>
				<div class="text-sm font-semibold">Service status</div>
				<div class="mt-1 text-xs leading-relaxed text-ink-muted">
					Current coarse component health
				</div>
			</a>
			{#if data.url}
				<a
					class="rounded-geist-lg border border-line bg-surface p-5 transition-colors hover:border-ink-faint"
					href={data.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					<div class="text-sm font-semibold">Support portal ↗</div>
					<div class="mt-1 text-xs leading-relaxed text-ink-muted">Deployment support channel</div>
				</a>
			{/if}
			{#if data.email}
				<a
					class="rounded-geist-lg border border-line bg-surface p-5 transition-colors hover:border-ink-faint"
					href={`mailto:${data.email}`}
				>
					<div class="text-sm font-semibold">Email support</div>
					<div class="mt-1 break-all font-mono text-xs text-ink-muted">{data.email}</div>
				</a>
			{/if}
		</div>
		{#if !data.url && !data.email}
			<p class="mt-4 text-xs leading-relaxed text-ink-faint">
				This deployment has not published a direct support contact. Self-hosted users should contact
				the operator who provided their endpoint.
			</p>
		{/if}
	</section>

	<section class="border-t border-line py-8" aria-labelledby="ephemeral-heading">
		<h2 id="ephemeral-heading" class="text-[15px] font-semibold">
			Ephemeral machines and host loss
		</h2>
		<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
			A machine is ephemeral compute. If its physical host is lost, the running VM, memory, and any
			filesystem changes that were not saved to a durable volume or published template may be
			unrecoverable. A persistent TTL does not turn local VM state into durable storage. Keep
			important data on the documented durable storage path and make machine creation safe to retry.
		</p>
	</section>

	<section class="border-t border-line py-8" aria-labelledby="report-heading">
		<h2 id="report-heading" class="text-[15px] font-semibold">When reporting a problem</h2>
		<ul class="mt-3 list-disc space-y-2 pl-5 text-[13px] leading-relaxed text-ink-muted">
			<li>
				Include the UTC time, operation, client version, and public request ID when available.
			</li>
			<li>Say whether a retry changed the result and whether durable data is affected.</li>
			<li>
				Do not send API keys, session credentials, device codes, or terminal and file contents.
			</li>
		</ul>
	</section>
</main>

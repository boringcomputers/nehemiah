<script lang="ts">
	import { onMount } from 'svelte';
	import { dashboardApi } from '$lib/nehemiah-client';

	type Usage = { usage_date: string; dimension: string; quantity: string; project_id: string };
	let usage = $state<Usage[]>([]);
	let plan = $state('private_beta');
	let spendCapCents = $state<number>();
	let delinquentAt = $state<string>();
	let error = $state('');
	onMount(
		() =>
			void dashboardApi<{
				account: { plan: string; spend_cap_cents?: number; delinquent_at?: string };
				usage: Usage[];
			}>('/v1/billing/usage')
				.then((result) => {
					plan = result.account.plan;
					spendCapCents = result.account.spend_cap_cents;
					delinquentAt = result.account.delinquent_at;
					usage = result.usage;
				})
				.catch((cause) => {
					error = cause instanceof Error ? cause.message : String(cause);
				})
	);
</script>

<h1 class="text-xl font-semibold">Usage</h1>
<p class="mt-2 text-sm text-ink-muted">
	Plan: {plan}. Private-beta metering runs in shadow mode
	{spendCapCents === undefined ? '' : ` with a $${(spendCapCents / 100).toFixed(2)} spend cap`}.
</p>
{#if delinquentAt}<p
		class="mt-3 rounded-geist border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-200"
	>
		Billing became delinquent on {new Date(delinquentAt).toLocaleString()}. New placements may be
		blocked.
	</p>{/if}
{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
<div class="mt-6 overflow-x-auto rounded-geist border border-line">
	<table class="w-full text-left text-sm">
		<thead class="bg-surface text-xs text-ink-muted"
			><tr
				><th class="p-3">Date</th><th class="p-3">Project</th><th class="p-3">Dimension</th><th
					class="p-3 text-right">Quantity</th
				></tr
			></thead
		><tbody
			>{#each usage as row (`${row.usage_date}:${row.project_id}:${row.dimension}`)}<tr
					class="border-t border-line"
					><td class="p-3">{row.usage_date}</td><td class="p-3 font-mono text-xs"
						>{row.project_id}</td
					><td class="p-3">{row.dimension}</td><td class="p-3 text-right font-mono"
						>{row.quantity}</td
					></tr
				>{:else}<tr><td colspan="4" class="p-5 text-ink-muted">No metered usage yet.</td></tr
				>{/each}</tbody
		>
	</table>
</div>

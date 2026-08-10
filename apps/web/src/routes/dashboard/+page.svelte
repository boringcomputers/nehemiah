<script lang="ts">
	import { onMount } from 'svelte';
	import { dashboardApi, selectOrganization, selectedOrganization } from '$lib/nehemiah-client';

	type Organization = { id: string; name: string; slug: string };
	let organizations = $state<Organization[]>([]);
	let organizationId = $state('');
	let machineCount = $state(0);
	let error = $state('');

	async function load() {
		try {
			const result = await dashboardApi<{ organizations: Organization[] }>(
				'/v1/organizations',
				{},
				undefined
			);
			organizations = result.organizations;
			organizationId = selectedOrganization() ?? organizations[0]?.id ?? '';
			if (organizationId) {
				selectOrganization(organizationId);
				machineCount = (
					await dashboardApi<{ machines: unknown[] }>('/v1/machines', {}, organizationId)
				).machines.length;
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function changeOrganization(id: string) {
		organizationId = id;
		selectOrganization(id);
		await load();
	}

	onMount(() => void load());
</script>

<h1 class="text-xl font-semibold">Overview</h1>
{#if error}<p
		class="mt-4 rounded-geist border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300"
	>
		{error}
	</p>{/if}
<label class="mt-6 block max-w-sm text-xs text-ink-muted"
	>Organization
	<select
		class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
		value={organizationId}
		onchange={(event) => void changeOrganization(event.currentTarget.value)}
	>
		{#each organizations as organization (organization.id)}<option value={organization.id}
				>{organization.name}</option
			>{/each}
	</select>
</label>
<div class="mt-8 grid gap-4 sm:grid-cols-3">
	<div class="rounded-geist border border-line bg-surface p-5">
		<div class="text-2xl font-semibold">{machineCount}</div>
		<div class="mt-1 text-xs text-ink-muted">Machines</div>
	</div>
	<div class="rounded-geist border border-line bg-surface p-5">
		<div class="text-2xl font-semibold">Private beta</div>
		<div class="mt-1 text-xs text-ink-muted">Plan</div>
	</div>
	<div class="rounded-geist border border-line bg-surface p-5">
		<div class="text-2xl font-semibold">ca-tor-1</div>
		<div class="mt-1 text-xs text-ink-muted">Region</div>
	</div>
</div>

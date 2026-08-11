<script lang="ts">
	import { onMount } from 'svelte';
	import { dashboardApi } from '$lib/nehemiah-client';

	type Project = {
		id: string;
		name: string;
		slug: string;
		max_machines: number;
		max_vcpus: number;
		max_memory_mb: number;
		max_disk_mb: number;
		max_storage_mb: number;
	};
	let projects = $state<Project[]>([]);
	let name = $state('');
	let slug = $state('');
	let error = $state('');

	async function load() {
		try {
			projects = (await dashboardApi<{ projects: Project[] }>('/v1/projects')).projects;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function create() {
		error = '';
		try {
			await dashboardApi('/v1/projects', { method: 'POST', body: JSON.stringify({ name, slug }) });
			name = '';
			slug = '';
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	onMount(() => void load());
</script>

<h1 class="text-xl font-semibold">Projects</h1>
<form
	class="mt-6 grid max-w-xl gap-3 rounded-geist border border-line bg-surface p-5 sm:grid-cols-2"
	onsubmit={(event) => {
		event.preventDefault();
		void create();
	}}
>
	<input
		class="rounded-geist border border-line bg-black px-3 py-2 text-sm"
		placeholder="Project name"
		bind:value={name}
		required
	/>
	<input
		class="rounded-geist border border-line bg-black px-3 py-2 font-mono text-sm"
		placeholder="project-slug"
		bind:value={slug}
		pattern={'[a-z0-9][a-z0-9-]{1,62}'}
		required
	/>
	<button class="rounded-geist bg-ink px-3 py-2 text-sm font-semibold text-black sm:col-span-2"
		>Create project</button
	>
</form>
{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
<div class="mt-6 divide-y divide-line rounded-geist border border-line">
	{#each projects as project (project.id)}
		<div class="flex flex-wrap items-center justify-between gap-4 p-4">
			<div>
				<div class="font-medium">{project.name}</div>
				<div class="font-mono text-xs text-ink-faint">{project.id}</div>
			</div>
			<div class="grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-ink-muted sm:grid-cols-4">
				<span>{project.max_machines} machines</span>
				<span>{project.max_vcpus} vCPUs</span>
				<span>{project.max_memory_mb.toLocaleString()} MiB memory</span>
				<span>{project.max_disk_mb.toLocaleString()} MiB machine disk</span>
				<span>{project.max_storage_mb.toLocaleString()} MiB volume storage</span>
			</div>
		</div>
	{:else}<p class="p-4 text-sm text-ink-muted">No projects yet.</p>{/each}
</div>

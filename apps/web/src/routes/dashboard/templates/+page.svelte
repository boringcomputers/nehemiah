<script lang="ts">
	import { onMount } from 'svelte';
	import { dashboardApi } from '$lib/nehemiah-client';

	type Project = { id: string; name: string };
	type Template = {
		id: string;
		project_id: string;
		name: string;
		version: string;
		checksum: string;
		size_bytes: number;
		manifest?: { architecture?: string };
	};

	let projects = $state<Project[]>([]);
	let templates = $state<Template[]>([]);
	let projectId = $state('');
	let deletingId = $state('');
	let loading = $state(false);
	let error = $state('');

	async function loadProjectResources() {
		if (!projectId) {
			templates = [];
			return;
		}
		const project = encodeURIComponent(projectId);
		const templateResult = await dashboardApi<{ templates: Template[] }>(
			`/v1/templates?project_id=${project}`
		);
		templates = templateResult.templates;
	}

	async function load() {
		loading = true;
		error = '';
		try {
			projects = (await dashboardApi<{ projects: Project[] }>('/v1/projects')).projects;
			if (!projects.some((project) => project.id === projectId)) projectId = projects[0]?.id ?? '';
			await loadProjectResources();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}

	async function changeProject(id: string) {
		projectId = id;
		error = '';
		try {
			await loadProjectResources();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function remove(template: Template) {
		if (deletingId || !confirm(`Delete immutable template ${template.name}@${template.version}?`))
			return;
		deletingId = template.id;
		error = '';
		try {
			await dashboardApi(
				`/v1/templates/${encodeURIComponent(template.id)}?project_id=${encodeURIComponent(projectId)}`,
				{ method: 'DELETE' }
			);
			await loadProjectResources();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			deletingId = '';
		}
	}

	onMount(() => void load());
</script>

<h1 class="text-xl font-semibold">Templates</h1>
<p class="mt-2 text-sm text-ink-muted">
	Inspect managed template records available to this project.
</p>

<section class="mt-6 max-w-2xl rounded-geist border border-line bg-surface p-5">
	<p class="text-sm text-ink-muted">
		Managed custom-template publication is disabled for the private beta until aggregate storage
		quotas and durable object/replica eviction are enforced. Built-in templates remain available
		when launching a machine.
	</p>
	<label class="grid gap-1 text-xs text-ink-muted">
		Project
		<select
			class="rounded-geist border border-line bg-black px-3 py-2 text-sm text-ink"
			value={projectId}
			onchange={(event) => void changeProject(event.currentTarget.value)}
			required
		>
			{#each projects as project (project.id)}<option value={project.id}>{project.name}</option
				>{/each}
		</select>
	</label>
</section>

{#if error}<p class="mt-5 rounded-geist border border-line p-4 text-sm text-red-300">
		{error}
	</p>{/if}

<div class="mt-6 divide-y divide-line rounded-geist border border-line">
	{#each templates as template (template.id)}
		<div class="flex flex-wrap items-center justify-between gap-4 p-4">
			<div>
				<div class="font-medium">{template.name}@{template.version}</div>
				<div class="font-mono text-xs text-ink-faint">
					{template.id} · {template.manifest?.architecture ?? 'unknown arch'} · {template.size_bytes.toLocaleString()}
					bytes
				</div>
				<div class="mt-1 max-w-xl truncate font-mono text-[11px] text-ink-faint">
					sha256:{template.checksum}
				</div>
			</div>
			<button
				class="text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
				disabled={deletingId === template.id}
				onclick={() => void remove(template)}
				>{deletingId === template.id ? 'Deleting…' : 'Delete'}</button
			>
		</div>
	{:else}
		<p class="p-4 text-sm text-ink-muted">
			{loading ? 'Loading templates…' : 'No templates in this project.'}
		</p>
	{/each}
</div>

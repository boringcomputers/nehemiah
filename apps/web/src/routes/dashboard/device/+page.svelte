<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { dashboardApi } from '$lib/nehemiah-client';

	type Project = { id: string; name: string };
	type DeviceRequest = {
		client_id: string;
		scopes: string[];
		expires_at: string;
		status: 'pending';
	};

	let userCode = $state('');
	let request = $state<DeviceRequest>();
	let projects = $state<Project[]>([]);
	let projectId = $state('');
	let scopes = $state<string[]>([]);
	let loading = $state(true);
	let deciding = $state(false);
	let decision = $state<'approved' | 'denied'>();
	let error = $state('');

	async function inspect() {
		loading = true;
		error = '';
		try {
			userCode = (page.url.searchParams.get('user_code') ?? '').toUpperCase();
			if (!/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(userCode)) {
				throw new Error('Enter the eight-character code shown by the CLI.');
			}
			const [inspected, projectList] = await Promise.all([
				dashboardApi<DeviceRequest>('/v1/auth/device/inspect', {
					method: 'POST',
					body: JSON.stringify({ user_code: userCode })
				}),
				dashboardApi<{ projects: Project[] }>('/v1/projects')
			]);
			request = inspected;
			scopes = [...inspected.scopes];
			projects = projectList.projects;
			projectId = projects[0]?.id ?? '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}

	async function decide(next: 'approve' | 'deny') {
		if (next === 'approve' && (!projectId || scopes.length === 0)) {
			error = 'Choose a project and at least one requested scope.';
			return;
		}
		deciding = true;
		error = '';
		try {
			await dashboardApi('/v1/auth/device/authorize', {
				method: 'POST',
				body: JSON.stringify({
					user_code: userCode,
					decision: next,
					...(next === 'approve' ? { project_id: projectId, scopes } : {})
				})
			});
			decision = next === 'approve' ? 'approved' : 'denied';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			deciding = false;
		}
	}

	onMount(() => void inspect());
</script>

<svelte:head><title>Authorize CLI · Nehemiah</title></svelte:head>

<div class="max-w-xl">
	<h1 class="text-xl font-semibold">Authorize the CLI</h1>
	<p class="mt-2 text-sm text-ink-muted">
		Only approve if <code class="font-mono text-ink">{userCode || 'the code'}</code> matches the code
		shown in your terminal.
	</p>

	{#if loading}
		<p class="mt-6 font-mono text-sm text-ink-muted">Checking authorization request…</p>
	{:else if decision}
		<div class="mt-6 rounded-geist border border-line bg-surface p-5">
			<h2 class="font-semibold">Request {decision}</h2>
			<p class="mt-2 text-sm text-ink-muted">You can close this page and return to the CLI.</p>
		</div>
	{:else if request}
		<div class="mt-6 grid gap-4 rounded-geist border border-line bg-surface p-5">
			<div>
				<div class="text-xs text-ink-faint">Client</div>
				<div class="mt-1 font-mono text-sm">{request.client_id}</div>
			</div>
			<label class="grid gap-1 text-xs text-ink-muted">
				Project
				<select
					class="rounded-geist border border-line bg-black px-3 py-2 text-sm text-ink"
					bind:value={projectId}
					required
				>
					{#each projects as project (project.id)}
						<option value={project.id}>{project.name}</option>
					{/each}
				</select>
			</label>
			<fieldset class="grid gap-2 rounded-geist border border-line p-3">
				<legend class="px-1 text-xs text-ink-muted">Explicitly allowed scopes</legend>
				{#each request.scopes as scope (scope)}
					<label class="flex items-center gap-2 font-mono text-xs">
						<input type="checkbox" value={scope} bind:group={scopes} />
						{scope}
					</label>
				{/each}
			</fieldset>
			<p class="text-xs text-ink-faint">
				This code expires {new Date(request.expires_at).toLocaleString()}.
			</p>
			<div class="flex gap-3">
				<button
					class="rounded-geist bg-ink px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
					disabled={deciding || !projectId || scopes.length === 0}
					onclick={() => void decide('approve')}>Approve selected access</button
				>
				<button
					class="rounded-geist border border-line px-4 py-2 text-sm text-red-200 disabled:opacity-50"
					disabled={deciding}
					onclick={() => void decide('deny')}>Deny</button
				>
			</div>
		</div>
	{/if}
	{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
</div>

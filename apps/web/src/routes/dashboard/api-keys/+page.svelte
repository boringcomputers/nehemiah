<script lang="ts">
	import { onMount } from 'svelte';
	import { dashboardApi } from '$lib/nehemiah-client';

	type Project = { id: string; name: string };
	type ApiKey = {
		id: string;
		project_id?: string;
		name: string;
		prefix: string;
		scopes: string[];
		expires_at?: string;
		last_used_at?: string;
		disabled_at?: string;
		revoked_at?: string;
	};
	const allScopes = [
		'machines:read',
		'machines:write',
		'templates:read',
		'templates:write',
		'volumes:read',
		'volumes:write',
		'billing:read'
	] as const;
	let projects = $state<Project[]>([]);
	let keys = $state<ApiKey[]>([]);
	let projectId = $state('');
	let name = $state('CLI');
	let scopes = $state<string[]>(['machines:read', 'machines:write', 'templates:read']);
	let expiresOn = $state('');
	let secret = $state('');
	let error = $state('');
	let pendingKeyId = $state('');

	async function load() {
		try {
			projects = (await dashboardApi<{ projects: Project[] }>('/v1/projects')).projects;
			projectId ||= projects[0]?.id ?? '';
			keys = (await dashboardApi<{ api_keys: ApiKey[] }>('/v1/api-keys')).api_keys;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	onMount(() => void load());

	async function create() {
		secret = '';
		error = '';
		try {
			if (scopes.length === 0) throw new Error('Select at least one scope.');
			const created = await dashboardApi<{ key: string }>('/v1/api-keys', {
				method: 'POST',
				body: JSON.stringify({
					name,
					project_id: projectId || undefined,
					scopes,
					expires_at: expiresOn ? new Date(`${expiresOn}T23:59:59.999Z`).toISOString() : undefined
				})
			});
			secret = created.key;
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function revoke(id: string) {
		error = '';
		pendingKeyId = id;
		try {
			await dashboardApi(`/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			pendingKeyId = '';
		}
	}

	async function setDisabled(id: string, disabled: boolean) {
		error = '';
		pendingKeyId = id;
		try {
			await dashboardApi(
				`/v1/api-keys/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`,
				{ method: 'POST' }
			);
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			pendingKeyId = '';
		}
	}

	async function rotate(id: string) {
		error = '';
		secret = '';
		pendingKeyId = id;
		try {
			const replacement = await dashboardApi<{ key: string }>(
				`/v1/api-keys/${encodeURIComponent(id)}/rotate`,
				{ method: 'POST' }
			);
			secret = replacement.key;
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			pendingKeyId = '';
		}
	}
</script>

<h1 class="text-xl font-semibold">API keys</h1>
<p class="mt-2 text-sm text-ink-muted">
	Secrets are hashed with Argon2id and shown once. Put automation keys in a secret manager.
</p>
<form
	class="mt-6 grid max-w-xl gap-3 rounded-geist border border-line bg-surface p-5"
	onsubmit={(event) => {
		event.preventDefault();
		void create();
	}}
>
	<input
		class="rounded-geist border border-line bg-black px-3 py-2 text-sm"
		bind:value={name}
		required
	/>
	<select class="rounded-geist border border-line bg-black px-3 py-2 text-sm" bind:value={projectId}
		><option value="">All projects</option>{#each projects as project (project.id)}<option
				value={project.id}>{project.name}</option
			>{/each}</select
	>
	<label class="grid gap-1 text-xs text-ink-muted">
		Expires on (optional)
		<input
			class="rounded-geist border border-line bg-black px-3 py-2 text-sm text-ink"
			type="date"
			min={new Date().toISOString().slice(0, 10)}
			bind:value={expiresOn}
		/>
	</label>
	<fieldset class="grid gap-2 rounded-geist border border-line p-3">
		<legend class="px-1 text-xs text-ink-muted">Scopes</legend>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each allScopes as scope (scope)}
				<label class="flex items-center gap-2 font-mono text-xs">
					<input type="checkbox" value={scope} bind:group={scopes} />
					{scope}
				</label>
			{/each}
		</div>
	</fieldset>
	<button class="rounded-geist bg-ink px-3 py-2 text-sm font-semibold text-black">Create key</button
	>
</form>
{#if secret}<div class="mt-5 rounded-geist border border-amber-700/50 bg-amber-950/20 p-4">
		<div class="text-xs font-semibold text-amber-200">
			Copy this now — it will not be shown again.
		</div>
		<code class="mt-2 block break-all text-sm text-amber-100">{secret}</code>
	</div>{/if}
{#if error}<p class="mt-4 text-sm text-red-300">{error}</p>{/if}
<div class="mt-6 divide-y divide-line rounded-geist border border-line">
	{#each keys as key (key.id)}
		<div class="flex items-center justify-between gap-4 p-4">
			<div>
				<div class="font-medium">{key.name}</div>
				<div class="font-mono text-xs text-ink-faint">{key.prefix} · {key.scopes.join(', ')}</div>
				<div class="mt-1 text-xs text-ink-faint">
					{key.project_id ? `Project ${key.project_id}` : 'All projects'}
					{key.expires_at ? ` · expires ${new Date(key.expires_at).toLocaleString()}` : ''}
					{key.last_used_at ? ` · last used ${new Date(key.last_used_at).toLocaleString()}` : ''}
					{key.disabled_at ? ` · disabled ${new Date(key.disabled_at).toLocaleString()}` : ''}
				</div>
			</div>
			{#if key.revoked_at}
				<span class="text-xs text-ink-faint">Revoked</span>
			{:else}
				<div class="flex items-center gap-3">
					{#if key.disabled_at}
						<button
							class="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
							disabled={pendingKeyId === key.id}
							onclick={() => void setDisabled(key.id, false)}>Enable</button
						>
					{:else}
						<button
							class="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
							disabled={pendingKeyId === key.id}
							onclick={() => void setDisabled(key.id, true)}>Disable</button
						>
						<button
							class="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
							disabled={pendingKeyId === key.id}
							onclick={() => void rotate(key.id)}>Rotate</button
						>
					{/if}
					<button
						class="text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
						disabled={pendingKeyId === key.id}
						onclick={() => void revoke(key.id)}>Revoke</button
					>
				</div>
			{/if}
		</div>
	{:else}<p class="p-4 text-sm text-ink-muted">No API keys yet.</p>{/each}
</div>

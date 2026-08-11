<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { loadClerk, type ClerkLike } from '$lib/clerk';
	import {
		dashboardApi,
		organizationForDashboard,
		selectedOrganization,
		selectOrganization
	} from '$lib/nehemiah-client';

	let { children } = $props();
	type Organization = { id: string; name: string; slug: string };
	let clerk = $state<ClerkLike>();
	let loading = $state(true);
	let error = $state('');
	let organizations = $state<Organization[]>([]);
	let organizationId = $state('');
	let organizationLoading = $state(false);
	let organizationError = $state('');
	let bootstrappedUserId = '';
	let bootstrapGeneration = 0;

	async function bootstrapOrganization(loaded: ClerkLike) {
		const userId = loaded.user?.id;
		if (!userId) return;
		const generation = ++bootstrapGeneration;
		organizationLoading = true;
		organizationError = '';
		try {
			const result = await dashboardApi<{ organizations: Organization[] }>(
				'/v1/organizations',
				{},
				undefined
			);
			if (generation !== bootstrapGeneration || loaded.user?.id !== userId) return;
			organizations = result.organizations;
			organizationId = organizationForDashboard(organizations, selectedOrganization()) ?? '';
			if (organizationId) selectOrganization(organizationId);
			bootstrappedUserId = userId;
		} catch (cause) {
			if (generation !== bootstrapGeneration) return;
			organizationError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (generation === bootstrapGeneration) organizationLoading = false;
		}
	}

	function changeOrganization(id: string) {
		if (!organizations.some((organization) => organization.id === id)) return;
		organizationId = id;
		selectOrganization(id);
	}

	function resetOrganization() {
		bootstrapGeneration += 1;
		organizations = [];
		organizationId = '';
		organizationLoading = false;
		organizationError = '';
		bootstrappedUserId = '';
	}

	function retryOrganization() {
		if (clerk) void bootstrapOrganization(clerk);
	}

	onMount(() => {
		let mounted = true;
		let unsubscribe: (() => void) | undefined;
		void loadClerk()
			.then((loaded) => {
				if (!mounted) return;
				clerk = loaded;
				loading = false;
				unsubscribe = loaded.addListener(() => {
					if (!mounted) return;
					clerk = loaded;
					const userId = loaded.user?.id;
					if (!userId) resetOrganization();
					else if (userId !== bootstrappedUserId && !organizationLoading) {
						void bootstrapOrganization(loaded);
					}
				});
				if (loaded.user) void bootstrapOrganization(loaded);
			})
			.catch((cause) => {
				if (!mounted) return;
				error = cause instanceof Error ? cause.message : String(cause);
				loading = false;
			});
		return () => {
			mounted = false;
			bootstrapGeneration += 1;
			unsubscribe?.();
		};
	});

	const links = [
		['Overview', '/dashboard'],
		['Machines', '/dashboard/machines'],
		['Projects', '/dashboard/projects'],
		['API keys', '/dashboard/api-keys'],
		['Templates', '/dashboard/templates'],
		['Volumes', '/dashboard/volumes'],
		['Usage', '/dashboard/usage']
	] as const;
</script>

<svelte:head><title>Dashboard · Nehemiah</title></svelte:head>

<main class="mx-auto min-h-screen max-w-6xl px-5 pt-20 pb-16 text-ink">
	{#if loading}
		<p class="font-mono text-sm text-ink-muted">Loading dashboard…</p>
	{:else if error}
		<div class="rounded-geist border border-line bg-surface p-6">
			<h1 class="text-lg font-semibold">Dashboard unavailable</h1>
			<p class="mt-2 text-sm text-ink-muted">{error}</p>
		</div>
	{:else if !clerk?.user}
		<div
			class="mx-auto mt-20 max-w-md rounded-geist-lg border border-line bg-surface p-8 text-center"
		>
			<h1 class="text-xl font-semibold">Nehemiah Cloud</h1>
			<p class="mt-2 text-sm text-ink-muted">
				Sign in to manage projects, machines, templates, volumes, and usage.
			</p>
			<button
				class="mt-6 rounded-geist bg-ink px-4 py-2 text-sm font-semibold text-black"
				onclick={() => clerk?.openSignIn()}>Sign in</button
			>
		</div>
	{:else}
		<header
			class="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5"
		>
			<div>
				<div class="font-semibold">Nehemiah Cloud</div>
				<div class="text-xs text-ink-faint">{clerk.user.fullName ?? clerk.user.id}</div>
			</div>
			<div class="flex items-center gap-3">
				{#if organizations.length > 1}
					<label class="sr-only" for="dashboard-organization">Organization</label>
					<select
						id="dashboard-organization"
						class="max-w-56 rounded-geist border border-line bg-black px-2 py-1.5 text-xs"
						value={organizationId}
						onchange={(event) => changeOrganization(event.currentTarget.value)}
					>
						{#each organizations as organization (organization.id)}
							<option value={organization.id}>{organization.name}</option>
						{/each}
					</select>
				{:else if organizations.length === 1}
					<span class="text-xs text-ink-muted">{organizations[0].name}</span>
				{/if}
				<button class="text-xs text-ink-muted hover:text-ink" onclick={() => void clerk?.signOut()}
					>Sign out</button
				>
			</div>
		</header>
		{#if organizationLoading}
			<p class="font-mono text-sm text-ink-muted">Loading organization…</p>
		{:else if organizationError}
			<div class="rounded-geist border border-red-900/50 bg-red-950/20 p-5">
				<p class="text-sm text-red-200">{organizationError}</p>
				<button
					class="mt-3 text-xs font-semibold text-red-100 underline"
					onclick={retryOrganization}>Retry</button
				>
			</div>
		{:else if !organizationId}
			<div class="rounded-geist border border-line bg-surface p-6">
				<h1 class="text-lg font-semibold">No organization assigned</h1>
				<p class="mt-2 text-sm text-ink-muted">
					Ask a Nehemiah administrator to add this account to an organization.
				</p>
			</div>
		{:else}
			<div class="grid gap-8 md:grid-cols-[170px_1fr]">
				<nav class="flex gap-2 overflow-x-auto md:flex-col">
					{#each links as [label, href] (href)}<a
							class="whitespace-nowrap rounded-geist px-3 py-2 text-sm text-ink-muted hover:bg-surface hover:text-ink"
							href={resolve(href)}>{label}</a
						>{/each}
				</nav>
				{#key organizationId}<section>{@render children()}</section>{/key}
			</div>
		{/if}
	{/if}
</main>

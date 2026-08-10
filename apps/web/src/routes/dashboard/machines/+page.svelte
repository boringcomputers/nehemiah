<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { onMount, tick } from 'svelte';
	import {
		dashboardApi,
		machinePreviewUrl,
		machineWebSocketSession,
		type DashboardMachineSession
	} from '$lib/nehemiah-client';
	import { durableOperation } from '$lib/durable-operation';
	import { setupTerminal, type TerminalHandle } from '$lib/terminal';
	import { connectVnc, type VncHandle } from '$lib/vnc';

	type Project = { id: string; name: string };
	type Machine = {
		id: string;
		state: string;
		ready: boolean;
		region: string;
		expires_at: string;
		project_id: string;
		template?: string;
		network_policy?: {
			mode: 'off' | 'allowlist';
			hostnames: string[];
			cidrs: string[];
		};
		failure_reason?: string;
		resources?: { vcpus: number; memory_mb: number; disk_mb: number };
	};
	type Execution = {
		stdout: string;
		stderr: string;
		exit_code: number | null;
		timed_out: boolean;
		duration_ms: number;
	};

	let projects = $state<Project[]>([]);
	let projectId = $state('');
	let machines = $state<Machine[]>([]);
	let templateName = $state('python');
	let ttlSeconds = $state(900);
	let vcpus = $state(1);
	let memoryMb = $state(512);
	let diskMb = $state(5120);
	let launching = $state(false);
	let loading = $state(true);
	let loadError = $state('');
	let actionError = $state('');
	let actionNotice = $state('');
	let busy = $state<Record<string, string>>({});
	let pendingDestroyId = $state('');
	let selectedMachineId = $state('');
	let extensionSeconds = $state(900);
	let forkCount = $state(1);
	let command = $state('uname -a');
	let execution = $state<Execution>();
	let previewPort = $state(3000);
	let previewLink = $state('');
	let connectionKind = $state<'tty' | 'vnc' | ''>('');
	let connectionStatus = $state('');
	let terminalHost = $state<HTMLDivElement>();
	let vncScreen = $state<HTMLDivElement>();
	let terminalHandle: TerminalHandle | undefined;
	let vncHandle: VncHandle | null | undefined;
	let connectionGeneration = 0;
	let refreshInFlight = $state(false);
	let refreshGeneration = 0;

	const selectedMachine = $derived(machines.find((machine) => machine.id === selectedMachineId));
	const isTerminal = (machine: Machine) => ['stopped', 'failed', 'lost'].includes(machine.state);
	const isBusy = (id: string) => Boolean(busy[id]);
	const formatExpiry = (value: string) => {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	};
	function setBusy(id: string, action?: string) {
		const next = { ...busy };
		if (action) next[id] = action;
		else delete next[id];
		busy = next;
	}

	function clearActionFeedback() {
		actionError = '';
		actionNotice = '';
		previewLink = '';
	}

	function disconnectConnection() {
		connectionGeneration += 1;
		terminalHandle?.cleanup();
		vncHandle?.teardown();
		terminalHandle = undefined;
		vncHandle = undefined;
		connectionKind = '';
		connectionStatus = '';
	}

	async function refreshMachines(silent = false) {
		if (!projectId) return;
		// A newer refresh (e.g. after a project switch) supersedes this one, so a
		// stale in-flight response is never applied under a different selection.
		const generation = ++refreshGeneration;
		const requestedProjectId = projectId;
		refreshInFlight = true;
		if (!silent) loadError = '';
		try {
			const result = (
				await dashboardApi<{ machines: Machine[] }>(
					`/v1/machines?project_id=${encodeURIComponent(requestedProjectId)}`
				)
			).machines;
			if (generation !== refreshGeneration || requestedProjectId !== projectId) return;
			machines = result;
			if (selectedMachineId && !machines.some((machine) => machine.id === selectedMachineId)) {
				selectedMachineId = '';
			}
		} catch (cause) {
			if (generation === refreshGeneration && !silent) {
				loadError = cause instanceof Error ? cause.message : String(cause);
			}
		} finally {
			if (generation === refreshGeneration) refreshInFlight = false;
		}
	}

	async function initialize() {
		loading = true;
		loadError = '';
		try {
			projects = (await dashboardApi<{ projects: Project[] }>('/v1/projects')).projects;
			if (!projects.some((project) => project.id === projectId)) {
				projectId = projects[0]?.id ?? '';
			}
			if (projectId) await refreshMachines();
			else machines = [];
		} catch (cause) {
			loadError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}

	async function changeProject(id: string) {
		disconnectConnection();
		projectId = id;
		machines = [];
		selectedMachineId = '';
		execution = undefined;
		clearActionFeedback();
		await refreshMachines();
	}

	async function launch() {
		if (!projectId) return;
		launching = true;
		clearActionFeedback();
		let retryKey = '';
		try {
			const payload = {
				project_id: projectId,
				template: templateName.trim(),
				ttl_seconds: ttlSeconds,
				vcpus,
				memory_mb: memoryMb,
				disk_mb: diskMb,
				network_policy: { mode: 'off', hostnames: [], cidrs: [] }
			};
			const operation = durableOperation(localStorage, `machine.create:${projectId}`, payload);
			retryKey = operation.idempotencyKey;
			const created = await dashboardApi<Machine>('/v1/machines', {
				method: 'POST',
				headers: { 'idempotency-key': operation.idempotencyKey },
				body: JSON.stringify(payload)
			});
			operation.complete();
			selectedMachineId = created.id;
			actionNotice = `Machine ${created.id} was accepted and is ${created.ready ? 'ready' : 'starting'}.`;
			await refreshMachines();
		} catch (cause) {
			actionError = `${cause instanceof Error ? cause.message : String(cause)}${retryKey ? ` Safe retry key: ${retryKey}` : ''}`;
		} finally {
			launching = false;
		}
	}

	async function destroy(id: string) {
		clearActionFeedback();
		setBusy(id, 'Stopping…');
		try {
			await dashboardApi(`/v1/machines/${encodeURIComponent(id)}`, { method: 'DELETE' });
			if (selectedMachineId === id) disconnectConnection();
			pendingDestroyId = '';
			actionNotice = `Machine ${id} is stopping.`;
			await refreshMachines();
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			setBusy(id);
		}
	}

	async function extend(id: string) {
		clearActionFeedback();
		setBusy(id, 'Extending…');
		const payload = { ttl_seconds: extensionSeconds };
		const operation = durableOperation(localStorage, `machine.extend:${id}`, payload);
		try {
			await dashboardApi(`/v1/machines/${encodeURIComponent(id)}/extend`, {
				method: 'POST',
				headers: { 'idempotency-key': operation.idempotencyKey },
				body: JSON.stringify(payload)
			});
			operation.complete();
			actionNotice = `Machine ${id} was extended by ${extensionSeconds} seconds.`;
			await refreshMachines();
		} catch (cause) {
			actionError = `${cause instanceof Error ? cause.message : String(cause)} Safe retry key: ${operation.idempotencyKey}`;
		} finally {
			setBusy(id);
		}
	}

	async function exec(id: string) {
		if (!command.trim()) return;
		clearActionFeedback();
		execution = undefined;
		setBusy(id, 'Running…');
		try {
			execution = await dashboardApi<Execution>(`/v1/machines/${encodeURIComponent(id)}/exec`, {
				method: 'POST',
				body: JSON.stringify({ command, timeout_seconds: 30 })
			});
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			setBusy(id);
		}
	}

	async function fork(id: string) {
		clearActionFeedback();
		setBusy(id, 'Forking…');
		const payload = { count: forkCount };
		const requestOperation = durableOperation(localStorage, `machine.fork:${id}`, payload);
		try {
			const result = await dashboardApi<
				| Machine
				| {
						machines: Machine[];
						requested: number;
						operation?: { id: string; state: string; idempotency_key?: string };
				  }
			>(`/v1/machines/${encodeURIComponent(id)}/fork`, {
				method: 'POST',
				headers: { 'idempotency-key': requestOperation.idempotencyKey },
				body: JSON.stringify(payload)
			});
			const children = 'machines' in result ? result.machines : [result];
			const forkOperation = 'operation' in result ? result.operation : undefined;
			if (
				forkOperation?.idempotency_key !== undefined &&
				forkOperation.idempotency_key !== requestOperation.idempotencyKey
			) {
				throw new Error('Fork recovery identity did not match the submitted operation.');
			}
			actionNotice = forkOperation
				? `Fork operation ${forkOperation.id} is ${forkOperation.state}; retry unchanged with key ${requestOperation.idempotencyKey}. All ${forkCount} children stay hidden until the batch is ready.`
				: `Created ${children.length} ready fork${children.length === 1 ? '' : 's'} from ${id}.`;
			if (!forkOperation) requestOperation.complete();
			if (children[0]?.id) selectedMachineId = children[0].id;
			await refreshMachines();
		} catch (cause) {
			actionError = `${cause instanceof Error ? cause.message : String(cause)} Safe retry key: ${requestOperation.idempotencyKey}`;
		} finally {
			setBusy(id);
		}
	}

	async function issueSession(
		id: string,
		capability: 'tty' | 'vnc' | 'preview'
	): Promise<DashboardMachineSession> {
		return dashboardApi(`/v1/machines/${encodeURIComponent(id)}/sessions`, {
			method: 'POST',
			body: JSON.stringify({
				capabilities: [capability],
				...(capability === 'preview' ? { port: previewPort } : {}),
				ttl_seconds: 300
			})
		});
	}

	async function connectSession(id: string, capability: 'tty' | 'vnc') {
		clearActionFeedback();
		disconnectConnection();
		const generation = connectionGeneration;
		setBusy(id, 'Issuing session…');
		try {
			const session = await issueSession(id, capability);
			if (generation !== connectionGeneration) return;
			const connection = machineWebSocketSession(session, id, capability);
			connectionKind = capability;
			connectionStatus = 'Connecting…';
			await tick();
			if (generation !== connectionGeneration) return;
			if (capability === 'tty') {
				if (!terminalHost) throw new Error('The terminal could not be mounted');
				const handle = await setupTerminal({
					host: terminalHost,
					machineId: id,
					connection,
					bannerText: '\r\nNehemiah Cloud terminal\r\n',
					onClose: () => {
						if (generation === connectionGeneration) connectionStatus = 'Session disconnected.';
					}
				});
				if (generation !== connectionGeneration) {
					handle.cleanup();
					return;
				}
				terminalHandle = handle;
				connectionStatus = `TTY session active · expires in ${session.expires_in} seconds`;
			} else {
				if (!vncScreen) throw new Error('The desktop could not be mounted');
				const handle = await connectVnc(
					{
						screen: vncScreen,
						machineId: id,
						connection,
						onConnect: () => {
							if (generation === connectionGeneration) {
								connectionStatus = `Desktop session active · expires in ${session.expires_in} seconds`;
							}
						},
						onDisconnect: () => {
							if (generation === connectionGeneration) connectionStatus = 'Session disconnected.';
						}
					},
					() => generation !== connectionGeneration
				);
				if (generation !== connectionGeneration) {
					handle?.teardown();
					return;
				}
				vncHandle = handle;
			}
		} catch (cause) {
			disconnectConnection();
			actionError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			setBusy(id);
		}
	}

	async function openPreview(id: string) {
		clearActionFeedback();
		const popup = window.open('about:blank', '_blank');
		if (popup) popup.opener = null;
		setBusy(id, 'Opening preview…');
		try {
			const session = await issueSession(id, 'preview');
			previewLink = machinePreviewUrl(session, id, previewPort);
			if (popup) {
				popup.location.replace(previewLink);
				actionNotice = `Preview opened on port ${previewPort}. The session expires in ${session.expires_in} seconds.`;
			} else {
				actionNotice = 'Your browser blocked the new tab. Use the preview link below.';
			}
		} catch (cause) {
			popup?.close();
			actionError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			setBusy(id);
		}
	}

	function openIssuedPreview() {
		if (previewLink) window.open(previewLink, '_blank', 'noopener,noreferrer');
	}

	onMount(() => {
		void initialize();
		const interval = window.setInterval(() => void refreshMachines(true), 10_000);
		return () => {
			window.clearInterval(interval);
			disconnectConnection();
		};
	});
</script>

<div class="flex flex-wrap items-center justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold">Machines</h1>
		<p class="mt-1 text-sm text-ink-muted">
			Launch and operate isolated computers in the selected project.
		</p>
	</div>
	<button
		class="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
		disabled={loading || refreshInFlight}
		onclick={() => void refreshMachines()}>Refresh</button
	>
</div>

<form
	class="mt-6 grid gap-3 rounded-geist border border-line bg-surface p-5 sm:grid-cols-2 lg:grid-cols-6"
	onsubmit={(event) => {
		event.preventDefault();
		void launch();
	}}
>
	<label class="text-xs text-ink-muted sm:col-span-2"
		>Project
		<select
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
			value={projectId}
			disabled={launching}
			onchange={(event) => void changeProject(event.currentTarget.value)}
		>
			{#each projects as project (project.id)}<option value={project.id}>{project.name}</option
				>{/each}
		</select>
	</label>
	<label class="text-xs text-ink-muted sm:col-span-2"
		>Template
		<input
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 font-mono text-sm"
			bind:value={templateName}
			required
		/>
	</label>
	<label class="text-xs text-ink-muted lg:col-span-2"
		>Lifetime (seconds)
		<input
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
			type="number"
			min="15"
			max="86400"
			bind:value={ttlSeconds}
			required
		/>
	</label>
	<label class="text-xs text-ink-muted"
		>vCPUs
		<input
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
			type="number"
			min="1"
			max="4"
			bind:value={vcpus}
			required
		/>
	</label>
	<label class="text-xs text-ink-muted sm:col-span-2 lg:col-span-2"
		>Memory (MiB)
		<input
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
			type="number"
			min="128"
			max="4096"
			step="128"
			bind:value={memoryMb}
			required
		/>
	</label>
	<div class="text-xs text-ink-muted sm:col-span-2">
		Guest egress: <span class="text-ink">off</span>. Managed public networking remains disabled
		until hard organization, project, and host-network traffic quotas are enforced.
	</div>
	<label class="text-xs text-ink-muted sm:col-span-2 lg:col-span-2"
		>Disk (MiB)
		<input
			class="mt-2 w-full rounded-geist border border-line bg-black px-3 py-2 text-sm"
			type="number"
			min="512"
			max="20480"
			step="512"
			bind:value={diskMb}
			required
		/>
	</label>
	<button
		class="self-end rounded-geist bg-ink px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
		disabled={!projectId || launching}>{launching ? 'Launching…' : 'Launch machine'}</button
	>
</form>

{#if loadError}<p
		class="mt-4 rounded-geist border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300"
	>
		{loadError}
	</p>{/if}
{#if actionError}<p
		class="mt-4 rounded-geist border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300"
		aria-live="polite"
	>
		{actionError}
	</p>{/if}
{#if actionNotice}<p
		class="mt-4 rounded-geist border border-line bg-surface p-3 text-sm text-ink-muted"
		aria-live="polite"
	>
		{actionNotice}
	</p>{/if}
{#if previewLink}
	<button class="mt-3 text-sm font-semibold text-ink underline" onclick={openIssuedPreview}
		>Open preview</button
	>
{/if}

<div class="mt-6 overflow-x-auto rounded-geist border border-line">
	<table class="w-full text-left text-sm">
		<thead class="bg-surface text-xs text-ink-muted"
			><tr
				><th class="p-3">Machine</th><th class="p-3">State</th><th class="p-3">Expires</th><th
					class="p-3"
				></th></tr
			></thead
		>
		<tbody>
			{#each machines as machine (machine.id)}
				<tr class="border-t border-line {selectedMachineId === machine.id ? 'bg-surface/60' : ''}">
					<td class="p-3">
						<button
							class="text-left"
							onclick={() => {
								disconnectConnection();
								selectedMachineId = machine.id;
								execution = undefined;
								clearActionFeedback();
							}}
						>
							<span class="block font-mono text-xs text-ink">{machine.id}</span>
							<span class="mt-1 block text-xs text-ink-faint"
								>{machine.template ?? 'custom'} · {machine.region} · network {machine.network_policy
									?.mode ?? 'off'}</span
							>
						</button>
					</td>
					<td class="p-3"
						><span
							class={machine.ready
								? 'text-green-300'
								: machine.state === 'failed' || machine.state === 'lost'
									? 'text-red-300'
									: ''}>{machine.ready ? 'ready' : machine.state}</span
						></td
					>
					<td class="p-3 text-xs text-ink-muted">{formatExpiry(machine.expires_at)}</td>
					<td class="p-3 text-right">
						{#if pendingDestroyId === machine.id}
							<span class="inline-flex items-center gap-2">
								<button
									class="text-xs font-semibold text-red-300 hover:text-red-200 disabled:opacity-50"
									disabled={isBusy(machine.id)}
									onclick={() => void destroy(machine.id)}>Confirm stop</button
								>
								<button
									class="text-xs text-ink-muted hover:text-ink"
									onclick={() => {
										pendingDestroyId = '';
									}}>Cancel</button
								>
							</span>
						{:else if !isTerminal(machine)}
							<button
								class="text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
								disabled={isBusy(machine.id)}
								onclick={() => {
									pendingDestroyId = machine.id;
								}}>Stop</button
							>
						{/if}
					</td>
				</tr>
			{:else}
				<tr
					><td class="p-5 text-ink-muted" colspan="4"
						>{loading
							? 'Loading machines…'
							: projectId
								? 'No machines in this project.'
								: 'Create a project before launching a machine.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>

{#if selectedMachine}
	{@const machine = selectedMachine}
	<section class="mt-6 rounded-geist border border-line bg-surface p-5">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="font-semibold">Machine tools</h2>
				<p class="mt-1 font-mono text-xs text-ink-faint">{machine.id}</p>
			</div>
			{#if busy[machine.id]}<span class="text-xs text-ink-muted">{busy[machine.id]}</span>{/if}
		</div>
		{#if machine.failure_reason}<p class="mt-4 text-sm text-red-300">
				{machine.failure_reason}
			</p>{/if}
		<div class="mt-5 grid gap-6 lg:grid-cols-3">
			<div>
				<h3 class="text-sm font-semibold">Lifetime</h3>
				<p class="mt-1 text-xs text-ink-muted">Expires {formatExpiry(machine.expires_at)}</p>
				<form
					class="mt-3 flex gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						void extend(machine.id);
					}}
				>
					<label class="sr-only" for="extension-seconds">Extension seconds</label>
					<input
						id="extension-seconds"
						class="min-w-0 flex-1 rounded-geist border border-line bg-black px-3 py-2 text-sm"
						type="number"
						min="15"
						max="86400"
						bind:value={extensionSeconds}
						required
					/>
					<button
						class="rounded-geist border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50"
						disabled={isBusy(machine.id) || isTerminal(machine)}>Extend</button
					>
				</form>
			</div>
			<div>
				<h3 class="text-sm font-semibold">Fork</h3>
				<p class="mt-1 text-xs text-ink-muted">Batch forks are all-ready or cleaned up together.</p>
				<form
					class="mt-3 flex gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						void fork(machine.id);
					}}
				>
					<label class="sr-only" for="fork-count">Fork count</label>
					<input
						id="fork-count"
						class="w-24 rounded-geist border border-line bg-black px-3 py-2 text-sm"
						type="number"
						min="1"
						max="8"
						bind:value={forkCount}
						required
					/>
					<button
						class="rounded-geist border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50"
						disabled={!machine.ready || isBusy(machine.id)}>Fork</button
					>
				</form>
			</div>
			<div>
				<h3 class="text-sm font-semibold">Connections</h3>
				<p class="mt-1 text-xs text-ink-muted">
					Sessions are capability-scoped and expire after five minutes.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<button
						class="rounded-geist border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50"
						disabled={!machine.ready || isBusy(machine.id)}
						onclick={() => void connectSession(machine.id, 'tty')}>Open TTY</button
					>
					<button
						class="rounded-geist border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50"
						disabled={!machine.ready || isBusy(machine.id)}
						onclick={() => void connectSession(machine.id, 'vnc')}>Open desktop</button
					>
					{#if connectionKind}<button
							class="rounded-geist border border-line px-3 py-2 text-xs text-ink-muted hover:text-ink"
							onclick={disconnectConnection}>Disconnect</button
						>{/if}
				</div>
				<form
					class="mt-2 flex gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						void openPreview(machine.id);
					}}
				>
					<label class="sr-only" for="preview-port">Preview port</label>
					<input
						id="preview-port"
						class="w-28 rounded-geist border border-line bg-black px-3 py-2 text-sm"
						type="number"
						min="1"
						max="65535"
						bind:value={previewPort}
						required
					/>
					<button
						class="rounded-geist border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50"
						disabled={!machine.ready || isBusy(machine.id)}>Open preview</button
					>
				</form>
			</div>
		</div>
		{#if connectionKind}
			<div class="mt-6 overflow-hidden rounded-geist border border-line bg-black">
				<div
					class="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-ink-muted"
				>
					<span>{connectionKind === 'tty' ? 'Terminal' : 'Desktop'}</span><span
						>{connectionStatus}</span
					>
				</div>
				{#if connectionKind === 'tty'}
					<div class="h-96 p-2" bind:this={terminalHost}></div>
				{:else}
					<div class="h-[32rem] overflow-hidden" bind:this={vncScreen}></div>
				{/if}
			</div>
		{/if}
		<div class="mt-6 border-t border-line pt-5">
			<h3 class="text-sm font-semibold">Execute a command</h3>
			<form
				class="mt-3 grid gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					void exec(machine.id);
				}}
			>
				<textarea
					class="min-h-20 rounded-geist border border-line bg-black px-3 py-2 font-mono text-sm"
					bind:value={command}
					maxlength="65536"
					spellcheck="false"
					required></textarea>
				<button
					class="justify-self-start rounded-geist bg-ink px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
					disabled={!machine.ready || isBusy(machine.id)}>Run command</button
				>
			</form>
			{#if execution}
				<div class="mt-4 overflow-hidden rounded-geist border border-line bg-black">
					<div
						class="flex flex-wrap justify-between gap-2 border-b border-line px-3 py-2 text-xs text-ink-muted"
					>
						<span>Exit {execution.exit_code ?? '—'}{execution.timed_out ? ' · timed out' : ''}</span
						><span>{execution.duration_ms} ms</span>
					</div>
					{#if execution.stdout}<pre
							class="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-ink">{execution.stdout}</pre>{/if}
					{#if execution.stderr}<pre
							class="max-h-80 overflow-auto whitespace-pre-wrap border-t border-line p-3 font-mono text-xs text-red-200">{execution.stderr}</pre>{/if}
					{#if !execution.stdout && !execution.stderr}<p class="p-3 text-xs text-ink-faint">
							Command produced no output.
						</p>{/if}
				</div>
			{/if}
		</div>
	</section>
{/if}

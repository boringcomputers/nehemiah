<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { onMount } from 'svelte';
	import {
		apiBase,
		createMachine,
		getMachine,
		branchMachine,
		extendMachine,
		createVolume,
		publishMachine,
		saveMachine,
		previewUrl,
		type Machine
	} from '$lib/boring';
	import { createCountdown } from '$lib/countdown';
	import { copyMachineUrl } from '$lib/clipboard';
	import { setupTerminal, type TerminalHandle } from '$lib/terminal';
	import { connectVnc, type VncHandle } from '$lib/vnc';
	import { connectAgent } from '$lib/agent-ws';

	// One computer, everything on it: a live desktop (browser + GUI over VNC), its
	// serial shell as a real terminal (coding agents preinstalled), and a prompt
	// box that turns the whole thing over to an AI. All one desktop microVM.

	type Phase = 'booting' | 'connecting' | 'live' | 'error' | 'closed';
	let {
		onClose,
		ttl = 300,
		machineId,
		volume,
		persistent = false
	}: {
		onClose?: () => void;
		ttl?: number;
		machineId?: string;
		volume?: string;
		persistent?: boolean;
	} = $props();

	let phase = $state<Phase>('booting');
	let machine = $state<Machine | null>(null);
	let error = $state('');
	let remaining = $state(0);
	let shared = $state(false);
	let copied = $state(false);
	let tab = $state<'desktop' | 'terminal'>('desktop');

	// VNC desktop
	let screen = $state<HTMLDivElement>();
	let vncHandle: VncHandle | null = null;
	let attempts = 0;

	// Serial terminal
	let termHost = $state<HTMLDivElement>();
	let termHandle: TerminalHandle | null = null;

	// AI prompt box (drives the computer-use agent on this machine)
	let goal = $state('');
	let agentRunning = $state(false);
	let agentLine = $state('');
	let agentWs: WebSocket | null = null;

	// Preview: open a port running inside this computer at a public URL.
	let previewPort = $state('');
	function openPreview() {
		const p = parseInt(previewPort, 10);
		if (!machine || !Number.isInteger(p) || p < 1 || p > 65535) return;
		window.open(previewUrl(machine.id, p), '_blank', 'noopener');
	}
	function previewKey(e: KeyboardEvent) {
		if (e.key === 'Enter') openPreview();
	}

	// File transfer: drag-drop to upload into /root, a path box to download.
	let dragOver = $state(false);
	let fileMsg = $state('');
	let dlPath = $state('');

	async function uploadFiles(files: FileList | File[]) {
		if (!machine) return;
		for (const f of Array.from(files)) {
			fileMsg = `⤒ uploading ${f.name}…`;
			try {
				const res = await fetch(`${apiBase}/v1/machines/${machine.id}/upload`, {
					method: 'POST',
					headers: { 'X-Filename': f.name },
					body: f
				});
				const j = await res.json().catch(() => ({}));
				fileMsg = res.ok ? `⤒ ${f.name} → ${j.path}` : `⚠ ${j.error ?? 'upload failed'}`;
			} catch {
				fileMsg = '⚠ upload failed';
			}
		}
		setTimeout(() => (fileMsg = ''), 5000);
	}

	async function downloadFile() {
		const p = dlPath.trim();
		if (!p || !machine) return;
		fileMsg = `⤓ fetching ${p}…`;
		try {
			const res = await fetch(
				`${apiBase}/v1/machines/${machine.id}/download?path=${encodeURIComponent(p)}`
			);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				fileMsg = `⚠ ${j.error ?? 'not found'}`;
			} else {
				const blob = await res.blob();
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = p.split('/').pop() || 'file';
				a.click();
				URL.revokeObjectURL(url);
				fileMsg = `⤓ downloaded ${a.download}`;
			}
		} catch {
			fileMsg = '⚠ download failed';
		}
		setTimeout(() => (fileMsg = ''), 5000);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files?.length) void uploadFiles(e.dataTransfer.files);
	}

	// Fork: clone this live computer into a new one, opened in a new tab.
	let forking = $state(false);
	async function fork() {
		if (!machine || forking) return;
		forking = true;
		fileMsg = '⑂ cloning this computer…';
		try {
			const f = await branchMachine(machine.id);
			window.open(`${location.origin}/c/${f.id}`, '_blank');
			fileMsg = '⑂ forked → opened in a new tab';
		} catch (e) {
			fileMsg = '⚠ ' + (e instanceof Error ? e.message : 'fork failed');
		} finally {
			forking = false;
			setTimeout(() => (fileMsg = ''), 5000);
		}
	}

	// Save: persist /root to a volume that outlives the machine. Reuses the
	// attached volume if there is one, else makes a new volume; surfaces a restore
	// link (?restore=vol-…) so you can reopen the work in a fresh computer.
	let saving = $state(false);
	async function save() {
		if (!machine || saving) return;
		saving = true;
		fileMsg = '💾 saving to storage…';
		try {
			const vol = volume ?? (await createVolume()).id;
			await saveMachine(machine.id, vol);
			const link = `${location.origin}/?restore=${vol}`;
			await navigator.clipboard?.writeText(link).catch(() => {});
			fileMsg = `💾 saved → ${vol} · restore link copied`;
		} catch (e) {
			fileMsg = '⚠ ' + (e instanceof Error ? e.message : 'save failed');
		} finally {
			saving = false;
			setTimeout(() => (fileMsg = ''), 8000);
		}
	}

	// Publish: freeze this machine's exact state as a named template — future
	// machines boot from it in milliseconds. The name field toggles inline.
	let publishing = $state(false);
	let publishOpen = $state(false);
	let publishName = $state('');
	async function publish() {
		const name = publishName.trim();
		if (!machine || publishing || !name) return;
		publishing = true;
		fileMsg = '📀 publishing template…';
		try {
			const t = await publishMachine(machine.id, name);
			publishOpen = false;
			publishName = '';
			fileMsg = `📀 published as "${t.name}" — new machines boot it in ms`;
		} catch (e) {
			fileMsg = '⚠ ' + (e instanceof Error ? e.message : 'publish failed');
		} finally {
			publishing = false;
			setTimeout(() => (fileMsg = ''), 8000);
		}
	}

	// Extend: reset the TTL when you need a few more minutes. The countdown
	// restarts from the machine's new expiry.
	let extending = $state(false);
	async function extend() {
		if (!machine || extending) return;
		extending = true;
		try {
			machine = await extendMachine(machine.id, 300);
			timer.start(machine);
		} catch (e) {
			fileMsg = '⚠ ' + (e instanceof Error ? e.message : 'extend failed');
			setTimeout(() => (fileMsg = ''), 5000);
		} finally {
			extending = false;
		}
	}

	let disposed = false;
	const MAX_ATTEMPTS = 10;
	const timer = createCountdown(
		() => ttl,
		(r) => (remaining = r)
	);

	onMount(() => {
		void launch();
		return () => close();
	});

	async function launch() {
		phase = 'booting';
		error = '';
		try {
			machine = machineId
				? await getMachine(machineId)
				: await createMachine('desktop', ttl, true, volume, persistent);
			phase = 'connecting';
			// A persistent machine has no expiry, so don't run a countdown.
			if (!machine.persistent) timer.start(machine);
			void openTerminal(machine.id);
			const painted = machineId || machine.mode === 'warm';
			setTimeout(doConnectVNC, painted ? 400 : 4500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			phase = 'error';
		}
	}

	// --- desktop (noVNC) ---
	async function doConnectVNC() {
		if (disposed || !machine || !screen) return;
		attempts += 1;
		try {
			vncHandle = await connectVnc(
				{
					screen,
					machineId: machine.id,
					qualityLevel: 7,
					compressionLevel: 1,
					onConnect: () => {
						if (!disposed) phase = 'live';
					},
					onDisconnect: () => {
						if (disposed) return;
						if (phase !== 'live' && attempts < MAX_ATTEMPTS) setTimeout(doConnectVNC, 1500);
						else if (phase === 'live') {
							phase = 'closed';
							timer.stop();
						}
					}
				},
				() => disposed
			);
		} catch {
			if (attempts < MAX_ATTEMPTS) setTimeout(doConnectVNC, 1500);
		}
	}

	// --- terminal (xterm over the guest serial) ---
	async function openTerminal(id: string) {
		termHandle = await setupTerminal({
			host: termHost!,
			machineId: id,
			fontSize: 12,
			theme: { background: '#0a0a0a', foreground: '#ededed', cursor: '#ededed', green: '#00ca50' },
			bannerText:
				'\x1b[38;5;244mboring computers · desktop shell · node · claude · codex · cursor · pi\r\n' +
				'run a server (e.g. python3 -m http.server 8000) then use "preview ↗" up top to open it\x1b[0m\r\n'
		});
	}

	function showTerminal() {
		tab = 'terminal';
		setTimeout(() => {
			termHandle?.fit?.fit();
			termHandle?.term?.focus();
		}, 40);
	}

	// --- AI prompt box ---
	// "drive" hands the machine to the computer-use agent (clicks the screen);
	// "build" hands it to the terminal agent (writes + runs code, ships a preview).
	let agentMode = $state<'drive' | 'build'>('build');
	let previewLink = $state('');

	function runAgent() {
		const g = goal.trim();
		if (!g || agentRunning || !machine || phase !== 'live') return;
		const build = agentMode === 'build';
		agentRunning = true;
		previewLink = '';
		agentLine = build ? 'getting to work…' : 'looking at the screen…';
		if (build) {
			showTerminal();
		} else {
			tab = 'desktop';
			if (vncHandle?.rfb) vncHandle.rfb.viewOnly = true;
		}
		const path = build
			? `/v1/machines/${machine.id}/shell-agent?goal=${encodeURIComponent(g)}`
			: `/v1/machines/${machine.id}/agent?goal=${encodeURIComponent(g)}`;
		const finish = () => {
			agentRunning = false;
			if (!build && vncHandle?.rfb) vncHandle.rfb.viewOnly = false;
		};
		agentWs = connectAgent(machine.id, path, {
			onPreview: (text) => {
				const port = parseInt(text, 10);
				if (machine && Number.isInteger(port)) previewLink = previewUrl(machine.id, port);
			},
			onDone: (text) => {
				agentLine = text || 'done ✓';
				finish();
			},
			onError: (text) => {
				agentLine = '⚠ ' + (text || 'something went wrong');
				finish();
			},
			onSay: (text) => (agentLine = text),
			onAction: (text) => (agentLine = text),
			onClose: finish
		});
	}

	function promptKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			runAgent();
		}
	}

	// --- lifecycle ---
	async function copyShare() {
		if (!machine) return;
		const ok = await copyMachineUrl(machine.id);
		if (ok) {
			shared = true;
			copied = true;
			setTimeout(() => (copied = false), 1600);
		}
	}

	export function close() {
		disposed = true;
		timer.stop();
		try {
			agentWs?.close();
		} catch {
			/* ignore */
		}
		agentWs = null;
		vncHandle?.teardown();
		vncHandle = null;
		termHandle?.cleanup();
		termHandle = null;
		if (machine && !shared && !machineId) {
			void fetch(`${apiBase}/v1/machines/${machine.id}`, { method: 'DELETE' }).catch(() => {});
		}
		machine = null;
		phase = 'closed';
		onClose?.();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="relative flex h-full flex-col bg-black font-mono text-[12px]"
	ondragover={(e) => {
		if (phase === 'live') {
			e.preventDefault();
			dragOver = true;
		}
	}}
	ondragleave={() => (dragOver = false)}
	ondrop={onDrop}
>
	{#if dragOver}
		<div
			class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-accent/70 bg-black/70 text-[13px] text-ink"
		>
			drop to upload into /root
		</div>
	{/if}
	<!-- status + tabs -->
	<div class="flex items-center justify-between border-b border-line/70 px-3 py-1.5">
		<div class="flex min-w-0 items-center gap-2 text-ink-muted">
			{#if phase === 'booting'}
				<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>booting your
				computer…
			{:else if phase === 'connecting'}
				<span class="size-1.5 animate-pulse rounded-full bg-ink-subtle"></span>starting the display…
			{:else if phase === 'live'}
				<span class="size-1.5 rounded-full bg-success"></span><span class="truncate text-ink"
					>{machine?.id}</span
				>
			{:else if phase === 'error'}
				<span class="size-1.5 rounded-full bg-danger"></span><span class="truncate text-danger"
					>{error}</span
				>
			{:else}
				<span class="size-1.5 rounded-full bg-ink-faint"></span>computer stopped
			{/if}
		</div>
		<div class="flex items-center gap-1">
			<button
				onclick={() => (tab = 'desktop')}
				class="rounded-[5px] px-2 py-0.5 transition-colors {tab === 'desktop'
					? 'bg-white/10 text-ink'
					: 'text-ink-faint hover:text-ink-muted'}">desktop</button
			>
			<button
				onclick={showTerminal}
				class="rounded-[5px] px-2 py-0.5 transition-colors {tab === 'terminal'
					? 'bg-white/10 text-ink'
					: 'text-ink-faint hover:text-ink-muted'}">terminal</button
			>
		</div>
		<div class="flex items-center gap-3 text-ink-faint">
			{#if phase === 'live'}
				<span class="flex items-center gap-1" title="Open a port running inside this computer">
					<input
						bind:value={previewPort}
						onkeydown={previewKey}
						placeholder="port"
						inputmode="numeric"
						class="w-11 rounded-[4px] border border-line bg-black px-1 py-0.5 text-right text-ink placeholder:text-ink-faint focus:border-white/25 focus:outline-none"
					/>
					<button class="text-ink-subtle transition-colors hover:text-ink" onclick={openPreview}
						>preview ↗</button
					>
				</span>
				<span
					class="tabular-nums"
					title={machine?.persistent ? 'no auto-shutdown' : 'self-destructs'}
					>{machine?.persistent ? '∞ stays up' : `${remaining}s`}</span
				>
				{#if !machine?.persistent}
					<button
						class="text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
						onclick={extend}
						disabled={extending}
						title="Reset the self-destruct to 5 minutes from now"
						>{extending ? '…' : '+5 min'}</button
					>
				{/if}
				<button
					class="text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
					onclick={save}
					disabled={saving}
					title="Save this computer's files to storage that outlives it"
					>{saving ? 'saving…' : 'save 💾'}</button
				>
				<button
					class="text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
					onclick={fork}
					disabled={forking}
					title="Clone this running computer into a new one"
					>{forking ? 'forking…' : 'fork ⑂'}</button
				>
				{#if publishOpen}
					<span class="flex items-center gap-1">
						<input
							bind:value={publishName}
							onkeydown={(e) => {
								if (e.key === 'Enter') void publish();
								if (e.key === 'Escape') publishOpen = false;
							}}
							placeholder="template-name"
							class="w-28 rounded-[4px] border border-line bg-black px-1 py-0.5 text-ink placeholder:text-ink-faint focus:border-white/25 focus:outline-none"
						/>
						<button
							class="text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
							onclick={publish}
							disabled={publishing || !publishName.trim()}>{publishing ? '…' : 'ok'}</button
						>
					</span>
				{:else}
					<button
						class="text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
						onclick={() => (publishOpen = true)}
						disabled={publishing}
						title="Freeze this exact state as a named template — boot it again in milliseconds"
						>publish 📀</button
					>
				{/if}
				<button class="text-ink-subtle transition-colors hover:text-ink" onclick={copyShare}
					>{copied ? 'copied ✓' : 'share'}</button
				>
			{/if}
			<button class="text-ink-subtle transition-colors hover:text-ink" onclick={close}>✕</button>
		</div>
	</div>

	<!-- main viewport: desktop OR terminal -->
	<div class="relative min-h-0 flex-1">
		<div bind:this={screen} class="h-full w-full" class:hidden={tab !== 'desktop'}></div>
		<div class="h-full w-full overflow-hidden bg-[#0a0a0a] p-2" class:hidden={tab !== 'terminal'}>
			<div bind:this={termHost} class="h-full w-full"></div>
		</div>
		{#if tab === 'desktop' && phase !== 'live' && phase !== 'error'}
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center text-ink-subtle"
			>
				{phase === 'booting' ? 'allocating a computer…' : 'painting the screen…'}
			</div>
		{/if}
	</div>

	<!-- file bar: drag-drop upload feedback + download -->
	{#if phase === 'live'}
		<div class="flex items-center gap-2 border-t border-line/70 bg-black px-3 py-1 text-[11px]">
			<span class="min-w-0 flex-1 truncate {fileMsg ? 'text-ink-muted' : 'text-ink-faint'}">
				{fileMsg || 'drag a file in to upload it to /root'}
			</span>
			<input
				bind:value={dlPath}
				onkeydown={(e) => e.key === 'Enter' && downloadFile()}
				placeholder="/root/result.txt"
				class="w-40 rounded-[4px] border border-line bg-black px-1.5 py-0.5 text-ink placeholder:text-ink-faint focus:border-white/25 focus:outline-none"
			/>
			<button class="text-ink-subtle transition-colors hover:text-ink" onclick={downloadFile}
				>download ↓</button
			>
		</div>
	{/if}

	<!-- AI prompt box -->
	<div class="border-t border-line/70 bg-surface px-3 py-2">
		<div class="flex items-center gap-2">
			<span class="font-semibold text-accent">AI</span>
			<!-- mode: build (write + run code, ship a link) vs drive (use the screen) -->
			<span class="flex overflow-hidden rounded-full border border-line text-[10px]">
				<button
					onclick={() => (agentMode = 'build')}
					class="px-2 py-0.5 transition-colors {agentMode === 'build'
						? 'bg-white/10 text-ink'
						: 'text-ink-faint hover:text-ink-muted'}">build</button
				>
				<button
					onclick={() => (agentMode = 'drive')}
					class="px-2 py-0.5 transition-colors {agentMode === 'drive'
						? 'bg-white/10 text-ink'
						: 'text-ink-faint hover:text-ink-muted'}">drive</button
				>
			</span>
			<input
				bind:value={goal}
				onkeydown={promptKey}
				disabled={agentRunning || phase !== 'live'}
				placeholder={agentMode === 'build'
					? 'describe an app to build — “a snake game” — and I’ll ship you a live link'
					: 'tell your computer what to do — “search Wikipedia for Firecracker”'}
				class="min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-60"
			/>
			<button
				onclick={runAgent}
				disabled={agentRunning || phase !== 'live' || !goal.trim()}
				class="rounded-geist bg-ink px-2.5 py-1 text-[11px] text-black transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				{agentRunning ? 'working…' : 'run'}
			</button>
		</div>
		{#if agentLine || previewLink}
			<p class="mt-1.5 flex items-center gap-2 text-[11px] text-ink-muted">
				{#if agentRunning}<span class="size-1.5 animate-pulse rounded-full bg-accent"></span>{/if}
				<span class="min-w-0 truncate">{agentLine}</span>
				{#if previewLink}
					<button
						onclick={() => window.open(previewLink, '_blank', 'noopener')}
						class="ml-auto shrink-0 rounded-geist bg-accent/15 px-2 py-0.5 font-semibold text-accent transition-colors hover:bg-accent/25"
						>your app is live → open ↗</button
					>
				{/if}
			</p>
		{/if}
	</div>
</div>

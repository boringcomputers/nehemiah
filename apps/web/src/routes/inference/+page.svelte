<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { apiBase } from '$lib/boring';

	type Msg = { role: 'user' | 'assistant'; content: string };

	let models = $state<string[]>([]);
	let model = $state('claude-sonnet-4-6');
	let input = $state('');
	let messages = $state<Msg[]>([]);
	let busy = $state(false);
	let error = $state('');
	let scroller = $state<HTMLDivElement>();

	const home = resolve('/');

	onMount(async () => {
		try {
			const res = await fetch(`${apiBase}/v1/models`);
			const j = await res.json();
			models = (j.data ?? []).map((m: { id: string }) => m.id);
			if (models.length && !models.includes(model)) model = models[0];
		} catch {
			/* leave defaults */
		}
	});

	function providerOf(m: string) {
		return m.includes('claude') ? 'anthropic' : m.includes('/') ? m.split('/')[0] : 'openrouter';
	}

	async function send() {
		const text = input.trim();
		if (!text || busy) return;
		input = '';
		error = '';
		messages = [...messages, { role: 'user', content: text }];
		const assistant: Msg = { role: 'assistant', content: '' };
		messages = [...messages, assistant];
		busy = true;
		await tick();
		try {
			const res = await fetch(`${apiBase}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model,
					stream: true,
					max_tokens: 1024,
					messages: messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
				})
			});
			if (!res.ok || !res.body) {
				const t = await res.text().catch(() => '');
				throw new Error(t.slice(0, 160) || `gateway returned ${res.status}`);
			}
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const data = line.slice(5).trim();
					if (!data || data === '[DONE]') continue;
					try {
						const j = JSON.parse(data);
						const delta = j.choices?.[0]?.delta?.content;
						if (delta) {
							// Mutate through the $state array so the proxy sees the write —
							// writing to the captured raw `assistant` object doesn't rerender.
							messages[messages.length - 1].content += delta;
							await tick();
						}
					} catch {
						/* ignore keepalive / non-json */
					}
				}
			}
			if (!messages[messages.length - 1].content)
				messages[messages.length - 1].content = '(no response)';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			messages = messages.slice(0, -1); // drop the empty assistant bubble
		} finally {
			busy = false;
			messages = [...messages];
		}
	}

	async function tick() {
		await new Promise((r) => requestAnimationFrame(() => r(null)));
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}
</script>

<svelte:head>
	<title>Inference · Nehemiah</title>
	<meta name="description" content="One OpenAI-compatible endpoint for every model." />
</svelte:head>

<div class="mx-auto flex min-h-screen max-w-4xl flex-col px-5 pt-24 pb-6">
	<div class="mb-4">
		<h1 class="text-[22px] font-semibold tracking-[-0.03em] text-ink">Inference</h1>
		<p class="mt-1 text-[13px] leading-relaxed text-ink-muted">
			One OpenAI-compatible endpoint for every model. Claude runs on Anthropic; everything else
			routes through OpenRouter.
		</p>
	</div>

	<!-- model picker -->
	<div class="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11px]">
		<span class="text-ink-faint">model</span>
		{#each models as m (m)}
			<button
				onclick={() => (model = m)}
				class="rounded-full border px-2 py-0.5 transition-colors {model === m
					? 'border-white/30 text-ink'
					: 'border-line text-ink-faint hover:text-ink-muted'}"
			>
				{m}
			</button>
		{/each}
		{#if models.length}
			<span class="text-ink-faint">· via {providerOf(model)}</span>
		{/if}
	</div>

	<!-- conversation -->
	<div
		bind:this={scroller}
		class="min-h-[320px] flex-1 space-y-4 overflow-y-auto rounded-geist-lg border border-line bg-surface p-4"
	>
		{#if messages.length === 0}
			<p class="font-mono text-[12px] text-ink-faint">
				Ask anything. Try switching models to compare answers.
			</p>
		{/if}
		{#each messages as m, i (i)}
			<div class="flex flex-col gap-1">
				<span class="font-mono text-[10px] tracking-wide text-ink-faint uppercase"
					>{m.role === 'user' ? 'you' : model}</span
				>
				<div
					class="text-[13px] leading-relaxed whitespace-pre-wrap {m.role === 'user'
						? 'text-ink'
						: 'text-ink-muted'}"
				>
					{m.content}{#if busy && i === messages.length - 1 && m.role === 'assistant'}<span
							class="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-ink-subtle align-middle"
						></span>{/if}
				</div>
			</div>
		{/each}
		{#if error}
			<p class="font-mono text-[12px] text-danger">{error}</p>
		{/if}
	</div>

	<!-- input -->
	<div class="mt-3 flex items-end gap-2">
		<textarea
			bind:value={input}
			onkeydown={onKey}
			rows="2"
			placeholder="Message the model…  (Enter to send)"
			class="flex-1 resize-none rounded-geist border border-line bg-black px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-white/25 focus:outline-none"
		></textarea>
		<button
			onclick={send}
			disabled={busy || !input.trim()}
			class="rounded-geist bg-ink px-3 py-2 font-mono text-[12px] text-black transition-opacity hover:opacity-90 disabled:opacity-40"
		>
			{busy ? '…' : 'Send'}
		</button>
	</div>

	<a href={home} class="mt-6 font-mono text-[12px] text-ink-subtle transition-colors hover:text-ink"
		>← back to Nehemiah</a
	>
</div>

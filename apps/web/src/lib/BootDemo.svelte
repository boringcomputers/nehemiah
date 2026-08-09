<script lang="ts">
	import { onMount } from 'svelte';

	// A self-contained, looping simulation of the real thing for the static
	// showcase: boot a computer (curl → kernel log → NEHEMIAH_READY), type a task
	// into the AI box, watch the agent build it, then play the snake game it
	// shipped. Every line is lifted from actual runs — this is what the
	// interactive console does for real in local dev.

	type Phase = 'boot' | 'prompt' | 'build' | 'play';
	let phase = $state<Phase>('boot');
	let lines = $state<string[]>([]);
	let typed = $state('');
	let score = $state(0);
	let canvas = $state<HTMLCanvasElement | null>(null);

	const PROMPT = 'build a snake game I can play';

	// [text, css] pairs — boot log, then the agent's narration (verbatim).
	const BOOT: Array<[string, string]> = [
		[`$ curl -XPOST $BORING/v1/machines -d '{"template":"desktop"}'`, 'text-ink-muted'],
		[`→ {"id":"m-1a2b3c4d","mode":"coldboot","boot_ms":412}`, 'text-ink-muted'],
		['[    0.000000] Booting Linux on physical CPU 0x0', 'text-ink-faint'],
		['[    0.084731] Memory: 246128K/261752K available', 'text-ink-faint'],
		['[    0.312904] virtio-mmio: probing devices', 'text-ink-faint'],
		['[    0.398112] EXT4-fs (vda): mounted filesystem without journal', 'text-ink-faint'],
		['[    0.412086] Run /sbin/boring-init as init process', 'text-ink-faint'],
		['NEHEMIAH_READY', 'text-success'],
		['# desktop up · claude · codex · cursor · pi preinstalled', 'text-ink-muted']
	];
	const AGENT: Array<[string, string]> = [
		['● On it — let me get to work in the terminal.', 'text-ink-muted'],
		['● Creating the snake game HTML file now.', 'text-ink-muted'],
		[`$ cat > index.html <<'EOF'`, 'text-ink-faint'],
		['$ python3 -m http.server 8000 --bind 0.0.0.0 &', 'text-ink-faint'],
		['PORT=8000', 'text-ink-faint'],
		['✓ your app is live → open ↗', 'text-success']
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// --- the snake the agent "shipped": a tiny auto-player on a canvas --------
	const COLS = 26;
	const ROWS = 13;
	const CELL = 13;

	function runSnake(ctx: CanvasRenderingContext2D, until: number, alive: () => boolean) {
		return new Promise<void>((done) => {
			let snake = [{ x: 5, y: 6 }];
			let dir = { x: 1, y: 0 };
			let food = { x: 18, y: 6 };
			score = 0;

			const spawnFood = () => {
				do {
					food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
				} while (snake.some((s) => s.x === food.x && s.y === food.y));
			};
			const hits = (p: { x: number; y: number }) =>
				p.x < 0 ||
				p.y < 0 ||
				p.x >= COLS ||
				p.y >= ROWS ||
				snake.some((s) => s.x === p.x && s.y === p.y);

			const tick = () => {
				if (!alive()) return done();
				if (Date.now() >= until) return done();

				// Greedy auto-play: head toward the food, never into a wall or itself.
				const head = snake[0];
				const options = [dir, { x: dir.y, y: dir.x }, { x: -dir.y, y: -dir.x }]
					.map((d) => ({ d, next: { x: head.x + d.x, y: head.y + d.y } }))
					.filter((o) => !hits(o.next))
					.sort(
						(a, b) =>
							Math.abs(a.next.x - food.x) +
							Math.abs(a.next.y - food.y) -
							(Math.abs(b.next.x - food.x) + Math.abs(b.next.y - food.y))
					);
				if (options.length === 0) {
					// Boxed in — restart the game, just like pressing Space.
					snake = [{ x: 5, y: 6 }];
					dir = { x: 1, y: 0 };
					score = 0;
					spawnFood();
					setTimeout(tick, 350);
					return;
				}
				dir = options[0].d;
				const next = { x: head.x + dir.x, y: head.y + dir.y };
				snake.unshift(next);
				if (next.x === food.x && next.y === food.y) {
					score += 10;
					spawnFood();
				} else {
					snake.pop();
				}

				// draw
				ctx.fillStyle = '#000000';
				ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
				ctx.strokeStyle = '#1f2a1f';
				ctx.strokeRect(0.5, 0.5, COLS * CELL - 1, ROWS * CELL - 1);
				ctx.fillStyle = '#f87171';
				ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
				snake.forEach((s, i) => {
					ctx.fillStyle = i === 0 ? '#4ade80' : '#22c55e';
					ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
				});

				setTimeout(tick, 110);
			};
			tick();
		});
	}

	onMount(() => {
		let running = true;

		// Reduced motion: show the finished state, no animation.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			phase = 'build';
			lines = [...BOOT.map((_, i) => String(i)), ...AGENT.map((_, i) => `a${i}`)];
			typed = PROMPT;
			return;
		}

		(async () => {
			while (running) {
				// 1. boot
				phase = 'boot';
				lines = [];
				typed = '';
				for (let i = 0; i < BOOT.length; i++) {
					if (!running) return;
					lines = [...lines, String(i)]; // sentinel; resolved into BOOT at render
					await sleep(i < 2 ? 900 : i === BOOT.length - 1 ? 600 : 140);
				}
				await sleep(500);

				// 2. the prompt types itself
				phase = 'prompt';
				for (let i = 1; i <= PROMPT.length; i++) {
					if (!running) return;
					typed = PROMPT.slice(0, i);
					await sleep(42);
				}
				await sleep(550);

				// 3. the agent builds it
				phase = 'build';
				for (const [i] of AGENT.entries()) {
					if (!running) return;
					lines = [...lines, `a${i}`];
					await sleep(i === 0 ? 800 : 950);
				}
				await sleep(700);

				// 4. play the game it shipped
				phase = 'play';
				await sleep(60); // let the canvas mount
				const ctx = canvas?.getContext('2d');
				if (ctx) await runSnake(ctx, Date.now() + 12000, () => running);
				await sleep(400);
			}
		})();

		return () => {
			running = false;
		};
	});

	// Which lines to show: sentinels "0".."8" map into BOOT, "a0".."a5" into AGENT.
	const resolve = (s: string): [string, string] =>
		s.startsWith('a') ? AGENT[parseInt(s.slice(1), 10)] : BOOT[parseInt(s, 10)];
</script>

<div class="flex h-full flex-col p-4 font-mono text-[12px] leading-relaxed" aria-hidden="true">
	{#if phase === 'play'}
		<!-- the shipped app, playing -->
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
			<div class="text-[13px] font-semibold text-ink">
				🐍 Snake <span class="ml-3 font-normal text-ink-muted tabular-nums">Score: {score}</span>
			</div>
			<canvas
				bind:this={canvas}
				width={COLS * CELL}
				height={ROWS * CELL}
				class="max-w-full"
				style="width: min(100%, {COLS * CELL * 1.5}px); image-rendering: pixelated"
			></canvas>
			<div class="text-[11px] text-ink-faint">m-1a2b3c4d:8000 · built + served by the agent</div>
		</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-hidden">
			{#each lines as s (s)}
				{@const [text, css] = resolve(s)}
				<div class={css}>{text}</div>
			{/each}
			{#if phase === 'boot'}
				<span class="inline-block h-3.5 w-1.5 animate-pulse bg-ink-subtle align-middle"></span>
			{/if}
		</div>
		<!-- the AI box, same shape as the real console -->
		<div
			class="mt-2 flex shrink-0 items-center gap-2 rounded-geist border border-line px-2.5 py-1.5"
		>
			<span class="font-semibold text-accent">AI</span>
			<span class="text-ink-faint">build</span>
			<span class="min-w-0 flex-1 truncate text-ink"
				>{typed}{#if phase === 'prompt'}<span
						class="ml-px inline-block h-3.5 w-1.5 animate-pulse bg-ink-subtle align-middle"
					></span>{/if}</span
			>
			<span
				class="rounded-geist px-2 py-0.5 text-[11px] {phase === 'build'
					? 'bg-ink text-black'
					: 'bg-white/10 text-ink-faint'}">{phase === 'build' ? 'working…' : 'run'}</span
			>
		</div>
	{/if}
</div>

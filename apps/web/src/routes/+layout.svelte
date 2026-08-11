<script lang="ts">
	import './layout.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	const SITE = 'https://boringcomputers.com';
	const OG_DESC =
		'Instant Firecracker microVMs with a terminal, a real browser, coding agents preinstalled, and an AI that drives them.';
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta property="og:site_name" content="Nehemiah" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Computers that are refreshingly boring." />
	<meta property="og:description" content={OG_DESC} />
	<meta property="og:url" content="{SITE}{page.url.pathname}" />
	<meta property="og:image" content="{SITE}/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="Computers that are refreshingly boring." />
	<meta name="twitter:description" content={OG_DESC} />
	<meta name="twitter:image" content="{SITE}/og.png" />
</svelte:head>

<nav
	class="max-w-4xl mx-auto absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 py-4 font-mono text-[12px]"
>
	<a href={resolve('/')} class="font-semibold text-ink transition-opacity hover:opacity-80 p-2"
		>boring.</a
	>
	<div class="flex items-center gap-5">
		<a href={resolve('/docs')} class="text-ink-subtle transition-colors hover:text-ink">Docs</a>
		<a href={resolve('/status')} class="text-ink-subtle transition-colors hover:text-ink">Status</a>
		<a href={resolve('/dashboard')} class="text-ink-subtle transition-colors hover:text-ink"
			>Cloud</a
		>
		<a
			href="https://github.com/boringcomputers/nehemiah"
			target="_blank"
			rel="noopener"
			aria-label="Nehemiah on GitHub"
			class="text-ink-subtle transition-colors hover:text-ink"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 16 16"
				fill="currentColor"
				aria-hidden="true"
				class="block"
			>
				<path
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
				/>
			</svg>
		</a>
	</div>
</nav>

{@render children()}

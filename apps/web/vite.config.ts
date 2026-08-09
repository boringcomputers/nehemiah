import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';

// nehemiahd host daemon. Reads NEHEMIAH_URL / NEHEMIAH_TOKEN from apps/web/.env
// (or the shell); the pre-rename BORING_URL / BORING_TOKEN still work. Point it
// at your own nehemiahd — directly, or at a local port forwarded to a private box
// over an SSH tunnel. If that nehemiahd needs a token, set NEHEMIAH_TOKEN and it is
// injected here server-side (never the browser).
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const pick = (name: string): string =>
		env[`NEHEMIAH_${name}`] ||
		process.env[`NEHEMIAH_${name}`] ||
		env[`BORING_${name}`] ||
		process.env[`BORING_${name}`] ||
		'';
	const NEHEMIAH_URL = pick('URL') || 'http://localhost:8080';
	const NEHEMIAH_TOKEN = pick('TOKEN');

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter()
			})
		],
		server: {
			proxy: {
				// Browser -> /boring/* -> nehemiahd (token injected here, HTTP + WS).
				'/boring': {
					target: NEHEMIAH_URL,
					changeOrigin: true,
					ws: true,
					rewrite: (p: string) => p.replace(/^\/boring/, ''),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					configure: (proxy: any) => {
						if (!NEHEMIAH_TOKEN) return;
						const auth = `Bearer ${NEHEMIAH_TOKEN}`;
						proxy.on('proxyReq', (r: { setHeader: (k: string, v: string) => void }) =>
							r.setHeader('authorization', auth)
						);
						proxy.on('proxyReqWs', (r: { setHeader: (k: string, v: string) => void }) =>
							r.setHeader('authorization', auth)
						);
					}
				}
			}
		},
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'client',
						browser: {
							enabled: true,
							provider: playwright(),
							instances: [{ browser: 'chromium', headless: true }]
						},
						include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						exclude: ['src/lib/server/**']
					}
				},
				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
					}
				}
			]
		}
	};
});

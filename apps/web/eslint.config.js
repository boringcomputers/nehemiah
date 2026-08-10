import path from 'node:path';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import { svelteConfig } from '@nehemiah/eslint-config/svelte';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(includeIgnoreFile(gitignorePath), svelteConfig, {
	// Override or add app-specific rule settings here, such as:
	// 'svelte/button-has-type': 'error'
	rules: {}
});

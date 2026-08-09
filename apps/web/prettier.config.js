import config from '@nehemiah/prettier-config';

/**
 * Shared options live in @nehemiah/prettier-config (packages/prettier-config).
 * tailwindStylesheet is app-specific because the path is relative to this app.
 * @type {import("prettier").Config}
 */
export default {
	...config,
	tailwindStylesheet: './src/routes/layout.css'
};

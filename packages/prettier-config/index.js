/**
 * Shared Prettier config for the monorepo.
 * Apps may spread this and add app-specific options (e.g. tailwindStylesheet).
 * @type {import("prettier").Config}
 */
export default {
  useTabs: true,
  singleQuote: true,
  trailingComma: "none",
  printWidth: 100,
  plugins: ["prettier-plugin-svelte", "prettier-plugin-tailwindcss"],
  overrides: [
    {
      files: "*.svelte",
      options: {
        parser: "svelte",
      },
    },
  ],
};

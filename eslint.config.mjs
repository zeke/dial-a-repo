import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "worker-configuration.d.ts", ".wrangler/**"],
  },
  // Plain config files: basic TS linting only, no type-aware rules. They
  // aren't part of tsconfig.json's `include`, and aren't worth the setup
  // to make them so.
  {
    files: ["eslint.config.mjs", "vitest.config.ts"],
    extends: [tseslint.configs.recommended],
  },
  // Everything else: full type-aware linting against the real project.
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Cloudflare Workers/Durable Object bindings are typed via generated
      // Env types; the odd narrow `any` (e.g. parsed webhook JSON) is
      // intentional and reviewed by hand rather than blanket-banned.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);

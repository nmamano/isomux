import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "ui/dist/",
      "ui/index.js",
      "ui/sw.js",
      "internal-docs/",
      "server/backends/codex/_generated/",
      "site/",
      // Stale Claude Code worktree leftovers — gitignored on disk but not
      // by ESLint, so explicit ignore here.
      ".claude/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The codebase has accumulated `any` usage around SDK boundaries.
      // The `no-unsafe-*` family flags every downstream use, drowning real
      // findings. Disable until a typing cleanup pass lands; the
      // `no-explicit-any` warning below keeps the source of the issue visible.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Most async methods here exist to satisfy a Promise-returning interface
      // (slash command handlers, backend adapters) and don't always need their
      // own await. The rule flags interface-driven shapes more than real bugs.
      "@typescript-eslint/require-await": "off",
      // Common defensive pattern: `let x = "";` then assign inside try/catch
      // with an early return on catch. Removing the initial value requires
      // restructure for stylistic gain only. Disable.
      "no-useless-assignment": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["ui/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react-hooks v7 added many React Compiler-derived rules
      // (refs, set-state-in-effect, purity, immutability, static-components,
      // use-memo, preserve-manual-memoization, ...). They flag forward-looking
      // patterns rather than real bugs. Demote to warn so they remain visible
      // without failing CI. The two classic rules below stay as recommended.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/config": "warn",
      "react-hooks/gating": "warn",
    },
  },
  {
    files: ["**/*.cjs", "scripts/**/*", "deploy/**/*", "eslint.config.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.cjs", "scripts/**/*", "deploy/**/*", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.cjs", "scripts/**/*", "deploy/**/*", "eslint.config.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "ui/dist/",
      "browser-extension/dist/",
      "ui/sw.js",
      "internal-docs/",
      "server/backends/codex/_generated/",
      "site/",
      // Stale Claude Code worktree leftovers - gitignored on disk but not
      // by ESLint, so explicit ignore here.
      ".claude/",
      // Its own package, with its own config: typed linting there needs Next's
      // types, which exist only after the nested install. `bun run lint:web`
      // covers it, and `bun run ci` runs that.
      "control-plane/web/",
      // Measurement harnesses, each with its own eslint config: a nested
      // config under the typed root parser reports two tsconfig roots and
      // fails every file (CI 2026-09-16). Lint one with its own config.
      "prototypes/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Typed rules read one program, built from tsconfig.eslint.json: the
        // files linted with types and what they import. A file linted with
        // types that no file of that program reaches fails with a parse error.
        // The project service would type each file against tsconfig.json,
        // tests included: 3.81 GiB of heap against 1.95 GiB (task 6a872fe1).
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
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
    // Type-aware lint is off on test code. Typing the tests cost about 1 GB of
    // ESLint's 3 GB heap (task abf51744, 2026-11-02), and any one type-aware
    // rule left on them brings most of it back. They are out of
    // tsconfig.eslint.json too. tsc still checks the tests, and a wrong shape
    // there fails the test itself.
    files: [
      "**/*.test.{ts,tsx}",
      "server/test-support/**",
      "ui/test-support/**",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The control plane's store is Promise-based, and a DROPPED AWAIT there is
    // silent: `if (!store.casX(...))` on a promise is always falsy, which
    // deletes the "loser re-reads" path without failing anything. These four
    // rules are the fence, and they are pinned here rather than left to the
    // recommended preset so a future trim of that preset cannot remove them.
    // The same block exists in control-plane/web/eslint.config.mjs, because
    // this config ignores that directory. It turns type information back on
    // for control-plane tests too, which the test block above turned off, so
    // tsconfig.eslint.json keeps them.
    files: ["control-plane/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json" },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Fences the other half of the class: `try { return store.tx(...) }`
      // settles the promise after this frame has left, so the catch never
      // runs. The narrow mode flags only that case rather than every return.
      "@typescript-eslint/return-await": [
        "error",
        "error-handling-correctness-only",
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
    // bun's expect(fn).not.toThrow() passes when fn leaves a rejected promise
    // behind, so the test it guards cannot fail on the rejection. The same rule
    // is in control-plane/web/eslint.config.mjs, which this config ignores.
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^toThrow(Error)?$/][callee.object.property.name='not']",
          message:
            "Call the function directly: a throw fails the test, and expect(fn).not.toThrow() also hides a promise rejection the call creates.",
        },
      ],
    },
  },
  {
    // A file this long costs every agent that reads it its context, and its
    // reviews go shallow. A warning, not an error: the files already over it
    // are split one task at a time. The message catalogs are flat data.
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["shared/i18n/{en,es,ca,zh}.ts"],
    rules: {
      "max-lines": [
        "warn",
        { max: 3000, skipBlankLines: false, skipComments: false },
      ],
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

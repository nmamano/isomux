// Lint config for the nested web package.
//
// It imports its plugins from the repository root's node_modules (this package
// installs Next and Auth.js, not a second copy of the toolchain), and it is
// invoked from the root by `bun run lint:web`. The root config ignores this
// directory, because typed linting here needs the Next types that only exist
// once the nested install has run.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Globstars, not bare directory names: ESLint resolves ignore patterns
  // against the INVOKING cwd, and this config is run from the repository root
  // by `bun run lint:web`, where ".next/" would mean the wrong directory - and
  // silently lint 200 generated files.
  { ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // The config file itself is not in the TypeScript project, so type-aware
  // rules cannot run on it.
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Same demotions as the root config: the v7 compiler-derived rules flag
      // forward-looking patterns rather than defects.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/purity": "warn",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);

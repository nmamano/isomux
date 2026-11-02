import { expect, it } from "bun:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

// Type-aware lint is off on test code: checking the types of the tests
// costs about 1 GB of ESLint heap (task abf51744). These cases guard both
// sides of that cut. A misplaced disableTypeChecked (a block without
// `files`, a glob too wide) turns type-aware lint off on production code
// while lint stays green, and only a check of the resolved config sees it.

type RuleMeta = { meta: { docs?: { requiresTypeChecking?: boolean } } };

// typescript-eslint types its plugin as a CompatiblePlugin, without rules.
const { rules } = tseslint.plugin as unknown as {
  rules: Record<string, RuleMeta>;
};
const TYPE_AWARE = Object.entries(rules)
  .filter(([, rule]) => rule.meta.docs?.requiresTypeChecking)
  .map(([name]) => `@typescript-eslint/${name}`);

// Pinned for all of control-plane/** by eslint.config.js.
const PROMISE_FENCE = [
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/await-thenable",
  "@typescript-eslint/return-await",
];

const eslint = new ESLint({ cwd: `${import.meta.dir}/..` });

async function typeAware(file: string) {
  const config = (await eslint.calculateConfigForFile(file)) as {
    languageOptions: { parserOptions: { projectService?: unknown } };
    rules: Record<string, unknown>;
  };
  const on = TYPE_AWARE.filter((name) => {
    const entry = config.rules[name];
    const severity = Array.isArray(entry) ? entry[0] : entry;
    return severity !== undefined && severity !== 0 && severity !== "off";
  });
  return {
    projectService: config.languageOptions.parserOptions.projectService,
    on,
  };
}

it("keeps type-aware lint on production code and off on test code", async () => {
  // The plugin metadata the check depends on.
  expect(TYPE_AWARE).toContain("@typescript-eslint/no-floating-promises");

  for (const file of ["server/agent-turn.ts", "ui/store.tsx"]) {
    const result = await typeAware(file);
    expect({ file, projectService: result.projectService }).toEqual({
      file,
      projectService: true,
    });
    expect(result.on).toEqual(
      expect.arrayContaining([
        "@typescript-eslint/no-floating-promises",
        "@typescript-eslint/no-misused-promises",
        "@typescript-eslint/await-thenable",
        "@typescript-eslint/no-unsafe-assignment",
        "@typescript-eslint/unbound-method",
      ]),
    );
  }

  for (const file of [
    "server/agent-turn.test.ts",
    "ui/store.theme.dom.test.tsx",
    "server/test-support/fake-app-supervisor.ts",
    "ui/test-support/dom.ts",
  ]) {
    const result = await typeAware(file);
    expect({ file, ...result }).toEqual({
      file,
      projectService: false,
      on: [],
    });
  }
}, 20_000);

it("keeps the promise fence on all control-plane code, tests included", async () => {
  const production = await typeAware("control-plane/boot.ts");
  expect(production.projectService).toBe(true);
  expect(production.on).toEqual(expect.arrayContaining(PROMISE_FENCE));

  const test = await typeAware("control-plane/boot.test.ts");
  expect(test.projectService).toBe(true);
  expect(test.on.toSorted()).toStrictEqual(PROMISE_FENCE.toSorted());
}, 20_000);

import { expect, it } from "bun:test";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

// Type-aware lint is off on test code: checking the types of the tests
// costs about 1 GB of ESLint heap (task abf51744), and ESLint builds its
// program from tsconfig.eslint.json, which holds only the files typed lint
// checks (task 6a872fe1). These cases guard both sides of that cut. A
// misplaced disableTypeChecked (a block without `files`, a glob too wide)
// turns type-aware lint off on production code while lint stays green, and a
// lint tsconfig that holds files typed lint skips costs heap silently: only a
// check of the resolved config sees either.

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

const LINT_TSCONFIG = "tsconfig.eslint.json";

const root = resolve(import.meta.dir, "..");
// The root config only. ESLint looks up a config from each file's folder, so
// without this a file in a folder with its own config (control-plane/web,
// prototypes) resolves to that config, though `eslint .` from the root
// ignores the folder.
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: resolve(root, "eslint.config.js"),
});

type ResolvedConfig = {
  languageOptions: {
    parserOptions: {
      project?: unknown;
      projectService?: unknown;
      tsconfigRootDir?: string;
    };
  };
  rules: Record<string, unknown>;
};

/**
 * The tsconfig ESLint builds a file's program from, relative to the
 * repository, or null for none. Anything other than one path is returned as
 * it is, so a check against a path fails on it.
 */
function lintProgram(config: ResolvedConfig): unknown {
  const { project, tsconfigRootDir } = config.languageOptions.parserOptions;
  if (project === undefined || project === null || project === false)
    return null;
  if (typeof project !== "string") return project;
  return relative(root, resolve(tsconfigRootDir ?? root, project));
}

/** undefined when ESLint does not lint the file. */
async function typeAware(file: string) {
  const config = (await eslint.calculateConfigForFile(file)) as
    | ResolvedConfig
    | undefined;
  if (config === undefined) return undefined;
  const on = TYPE_AWARE.filter((name) => {
    const entry = config.rules[name];
    const severity = Array.isArray(entry) ? entry[0] : entry;
    return severity !== undefined && severity !== 0 && severity !== "off";
  });
  return {
    project: lintProgram(config),
    // The project service ignores `project` and types each file with the
    // nearest tsconfig.json, which holds every test.
    projectService: Boolean(
      config.languageOptions.parserOptions.projectService,
    ),
    on,
  };
}

it("keeps type-aware lint on production code and off on test code", async () => {
  // The plugin metadata the check depends on.
  expect(TYPE_AWARE).toContain("@typescript-eslint/no-floating-promises");

  for (const file of ["server/agent-turn.ts", "ui/store.tsx"]) {
    const result = await typeAware(file);
    expect({
      file,
      project: result?.project,
      projectService: result?.projectService,
    }).toEqual({ file, project: LINT_TSCONFIG, projectService: false });
    expect(result?.on).toEqual(
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
    "scripts/lint.ts",
  ]) {
    const result = await typeAware(file);
    expect({ file, ...result }).toEqual({
      file,
      project: null,
      projectService: false,
      on: [],
    });
  }
}, 20_000);

it("keeps the promise fence on all control-plane code, tests included", async () => {
  for (const file of ["control-plane/boot.ts", "control-plane/boot.test.ts"]) {
    const result = await typeAware(file);
    expect({
      file,
      project: result?.project,
      projectService: result?.projectService,
    }).toEqual({ file, project: LINT_TSCONFIG, projectService: false });
    expect(result?.on).toEqual(expect.arrayContaining(PROMISE_FENCE));
  }

  const test = await typeAware("control-plane/boot.test.ts");
  expect(test?.on.toSorted()).toStrictEqual(PROMISE_FENCE.toSorted());
}, 20_000);

/** The root files of a tsconfig, read by the TypeScript the parser uses. */
function rootFiles(tsconfig: string): string[] {
  const parser = createRequire(import.meta.url).resolve(
    "@typescript-eslint/typescript-estree",
  );
  const ts = createRequire(parser)("typescript") as typeof import("typescript");
  const path = resolve(root, tsconfig);
  const read = ts.readConfigFile(path, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(`cannot read ${tsconfig}`);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  return parsed.fileNames.map((file) => relative(root, file));
}

it("builds the lint program from exactly the files typed lint checks", async () => {
  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file));

  const typed: string[] = [];
  const untyped = new Set<string>();
  const programs = new Set<unknown>();
  for (const file of tracked) {
    const result = await typeAware(file);
    if (result === undefined) continue;
    if (result.on.length === 0) {
      untyped.add(file);
      continue;
    }
    typed.push(file);
    programs.add(result.project);
  }
  // Every file typed lint checks is typed against the one lint program.
  expect([...programs]).toEqual([LINT_TSCONFIG]);

  const roots = new Set(rootFiles(LINT_TSCONFIG));
  // The checks below see both sides: typed production code and linted files
  // left untyped (the tests).
  expect(typed).toContain("server/agent-turn.ts");
  expect(untyped.has("server/agent-turn.test.ts")).toBe(true);

  // A typed file that is not a root gets typed lint only while a root imports
  // it; when none does, lint fails on it with a parse error. Roots for every
  // typed file keep that independent of the import graph.
  const missing = typed.filter((file) => !roots.has(file));
  // A root typed lint skips costs heap and fails nothing. A root ESLint does
  // not lint at all (generated code) may stay: production code imports it,
  // so it is in the program either way.
  const extra = [...roots].filter((file) => untyped.has(file));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
}, 60_000);

// Picks the scoped tests for `scripts/ci-remote.sh --gate` from a diff, so a
// worker does not name them from memory. The gate runs the CLI below from the
// checkout under test and adds the paths the worker names.
//
//   bun scripts/gate-tests.ts
//
// prints `base <sha>` (or `base none` with no main), then one line per test
// the remote runs, `cp <path>` per control-plane test (they need Postgres,
// so they run here), and `web` when the diff can break control-plane/web.
import { Glob } from "bun";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { TEST_FILE } from "./test-shards.ts";

/** What the selector reads: the tracked files at HEAD and the changed paths. */
export type GateTestsInput = {
  /** Every path tracked at HEAD. */
  files: string[];
  /** A tracked file's text, or undefined when it cannot be read. */
  read: (path: string) => string | undefined;
  /** Paths the diff adds, changes, deletes or renames (both names). */
  changed: string[];
  /** Whole-tree tests: test path -> globs of the files it reads. */
  wholeTree: Record<string, string[]>;
};

export type GateTests = {
  /** Test files the remote gate runs. */
  tests: string[];
  /** Selected tests under control-plane/: they need Postgres, so run here. */
  controlPlaneTests: string[];
  /** The diff can break control-plane/web: run `bun run ci:web`. */
  web: boolean;
};

/**
 * A hub: a module, not changed, with more importers than this, tests
 * included (load edges do not count, so a load edge never makes a hub that
 * stops a walk without it), and more test files than this behind them (the
 * tests a walk from it with no stop would select). The walk stops at a hub.
 * Its own tests run only when it imports a changed file directly: a change
 * to shared/i18n/en.ts runs the tests of translate.ts, but not the 147 tests
 * of server/test-support/harness.ts that a longer path reaches. Without a stop,
 * any copy edit selected 687 of 1149 test files. A facade that many modules
 * import with few tests behind them, such as
 * control-plane/web/lib/services.server.ts, is no hub. Over the last 150
 * commits on main, on the tree of 2026-11-07 (1258 test files), the tests
 * this selects per commit: median 62, p90 549, max 755.
 */
export const HUB_IMPORTERS = 20;

/**
 * Tests that read the tree by walking it, not by importing it: test path ->
 * globs of the files it reads. A test that calls Bun.Glob, `git ls-files` or
 * readdirSync over the repository, or walks an import graph from an entry
 * file, belongs here.
 */
export const WHOLE_TREE_TESTS: Record<string, string[]> = {
  "api/_site-agent-readiness.test.ts": ["site/**/*.html"],
  "control-plane/create-latch.test.ts": ["control-plane/*.ts"],
  "control-plane/deploy/image.test.ts": ["control-plane/**/*.ts"],
  "control-plane/stripe/fixtures.test.ts": [
    "control-plane/stripe/fixtures/*.json",
  ],
  "control-plane/stripe/ownership.test.ts": ["control-plane/**/*.ts"],
  "control-plane/web-boundary.test.ts": ["control-plane/**/*.{ts,tsx}"],
  "control-plane/web-reachability.test.ts": ["control-plane/web/**/*.{ts,tsx}"],
  "control-plane/web/lib/i18n/catalog.test.ts": [
    "control-plane/web/**/*.{ts,tsx}",
  ],
  "deploy/install-docs.test.ts": ["**/*.md"],
  "scripts/bun-pins.test.ts": ["**/*Dockerfile"],
  "scripts/hosting-docs.test.ts": ["docs/**/*.md"],
  "scripts/indexnow.test.ts": ["docs/**/*.md"],
  "scripts/site-i18n-check.test.ts": ["docs/**/*.md"],
  "scripts/test-shards.test.ts": ["**/*.test.{ts,tsx}"],
  "scripts/use-cases-docs.test.ts": [
    "site/**/*.html",
    "docs/**/*.md",
    "site/use-cases/*",
  ],
  // Read every topic of server/agent-reference.ts, which loads them at import.
  "server/agent-reference.test.ts": ["server/agent-reference/*.md"],
  "server/backends/opencode/authority-broker.prompt-routes.test.ts": [
    "server/agent-reference/*.md",
  ],
  "server/test-support/routes-table.test.ts": ["server/agent-reference/*.md"],
  "server/test-support/system-prompt.test.ts": ["server/agent-reference/*.md"],
  "server/backends/codex/safety-hook-install.test.ts": ["server/**/*.ts"],
  "server/backends/opencode/supervisor.test.ts": [
    "server/backends/opencode/*.ts",
  ],
  "server/skills.test.ts": ["skills/**"],
  // Walk the import graph from an entry they do not import.
  "server/test-support/routes-agent-avatar.test.ts": [
    "server/**/*.ts",
    "shared/**/*.ts",
    "ui/office/*.tsx",
    "ui/components/*.tsx",
  ],
  "ui/first-bundle.test.ts": ["ui/**/*.{ts,tsx}", "shared/**/*.ts"],
  "server/test-support/source-hygiene.test.ts": ["**"],
  "site-host/server.test.ts": ["site/**", "docs/**/*.md"],
  "ui/audit-operations.test.ts": ["server/**/*.ts"],
};

// The root tsconfig.json's `paths`.
const ALIASES: [string, string][] = [["@shared/", "shared/"]];
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
// A string literal on one line.
const STRING = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
// One inside an import, require() or mock.module(): an import edge, which the
// import walk follows with its hub stop.
const IMPORT_STRING =
  /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmodule\s*\(\s*)(["'`])(?:(?!\2)[^\\\n]|\\.)*\2/g;
// A load by a computed path: import(), require() or a require function of
// createRequire (nodeRequire, webRequire) on anything but a string literal.
const COMPUTED_LOAD = /(?:\bimport|require)\s*\(\s*[^"'`\s)]/i;

/** The path pieces a test's string literals hold, outside its imports. */
function pathPieces(unimported: string): Set<string> {
  const pieces = new Set<string>();
  for (const [, , body] of unimported.matchAll(STRING))
    // A piece keeps [ and ]: Next.js names a dynamic route directory [id].
    for (const piece of body.split(/[^\w@.[\]-]+/))
      if (piece) pieces.add(piece);
  return pieces;
}

/**
 * A test names a path when its pieces hold the file name and each directory
 * below the deepest one the test and the file share, in any order: a whole
 * literal, a path relative to the test, or join(import.meta.dir, "web",
 * "route.ts").
 */
function namesPath(test: string, pieces: Set<string>, path: string): boolean {
  const dirs = path.split("/");
  if (!pieces.has(dirs.pop()!)) return false;
  const own = test.split("/").slice(0, -1);
  let shared = 0;
  while (shared < dirs.length && dirs[shared] === own[shared]) shared++;
  return dirs.slice(shared).every((d) => pieces.has(d));
}

function isTest(path: string): boolean {
  // Bun skips node_modules and dot directories.
  return (
    TEST_FILE.test(path) &&
    !path.split("/").some((s) => s.startsWith(".") || s === "node_modules")
  );
}

function resolver(files: Set<string>) {
  return (from: string, spec: string): string | undefined => {
    let base: string | undefined;
    for (const [alias, dir] of ALIASES)
      if (spec.startsWith(alias)) base = dir + spec.slice(alias.length);
    if (base === undefined) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
      base = posix.normalize(posix.join(posix.dirname(from), spec));
    }
    for (const suffix of SUFFIXES)
      if (files.has(base + suffix)) return base + suffix;
    // TypeScript lets `./x.js` name x.ts.
    const ts = base.replace(/\.(m?)js$/, ".$1ts");
    if (ts !== base && files.has(ts)) return ts;
    return undefined;
  };
}

export function selectGateTests(input: GateTestsInput): GateTests {
  const files = new Set(input.files);
  const changed = new Set(input.changed);
  const selected = new Set<string>();

  for (const [test, globs] of Object.entries(input.wholeTree)) {
    if (!files.has(test) || !isTest(test))
      throw new Error(`whole-tree table: ${test} is not a tracked test file`);
    for (const pattern of globs) {
      const glob = new Glob(pattern);
      if (!input.files.some((f) => glob.match(f)))
        throw new Error(
          `whole-tree table: ${test}: ${pattern} matches no tracked file`,
        );
      if (input.changed.some((f) => glob.match(f))) selected.add(test);
    }
  }

  // Reverse runtime import edges: module -> the files that import it.
  const resolve = resolver(files);
  const importers = new Map<string, string[]>();
  // Load edges per module, left out of its importer count.
  const loads = new Map<string, number>();
  const addImporter = (target: string, file: string) => {
    const list = importers.get(target);
    if (list) list.push(file);
    else importers.set(target, [file]);
  };
  // Source files by file name, for the load edges.
  const byName = new Map<string, string[]>();
  for (const file of input.files)
    if (SOURCE.test(file)) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      const list = byName.get(name);
      if (list) list.push(file);
      else byName.set(name, [file]);
    }
  const transpilers = new Map<string, Bun.Transpiler>();
  for (const file of input.files) {
    if (!SOURCE.test(file)) continue;
    const text = input.read(file);
    if (text === undefined) continue;
    if (isTest(file)) {
      if (changed.has(file)) selected.add(file);
      const unimported = text.replace(IMPORT_STRING, "");
      const pieces = pathPieces(unimported);
      if (input.changed.some((f) => namesPath(file, pieces, f)))
        selected.add(file);
      // A test that loads a module by a computed path imports each source
      // file it names. One that only reads files as text imports none.
      if (COMPUTED_LOAD.test(unimported))
        for (const piece of pieces)
          for (const target of byName.get(piece) ?? [])
            if (target !== file && namesPath(file, pieces, target)) {
              addImporter(target, file);
              loads.set(target, (loads.get(target) ?? 0) + 1);
            }
    }
    const loader = /x$/.test(file) ? "tsx" : /ts$/.test(file) ? "ts" : "js";
    let transpiler = transpilers.get(loader);
    if (!transpiler)
      transpilers.set(loader, (transpiler = new Bun.Transpiler({ loader })));
    let imports: { path: string }[];
    try {
      // Drops type-only imports: they change nothing at run time.
      imports = transpiler.scanImports(text);
    } catch {
      continue; // tsc reports a file that does not parse.
    }
    for (const { path } of imports) {
      const target = resolve(file, path);
      if (target === undefined || target === file) continue;
      addImporter(target, file);
    }
  }

  // More than HUB_IMPORTERS test files behind a module: the distinct tests
  // that import it or a module that reaches it, at any depth.
  const crowded = new Map<string, boolean>();
  const manyTestsBehind = (module: string): boolean => {
    let many = crowded.get(module);
    if (many !== undefined) return many;
    const tests = new Set<string>();
    const seen = new Set([module]);
    const queue = [module];
    while (queue.length > 0 && tests.size <= HUB_IMPORTERS)
      for (const f of importers.get(queue.pop()!) ?? [])
        if (!seen.has(f)) {
          seen.add(f);
          if (isTest(f)) tests.add(f);
          else queue.push(f);
        }
    many = tests.size > HUB_IMPORTERS;
    crowded.set(module, many);
    return many;
  };

  // The files that import a changed file directly.
  const direct = new Set([...changed].flatMap((f) => importers.get(f) ?? []));
  const queue = [...changed];
  const reached = new Set(queue);
  while (queue.length > 0) {
    const module = queue.pop()!;
    const from = importers.get(module) ?? [];
    const hub =
      !changed.has(module) &&
      from.length - (loads.get(module) ?? 0) > HUB_IMPORTERS &&
      manyTestsBehind(module);
    if (!hub || direct.has(module))
      for (const f of from) if (isTest(f)) selected.add(f);
    if (hub) continue;
    for (const f of from)
      if (!isTest(f) && !reached.has(f)) {
        reached.add(f);
        queue.push(f);
      }
  }

  // Every file that reaches a changed one, with no stop at hubs.
  let web = input.changed.some((f) => f.startsWith("control-plane/web/"));
  const all = [...changed];
  const seen = new Set(all);
  while (!web && all.length > 0)
    for (const f of importers.get(all.pop()!) ?? [])
      if (!seen.has(f)) {
        if (f.startsWith("control-plane/web/")) web = true;
        seen.add(f);
        all.push(f);
      }

  const tests = [...selected].filter((f) => files.has(f)).sort();
  return {
    tests: tests.filter((f) => !f.startsWith("control-plane/")),
    controlPlaneTests: tests.filter((f) => f.startsWith("control-plane/")),
    web,
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

// -z: git quotes a path with unusual characters otherwise.
function paths(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

function main(): void {
  const top = git("rev-parse", "--show-toplevel");
  let base: string | undefined;
  for (const ref of ["main", "origin/main"])
    try {
      base = git("-C", top, "merge-base", ref, "HEAD");
      break;
    } catch {
      // The next ref.
    }
  if (base === undefined) {
    console.log("base none");
    return;
  }
  const result = selectGateTests({
    files: paths(git("-C", top, "ls-tree", "-r", "-z", "--name-only", "HEAD")),
    read: (path) => {
      try {
        return readFileSync(posix.join(top, path), "utf8");
      } catch {
        return undefined;
      }
    },
    changed: paths(
      git("-C", top, "diff", "-z", "--name-only", "--no-renames", base, "HEAD"),
    ),
    wholeTree: WHOLE_TREE_TESTS,
  });
  const out = [
    `base ${base}`,
    ...result.tests,
    ...result.controlPlaneTests.map((f) => `cp ${f}`),
  ];
  if (result.web) out.push("web");
  console.log(out.join("\n"));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(
      `gate-tests: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

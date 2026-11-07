// scripts/gate-tests.ts: which test files a diff selects for the hand-off
// gate. Each case is a small synthetic tree, so a case names the one edge
// (import, path literal, whole-tree glob) that selects a test.

import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  HUB_IMPORTERS,
  WHOLE_TREE_TESTS,
  selectGateTests,
  type GateTests,
} from "./gate-tests.ts";

type Tree = Record<string, string | undefined>;

function select(
  tree: Tree,
  changed: string[],
  wholeTree: Record<string, string[]> = {},
): GateTests {
  return selectGateTests({
    files: Object.keys(tree),
    read: (path) => tree[path],
    changed,
    wholeTree,
  });
}

/** n modules that import `target`, each with its own test. */
function importers(n: number, target: string): Tree {
  const tree: Tree = {};
  for (let i = 0; i < n; i++) {
    tree[`ui/m${i}.ts`] =
      `import { t } from "../${target}";\nexport const m = t;\n`;
    tree[`ui/m${i}.test.ts`] = `import { m } from "./m${i}";\n`;
  }
  return tree;
}

const moduleTests = (n: number) =>
  Array.from({ length: n }, (_, i) => `ui/m${i}.test.ts`).sort();

describe("selectGateTests, imports", () => {
  // Each row: a tree, the changed path, the tests it selects. The tree also
  // holds a test that imports nothing changed, and a file read() cannot
  // read, so every row also proves those stay out.
  const rows: [string, Tree, string, string[]][] = [
    [
      "a direct import, with an explicit extension",
      {
        "server/a.ts": "export const a = 1;\n",
        "server/a.test.ts": 'import { a } from "./a.ts";\n',
      },
      "server/a.ts",
      ["server/a.test.ts"],
    ],
    [
      "an import with no extension, of a .tsx file",
      {
        "ui/view.tsx": "export const View = () => null;\n",
        "ui/view.dom.test.tsx": 'import { View } from "./view";\n',
      },
      "ui/view.tsx",
      ["ui/view.dom.test.tsx"],
    ],
    [
      "the @shared/ alias of the root tsconfig",
      {
        "shared/form.ts": "export const form = 1;\n",
        "ui/form.test.ts": 'import { form } from "@shared/form";\n',
      },
      "shared/form.ts",
      ["ui/form.test.ts"],
    ],
    [
      "a directory import, through its index file",
      {
        "server/lib/index.ts": "export const lib = 1;\n",
        "server/lib.test.ts": 'import { lib } from "./lib";\n',
      },
      "server/lib/index.ts",
      ["server/lib.test.ts"],
    ],
    [
      // Task 995fc76a: routes-table.test.ts reaches plain-text-form.ts only
      // through the route table.
      "two hops through a module few files import",
      {
        "shared/plain-text-form.ts": "export const form = 1;\n",
        "server/routes/table.ts":
          'import { form } from "../../shared/plain-text-form.ts";\nexport const table = form;\n',
        "server/test-support/routes-table.test.ts":
          'import { table } from "../routes/table.ts";\n',
      },
      "shared/plain-text-form.ts",
      ["server/test-support/routes-table.test.ts"],
    ],
    [
      "a re-export",
      {
        "server/x.ts": "export const x = 1;\n",
        "server/y.ts": "export const y = 2;\n",
        "server/barrel.ts": 'export { x } from "./x";\nexport * from "./y";\n',
        "server/barrel.test.ts": 'import { x, y } from "./barrel";\n',
      },
      "server/y.ts",
      ["server/barrel.test.ts"],
    ],
    [
      "a dynamic import with a literal",
      {
        "ui/lazy.tsx": "export default () => null;\n",
        "ui/lazy.test.ts": 'const m = await import("./lazy.tsx");\n',
      },
      "ui/lazy.tsx",
      ["ui/lazy.test.ts"],
    ],
    [
      "a require call",
      {
        "scripts/old.cjs": "module.exports = 1;\n",
        "scripts/old.test.ts": 'const old = require("./old.cjs");\n',
      },
      "scripts/old.cjs",
      ["scripts/old.test.ts"],
    ],
    [
      // tsc checks types on every gate; only runtime edges select tests.
      "no import that names types only",
      {
        "server/types.ts": "export type T = number;\n",
        "server/a.test.ts": 'import type { T } from "./types";\n',
        "server/b.test.ts": 'import { type T } from "./types";\n',
      },
      "server/types.ts",
      [],
    ],
    [
      "a changed test file, which selects itself",
      { "server/new.test.ts": "// new\n" },
      "server/new.test.ts",
      ["server/new.test.ts"],
    ],
  ];
  it.each(rows)("selects through %s", (_, tree, changed, tests) => {
    const result = select(
      {
        ...tree,
        "server/other.ts": "export const other = 1;\n",
        "server/other.test.ts": 'import { other } from "./other";\n',
        "ui/logo.png": undefined,
      },
      [changed],
    );
    expect(result).toEqual({ tests, controlPlaneTests: [], web: false });
  });

  it("selects a test reached by two routes once", () => {
    const result = select(
      {
        "server/a.ts": "export const a = 1;\n",
        "server/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
        "server/a.test.ts":
          'import { a } from "./a";\nimport { b } from "./b";\n',
      },
      ["server/a.ts", "server/b.ts"],
    );
    expect(result.tests).toStrictEqual(["server/a.test.ts"]);
  });

  it("does not select a test whose file the diff deletes", () => {
    const result = select({ "server/a.ts": "" }, ["server/gone.test.ts"]);
    expect(result.tests).toStrictEqual([]);
  });
});

describe("selectGateTests, hubs", () => {
  // A hub: shared/i18n/translate.ts, which a copy edit in en.ts reaches. It
  // has n module importers and its own test, n + 1 importers in all.
  const hub = (n: number, extra: Tree = {}): Tree => ({
    "shared/i18n/en.ts": 'export const en = { hi: "Hi" };\n',
    "shared/i18n/translate.ts":
      'import { en } from "./en";\nexport const t = en;\n',
    "shared/i18n/translate.test.ts": 'import { t } from "./translate";\n',
    ...importers(n, "shared/i18n/translate"),
    ...extra,
  });

  it(`walks through a module that ${HUB_IMPORTERS} files import`, () => {
    expect(select(hub(HUB_IMPORTERS - 1), ["shared/i18n/en.ts"]).tests).toEqual(
      [
        ...moduleTests(HUB_IMPORTERS - 1),
        "shared/i18n/translate.test.ts",
      ].sort(),
    );
  });

  // translate.ts imports the changed en.ts, so its own tests run.
  it("stops at a module with one importer more, but selects its own tests", () => {
    expect(select(hub(HUB_IMPORTERS), ["shared/i18n/en.ts"]).tests).toEqual([
      "shared/i18n/translate.test.ts",
    ]);
  });

  it("counts test files as importers of a hub", () => {
    const tree = hub(HUB_IMPORTERS - 1, {
      "shared/i18n/more.test.ts": 'import { t } from "./translate";\n',
    });
    expect(select(tree, ["shared/i18n/en.ts"]).tests).toEqual([
      "shared/i18n/more.test.ts",
      "shared/i18n/translate.test.ts",
    ]);
  });

  // server/test-support/harness.ts: 2 modules and 147 tests import it, and a
  // copy edit reaches it through server/isomux-office.ts (2026-11-04).
  it("selects nothing at a hub that does not import a changed file", () => {
    const tree: Tree = {
      "server/templates.ts": "export const templates = [];\n",
      "server/office.ts":
        'import { templates } from "./templates";\nexport const office = templates;\n',
      "server/office.test.ts": 'import { office } from "./office";\n',
      "server/harness.ts":
        'import { office } from "./office";\nexport const harness = office;\n',
    };
    for (let i = 0; i <= HUB_IMPORTERS; i++)
      tree[`server/h${i}.test.ts`] = 'import { harness } from "./harness";\n';
    expect(select(tree, ["server/templates.ts"]).tests).toEqual([
      "server/office.test.ts",
    ]);
  });

  it("walks on from a hub the diff changes", () => {
    expect(
      select(hub(HUB_IMPORTERS), ["shared/i18n/translate.ts"]).tests,
    ).toEqual(
      [...moduleTests(HUB_IMPORTERS), "shared/i18n/translate.test.ts"].sort(),
    );
  });

  // control-plane/web/lib/services.server.ts (task 3924f913): many routes
  // import it, but few tests stand behind them, so it is no hub.
  // m0..m{n-1} import server/facade.ts, which imports the changed
  // server/dep.ts; `tests` adds the test files behind them.
  const facade = (n: number, tests: Tree = {}): Tree => {
    const tree: Tree = {
      "server/dep.ts": "export const dep = 1;\n",
      "server/facade.ts":
        'import { dep } from "./dep";\nexport const facade = dep;\n',
      ...tests,
    };
    for (let i = 0; i < n; i++)
      tree[`server/m${i}.ts`] =
        `import { facade } from "./facade";\nexport const m = facade;\n`;
    return tree;
  };
  const ownTests = (n: number): Tree =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `server/m${i}.test.ts`,
        `import { m } from "./m${i}";\n`,
      ]),
    );
  const ownTestNames = (n: number) => Object.keys(ownTests(n)).sort();

  it(`walks through a module with ${HUB_IMPORTERS + 1} importers and ${HUB_IMPORTERS} tests behind them`, () => {
    expect(
      select(facade(HUB_IMPORTERS + 1, ownTests(HUB_IMPORTERS)), [
        "server/dep.ts",
      ]).tests,
    ).toEqual(ownTestNames(HUB_IMPORTERS));
  });

  it("stops at that module with one test more behind it", () => {
    expect(
      select(facade(HUB_IMPORTERS + 1, ownTests(HUB_IMPORTERS + 1)), [
        "server/dep.ts",
      ]).tests,
    ).toEqual([]);
  });

  it("counts a test behind several of its importers once", () => {
    const all = Array.from(
      { length: HUB_IMPORTERS + 1 },
      (_, i) => `import { m as m${i} } from "./m${i}";\n`,
    ).join("");
    expect(
      select(facade(HUB_IMPORTERS + 1, { "server/all.test.ts": all }), [
        "server/dep.ts",
      ]).tests,
    ).toEqual(["server/all.test.ts"]);
  });

  it("counts the tests behind it at any depth", () => {
    // Each m{i} has no test of its own; n{i} imports it, and n{i}'s test
    // imports n{i}: the tests stand two modules away.
    const far: Tree = {};
    for (let i = 0; i <= HUB_IMPORTERS; i++) {
      far[`server/n${i}.ts`] =
        `import { m } from "./m${i}";\nexport const n = m;\n`;
      far[`server/n${i}.test.ts`] = `import { n } from "./n${i}";\n`;
    }
    expect(
      select(facade(HUB_IMPORTERS + 1, far), ["server/dep.ts"]).tests,
    ).toEqual([]);
  });

  it(`walks through a module that ${HUB_IMPORTERS} files import, with more tests behind them`, () => {
    // Two tests per module: 2 * (HUB_IMPORTERS - 1) + 1 tests behind
    // translate.ts, but only HUB_IMPORTERS importers.
    const twice: Tree = {};
    for (let i = 0; i < HUB_IMPORTERS - 1; i++)
      twice[`ui/m${i}.more.test.ts`] = `import { m } from "./m${i}";\n`;
    expect(
      select(hub(HUB_IMPORTERS - 1, twice), ["shared/i18n/en.ts"]).tests,
    ).toEqual(
      [
        ...moduleTests(HUB_IMPORTERS - 1),
        ...Object.keys(twice),
        "shared/i18n/translate.test.ts",
      ].sort(),
    );
  });

  // A load edge must not make a hub that stops a walk the import edges let
  // through: translate.ts has HUB_IMPORTERS import edges and one load edge.
  it("does not count a test that loads the module by a computed path as an importer", () => {
    const tree = hub(HUB_IMPORTERS - 1, {
      "shared/i18n/load.test.ts":
        'const t = await import(join(import.meta.dir, "translate.ts"));\n',
    });
    expect(select(tree, ["shared/i18n/en.ts"]).tests).toEqual(
      [
        ...moduleTests(HUB_IMPORTERS - 1),
        "shared/i18n/load.test.ts",
        "shared/i18n/translate.test.ts",
      ].sort(),
    );
  });
});

describe("selectGateTests, path literals", () => {
  const tree: Tree = {
    "docs/features.md": "# Features\n",
    "ui/page.html": "<html></html>\n",
    "scripts/docs.test.ts":
      'const text = readFileSync("docs/features.md", "utf8");\n',
    "ui/page.test.ts":
      'const html = readFileSync(join(import.meta.dir, "page.html"), "utf8");\n',
    "server/readme.test.ts": 'const p = join(root, "../README.md");\n',
    "scripts/name.test.ts": 'const name = "features.md";\n',
  };

  it.each([
    ["repo-relative", "docs/features.md", ["scripts/docs.test.ts"]],
    ["relative to the test's directory", "ui/page.html", ["ui/page.test.ts"]],
    [
      "with ../, relative to the test's directory",
      "README.md",
      ["server/readme.test.ts"],
    ],
    // A test that reads a file the diff deletes must run, and go red.
    ["of a deleted file", "docs/old.md", ["scripts/old.test.ts"]],
  ])("selects a test with a literal path, %s", (_, changed, tests) => {
    const result = select(
      {
        ...tree,
        "scripts/old.test.ts": 'readFileSync("docs/old.md", "utf8");\n',
      },
      [changed],
    );
    expect(result.tests).toEqual(tests);
  });

  // Task b4e5a3a0: control-plane/signin-return.test.ts read
  // web/app/api/session/route.ts through join() with one piece per argument,
  // so no single literal named the path and the gate did not select it.
  const route = "control-plane/web/app/api/session/route.ts";
  const reader = "control-plane/signin-return.test.ts";
  const joined = (...pieces: string[]) =>
    `const p = path.join(import.meta.dir, ${pieces.map((p) => `"${p}"`).join(", ")});\n`;
  const rows: [string, Tree, string, string[]][] = [
    [
      "selects a path joined from one piece per argument",
      { [reader]: joined("web", "app", "api", "session", "route.ts") },
      route,
      [reader],
    ],
    [
      "selects a path in a template literal with a placeholder",
      { "server/docs.test.ts": "const p = `${root}/docs/features.md`;\n" },
      "docs/features.md",
      ["server/docs.test.ts"],
    ],
    [
      "selects the pieces of a path in two literals of the file",
      {
        "server/docs.test.ts":
          'const DOCS = join(ROOT, "docs");\nconst text = readFileSync(join(DOCS, "features.md"), "utf8");\n',
      },
      "docs/features.md",
      ["server/docs.test.ts"],
    ],
    [
      "selects the file name alone, in the test's own directory",
      { "server/a/x.test.ts": 'const p = join(import.meta.dir, "f.ts");\n' },
      "server/a/f.ts",
      ["server/a/x.test.ts"],
    ],
    [
      // Next.js names a dynamic route directory in brackets.
      "selects a path through a dynamic route directory",
      {
        [reader]: joined("web", "app", "api", "progress", "[id]", "route.ts"),
      },
      "control-plane/web/app/api/progress/[id]/route.ts",
      [reader],
    ],
    [
      "does not select a path with one directory piece missing",
      { [reader]: joined("web", "app", "api", "route.ts") },
      route,
      [],
    ],
    [
      // server/ab and server/a share the directory server, not server/a.
      "does not select the file name alone from a directory whose name starts the same",
      { "server/ab/x.test.ts": 'const p = join(import.meta.dir, "f.ts");\n' },
      "server/a/f.ts",
      [],
    ],
    [
      "does not select a piece that only contains the file name",
      { [reader]: joined("web", "app", "api", "session", "old-route.ts") },
      route,
      [],
    ],
    [
      // An import is an edge, not a path the test reads; a type-only one
      // selects nothing (see "no import that names types only").
      "does not select a type-only import with an explicit extension",
      { "server/a.test.ts": 'import type { T } from "./types.ts";\n' },
      "server/types.ts",
      [],
    ],
  ];
  it.each(rows)("%s", (_, tests, changed, expected) => {
    const result = select({ ...tests, [changed]: "export const x = 1;\n" }, [
      changed,
    ]);
    expect([...result.tests, ...result.controlPlaneTests].sort()).toEqual(
      expected,
    );
  });
});

// Task 3924f913: control-plane/web-enterprise.test.ts loads each route by
// `await import(path.join(WEB, "app/api/enterprise", rel, "route.ts"))`. A
// test that loads a module by a computed path imports each source file it
// names; a test that only reads files as text imports none of them.
describe("selectGateTests, load edges", () => {
  const tree: Tree = {
    "server/lib.ts": "export const lib = 1;\n",
    "server/web/route.ts":
      'import { lib } from "../lib";\nexport const route = lib;\n',
    "server/other.ts": "export const other = 1;\n",
    "server/web2/route.ts":
      'import { other } from "../other";\nexport const route = other;\n',
  };
  const at = 'join(import.meta.dir, "web", "route.ts")';
  const rows: [string, string, string, string[]][] = [
    [
      "selects a test that loads the module by import()",
      `const m = await import(${at});\n`,
      "server/lib.ts",
      ["server/t.test.ts"],
    ],
    [
      "selects a test that loads the module by require()",
      `const m = require(${at});\n`,
      "server/lib.ts",
      ["server/t.test.ts"],
    ],
    [
      "selects a test that loads the module by a require function of createRequire",
      `const nodeRequire = createRequire(import.meta.url);\nconst m = nodeRequire(${at});\n`,
      "server/lib.ts",
      ["server/t.test.ts"],
    ],
    [
      "selects a test that loads the module through a variable",
      `const ROUTE = ${at};\nconst m = await import(ROUTE);\n`,
      "server/lib.ts",
      ["server/t.test.ts"],
    ],
    [
      "does not select a test that only reads the module as text",
      `const text = readFileSync(${at}, "utf8");\n`,
      "server/lib.ts",
      [],
    ],
    [
      // A literal import is an edge of its own, not a load by a computed
      // path, so the path the test reads stays text.
      "does not select a test whose only import() takes a literal",
      `const m = await import("./x.ts");\nconst text = readFileSync(${at}, "utf8");\n`,
      "server/lib.ts",
      [],
    ],
    [
      "does not select a test for a module it loads no importer of",
      `const m = await import(${at});\n`,
      "server/other.ts",
      [],
    ],
  ];
  it.each(rows)("%s", (_, test, changed, expected) => {
    const result = select(
      {
        ...tree,
        "server/x.ts": "export const x = 1;\n",
        "server/t.test.ts": test,
      },
      [changed],
    );
    expect(result.tests).toEqual(expected);
  });

  // The 8cc2862f path: enterprise-invoices.ts -> services.server.ts (a
  // dynamic import) -> the portal route -> web-enterprise.test.ts.
  it("selects a test that loads a route for a change two modules behind it", () => {
    const test = [
      'const WEB = path.join(import.meta.dir, "web");',
      "const route = async (rel: string) =>",
      '  await import(path.join(WEB, "app/api/enterprise", rel, "route.ts"));',
      'const portal = await route("billing/portal");',
      "",
    ].join("\n");
    const result = select(
      {
        "control-plane/enterprise-invoices.ts": "export const inv = 1;\n",
        "control-plane/web/lib/services.server.ts":
          'export const load = () => import("../../enterprise-invoices");\n',
        "control-plane/web/app/api/enterprise/billing/portal/route.ts":
          'import { load } from "../../../../../lib/services.server";\nexport const POST = load;\n',
        "control-plane/web-enterprise.test.ts": test,
      },
      ["control-plane/enterprise-invoices.ts"],
    );
    expect(result.controlPlaneTests).toEqual([
      "control-plane/web-enterprise.test.ts",
    ]);
  });
});

describe("selectGateTests, whole-tree tests", () => {
  const tree: Tree = {
    "ui/first-bundle.test.ts": "// walks ui/\n",
    "ui/deep/style.css": "a {}\n",
    "server/a.ts": "export const a = 1;\n",
  };
  const table = { "ui/first-bundle.test.ts": ["ui/**"] };

  it.each([
    ["a changed file", "ui/deep/style.css", ["ui/first-bundle.test.ts"]],
    ["a deleted file", "ui/deep/gone.css", ["ui/first-bundle.test.ts"]],
    ["no file", "server/a.ts", []],
  ])("selects a test whose glob matches %s", (_, changed, tests) => {
    expect(select(tree, [changed], table).tests).toEqual(tests);
  });

  // A rename of a whole-tree test or of the directory it reads must fail
  // the gate, not drop the test from every later gate.
  it.each([
    [
      "a key that is not tracked",
      { "ui/gone.test.ts": ["ui/**"] },
      "ui/gone.test.ts",
    ],
    [
      "a key that is not a test file",
      { "server/a.ts": ["ui/**"] },
      "server/a.ts",
    ],
    [
      "a glob that matches no tracked file",
      { "ui/first-bundle.test.ts": ["web/**"] },
      "web/**",
    ],
  ])("throws, naming it, on %s", (_, wholeTree, offender) => {
    expect(() => select(tree, ["server/a.ts"], wholeTree)).toThrow(offender);
  });

  it("has a table that holds at the current HEAD", () => {
    const root = join(import.meta.dir, "..");
    const ls = spawnSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(ls.status, ls.stderr).toBe(0);
    const files = ls.stdout.split("\0").filter(Boolean);
    expect(Object.keys(WHOLE_TREE_TESTS).length).toBeGreaterThan(0);
    // The table checks need the paths only: no file is read.
    const result = selectGateTests({
      files,
      read: () => "",
      changed: Object.keys(WHOLE_TREE_TESTS),
      wholeTree: WHOLE_TREE_TESTS,
    });
    // Each key is a changed test here, so each one selects itself.
    expect([...result.tests, ...result.controlPlaneTests].sort()).toEqual(
      Object.keys(WHOLE_TREE_TESTS).sort(),
    );
  });
});

describe("selectGateTests, control-plane", () => {
  const tree: Tree = {
    "shared/x.ts": "export const x = 1;\n",
    "shared/i18n/en.ts": "export const en = {};\n",
    "shared/i18n/translate.ts":
      'import { en } from "./en";\nexport const t = en;\n',
    ...importers(HUB_IMPORTERS + 1, "shared/i18n/translate"),
    "control-plane/plans.ts":
      'import { x } from "../shared/x";\nexport const plans = x;\n',
    "control-plane/store.test.ts": 'import { plans } from "./plans";\n',
    "control-plane/web/app/page.tsx":
      'import { plans } from "../../plans";\nimport { t } from "../../../shared/i18n/translate";\n',
    "control-plane/web/package.json": "{}\n",
    "server/y.ts": "export const y = 1;\n",
    "server/y.test.ts": 'import { y } from "./y";\n',
  };

  it("puts a selected control-plane test apart from the gate's tests", () => {
    expect(select(tree, ["shared/x.ts"])).toEqual({
      tests: [],
      controlPlaneTests: ["control-plane/store.test.ts"],
      web: true,
    });
  });

  it.each([
    ["a module control-plane/web reaches", "shared/x.ts", true],
    // The web walk is one yes or no: no hub stops it.
    [
      "a module control-plane/web reaches through a hub",
      "shared/i18n/en.ts",
      true,
    ],
    ["a file under control-plane/web", "control-plane/web/package.json", true],
    ["a module control-plane/web does not reach", "server/y.ts", false],
  ])("asks for ci:web for a change to %s: %p", (_, changed, web) => {
    expect(select(tree, [changed]).web).toBe(web);
  });
});

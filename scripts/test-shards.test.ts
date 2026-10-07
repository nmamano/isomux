import { afterEach, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DOCS_BUILD_FILES,
  MAX_WORKERS,
  failed,
  parseCounts,
  plan,
  testFiles,
  total,
  workerCount,
} from "./test-shards";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const RUNNER = new URL("./test-shards.ts", import.meta.url).pathname;
const BODY = `import { test } from "bun:test";\ntest("t", () => {});\n`;

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "isomux-test-shards-")));
  roots.push(root);
  return root;
}

function tree(
  paths: string[],
  links: Record<string, string> = {},
  root = scratch(),
): string {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), BODY);
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, link)), { recursive: true });
    symlinkSync(target, join(root, link));
  }
  return root;
}

it("finds the same files as bun test", async () => {
  const outside = tree(["o.test.ts", "o.ts"]);
  const root = tree(
    [
      "a.test.ts",
      "sub/b_test.tsx",
      "sub/c.spec.js",
      "sub/d_spec.mjs",
      "sub/e.test.mts",
      "sub/f.test.cjs",
      "sub/g.test.jsx",
      "sub/h.test.cts",
      "sub/.i.test.ts",
      "ignored-by-git/j.test.ts",
      ".hidden/k.test.ts",
      "node_modules/pkg/l.test.ts",
      "sub/node_modules/m.test.ts",
      "sub/n.test.json",
      "sub/o.tests.ts",
      "sub/test.ts",
      "sub/actual.ts",
    ],
    {
      // A test name on a file that has none, two names for one file, a
      // directory reached twice, a loop, and a tree outside the root.
      "sub/link.test.ts": "actual.ts",
      "sub/dup.test.ts": "../a.test.ts",
      "sub/p.test.json": "actual.ts",
      again: "sub",
      "sub/loop": ".",
      outside,
      "outside-file.test.ts": join(outside, "o.ts"),
    },
  );
  writeFileSync(join(root, ".gitignore"), "ignored-by-git\n");
  const report = join(root, "report.xml");
  const bun = Bun.spawn(
    ["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  );
  expect(await bun.exited).toBe(0);
  // Bun names a linked file by its target, so compare real paths.
  const fromBun = [
    ...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+)"/g),
  ]
    .map((match) => realpathSync(resolve(root, match[1])))
    .sort();
  const found = testFiles(root);

  expect(fromBun).toHaveLength(13);
  expect(found).toHaveLength(fromBun.length);
  expect(found.map((file) => realpathSync(join(root, file))).sort()).toEqual(
    fromBun,
  );
});

async function runner(root: string) {
  const child = Bun.spawn([process.execPath, RUNNER], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const summary = out.slice(out.lastIndexOf("slowest processes:"));
  return { code, out, err, counts: parseCounts(summary) };
}

it("exits 0 and adds the counts when every file passes", async () => {
  const root = tree(["a.test.ts", "sub/b.test.ts", "ui/c.dom.test.tsx"]);
  const { code, counts } = await runner(root);
  expect(code).toBe(0);
  expect(counts).toEqual({
    pass: 3,
    skip: 0,
    todo: 0,
    fail: 0,
    tests: 3,
    files: 3,
  });
});

it("exits 1 when one file fails", async () => {
  const root = tree(["a.test.ts"]);
  writeFileSync(
    join(root, "b.test.ts"),
    `import { expect, test } from "bun:test";\ntest("f", () => expect(1).toBe(2));\n`,
  );
  const { code, counts } = await runner(root);
  expect(code).toBe(1);
  expect(counts).toMatchObject({ pass: 1, fail: 1, files: 2 });
});

it("exits 1 on a broken link, as bun test does", async () => {
  const root = tree(["a.test.ts"], { "broken.test.ts": "nowhere.ts" });
  expect(testFiles(root)).toEqual(["a.test.ts", "broken.test.ts"]);
  expect((await runner(root)).code).toBe(1);
});

it("exits 1 when it finds no test files, as bun test does", async () => {
  const { code, counts } = await runner(tree(["sub/actual.ts"]));
  expect(code).toBe(1);
  expect(counts).toBeUndefined();
});

it("uses half the threads, at least one worker and at most the cap", () => {
  expect(workerCount(1)).toBe(1);
  expect(workerCount(4)).toBe(2);
  expect(workerCount(8)).toBe(4);
  expect(workerCount(1_000)).toBe(MAX_WORKERS);
});

const summary = (counts: string) =>
  `bun test v1.3.11\n\nsome/file.test.ts:\n(fail) x\n\n${counts}\n 7 expect() calls\n`;

it("reads the counts a bun test process prints", () => {
  expect(
    parseCounts(
      summary(
        " 5 pass\n 2 skip\n 1 todo\n 1 fail\nRan 9 tests across 1 file. [1.00s]",
      ),
    ),
  ).toEqual({ pass: 5, skip: 2, todo: 1, fail: 1, tests: 9, files: 1 });
  expect(
    parseCounts(summary(" 1 pass\n 0 fail\nRan 1 test across 1 file. [3ms]")),
  ).toEqual({ pass: 1, skip: 0, todo: 0, fail: 0, tests: 1, files: 1 });
  expect(parseCounts("error: preload failed\n")).toBeUndefined();
});

it("counts a file red on a nonzero exit, a failed test or no summary", () => {
  const counts = { pass: 1, skip: 0, todo: 0, fail: 0, tests: 1, files: 1 };
  const result = { files: ["a.test.ts"], seconds: 1, exitCode: 0, counts };
  expect(failed(result)).toBe(false);
  // An error between tests leaves fail at 0 and exits 1.
  expect(failed({ ...result, exitCode: 1 })).toBe(true);
  expect(failed({ ...result, counts: { ...counts, fail: 1 } })).toBe(true);
  expect(failed({ ...result, counts: undefined })).toBe(true);
});

it("adds the counts of every file", () => {
  const one = { pass: 3, skip: 1, todo: 0, fail: 0, tests: 4, files: 1 };
  const two = { pass: 2, skip: 0, todo: 1, fail: 1, tests: 4, files: 1 };
  expect(
    total([
      { files: ["a"], seconds: 1, exitCode: 0, counts: one },
      { files: ["b"], seconds: 1, exitCode: 1, counts: two },
      { files: ["c"], seconds: 1, exitCode: 1, counts: undefined },
    ]),
  ).toEqual({ pass: 5, skip: 1, todo: 1, fail: 1, tests: 8, files: 2 });
});

it("runs the DOM files in one process first and every other file alone", () => {
  const dom = ["ui/a.dom.test.tsx", "ui/b.dom.test.tsx"];
  const rest = ["server/a.test.ts", "server/b.test.ts", "ui/c.test.tsx"];
  expect(plan([...rest, ...dom].sort())).toEqual([
    dom,
    ...rest.map((file) => [file]),
  ]);
  expect(plan(rest)).toEqual(rest.map((file) => [file]));
  expect(plan([])).toEqual([]);
});

it("runs the files that rebuild site/docs in one process", () => {
  const rest = ["server/a.test.ts"];
  expect(plan([...DOCS_BUILD_FILES, ...rest].sort())).toEqual([
    DOCS_BUILD_FILES,
    ...rest.map((file) => [file]),
  ]);
});

it("lists every test file that rebuilds site/docs", () => {
  // Built from parts so this file does not match itself.
  const needle = ["main", "as", "buildDocs"].join(" ");
  const builders = testFiles(".").filter((file) =>
    readFileSync(file, "utf8").includes(needle),
  );
  expect(builders.sort()).toEqual([...DOCS_BUILD_FILES].sort());
});

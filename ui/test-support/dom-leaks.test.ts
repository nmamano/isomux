// The render harness keeps one DOM file's globals out of the files after it
// in the same bun process (task 222af307). A file that leaves a global behind,
// or sends a real request, fails itself; the next file sees Bun's globals.
//
// Each case runs fixture files, in a given order, in one child `bun test`, and
// reads the junit report per file. This file is not a DOM file: it must keep
// Bun's own globals, so it never imports the harness.
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const HARNESS = join(REPO, "ui/test-support/dom.ts");
const scratch = mkdtempSync(join(tmpdir(), "dom-leaks-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type FileResult = { passed: string[]; failures: string[] };

function unescapeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Per test file: the names of the passing cases and the text of each failure. */
function readReport(xml: string): Map<string, FileResult> {
  const files = new Map<string, FileResult>();
  for (const suite of xml.matchAll(
    /<testsuite name="[^"]*" file="([^"]+)"[^>]*>([\s\S]*?)<\/testsuite>/g,
  )) {
    const result: FileResult = { passed: [], failures: [] };
    for (const testcase of suite[2]!.matchAll(
      /<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g,
    )) {
      const failure = /<failure([^>]*)>([\s\S]*?)<\/failure>/.exec(
        testcase[2] ?? "",
      );
      if (failure)
        result.failures.push(unescapeXml(`${failure[1]}\n${failure[2]}`));
      else if (!/<skipped/.test(testcase[2] ?? ""))
        result.passed.push(unescapeXml(testcase[1]!));
    }
    files.set(suite[1]!, result);
  }
  return files;
}

/** The child gets the parent's env minus the per-run test roots, as in
 *  server/test-support/temp-root.test.ts. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("ISOMUX_TEST_") &&
      k !== "ISOMUX_HOME" &&
      k !== "TMPDIR"
    )
      env[k] = v;
  return { ...env, ...extra };
}

/**
 * Writes the fixture files into a fresh directory and runs them, in the given
 * order, in one `bun test` from the repo root (so bunfig's preload applies).
 * Every fixture appends its name to ORDER_FILE when it loads: the cases assert
 * that order, so a runner that reorders files cannot make them pass vacuously.
 */
async function runInOneProcess(
  name: string,
  fixtures: [string, string][],
  env: Record<string, string> = {},
) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const orderFile = join(dir, "order.txt");
  writeFileSync(orderFile, "");
  const paths = fixtures.map(([file, source]) => {
    const path = join(dir, file);
    writeFileSync(path, source);
    return path;
  });
  const report = join(dir, "report.xml");
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...paths,
    ],
    {
      cwd: REPO,
      env: childEnv({ ORDER_FILE: orderFile, ...env }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = `bun test exited ${code}:\n${out}${err}`;
  const results = readReport(readFileSync(report, "utf8"));
  const file = (fixture: string): FileResult => {
    const result = results.get(join(dir, fixture));
    if (!result) throw new Error(`no report for ${fixture}\n${output}`);
    return result;
  };
  const order = readFileSync(orderFile, "utf8").split("\n").filter(Boolean);
  return { code, output, file, order, path: (f: string) => join(dir, f) };
}

/** A DOM fixture: the harness file shape, with `body` after setUpDomTestFile(). */
function domFixture(
  name: string,
  body: string,
  { beforeSetUp = "", setUp = "setUpDomTestFile();" } = {},
): [string, string] {
  return [
    `${name}.dom.test.ts`,
    `import { afterAll, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { setUpDomTestFile, stubGlobal } from ${JSON.stringify(HARNESS)};
appendFileSync(process.env.ORDER_FILE!, ${JSON.stringify(name)} + "\\n");
${beforeSetUp}
${setUp}
${body}
void afterAll; void expect; void stubGlobal;
`,
  ];
}

/** A plain fixture with no DOM: what every file after a DOM file should see. */
function bunGlobalsCheck(name: string): [string, string] {
  return [
    `${name}.test.ts`,
    `import { expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ORDER_FILE!, ${JSON.stringify(name)} + "\\n");
it("has Bun's own globals", async () => {
  const g = globalThis as Record<string, unknown>;
  expect(typeof g.window).toBe("undefined");
  expect(typeof g.document).toBe("undefined");
  for (const key of ["isSecureContext", "AudioContext", "chrome"])
    expect(key in globalThis, key).toBe(false);
  // Bun's fetch reaches a server; a stub or a closed window's fetch does not.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("bun") });
  try {
    const res = await fetch(server.url);
    expect(await res.text()).toBe("bun");
  } finally {
    server.stop(true);
  }
});
`,
  ];
}

const plainDomTest = `it("runs", () => {});`;

describe("render harness isolation", () => {
  it("fails a DOM file that leaves globals, and the next file sees Bun's", async () => {
    const run = await runInOneProcess("leaves", [
      domFixture(
        "leaver",
        `it("stubs and never restores", () => {
  (globalThis as Record<string, unknown>).fetch = async () => new Response("fake");
  (globalThis as Record<string, unknown>).isSecureContext = true;
});`,
      ),
      bunGlobalsCheck("after"),
    ]);
    expect(run.order).toEqual(["leaver", "after"]);
    const leaver = run.file("leaver.dom.test.ts");
    expect(leaver.passed).toContain("stubs and never restores");
    // One harness error that names the file (bun labels it "(unnamed)") and
    // every key it left: a replaced window key and an added one.
    expect(leaver.failures).toHaveLength(1);
    expect(leaver.failures[0]).toContain(run.path("leaver.dom.test.ts"));
    expect(leaver.failures[0]).toContain("fetch");
    expect(leaver.failures[0]).toContain("isSecureContext");
    expect(run.file("after.test.ts"), run.output).toEqual({
      passed: ["has Bun's own globals"],
      failures: [],
    });
  }, 30_000);

  it("blames a late restore on its own file, and the next DOM file names a late write", async () => {
    const run = await runInOneProcess("late", [
      // The pattern the task found: save the window's value after setup and
      // restore it in the file's own afterAll, which bun runs after the
      // harness's. The harness sees the stub still in place and fails the file.
      domFixture(
        "late",
        `const real = globalThis.fetch;
afterAll(() => { globalThis.fetch = real; });
it("stubs fetch", () => {
  globalThis.fetch = (async () => new Response("fake")) as unknown as typeof fetch;
});`,
      ),
      // A write the harness cannot see: the file is clean when the harness
      // checks, and its own afterAll changes a global after that.
      domFixture(
        "writer",
        `afterAll(() => { (globalThis as Record<string, unknown>).isSecureContext = true; });
${plainDomTest}`,
      ),
      domFixture("next", plainDomTest),
      bunGlobalsCheck("after"),
    ]);
    expect(run.order).toEqual(["late", "writer", "next", "after"]);
    const late = run.file("late.dom.test.ts");
    expect(late.passed).toContain("stubs fetch");
    expect(late.failures).toHaveLength(1);
    expect(late.failures[0]).toContain(run.path("late.dom.test.ts"));
    expect(late.failures[0]).toContain("fetch");
    expect(run.file("writer.dom.test.ts")).toEqual({
      passed: ["runs"],
      failures: [],
    });
    // The next DOM file finds the late write, puts Bun's globals back, and
    // fails naming the DOM file before it as the cause.
    const next = run.file("next.dom.test.ts");
    expect(next.failures).toHaveLength(1);
    expect(next.failures[0]).toContain(run.path("writer.dom.test.ts"));
    expect(next.failures[0]).toContain("isSecureContext");
    expect(run.file("after.test.ts"), run.output).toEqual({
      passed: ["has Bun's own globals"],
      failures: [],
    });
  }, 30_000);

  it("names an earlier file when a non-DOM file left a global between two DOM files", async () => {
    const run = await runInOneProcess("between", [
      domFixture("first", plainDomTest),
      [
        "leaker.test.ts",
        `import { it } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ORDER_FILE!, "leaker\\n");
it("sets chrome", () => { (globalThis as Record<string, unknown>).chrome = {}; });
`,
      ],
      domFixture("second", plainDomTest),
      bunGlobalsCheck("after"),
    ]);
    expect(run.order).toEqual(["first", "leaker", "second", "after"]);
    expect(run.file("first.dom.test.ts")).toEqual({
      passed: ["runs"],
      failures: [],
    });
    expect(run.file("leaker.test.ts").passed).toEqual(["sets chrome"]);
    const second = run.file("second.dom.test.ts");
    expect(second.failures).toHaveLength(1);
    expect(second.failures[0]).toContain("chrome");
    expect(second.failures[0]).toContain(run.path("first.dom.test.ts"));
    expect(run.file("after.test.ts"), run.output).toEqual({
      passed: ["has Bun's own globals"],
      failures: [],
    });
  }, 30_000);

  // A file outside the harness that leaks before the first harness file of the
  // process loads it (task 4a2ca1fd): the harness must neither take the leak
  // for one of Bun's globals nor blame the first harness file for it.
  it("names an earlier file, not the first DOM file, for a global left before the harness loaded", async () => {
    const leaker: [string, string] = [
      "leaker.test.ts",
      `import { it } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ORDER_FILE!, "leaker\\n");
(globalThis as Record<string, unknown>).isSecureContext = true;
it("runs", () => {});
`,
    ];
    const [touched, untouched] = await Promise.all([
      runInOneProcess("leaked-first-touched", [
        leaker,
        // Sets the leaked key for one test and deletes it after: clean.
        domFixture(
          "toucher",
          `import { afterEach } from "bun:test";
afterEach(() => { delete (globalThis as Record<string, unknown>).isSecureContext; });
it("sets isSecureContext for one test", () => {
  Object.defineProperty(globalThis, "isSecureContext", { value: true, writable: true, configurable: true });
});`,
        ),
        bunGlobalsCheck("after"),
      ]),
      runInOneProcess("leaked-first-untouched", [
        leaker,
        domFixture("quiet", plainDomTest),
        domFixture(
          "leaver",
          `it("sets chrome", () => { (globalThis as Record<string, unknown>).chrome = {}; });`,
        ),
        bunGlobalsCheck("after"),
      ]),
    ]);
    expect(touched.order).toEqual(["leaker", "toucher", "after"]);
    expect(untouched.order).toEqual(["leaker", "quiet", "leaver", "after"]);

    // Each sentence that lists `key` as changed, up to the list: whom it
    // blames. The harness reports each problem on a line of its own.
    const blamesFor = (failure: string, key: string): string[] => {
      const lines = [
        ...failure.matchAll(
          new RegExp(`^(.*?): (?:[\\w$]+, )*${key}\\b`, "gm"),
        ),
      ].map((line) => line[1]!);
      if (!lines.length)
        throw new Error(`no sentence lists ${key}:\n${failure}`);
      return lines;
    };
    const blaming = (failure: string, key: string, path: string) =>
      blamesFor(failure, key).filter((line) => line.includes(path));

    // The file that touched the key is reported, but not blamed for it.
    const toucher = touched.file("toucher.dom.test.ts");
    expect(toucher.passed).toEqual(["sets isSecureContext for one test"]);
    expect(toucher.failures, touched.output).toHaveLength(1);
    expect(
      blaming(
        toucher.failures[0]!,
        "isSecureContext",
        touched.path("toucher.dom.test.ts"),
      ),
    ).toEqual([]);

    // A first harness file that never touched the key reports it too.
    const quiet = untouched.file("quiet.dom.test.ts");
    expect(quiet.passed).toEqual(["runs"]);
    expect(quiet.failures, untouched.output).toHaveLength(1);
    expect(
      blaming(
        quiet.failures[0]!,
        "isSecureContext",
        untouched.path("quiet.dom.test.ts"),
      ),
    ).toEqual([]);
    // Once: the next harness file is blamed only for what it left itself.
    // That sentence names its file, which shows blamesFor reads the blame.
    const leaver = untouched.file("leaver.dom.test.ts");
    expect(leaver.failures).toHaveLength(1);
    expect(leaver.failures[0]).not.toContain("isSecureContext");
    expect(
      blaming(
        leaver.failures[0]!,
        "chrome",
        untouched.path("leaver.dom.test.ts"),
      ).length,
    ).toBeGreaterThan(0);

    // The harness put Bun's globals back, not the leaked value.
    for (const run of [touched, untouched])
      expect(run.file("after.test.ts"), run.output).toEqual({
        passed: ["has Bun's own globals"],
        failures: [],
      });
  }, 30_000);

  it("puts back what stubGlobal replaced or added, also past the cap", async () => {
    const run = await runInOneProcess("stubs", [
      domFixture(
        "stubs",
        `stubGlobal("fetch", async () => new Response("one"));
stubGlobal("isSecureContext", true);
// A second stub of one name: the value before the FIRST one is what comes back.
stubGlobal("fetch", async () => new Response("two"));
it("sees its stubs", async () => {
  expect(await (await fetch("http://localhost/x")).text()).toBe("two");
  expect((globalThis as Record<string, unknown>).isSecureContext).toBe(true);
});`,
      ),
      // The previous file set up the harness; this one has not, yet.
      domFixture(
        "early",
        `stubGlobal("stubbedAfterSetUp", 2);
it("refuses a stub before this file's setup", () => {
  expect(threw).toBe(true);
  const g = globalThis as Record<string, unknown>;
  expect("stubbedBeforeSetUp" in g).toBe(false);
  expect(g.stubbedAfterSetUp).toBe(2);
});`,
        {
          beforeSetUp: `let threw = false;
try { stubGlobal("stubbedBeforeSetUp", 1); } catch { threw = true; }`,
        },
      ),
      domFixture(
        "capped",
        `stubGlobal("isSecureContext", true);
stubGlobal("fetch", async () => new Response("capped"));
${plainDomTest}`,
        { setUp: "setUpDomTestFile({ capMs: 0 });" },
      ),
      bunGlobalsCheck("after"),
      [
        "no-leftover.test.ts",
        `import { expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ORDER_FILE!, "no-leftover\\n");
it("has no stubbed key", () => {
  expect("stubbedAfterSetUp" in globalThis).toBe(false);
});
`,
      ],
    ]);
    expect(run.order).toEqual([
      "stubs",
      "early",
      "capped",
      "after",
      "no-leftover",
    ]);
    expect(run.file("stubs.dom.test.ts"), run.output).toEqual({
      passed: ["sees its stubs"],
      failures: [],
    });
    expect(run.file("early.dom.test.ts"), run.output).toEqual({
      passed: ["refuses a stub before this file's setup"],
      failures: [],
    });
    // capMs 0: the cap throws, and the stubs still come off.
    expect(run.file("capped.dom.test.ts").failures.length).toBeGreaterThan(0);
    expect(run.file("after.test.ts"), run.output).toEqual({
      passed: ["has Bun's own globals"],
      failures: [],
    });
    expect(run.file("no-leftover.test.ts"), run.output).toEqual({
      passed: ["has no stubbed key"],
      failures: [],
    });
  }, 30_000);

  it("fails a DOM file whose requests go through happy-dom, and none leaves the process", async () => {
    let connections = 0;
    const listener = net.createServer((socket) => {
      connections++;
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
      );
    });
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const { port } = listener.address() as net.AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const run = await runInOneProcess(
        "requests",
        [
          domFixture(
            "requester",
            `it("gets a network error", async () => {
  const error = await fetch(process.env.LISTEN_URL + "/api/probe").then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe("TypeError");
  const xhr = new XMLHttpRequest();
  try {
    xhr.open("POST", process.env.LISTEN_URL + "/api/sync", false);
    xhr.send("{}");
  } catch {}
});`,
          ),
          bunGlobalsCheck("after"),
        ],
        { LISTEN_URL: base },
      );
      expect(run.order).toEqual(["requester", "after"]);
      const requester = run.file("requester.dom.test.ts");
      expect(requester.passed).toContain("gets a network error");
      expect(requester.failures).toHaveLength(1);
      expect(requester.failures[0]).toContain(
        run.path("requester.dom.test.ts"),
      );
      expect(requester.failures[0]).toContain(`GET ${base}/api/probe`);
      expect(requester.failures[0]).toContain(`POST ${base}/api/sync`);
      expect(connections).toBe(0);
      expect(run.file("after.test.ts"), run.output).toEqual({
        passed: ["has Bun's own globals"],
        failures: [],
      });
    } finally {
      listener.close();
    }
  }, 30_000);
});

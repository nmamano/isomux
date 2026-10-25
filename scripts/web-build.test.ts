import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import {
  type BuildRun,
  RETRY_BUILD_WORKERS,
  buildCrash,
  runWebBuild,
} from "./web-build";

afterEach(() => {
  mock.restore();
});

type Ending = { code: number; signal: string | null; output: string };

// The line Next.js 16.3.8 printed when a page-data worker died in CI
// (2026-10-25, task 65d244ad), with the lines around it.
const WORKER_SEGV = [
  "  Collecting page data using 27 workers ...",
  "⨯ Next.js build worker exited with code: null and signal: SIGSEGV",
  "",
].join("\n");

const BUILD_ERROR = [
  "Failed to compile.",
  "./app/page.tsx:3:1",
  "Type error: Cannot find name 'missing'.",
  "",
].join("\n");

const OK = { code: 0, signal: null, output: "✓ Compiled successfully\n" };

/** Runs the build as a script of endings; a run past the script fails the test. */
async function buildWith(endings: Ending[]) {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  spyOn(console, "log").mockImplementation(keep);
  spyOn(console, "error").mockImplementation(keep);
  spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  const workers: (number | undefined)[] = [];
  const run: BuildRun = async (count) => {
    workers.push(count);
    const ending = endings[workers.length - 1];
    if (!ending) throw new Error(`unexpected build run ${workers.length}`);
    return ending;
  };
  const code = await runWebBuild(run);
  return { code, workers, lines };
}

it("tells a worker or process crash from a build that failed or passed", () => {
  const segv = buildCrash({ code: 1, signal: null, output: WORKER_SEGV });
  expect(segv).toContain("SIGSEGV");

  // A worker that exited with a code is not a signal death: it can be a real
  // failure, so it gets no retry.
  expect(
    buildCrash({
      code: 1,
      signal: null,
      output: "⨯ Next.js build worker exited with code: 1 and signal: null\n",
    }),
  ).toBeUndefined();
  expect(
    buildCrash({ code: 1, signal: null, output: BUILD_ERROR }),
  ).toBeUndefined();
  expect(buildCrash(OK)).toBeUndefined();
  // A worker line in a run that still exited 0 is no failure to retry.
  expect(
    buildCrash({ code: 0, signal: null, output: WORKER_SEGV }),
  ).toBeUndefined();

  // The build process itself died: Bun reports it as 128 plus the signal.
  expect(
    buildCrash({ code: 139, signal: "SIGSEGV", output: "" }),
  ).toBeDefined();
  expect(buildCrash({ code: 137, signal: null, output: "" })).toBeDefined();
});

it("runs the build once when it passes or fails with a build error", async () => {
  const passed = await buildWith([OK]);
  expect(passed.code).toBe(0);
  // The first run keeps Next's own worker count.
  expect(passed.workers).toStrictEqual([undefined]);

  const failed = await buildWith([
    { code: 1, signal: null, output: BUILD_ERROR },
  ]);
  expect(failed.code).toBe(1);
  expect(failed.workers).toStrictEqual([undefined]);
});

it("runs a crashed build again with fewer workers and returns that run's code", async () => {
  const recovered = await buildWith([
    { code: 1, signal: null, output: WORKER_SEGV },
    OK,
  ]);
  expect(recovered.workers).toStrictEqual([undefined, RETRY_BUILD_WORKERS]);
  expect(recovered.code).toBe(0);
  const said = recovered.lines.join("\n");
  expect(said).toContain("SIGSEGV");
  expect(said).toContain(String(RETRY_BUILD_WORKERS));

  // The retry's verdict stands: a real error on the second run fails CI.
  const failed = await buildWith([
    { code: 1, signal: null, output: WORKER_SEGV },
    { code: 1, signal: null, output: BUILD_ERROR },
  ]);
  expect(failed.workers).toStrictEqual([undefined, RETRY_BUILD_WORKERS]);
  expect(failed.code).toBe(1);
});

it("fails when the build crashes on the retry too", async () => {
  const { code, workers } = await buildWith([
    { code: 1, signal: null, output: WORKER_SEGV },
    { code: 139, signal: "SIGSEGV", output: "" },
  ]);
  expect(workers).toStrictEqual([undefined, RETRY_BUILD_WORKERS]);
  expect(code).not.toBe(0);
});

const repoRoot = path.join(import.meta.dirname, "..");

/** experimental.cpus of the config Next loads, with the worker count set to `value`. */
async function configCpus(value: string | undefined): Promise<unknown> {
  const env = { ...process.env };
  delete env.ISOMUX_WEB_BUILD_WORKERS;
  if (value !== undefined) env.ISOMUX_WEB_BUILD_WORKERS = value;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const c = (await import("./control-plane/web/next.config.ts")).default;' +
        "console.log(JSON.stringify({ cpus: c.experimental?.cpus ?? null, root: c.turbopack?.root ?? null }));",
    ],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`next.config.ts did not load: ${err}`);
  const parsed = JSON.parse(out) as { cpus: unknown; root: unknown };
  // The config loaded in full, not a stand-in object.
  expect(parsed.root).toBe(repoRoot);
  return parsed.cpus;
}

it("hands Next the retry's worker count and nothing else", async () => {
  expect(await configCpus("4")).toBe(4);
  expect(await configCpus(undefined)).toBeNull();
  for (const bad of ["", "0", "-2", "2.5", "abc"])
    expect({ bad, cpus: await configCpus(bad) }).toEqual({ bad, cpus: null });
});

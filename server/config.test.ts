import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { resolveStateRoot, STATE_ROOT } from "./config.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

describe("resolveStateRoot", () => {
  const DEFAULT = join(homedir(), ".isomux");

  it.each([
    ["unset", undefined, DEFAULT],
    // Whitespace only reads as unset.
    ["whitespace", "   ", DEFAULT],
    ["absolute", "/tmp/isomux-test-root", "/tmp/isomux-test-root"],
    ["relative", "rel/state-dir", resolve("rel/state-dir")],
  ])("an ISOMUX_HOME that is %s", (_label, home, expected) => {
    expect(
      resolveStateRoot(home === undefined ? {} : { ISOMUX_HOME: home }),
    ).toBe(expected);
  });
});

describe("STATE_ROOT", () => {
  it("matches the resolver applied to the current process env", () => {
    expect(STATE_ROOT).toBe(resolveStateRoot(process.env));
  });
});

// bun reads bunfig.toml, and with it the test preload, only from the directory
// it runs in. Each case runs a probe that imports config.ts from a temp dir
// with no bunfig.toml and HOME moved into that dir, so the "live" root it
// guards is <temp>/home/.isomux, never the real one.
describe("a bun test run without the test preload", () => {
  const CONFIG = join(import.meta.dir, "config.ts");
  let dir = "";
  let home = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-config-guard-"));
    home = join(dir, "home");
    mkdirSync(home);
    // The test body records the state root it saw; a refused run must never
    // reach it.
    const body = `import { test } from "bun:test";
import { writeFileSync } from "fs";
import { STATE_ROOT } from ${JSON.stringify(CONFIG)};
test("probe", () => { writeFileSync(process.env.PROBE_SENTINEL!, STATE_ROOT); });
`;
    writeFileSync(join(dir, "probe.test.ts"), body);
    // bun test runs a file without a test-file name when the path is explicit.
    writeFileSync(join(dir, "probe-plain.ts"), body);
    // The server boot: a plain bun run of a module that imports config.ts.
    writeFileSync(
      join(dir, "boot.ts"),
      `import { writeFileSync } from "fs";
import { STATE_ROOT } from ${JSON.stringify(CONFIG)};
writeFileSync(process.env.PROBE_SENTINEL!, STATE_ROOT);
`,
    );
  });

  afterAll(() => removeStateDir(dir));

  type Case = {
    args: string[];
    env: (home: string, dir: string) => Record<string, string>;
    root: (home: string, dir: string) => string;
    refused: boolean;
  };
  const liveRoot = (h: string) => join(h, ".isomux");
  let runs = 0;

  it.each<[string, Case]>([
    [
      "refused when bun test sets NODE_ENV and the file has no test-file name",
      {
        args: ["test", "./probe-plain.ts"],
        env: () => ({}),
        root: liveRoot,
        refused: true,
      },
    ],
    [
      "refused when NODE_ENV is production and the file has a test-file name",
      {
        args: ["test", "./probe.test.ts"],
        env: () => ({ NODE_ENV: "production" }),
        root: liveRoot,
        refused: true,
      },
    ],
    [
      "refused when ISOMUX_HOME names the live root",
      {
        args: ["test", "./probe.test.ts"],
        env: (h) => ({ ISOMUX_HOME: join(h, ".isomux") }),
        root: liveRoot,
        refused: true,
      },
    ],
    [
      "allowed with the preload marker",
      {
        args: ["test", "./probe.test.ts"],
        env: () => ({ ISOMUX_TEST_PRELOAD: "1" }),
        root: liveRoot,
        refused: false,
      },
    ],
    [
      "allowed when ISOMUX_HOME moves the root",
      {
        args: ["test", "./probe.test.ts"],
        env: (_h, d) => ({ ISOMUX_HOME: join(d, "state") }),
        root: (_h, d) => join(d, "state"),
        refused: false,
      },
    ],
    [
      "allowed outside bun test (the server boot)",
      {
        args: ["./boot.ts"],
        env: () => ({}),
        root: liveRoot,
        refused: false,
      },
    ],
  ])("%s", async (_label, c) => {
    const sentinel = join(dir, `sentinel-${++runs}`);
    const proc = Bun.spawn([process.execPath, ...c.args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        PROBE_SENTINEL: sentinel,
        ...c.env(home, dir),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const root = c.root(home, dir);
    if (c.refused) {
      expect(code).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      // The refusal names the root it protected.
      expect(stdout + stderr).toContain(root);
    } else {
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(readFileSync(sentinel, "utf8")).toBe(root);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./temp-state.ts";

// The state helpers must refuse a state root the preload did not make. Each
// case runs a probe through the gap config.ts's import guard leaves open (an
// exported NODE_ENV and a bun test path without a test-file name), from a
// folder with no bunfig.toml, so no preload runs. HOME is moved into the test's
// temp folder and the probe checks it before it imports any state module, so
// the root it acts on is never the real ~/.isomux.
describe("test state helpers outside the preload's temp root", () => {
  const CONFIG = join(import.meta.dir, "..", "config.ts");
  const ENV_HELPERS = join(import.meta.dir, "managed-office-env.ts");
  const CONFIG_FILE = join(import.meta.dir, "office-config-file.ts");
  let dir = "";
  let childTmp = "";
  let home = "";
  let runs = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-state-helpers-"));
    childTmp = join(dir, "child-tmp");
    home = join(childTmp, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(dir, "probe-plain.ts"),
      `import { test } from "bun:test";
import { writeFileSync } from "fs";
import { homedir } from "os";
test("probe", async () => {
  const out = process.env.PROBE_OUT!;
  const { STATE_ROOT } = await import(${JSON.stringify(CONFIG)});
  if (homedir() !== process.env.HOME || STATE_ROOT !== process.env.PROBE_ROOT) {
    writeFileSync(out, JSON.stringify({ aborted: { home: homedir(), root: STATE_ROOT } }));
    return;
  }
  const env = await import(${JSON.stringify(ENV_HELPERS)});
  const configFile = await import(${JSON.stringify(CONFIG_FILE)});
  const calls: [string, () => void][] = [
    ["clearTestManagedOfficeEnv", () => env.clearTestManagedOfficeEnv()],
    ["setTestManagedOfficeEnv", () => env.setTestManagedOfficeEnv({ PROBE_VAR: "written" })],
    ["patchOfficeConfig", () => configFile.patchOfficeConfig({ probe: "written" })],
  ];
  const refused: Record<string, string | null> = {};
  for (const [name, call] of calls) {
    try {
      call();
      refused[name] = null;
    } catch (err) {
      refused[name] = String((err as Error).message ?? err);
    }
  }
  writeFileSync(out, JSON.stringify({ refused }));
});
`,
    );
  });

  afterAll(() => removeStateDir(dir));

  // What a wrong delete or write would change: the office variables folder and
  // the office config.
  function seedDecoy(root: string): void {
    mkdirSync(join(root, "office-env"), { recursive: true });
    writeFileSync(join(root, "office-env", "office.env"), "DECOY_VAR=keep\n");
    writeFileSync(join(root, "office-config.json"), '{"decoy":true}\n');
  }
  function snapshot(root: string): Record<string, string | null> {
    const envDir = join(root, "office-env");
    const files: Record<string, string | null> = {};
    if (existsSync(envDir)) {
      for (const name of readdirSync(envDir)) {
        files[`office-env/${name}`] = readFileSync(join(envDir, name), "utf8");
      }
    }
    const config = join(root, "office-config.json");
    files["office-config.json"] = existsSync(config)
      ? readFileSync(config, "utf8")
      : null;
    return files;
  }

  // Waits for the probe for at most PROBE_DEADLINE_MS. A probe still running
  // then gets SIGKILL and KILL_GRACE_MS to exit, so the case ends red inside
  // its own timeout and never awaits an unbounded child (task 78a55448: in
  // desktop CI a probe spun at full CPU past the case timeout). The stderr
  // read is raced too: it waits for EOF, which a stuck child never sends.
  const PROBE_DEADLINE_MS = 15_000;
  const KILL_GRACE_MS = 3_000;
  async function waitBounded(
    proc: Bun.Subprocess<"ignore", "ignore", "pipe">,
  ): Promise<
    | { code: number; stderr: string }
    | { finishedInTime: false; exitedAfterKill: boolean }
  > {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => {
        timers.push(setTimeout(() => resolve(value), ms));
      });
    try {
      const finished = Promise.all([
        new Response(proc.stderr).text().catch(() => ""),
        proc.exited,
      ]).then(([stderr, code]) => ({ code, stderr }));
      const result = await Promise.race([
        finished,
        after(PROBE_DEADLINE_MS, null),
      ]);
      if (result) return result;
      proc.kill("SIGKILL");
      const exitedAfterKill = await Promise.race([
        proc.exited.then(() => true),
        after(KILL_GRACE_MS, false),
      ]);
      return { finishedInTime: false, exitedAfterKill };
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }

  it.each<
    [string, { root: () => string; extraEnv: () => Record<string, string> }]
  >([
    [
      "the default root ~/.isomux, inside the OS temp dir",
      { root: () => join(home, ".isomux"), extraEnv: () => ({}) },
    ],
    [
      "an explicit root outside the OS temp dir",
      {
        root: () => join(dir, "decoy-state"),
        extraEnv: () => ({ ISOMUX_HOME: join(dir, "decoy-state") }),
      },
    ],
  ])(
    "refuses %s and leaves it as it was",
    async (_label, c) => {
      const root = c.root();
      seedDecoy(root);
      const before = snapshot(root);
      const out = join(dir, `out-${++runs}.json`);
      const proc = Bun.spawn([process.execPath, "test", "./probe-plain.ts"], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: childTmp,
          NODE_ENV: "production",
          PROBE_OUT: out,
          PROBE_ROOT: root,
          ...c.extraEnv(),
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const run = await waitBounded(proc);
      expect(
        "code" in run && run.code === 0 ? { code: 0, stderr: "" } : run,
      ).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(readFileSync(out, "utf8")) as {
        aborted?: unknown;
        refused?: Record<string, string | null>;
      };
      // The probe acted on the decoy root, with HOME moved.
      expect(result.aborted).toBeUndefined();
      // Each helper refused, naming a path under the root it protected.
      const refused = result.refused ?? {};
      const names = [
        "clearTestManagedOfficeEnv",
        "setTestManagedOfficeEnv",
        "patchOfficeConfig",
      ];
      expect(
        Object.fromEntries(
          names.map((n) => [
            n,
            refused[n]?.includes(root) ? "refused" : (refused[n] ?? null),
          ]),
        ),
      ).toEqual(Object.fromEntries(names.map((n) => [n, "refused"])));
      expect(snapshot(root)).toEqual(before);
    },
    30_000,
  );
});

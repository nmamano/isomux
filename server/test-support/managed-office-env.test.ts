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
  const APP_KIT = join(import.meta.dir, "app-host-test-kit.ts");
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
  const kit = await import(${JSON.stringify(APP_KIT)});
  const calls: [string, () => void][] = [
    ["clearTestManagedOfficeEnv", () => env.clearTestManagedOfficeEnv()],
    ["setTestManagedOfficeEnv", () => env.setTestManagedOfficeEnv({ PROBE_VAR: "written" })],
    ["patchOfficeConfig", () => kit.patchOfficeConfig({ probe: "written" })],
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
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
        code: 0,
        stderr: "",
      });
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

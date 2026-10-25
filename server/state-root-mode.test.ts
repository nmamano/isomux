// The state root's own mode is the fence against other OS users (task
// fe7619bc): with no group or other bits on the root, nothing below it is
// reachable for them, whatever the modes of the files below.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { secureStateRoot } from "./state-root-mode.ts";

const ENTRY_POINT = `${import.meta.dir}/isomux-office.ts`;

const mode = (path: string) => statSync(path).mode & 0o777;

let dir: string;
let previousUmask: number;
let spies: ReturnType<typeof spyOn>[];

/** Every console line the function printed, by channel. */
function printed() {
  const [log, info, warn, error] = spies.map((s) =>
    s.mock.calls.map((args: unknown[]) => args.map(String).join(" ")),
  );
  return { log, info, warn, error, all: [...log, ...info, ...warn, ...error] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isomux-state-root-mode-"));
  // The common ambient umask, under which a plain mkdir gives 0775.
  previousUmask = process.umask(0o002);
  spies = (["log", "info", "warn", "error"] as const).map((channel) =>
    spyOn(console, channel).mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.umask(previousUmask);
  rmSync(dir, { recursive: true, force: true });
});

describe("secureStateRoot", () => {
  test("creates a missing root, and its missing parents, closed to other users", () => {
    const root = join(dir, "parent", ".isomux");
    secureStateRoot(root);
    expect(mode(root)).toBe(0o700);
    // Created private, not created open and then closed.
    expect(printed().all).toEqual([]);
  });

  // 0711 and 0701 matter as much as 0775: execute alone lets another user
  // reach every path below whose name they can guess (logs/<agent id>/...).
  test.each(["775", "755", "750", "711", "701"])(
    "closes an existing root at %s and says so once",
    (octal) => {
      const initial = parseInt(octal, 8);
      const root = join(dir, ".isomux");
      mkdirSync(root);
      chmodSync(root, initial);
      expect(mode(root)).toBe(initial);

      secureStateRoot(root);

      expect(mode(root)).toBe(0o700);
      const lines = printed().all;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(root);
    },
  );

  test("leaves a private root alone and prints nothing", async () => {
    const root = join(dir, ".isomux");
    mkdirSync(root);
    chmodSync(root, 0o700);
    const before = statSync(root, { bigint: true }).ctimeNs;
    // A chmod sets ctime even when the mode does not change. The kernel's
    // timestamp clock is coarse (one tick), so wait past it first.
    await Bun.sleep(30);

    secureStateRoot(root);

    expect(statSync(root, { bigint: true }).ctimeNs).toBe(before);
    expect(mode(root)).toBe(0o700);
    expect(printed().all).toEqual([]);
  });

  test("an unusable root path warns once and returns", () => {
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    chmodSync(file, 0o644);

    // The parent is a regular file, so the directory cannot be created.
    const under = join(file, ".isomux");
    secureStateRoot(under);
    expect(existsSync(under)).toBe(false);

    // The root itself is a regular file: it is not a directory to close.
    secureStateRoot(file);
    expect(mode(file)).toBe(0o644);

    const out = printed();
    expect(out.warn).toHaveLength(2);
    expect(out.all).toHaveLength(2);
  });
});

describe("wiring", () => {
  // Proves runOfficeMain calls it: the real entry point, booted on a root left
  // at 0775 by an older install. 2026-10-11 (server/process-name.test.ts): a
  // cold import of the office graph takes 2-3 s under load.
  test("the office closes an existing state root when it starts", async () => {
    const home = join(dir, "home");
    const root = join(home, ".isomux");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o775);
    expect(mode(root)).toBe(0o775);

    const proc = Bun.spawn(["bun", "run", ENTRY_POINT], {
      env: {
        ...process.env,
        HOME: home,
        ISOMUX_HOME: root,
        ISOMUX_BACKUP_DIR: join(dir, "backups"),
        XDG_CONFIG_HOME: join(home, ".config"),
        PORT: "0",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();
    try {
      const deadline = performance.now() + 15_000;
      while (
        mode(root) !== 0o700 &&
        proc.exitCode === null &&
        performance.now() < deadline
      )
        await Bun.sleep(50);
      const alive = proc.exitCode === null;
      const got: Record<string, unknown> = {
        mode: mode(root).toString(8),
        alive,
      };
      if (got.mode !== "700" || !alive) {
        proc.kill();
        got.stderr = (await stderr).slice(-2000);
      }
      expect(got).toEqual({ mode: "700", alive: true });
    } finally {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
      await stderr;
    }
  }, 30_000);
});

// The bridge package download (task d03a61d8): installs from the pinned
// lockfile into the runtime dir once, again when the pin changes, one install
// at a time, and reports a failure as a result, never a throw. runInstall is
// faked; the files are real.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { createBridgeInstaller } from "./installer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t-d03a61d8-inst-"));
  dirs.push(root);
  const packageDir = join(root, "bridge");
  const runtimeDir = join(root, "state", "whatsapp", "runtime");
  mkdirSync(packageDir, { recursive: true });
  const f = {
    packageDir,
    runtimeDir,
    stamp: join(runtimeDir, ".lock-sha256"),
    // What runInstall found in runtimeDir at each call.
    calls: [] as { dir: string; pkg: string; lock: string }[],
    exitCode: 0 as number,
    throwIt: false,
    gate: null as Promise<void> | null,
    setPackage(pkg: string, lock: string) {
      writeFileSync(join(packageDir, "package.json"), pkg);
      writeFileSync(join(packageDir, "bun.lock"), lock);
    },
  };
  f.setPackage('{"dependencies":{"baileys":"7.0.0-rc14"}}', "LOCK-A");
  const installer = createBridgeInstaller({
    runtimeDir,
    packageDir,
    runInstall: async (dir) => {
      f.calls.push({
        dir,
        pkg: readFileSync(join(dir, "package.json"), "utf8"),
        lock: readFileSync(join(dir, "bun.lock"), "utf8"),
      });
      if (f.gate) await f.gate;
      if (f.throwIt) throw new Error("spawn bun ENOENT");
      return f.exitCode;
    },
  });
  return { f, installer };
}

describe("whatsapp bridge installer", () => {
  it("installs once from the copied package files and stamps the lockfile hash", async () => {
    const { f, installer } = fixture();
    expect(await installer.ensure()).toEqual({
      ok: true,
      runtimeDir: f.runtimeDir,
    });
    expect(f.calls).toEqual([
      {
        dir: f.runtimeDir,
        pkg: '{"dependencies":{"baileys":"7.0.0-rc14"}}',
        lock: "LOCK-A",
      },
    ]);
    expect(readFileSync(f.stamp, "utf8").trim()).toBe(sha256("LOCK-A"));

    expect(await installer.ensure()).toEqual({
      ok: true,
      runtimeDir: f.runtimeDir,
    });
    expect(f.calls).toHaveLength(1);
  });

  it("installs again when a release changes the pin", async () => {
    const { f, installer } = fixture();
    await installer.ensure();
    f.setPackage('{"dependencies":{"baileys":"7.0.1"}}', "LOCK-B");
    expect((await installer.ensure()).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toMatchObject({
      pkg: '{"dependencies":{"baileys":"7.0.1"}}',
      lock: "LOCK-B",
    });
    expect(readFileSync(f.stamp, "utf8").trim()).toBe(sha256("LOCK-B"));
  });

  it("concurrent callers share one install", async () => {
    const { f, installer } = fixture();
    let open!: () => void;
    f.gate = new Promise((r) => (open = r));
    const a = installer.ensure();
    const b = installer.ensure();
    await Bun.sleep(5);
    open();
    expect(await Promise.all([a, b])).toEqual([
      { ok: true, runtimeDir: f.runtimeDir },
      { ok: true, runtimeDir: f.runtimeDir },
    ]);
    expect(f.calls).toHaveLength(1);
  });

  it("a failed or throwing install is a result, leaves no stamp, and the next call tries again", async () => {
    const { f, installer } = fixture();
    f.exitCode = 1;
    expect(await installer.ensure()).toEqual({ ok: false });
    expect(existsSync(f.stamp)).toBe(false);

    f.exitCode = 0;
    f.throwIt = true;
    expect(await installer.ensure()).toEqual({ ok: false });
    expect(existsSync(f.stamp)).toBe(false);

    f.throwIt = false;
    expect((await installer.ensure()).ok).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  it("a failed reinstall after a pin change does not count as installed", async () => {
    const { f, installer } = fixture();
    await installer.ensure();
    f.setPackage('{"dependencies":{"baileys":"7.0.1"}}', "LOCK-B");
    f.exitCode = 1;
    expect(await installer.ensure()).toEqual({ ok: false });
    f.exitCode = 0;
    expect((await installer.ensure()).ok).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(readFileSync(f.stamp, "utf8").trim()).toBe(sha256("LOCK-B"));
  });
});

// Downloads the bridge package (server/whatsapp/bridge/package.json, pinned by
// its own bun.lock) into STATE_ROOT/whatsapp/runtime/ on the first link, so an
// office that never links WhatsApp never gets it. runtime/.lock-sha256 holds
// the hash of the bun.lock it was installed from; a release that changes the
// pin makes ensure() install again. One install at a time: concurrent calls
// share it.

import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export type InstallResult = { ok: true; runtimeDir: string } | { ok: false };

export interface BridgeInstaller {
  ensure(): Promise<InstallResult>;
}

export interface BridgeInstallerDeps {
  // STATE_ROOT/whatsapp/runtime
  runtimeDir: string;
  // server/whatsapp/bridge (package.json + bun.lock)
  packageDir: string;
  // Runs `bun install --frozen-lockfile --ignore-scripts` in runtimeDir after
  // the package files are copied there; resolves to its exit code.
  runInstall(runtimeDir: string): Promise<number>;
}

const STAMP = ".lock-sha256";
const PACKAGE_FILES = ["package.json", "bun.lock"];

export function createBridgeInstaller(
  deps: BridgeInstallerDeps,
): BridgeInstaller {
  const { runtimeDir, packageDir } = deps;
  const stampPath = join(runtimeDir, STAMP);
  let inFlight: Promise<InstallResult> | null = null;

  async function install(): Promise<InstallResult> {
    try {
      const want = createHash("sha256")
        .update(readFileSync(join(packageDir, "bun.lock")))
        .digest("hex");
      if (
        existsSync(stampPath) &&
        readFileSync(stampPath, "utf8").trim() === want
      )
        return { ok: true, runtimeDir };
      // No stamp while the install runs: a failure part way is not installed.
      rmSync(stampPath, { force: true });
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      for (const name of PACKAGE_FILES)
        copyFileSync(join(packageDir, name), join(runtimeDir, name));
      if ((await deps.runInstall(runtimeDir)) !== 0) return { ok: false };
      writeFileSync(stampPath, want + "\n", { mode: 0o600 });
      return { ok: true, runtimeDir };
    } catch {
      return { ok: false };
    }
  }

  return {
    ensure() {
      inFlight ??= install().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

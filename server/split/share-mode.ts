// Modes in the share (internal-docs/os-user-split-design.md, section 3.1.1).
// Bun 1.3.11 drops the setgid bit in chmod: fs.chmodSync, fs.promises.chmod
// and fchmodSync all give 0750 for 0o2750 (measured 2026-10-06; Node keeps
// it). A share directory needs the bit, so that new entries get the agent
// group, so a mode with a bit above 0o777 goes through chmod(1).
import { spawnSync } from "child_process";
import { chmodSync } from "fs";

export function chmodShare(path: string, mode: number): void {
  if ((mode & ~0o777) === 0) {
    chmodSync(path, mode);
    return;
  }
  const result = spawnSync("chmod", [mode.toString(8), "--", path], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `chmod ${mode.toString(8)} ${path} failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
}

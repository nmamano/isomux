import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IS_DEFAULT_STATE_ROOT, STATE_ROOT } from "./config.ts";

// The receptionist deliberately differs from welcome agents' home-directory
// default. Keep its writable workspace outside the protected state root.
// The existing ISOMUX_HOME seam keeps tests and alternate offices isolated.
export const RECEPTIONIST_CWD = IS_DEFAULT_STATE_ROOT
  ? join(homedir(), "isomux-receptionist")
  : `${STATE_ROOT}-receptionist`;

export function ensureReceptionistWorkspace(): string {
  mkdirSync(RECEPTIONIST_CWD, { recursive: true, mode: 0o700 });
  const stat = lstatSync(RECEPTIONIST_CWD);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Receptionist workspace must be a directory, not a symlink");
  }
  return RECEPTIONIST_CWD;
}

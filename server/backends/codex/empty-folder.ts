// The empty folder a Codex thread below standard runs in (access.ts). It runs
// in agent space: in process, or as the runner's codex-empty-cwd entry in
// split mode. Only fs imports, so the entry loads nothing else.
import { lstatSync, mkdirSync, readdirSync } from "fs";
import { dirname } from "path";

// Makes `dir` (mode 0700) when it is missing and returns it. Throws when it
// is not a folder or holds anything.
export function ensureEmptyFolder(dir: string): string {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory())
    throw new Error(
      `Codex runs this agent in ${dir}, which is not a folder. Delete it, then try again.`,
    );
  if ((stat.mode & 0o777) !== 0o700 || readdirSync(dir).length > 0)
    throw new Error(
      `Codex runs this agent in ${dir}, which must be empty. Delete it, then try again.`,
    );
  return dir;
}

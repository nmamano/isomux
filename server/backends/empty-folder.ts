// The empty folder an agent at chat or office runs in, per engine
// (codex/access.ts, opencode/access.ts). It runs in agent space: in process,
// or as the runner's empty-folder entry in split mode, which takes the roots
// from the server (the agent user resolves another state root).
import { lstatSync, mkdirSync, readdirSync } from "fs";
import { dirname, isAbsolute, join, normalize } from "path";
import { AGENT_ROOT } from "../split/roots.ts";

// The parent of each engine's empty folders, in agent space.
export const CODEX_EMPTY_CWD_ROOT = join(AGENT_ROOT, "codex", "no-folder");
export const OPENCODE_EMPTY_CWD_ROOT = join(
  AGENT_ROOT,
  "opencode",
  "no-folder",
);

// The parents an empty folder may sit directly under.
export function emptyFolderRoots(): string[] {
  return [CODEX_EMPTY_CWD_ROOT, OPENCODE_EMPTY_CWD_ROOT];
}

// Makes `dir` (mode 0700) when it is missing and returns it. Throws when
// `dir` is not directly under one of `roots`, is not a folder, or holds
// anything.
export function ensureEmptyFolder(
  dir: string,
  roots: readonly string[] = emptyFolderRoots(),
): string {
  if (
    !isAbsolute(dir) ||
    normalize(dir) !== dir ||
    !roots.some((root) => dirname(dir) === root && dir !== root)
  )
    throw new Error(`${dir} is not a folder Isomux makes for an agent.`);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory())
    throw new Error(
      `This agent runs in ${dir}, which is not a folder. Delete it, then try again.`,
    );
  if ((stat.mode & 0o777) !== 0o700)
    throw new Error(
      `This agent runs in ${dir}, which has the wrong permissions. Delete it, then try again.`,
    );
  if (readdirSync(dir).length > 0)
    throw new Error(
      `This agent runs in ${dir}, which must be empty. Delete it, then try again.`,
    );
  return dir;
}

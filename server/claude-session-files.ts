// The files of one Claude session in a project folder: <id>.jsonl and the
// sibling <id>/ folder (tool results, subagents). No import with the owner
// lookup: the member runner's claude-cwd-move entry runs this as the member
// (server/member-move-receive.ts).
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { errMessage } from "../shared/errors.ts";

export interface SessionFilesMove {
  ok: boolean;
  moved: boolean;
  error?: string;
}

// The project folder of `cwd` under a Claude config root.
export function claudeProjectDirIn(configDir: string, cwd: string): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
}

// Rename the session's files from oldDir to newDir; a file already at the
// destination stays. `moved` says whether a rename happened (a caller
// reverses a partial move).
export function moveSessionFilesBetween(
  sessionId: string,
  oldDir: string,
  newDir: string,
): SessionFilesMove {
  if (oldDir === newDir || !existsSync(oldDir))
    return { ok: true, moved: false };
  const oldJsonl = join(oldDir, `${sessionId}.jsonl`);
  const newJsonl = join(newDir, `${sessionId}.jsonl`);
  const oldSib = join(oldDir, sessionId);
  const newSib = join(newDir, sessionId);
  const moveJsonl = existsSync(oldJsonl) && !existsSync(newJsonl);
  const moveSib = existsSync(oldSib) && !existsSync(newSib);
  if (!moveJsonl && !moveSib) return { ok: true, moved: false };
  mkdirSync(newDir, { recursive: true });
  let moved = false;
  if (moveJsonl) {
    try {
      renameSync(oldJsonl, newJsonl);
      moved = true;
    } catch (err) {
      console.error(
        `[cwd-change] Failed to move ${oldJsonl} -> ${newJsonl}:`,
        err,
      );
      return { ok: false, moved, error: errMessage(err) };
    }
  }
  if (moveSib) {
    try {
      renameSync(oldSib, newSib);
      moved = true;
    } catch (err) {
      console.error(`[cwd-change] Failed to move ${oldSib} -> ${newSib}:`, err);
      return { ok: false, moved, error: errMessage(err) };
    }
  }
  return { ok: true, moved };
}

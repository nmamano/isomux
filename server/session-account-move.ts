// Moves one conversation between two accounts of the same engine (task
// 2008c993, server/provider-fallback.ts). Claude and Codex keep a
// conversation in the account's folder (CLAUDE_CONFIG_DIR, CODEX_HOME), so
// a conversation runs on another account only after its files move there.
//
// Order, per file or folder: copy to a temporary name in the target folder,
// rename it into place, and delete the source only after the caller has
// pinned the new place. A temporary copy left by a failed move is replaced
// on the next try. A move stops at the first failure and throws; the
// conversation then stays where it was.
//
// In split mode the account folders are agent space, so the move runs as the
// agent user (server/agent-runner/entries/session-move.ts).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { inAgentSpace } from "./agent-host.ts";
import {
  CODEX_THREAD_ID_PATTERN,
  claudeProjectDir,
  findCodexRolloutPath,
} from "./cwd-utils.ts";

export type SessionMove =
  | {
      engine: "claude";
      sessionId: string;
      // The cwd the session runs in: it names the projects/ folder.
      cwd: string;
      fromRoot: string;
      toRoot: string;
    }
  | {
      engine: "codex";
      threadId: string;
      fromHome: string;
      toHome: string;
    };

// One file or folder of the conversation, relative to its account folder.
type Part = { path: string; required?: boolean };

function claudeParts(move: Extract<SessionMove, { engine: "claude" }>): Part[] {
  const { sessionId: sid, fromRoot } = move;
  const project = relative(
    fromRoot,
    claudeProjectDir(move.cwd, { CLAUDE_CONFIG_DIR: fromRoot }),
  );
  // The todo files of the session and its subagents: <sid>-agent-<id>.json.
  let todos: string[] = [];
  try {
    todos = readdirSync(join(fromRoot, "todos")).filter((name) =>
      name.startsWith(sid),
    );
  } catch {
    // No todos folder.
  }
  return [
    { path: join(project, sid) },
    { path: join("session-env", sid) },
    { path: join("tasks", sid) },
    ...todos.map((name) => ({ path: join("todos", name) })),
    { path: join("file-history", sid) },
    // Last: a copy that stops early leaves no transcript in the target.
    { path: join(project, `${sid}.jsonl`), required: true },
  ];
}

function codexParts(move: Extract<SessionMove, { engine: "codex" }>): Part[] {
  const path = findCodexRolloutPath(move.threadId, {
    CODEX_HOME: move.fromHome,
  });
  if (!path)
    throw new Error(
      `No rollout of thread ${move.threadId.slice(0, 8)} in ${move.fromHome}.`,
    );
  return [{ path: relative(move.fromHome, path), required: true }];
}

function partsOf(move: SessionMove): {
  parts: Part[];
  from: string;
  to: string;
} {
  // The id names the folders removed below: only a UUID, which every Claude
  // session id and Codex thread id is, may name one.
  const id = move.engine === "claude" ? move.sessionId : move.threadId;
  if (!CODEX_THREAD_ID_PATTERN.test(id))
    throw new Error("A conversation id to move must be a UUID.");
  if (move.engine === "claude")
    return { parts: claudeParts(move), from: move.fromRoot, to: move.toRoot };
  return { parts: codexParts(move), from: move.fromHome, to: move.toHome };
}

const TEMP_SUFFIX = ".isomux-move";

/** Copies the conversation's files into the target account, under their
 *  final names. Throws on the first failure. Does not delete the source. */
export function copySessionFiles(move: SessionMove): void {
  const { parts, from, to } = partsOf(move);
  for (const part of parts)
    if (part.required && !existsSync(join(from, part.path)))
      throw new Error(
        `The conversation has no file at ${join(from, part.path)}.`,
      );
  for (const part of parts) {
    const source = join(from, part.path);
    if (!existsSync(source)) continue;
    const target = join(to, part.path);
    const temp = target + TEMP_SUFFIX;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rmSync(temp, { recursive: true, force: true });
    try {
      cpSync(source, temp, { recursive: true, preserveTimestamps: true });
      rmSync(target, { recursive: true, force: true });
      renameSync(temp, target);
    } catch (err) {
      rmSync(temp, { recursive: true, force: true });
      throw err;
    }
  }
}

/** Deletes the conversation's files in the source account, after the copy
 *  and the new pin. */
export function removeSessionSource(move: SessionMove): void {
  const { parts, from } = partsOf(move);
  for (const part of parts)
    rmSync(join(from, part.path), { recursive: true, force: true });
}

function inSpace(op: "copy" | "remove", move: SessionMove): Promise<void> {
  return inAgentSpace("session-move", { op, move }, () =>
    op === "copy" ? copySessionFiles(move) : removeSessionSource(move),
  ).then(() => undefined);
}

/** copySessionFiles in agent space. */
export function copySessionFilesInAgentSpace(move: SessionMove): Promise<void> {
  return inSpace("copy", move);
}

/** removeSessionSource in agent space. */
export function removeSessionSourceInAgentSpace(
  move: SessionMove,
): Promise<void> {
  return inSpace("remove", move);
}

/** The first of `homes` whose sessions/ folder holds the Codex thread's
 *  rollout, or null. */
export function codexHomeOfThread(
  threadId: string,
  homes: readonly string[],
): string | null {
  for (const home of homes)
    if (findCodexRolloutPath(threadId, { CODEX_HOME: home })) return home;
  return null;
}

/** The request the session-move runner entry takes, checked. */
export function parseSessionMoveRequest(input: unknown): {
  op: "copy" | "remove";
  move: SessionMove;
} {
  const req = input as { op?: unknown; move?: Record<string, unknown> } | null;
  const m = req?.move;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (req?.op !== "copy" && req?.op !== "remove") throw new Error("bad op");
  if (
    m?.engine === "claude" &&
    str(m.sessionId) &&
    str(m.cwd) &&
    str(m.fromRoot) &&
    str(m.toRoot)
  )
    return { op: req.op, move: m as SessionMove };
  if (
    m?.engine === "codex" &&
    str(m.threadId) &&
    str(m.fromHome) &&
    str(m.toHome)
  )
    return { op: req.op, move: m as SessionMove };
  throw new Error("session-move needs a claude or codex move");
}

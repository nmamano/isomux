// The checks a chat affordance runs on what an agent sends: a terminal
// command, a path for the editor card, a path for a file chip. The chat ops
// (agent-manager.ts emitAgentTerminalCommand / emitAgentEditRequest /
// emitAgentReadFile) and an ask's affordances (routes/handlers/asks.ts) run
// the same checks. A refusal carries a kind, not words: the chat turns it into
// a catalog system line, the ask route into an HTTP error.
//
// LEAF over file-editor.ts and credential-store-paths.ts.

import { statSync } from "fs";
import type { FilePayload } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { openFile, resolveEditorPath } from "./file-editor.ts";
import { isCredentialStorePath } from "./credential-store-paths.ts";

// Single-line only; an agent joins steps with && or ;.
export const TERMINAL_COMMAND_MAX_LEN = 4096;
// The file chip's cap. Independent from the editor panel's 1 MB text cap
// (file-editor.ts): this one bounds binary and image payloads served
// through /api/files.
export const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;

export type CommandCheck =
  | { ok: true; command: string }
  | { ok: false; kind: "empty" | "too_long" | "multi_line" };

export type PathRefusal = {
  ok: false;
  kind:
    | "bad_path"
    | "credential"
    | "not_found"
    | "not_file"
    | "binary"
    | "too_large"
    | "io_error";
  path: string;
  size?: number;
  message?: string;
};

export type EditFileCheck = { ok: true; file: FilePayload } | PathRefusal;

// A read-file passes the checks without being read: the copy (the manager's
// copyReadFile) reads it.
export type ReadFileCheck =
  | { ok: true; path: string; size: number }
  | PathRefusal;

export function checkTerminalCommand(raw: string): CommandCheck {
  const command = raw.replace(/\s+$/u, "");
  if (!command) return { ok: false, kind: "empty" };
  if (command.length > TERMINAL_COMMAND_MAX_LEN)
    return { ok: false, kind: "too_long" };
  if (/[\r\n]/u.test(command)) return { ok: false, kind: "multi_line" };
  return { ok: true, command };
}

// The editor panel's own open, so every refusal the panel would give comes
// here first.
export function probeEditFile(rawPath: string, cwd: string): EditFileCheck {
  const resolved = resolveEditorPath(rawPath, cwd);
  if (resolved.kind === "bad_path")
    return { ok: false, kind: "bad_path", path: resolved.attempted };
  const probe = openFile(resolved.path);
  switch (probe.kind) {
    case "ok":
      return { ok: true, file: { cwd, path: resolved.path } };
    case "too_large":
      return {
        ok: false,
        kind: probe.kind,
        path: probe.path,
        size: probe.size,
      };
    case "io_error":
      return {
        ok: false,
        kind: probe.kind,
        path: probe.path,
        message: probe.message,
      };
    default:
      return { ok: false, kind: probe.kind, path: probe.path };
  }
}

export function probeReadFile(rawPath: string, cwd: string): ReadFileCheck {
  const resolved = resolveEditorPath(rawPath, cwd);
  if (resolved.kind === "bad_path")
    return { ok: false, kind: "bad_path", path: resolved.attempted };
  const path = resolved.path;
  if (isCredentialStorePath(path))
    return { ok: false, kind: "credential", path };
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT")
      return { ok: false, kind: "not_found", path };
    return { ok: false, kind: "io_error", path, message: errMessage(err) };
  }
  if (!st.isFile()) return { ok: false, kind: "not_file", path };
  if (st.size > MAX_READ_FILE_BYTES)
    return { ok: false, kind: "too_large", path, size: st.size };
  return { ok: true, path, size: st.size };
}

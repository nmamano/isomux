// Shared parsing for the instruction layers (office, room, agent, member,
// schedules). Each layer reads and writes its text at GET/PUT .../instructions
// with {instructions, version}; the old routes and field names stay for one
// release and reach the same core. Each layer's handler calls its own core;
// this module only parses the body and shapes the answer.
//
// LEAF over the executor + shared types.

import { fail, type HandlerResult } from "../executor.ts";
import type { InstructionsRes } from "../../../shared/contract-shapes.ts";
import { versionOf } from "../../../shared/blob-version.ts";

// The answer of every read and write: the stored text and its version.
export function instructionsRes(text: string | null): InstructionsRes {
  return { instructions: text, version: versionOf(text ?? "") };
}

// A PUT .../instructions body. `instructions` must be present: a string, or
// null to clear. "" also clears. `version` is the token from a preceding read.
export function parseInstructionsWrite(
  body: unknown,
):
  | { ok: true; instructions: string | null; version: string }
  | { ok: false; result: HandlerResult } {
  const b = (body ?? {}) as { instructions?: unknown; version?: unknown };
  if (typeof b.version !== "string" || b.version.length === 0) {
    return {
      ok: false,
      result: fail(
        400,
        "invalid_version",
        "version is required (from a preceding GET of the instructions)",
      ),
    };
  }
  if (b.instructions !== null && typeof b.instructions !== "string") {
    return {
      ok: false,
      result: fail(
        422,
        "invalid_request",
        "instructions must be a string, or null to clear",
      ),
    };
  }
  return {
    ok: true,
    instructions: b.instructions === "" ? null : b.instructions,
    version: b.version,
  };
}

// The 409 of every layer: the text changed since the caller's read.
export function instructionsConflict(version: string): HandlerResult {
  return fail(
    409,
    "version_conflict",
    "the instructions changed since your read; re-read and retry",
    { version },
  );
}

// Old field names, kept for one release. A body may carry the new or the old
// name of a field, never both (400, equal values or not). Moves the value from
// `from` to `to`, so the rest of the handler reads one name.
export function foldFieldAlias(
  body: Record<string, unknown>,
  from: string,
  to: string,
): HandlerResult | null {
  if (!Object.hasOwn(body, from)) return null;
  if (Object.hasOwn(body, to))
    return fail(400, "invalid_request", `send ${from} or ${to}, not both`);
  body[to] = body[from];
  delete body[from];
  return null;
}

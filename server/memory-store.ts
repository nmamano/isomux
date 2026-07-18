// isomux-memory storage — the leaf module. Raw, unstructured, one-fact-per-line
// markdown under STATE_ROOT/memory/. See internal-docs/isomux-memory-design.md.
//
// The directory tree IS the schema:
//   <STATE_ROOT>/memory/office.md
//   <STATE_ROOT>/memory/rooms/<roomId>.md
//   <STATE_ROOT>/memory/agents/<agentId>.md
//   <STATE_ROOT>/memory/bosses/<userId>.md
//   <STATE_ROOT>/memory/.oplog.jsonl   (append-only audit/recovery log)
//
// Each fact is one bullet line:
//   - {Creator}, {YYYY-MM-DD}: {the self-contained fact}
// There are NO ids and NO supersede/tombstone grammar. There are three verbs:
//   APPEND  — add one server-stamped line (the safe default).
//   READ    — return the whole raw file plus an optimistic-concurrency version.
//   REPLACE — overwrite the whole file, guarded by the version you READ (409 on
//             mismatch). This is how edits and retractions happen.
// Every mutating op is recorded to the op-log so a bad write can be restored by
// re-REPLACEing an earlier `content` snapshot.
//
// Provenance: APPEND stamps the Creator + date from the authenticated caller. A
// REPLACE writes the file bytes verbatim (free-form), so in-file creators are
// DISPLAY ONLY after a rewrite — the op-log `actor` is the authoritative record
// of who changed what.
//
// Pure helpers (format/parse/version) + an INJECTABLE store so unit tests can pin
// deterministic dates/timestamps and a temp dir, while production uses the default
// singleton against the real STATE_ROOT. Server-only; never reached by the bundle.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "fs";
import { dirname, join } from "path";
import { STATE_ROOT } from "./config.ts";
import { versionOf } from "../shared/blob-version.ts";
import type { MemoryItem, MemoryScope } from "../shared/types.ts";

// A scopeId (roomId / agentId / userId) is interpolated into a filesystem path,
// so it MUST be a strict identifier — the only thing between a caller-supplied
// scopeId and path traversal. Reject slashes, dots, anything else.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export function isSafeScopeId(id: string): boolean {
  return SAFE_ID.test(id);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIsoUtc(): string {
  return new Date().toISOString();
}

// --- pure format / parse ----------------------------------------------------

// The APPEND line shape: "- {author}, {date}: {text}". REPLACE writes raw bytes
// and does NOT go through here.
export function formatMemoryLine(input: {
  author: string;
  date: string;
  text: string;
}): string {
  return `- ${input.author}, ${input.date}: ${input.text}`;
}

// Best-effort parse of an APPEND-shaped line, used only for the exact-duplicate
// guard and provenance display. The date (YYYY-MM-DD) is the anchor, so an author
// containing a comma still parses (the author capture is lazy). A free-form line
// written by a human REPLACE that doesn't match simply yields null and doesn't
// participate in dedup — raw memory is allowed to be unstructured.
const LINE_RE = /^- (.+?), (\d{4}-\d{2}-\d{2}): (.*\S)\s*$/;

export function parseMemoryLine(
  raw: string,
  scope: MemoryScope,
  scopeId: string | null,
): MemoryItem | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  return {
    scope,
    scopeId,
    author: m[1],
    date: m[2],
    text: m[3],
    raw: raw.replace(/\s+$/, ""),
  };
}

// --- exact-duplicate guard (append-time) ------------------------------------

// trim -> lowercase -> collapse internal whitespace -> strip ONLY terminal
// punctuation (so internal hyphens/slashes/dots in `isomux-active`, paths, IPs
// survive). Normalization is for COMPARISON only; the stored line keeps the
// original text verbatim.
export function normalizeForDedup(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

// True when `text` is a normalized-exact restatement of `existing`. The single
// non-prompt guardrail: cheap, deterministic, catches an agent re-adding a fact
// it doesn't remember writing. No fuzzy matching (a reword is allowed through).
export function isExactDuplicateText(text: string, existing: string): boolean {
  return normalizeForDedup(text) === normalizeForDedup(existing);
}

// --- per-scope injected-size caps -------------------------------------------

// Max injected size per scope, in characters (Nil-set). Office/room are smaller
// than boss/agent because they reach more people. Central + exported; injectable
// via MemoryStoreDeps.caps so tests use tiny fixtures.
export const MEMORY_CAPS: Record<MemoryScope, number> = {
  office: 2500,
  room: 3500,
  agent: 5000,
  boss: 5000,
};

// Appended when a scope is truncated. A fixed diagnostic OUTSIDE the cap budget.
export const OVER_CAP_NOTICE =
  "Not all memories fit. Consider suggesting the boss to trim them.";

// Join non-empty lines under a char cap: keep the NEWEST (end of file) that fit,
// present survivors in FILE ORDER, append the notice when anything was dropped.
// A single line longer than the cap yields the notice alone.
export function renderCapped(lines: readonly string[], cap: number): string {
  const full = lines.join("\n");
  if (full.length <= cap) return full;
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length ? 1 : 0); // +1 for the newline join
    if (size + add > cap) break;
    kept.push(lines[i]);
    size += add;
  }
  kept.reverse(); // back to file order
  const body = kept.join("\n");
  return body.length ? `${body}\n${OVER_CAP_NOTICE}` : OVER_CAP_NOTICE;
}

// --- optimistic-concurrency version -----------------------------------------

// Short sha256 of the exact file bytes. A missing/empty file hashes "" to a fixed
// value (sha256("")[:12]), which serves as the missing-file sentinel — so a
// READ -> REPLACE round-trip works on a never-written scope. 12 hex chars keeps
// collision anxiety out of reviews while staying compact.
//
// The implementation moved to shared/blob-version.ts (task 44a2c98d) so the
// same token derivation serves the prompt-blob version guards, including
// AgentInfo.customInstructionsVersion, which is maintained inside the
// browser-bundled shared/office-state.ts. Re-exported here so existing
// memory-surface imports keep working.
export { versionOf } from "../shared/blob-version.ts";

// --- op-log -----------------------------------------------------------------

// One append-only audit/recovery record per successful mutating op. `content` is
// the EXACT full file bytes after the op, so manual recovery is just re-REPLACEing
// an earlier snapshot. `actor` is server-stamped (the authenticated caller) and is
// the authoritative who-did-what, independent of in-file creators after a rewrite.
export interface OpLogEntry {
  ts: string; // ISO-8601
  actor: string;
  scope: MemoryScope;
  scopeId: string | null;
  op: "append" | "replace";
  text: string; // the appended fact, or "(full rewrite)" for replace
  content: string; // full file bytes after the op
  version: string; // post-op version
  previousVersion?: string; // pre-op version (replace only)
}

// --- the injectable store ---------------------------------------------------

// One scope to fold into the auto-load block, with the plain label shown above
// its lines (e.g. "Office-wide", `Room "Isomux Dev"`, "Your agent").
export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string | null;
  label: string;
}

export interface MemoryReadResult {
  text: string;
  version: string;
}

export interface MemoryAppendResult {
  item: MemoryItem;
  version: string;
}

export type MemoryReplaceResult =
  | { ok: true; version: string }
  | { ok: false; conflict: true; version: string };

export interface MemoryStore {
  // The whole raw file (verbatim bytes, "" if missing) plus its version. Uncapped.
  read(scope: MemoryScope, scopeId: string | null): MemoryReadResult;
  // Raw file bytes only (verbatim, "" if missing). For callers that don't need a
  // version (auto-load render, dedup, the transitional curation reads).
  readText(scope: MemoryScope, scopeId: string | null): string;
  // Append one server-stamped line. Returns the new item + post-write version.
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryAppendResult;
  // Overwrite the whole file. If expectedVersion is given and no longer matches
  // the current file, returns a conflict (with the current version) and writes
  // nothing. Omit expectedVersion to force (human/owner curation save). `author`
  // is the op-log actor only — the file bytes are written verbatim.
  replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    author: string;
    expectedVersion?: string | null;
  }): MemoryReplaceResult;
  // The first line in this scope that `text` exactly restates (normalized), or
  // null. The write-time dedup guard (APPEND only).
  findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null;
  // Non-empty file lines joined under the per-scope cap, or null when empty.
  renderForPrompt(scope: MemoryScope, scopeId: string | null): string | null;
  // Several scopes combined into one body for the single auto-load layer: each
  // NON-EMPTY scope contributes a "<label>:\n<lines>" block, in the given order;
  // null when every scope is empty. Labels are plain text, NOT markdown headings.
  renderForPromptMulti(refs: readonly MemoryScopeRef[]): string | null;
}

export interface MemoryStoreDeps {
  stateRoot?: string;
  today?: () => string; // YYYY-MM-DD, for the in-file date
  now?: () => string; // ISO timestamp, for the op-log ts
  // Per-scope injected-size caps; defaults to MEMORY_CAPS. Tests inject tiny caps.
  caps?: Record<MemoryScope, number>;
}

export function createMemoryStore(deps: MemoryStoreDeps = {}): MemoryStore {
  const stateRoot = deps.stateRoot ?? STATE_ROOT;
  const today = deps.today ?? todayUtc;
  const now = deps.now ?? nowIsoUtc;
  const caps = deps.caps ?? MEMORY_CAPS;

  function filePath(scope: MemoryScope, scopeId: string | null): string {
    const base = join(stateRoot, "memory");
    switch (scope) {
      case "office":
        return join(base, "office.md");
      case "room":
        return join(base, "rooms", `${scopeId}.md`);
      case "agent":
        return join(base, "agents", `${scopeId}.md`);
      case "boss":
        return join(base, "bosses", `${scopeId}.md`);
    }
  }

  function readText(scope: MemoryScope, scopeId: string | null): string {
    try {
      return readFileSync(filePath(scope, scopeId), "utf8");
    } catch {
      return ""; // missing file => no memory
    }
  }

  function read(scope: MemoryScope, scopeId: string | null): MemoryReadResult {
    const text = readText(scope, scopeId);
    return { text, version: versionOf(text) };
  }

  function logOp(entry: OpLogEntry): void {
    const path = join(stateRoot, "memory", ".oplog.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  }

  function append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryAppendResult {
    const date = today();
    const line = formatMemoryLine({
      author: input.author,
      date,
      text: input.text,
    });
    const path = filePath(input.scope, input.scopeId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
    const content = readText(input.scope, input.scopeId);
    const version = versionOf(content);
    logOp({
      ts: now(),
      actor: input.author,
      scope: input.scope,
      scopeId: input.scopeId,
      op: "append",
      text: input.text,
      content,
      version,
    });
    return {
      item: {
        scope: input.scope,
        scopeId: input.scopeId,
        author: input.author,
        date,
        text: input.text,
        raw: line,
      },
      version,
    };
  }

  function replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    author: string;
    expectedVersion?: string | null;
  }): MemoryReplaceResult {
    // Read current state + version check + write are ONE synchronous task, so the
    // single-threaded event loop serializes concurrent replaces (no lost update).
    const current = readText(input.scope, input.scopeId);
    const currentVersion = versionOf(current);
    if (
      input.expectedVersion != null &&
      input.expectedVersion !== currentVersion
    ) {
      return { ok: false, conflict: true, version: currentVersion };
    }
    const content = input.text;
    const path = filePath(input.scope, input.scopeId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    const version = versionOf(content);
    logOp({
      ts: now(),
      actor: input.author,
      scope: input.scope,
      scopeId: input.scopeId,
      op: "replace",
      text: "(full rewrite)",
      content,
      version,
      previousVersion: currentVersion,
    });
    return { ok: true, version };
  }

  function findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null {
    for (const line of readText(scope, scopeId).split("\n")) {
      const item = parseMemoryLine(line, scope, scopeId);
      if (item && isExactDuplicateText(text, item.text)) return item;
    }
    return null;
  }

  function renderForPrompt(
    scope: MemoryScope,
    scopeId: string | null,
  ): string | null {
    const lines = readText(scope, scopeId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    return renderCapped(lines, caps[scope]);
  }

  function renderForPromptMulti(
    refs: readonly MemoryScopeRef[],
  ): string | null {
    const blocks: string[] = [];
    for (const ref of refs) {
      const body = renderForPrompt(ref.scope, ref.scopeId);
      if (body) blocks.push(`${ref.label}:\n${body}`);
    }
    return blocks.length ? blocks.join("\n\n") : null;
  }

  return {
    read,
    readText,
    append,
    replace,
    findDuplicate,
    renderForPrompt,
    renderForPromptMulti,
  };
}

// Default production store against the real STATE_ROOT. Used by the route handler,
// agent-manager auto-load, and the /isomux-system-prompt inspector.
export const memoryStore = createMemoryStore();

import { requireAuditContext } from "./audit-context.ts";
import { recordAudit, type AuditWrite } from "./audit-store.ts";
// isomux-memory storage - the leaf module. Raw, unstructured, one-fact-per-line
// markdown under STATE_ROOT/memory/. See internal-docs/isomux-memory-design.md.
//
// The directory tree IS the schema:
//   <STATE_ROOT>/memory/office.md
//   <STATE_ROOT>/memory/rooms/<roomId>.md
//   <STATE_ROOT>/memory/agents/<agentId>.md
//   <STATE_ROOT>/memory/members/<userId>.md
// Full post-write content is retained in office.sqlite; an old .oplog.jsonl is left untouched.
//
// Each fact is one bullet line: "- {the self-contained fact}". Lines carry no
// author or date: memory text loads into agent context, and who wrote a line
// and when is audit data, so it lives in the audit log. Older offices hold
// stamped lines ("- {Creator}, {YYYY-MM-DD}: {fact}" or "- {YYYY-MM-DD}: {fact}");
// nothing rewrites them, and the dedup guard still reads both shapes.
// There are NO ids and NO supersede/tombstone grammar. There are three verbs:
//   APPEND  - add one line (the safe default).
//   READ    - return the whole raw file plus an optimistic-concurrency version.
//   REPLACE - overwrite the whole file, guarded by the version you READ (409 on
//             mismatch). This is how edits and retractions happen.
// Every mutating op is recorded to the audit log, with the authenticated actor,
// the time and the full file after the op. That row is the record of who
// changed what and when, and a bad write can be restored by re-REPLACEing an
// earlier snapshot.
//
// Pure helpers (format/parse/version) + an INJECTABLE store so unit tests can pin
// deterministic timestamps and a temp dir, while production uses the default
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
import { injectedMemorySize } from "../shared/memory-size.ts";
import { MEMORY_CAPS } from "../shared/memory-caps.ts";

// A scopeId (roomId / agentId / userId) is interpolated into a filesystem path,
// so it MUST be a strict identifier - the only thing between a caller-supplied
// scopeId and path traversal. Reject slashes, dots, anything else.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export function isSafeScopeId(id: string): boolean {
  return SAFE_ID.test(id);
}

function nowIsoUtc(): string {
  return new Date().toISOString();
}

// The APPEND line shape. REPLACE writes raw bytes and does NOT go through here.
function formatMemoryLine(text: string): string {
  return `- ${text}`;
}

// Parse of a bullet line, used only for the exact-duplicate guard. `text` is the
// whole bullet text. A line that
// is not a "- " bullet yields null and doesn't participate in dedup - raw
// memory is allowed to be unstructured.
//
// A legacy stamped line ("- {author}, {date}: {text}" or "- {date}: {text}",
// written before APPEND stopped stamping) also yields its stamp-free text in
// `legacyText`, so restating its fact still dedups. The date (YYYY-MM-DD) is
// the anchor, so an author containing a comma still parses (the author capture
// is lazy).
//
// TWO legacy regexes, authorless tried FIRST, rather than one with an optional author
// group. An optional group is greedy and would try to fill itself: on the
// authorless line "- 2026-06-28: shipped, 2026-07-01: done" it captures
// author="2026-06-28: shipped" off the comma inside the TEXT. Anchoring the
// date directly after "- " is unambiguous (an author is never empty), and any
// line that doesn't match falls through to the original authored pattern, so
// every previously-parsing line parses identically.
const AUTHORLESS_LINE_RE = /^- (\d{4}-\d{2}-\d{2}): (.*\S)\s*$/;
const AUTHORED_LINE_RE = /^- (.+?), (\d{4}-\d{2}-\d{2}): (.*\S)\s*$/;

const BULLET_LINE_RE = /^- (.*\S)\s*$/;

function parseMemoryLine(
  raw: string,
  scope: MemoryScope,
  scopeId: string | null,
): { item: MemoryItem; legacyText: string | null } | null {
  const bullet = BULLET_LINE_RE.exec(raw);
  if (!bullet) return null;
  const bare = AUTHORLESS_LINE_RE.exec(raw);
  const legacy = bare ?? AUTHORED_LINE_RE.exec(raw);
  const legacyText = legacy ? (bare ? legacy[2] : legacy[3]) : null;
  return {
    item: {
      scope,
      scopeId,
      text: bullet[1],
      raw: raw.replace(/\s+$/, ""),
    },
    legacyText,
  };
}

// trim -> lowercase -> collapse internal whitespace -> strip ONLY terminal
// punctuation (so internal hyphens/slashes/dots in `isomux-active`, paths, IPs
// survive). Normalization is for COMPARISON only; the stored line keeps the
// original text verbatim.
function normalizeForDedup(text: string): string {
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
function isExactDuplicateText(text: string, existing: string): boolean {
  return normalizeForDedup(text) === normalizeForDedup(existing);
}

export const MEMORY_LINE_MAX = 400;

// Caps are HARD and enforced at write time: a save that would put a scope over
// its cap is refused (fail loud and early), so memories are
// never silently dropped from the prompt. A scope can still sit over its cap
// from before this rule existed; such a scope renders in FULL, refuses new
// appends, and accepts a replace only if it shrinks the file.
export class MemoryCapError extends Error {
  constructor(
    readonly size: number,
    readonly cap: number,
  ) {
    super(`memory scope size exceeds its cap (${size} of ${cap} chars)`);
  }
}

export class MemoryLineTooLongError extends Error {
  constructor(readonly size: number) {
    super(`memory line is too long (${size} of ${MEMORY_LINE_MAX} chars)`);
  }
}

// The size a scope contributes to the prompt: non-empty lines, newline-joined.
export function injectedSize(text: string): number {
  return injectedMemorySize(text);
}

// Short sha256 of the exact file bytes. A missing/empty file hashes "" to a fixed
// value (sha256("")[:12]), which serves as the missing-file sentinel - so a
// READ -> REPLACE round-trip works on a never-written scope. 12 hex chars keeps
// collision anxiety out of reviews while staying compact.
//
// The implementation lives in shared/blob-version.ts so the
// same token derivation serves the prompt-blob version guards, including
// AgentInfo.customInstructionsVersion, which is maintained inside the
// browser-bundled shared/office-state.ts. Re-exported here so existing
// memory-surface imports keep working.
export { versionOf } from "../shared/blob-version.ts";

// One audit/recovery record per successful mutating op. `content` is the EXACT
// full file bytes after the op, so manual recovery is just re-REPLACEing an
// earlier snapshot. The actor comes from the audit context (the authenticated
// caller).
interface OpLogEntry {
  ts: string; // ISO-8601
  scope: MemoryScope;
  scopeId: string | null;
  content: string; // full file bytes after the op
}

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
  size: number;
  cap: number;
}

export type MemoryReplaceResult =
  | { ok: true; version: string }
  | { ok: false; conflict: true; version: string };

export interface MemoryStore {
  // The whole raw file (verbatim bytes, "" if missing) plus its version. Uncapped.
  read(scope: MemoryScope, scopeId: string | null): MemoryReadResult;
  // Append one "- {text}" line. Returns the new item + post-write version.
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
  }): MemoryAppendResult;
  // Overwrite the whole file. If expectedVersion no longer matches the current
  // file, returns a conflict (with the current version) and writes nothing.
  // The file bytes are written verbatim.
  replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    expectedVersion: string;
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
  // How full each of those scopes is against its cap, for the session-start
  // memory-size notice. Same refs, same order; scopes with no content at all are
  // omitted. `contentChars` is the injected size; a legacy scope still over its
  // cap (from before caps were write-enforced) reports a fill above 1.
  measureForPromptMulti(
    refs: readonly MemoryScopeRef[],
  ): MemoryScopeMeasurement[];
}

// One scope's contribution to the auto-loaded memory layer, sized against its cap.
export interface MemoryScopeMeasurement {
  scope: MemoryScope;
  label: string;
  contentChars: number;
  cap: number;
}

export interface MemoryStoreDeps {
  audit?: (entry: AuditWrite) => void;
  stateRoot?: string;
  now?: () => string; // ISO timestamp, for the audit log ts
  // Per-scope injected-size caps; defaults to MEMORY_CAPS. Tests inject tiny caps.
  caps?: Record<MemoryScope, number>;
}

export function createMemoryStore(deps: MemoryStoreDeps = {}): MemoryStore {
  const stateRoot = deps.stateRoot ?? STATE_ROOT;
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
      // The folder keeps its name from when the scope was called "boss", so
      // a rollback still finds every member memory.
      case "member":
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
    const context = requireAuditContext();
    try {
      (deps.audit ?? recordAudit)({
        actor: context.actor,
        operation: context.operation,
        targets: [`memory:${entry.scope}:${entry.scopeId ?? "office"}`],
        fields: ["content"],
        memoryContent: entry.content,
        time: Date.parse(entry.ts),
      });
    } catch (error) {
      console.error("[audit] could not record completed memory write", error);
    }
  }

  function append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
  }): MemoryAppendResult {
    requireAuditContext();
    if (input.text.length > MEMORY_LINE_MAX) {
      throw new MemoryLineTooLongError(input.text.length);
    }
    const line = formatMemoryLine(input.text);
    // Hard cap, checked BEFORE the write: appending must never push the scope
    // over its injected-size cap. Throws so no caller can ignore it.
    const cap = caps[input.scope];
    const existing = readText(input.scope, input.scopeId);
    const prospective = injectedSize(existing) + line.length + 1;
    if (prospective > cap) throw new MemoryCapError(prospective, cap);
    const path = filePath(input.scope, input.scopeId);
    mkdirSync(dirname(path), { recursive: true });
    const separator =
      existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(path, separator + line + "\n");
    const content = readText(input.scope, input.scopeId);
    const version = versionOf(content);
    logOp({
      ts: now(),
      scope: input.scope,
      scopeId: input.scopeId,
      content,
    });
    return {
      item: {
        scope: input.scope,
        scopeId: input.scopeId,
        text: input.text,
        raw: line,
      },
      version,
      size: injectedSize(content),
      cap,
    };
  }

  function replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    expectedVersion: string;
  }): MemoryReplaceResult {
    requireAuditContext();
    // Read current state + version check + write are ONE synchronous task, so the
    // single-threaded event loop serializes concurrent replaces (no lost update).
    const current = readText(input.scope, input.scopeId);
    const currentVersion = versionOf(current);
    if (input.expectedVersion !== currentVersion) {
      return { ok: false, conflict: true, version: currentVersion };
    }
    // Hard cap on growth. A replace that SHRINKS a legacy over-cap file is
    // allowed even while still over - otherwise an incremental trim from, say,
    // 118% to 105% would be refused and the only way out would be one perfect
    // rewrite.
    const newSize = injectedSize(input.text);
    const cap = caps[input.scope];
    if (newSize > cap && newSize >= injectedSize(current)) {
      throw new MemoryCapError(newSize, cap);
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
      scope: input.scope,
      scopeId: input.scopeId,
      content,
    });
    return { ok: true, version };
  }

  function findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null {
    // Compare with the whole bullet text AND, for a legacy stamped line, its
    // stamp-free text: a new line can itself look like a stamp ("Nil, <date>:
    // rule"), and an old stamped fact must still catch its restatement.
    for (const line of readText(scope, scopeId).split("\n")) {
      const parsed = parseMemoryLine(line, scope, scopeId);
      if (!parsed) continue;
      // The returned `text` is what matched, which the 409 shows the caller.
      if (isExactDuplicateText(text, parsed.item.text)) return parsed.item;
      if (
        parsed.legacyText !== null &&
        isExactDuplicateText(text, parsed.legacyText)
      )
        return { ...parsed.item, text: parsed.legacyText };
    }
    return null;
  }

  function renderForPrompt(
    scope: MemoryScope,
    scopeId: string | null,
  ): string | null {
    // Renders in FULL, always - caps are enforced at write time, never by
    // dropping lines here. A legacy over-cap scope still renders whole; the
    // session-start memory notice is what surfaces it.
    const lines = readText(scope, scopeId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    return lines.join("\n");
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

  // Sizes the SAME lines renderForPrompt joins - what each scope actually
  // contributes to the prompt, measured against the write-enforced cap.
  function measureForPromptMulti(
    refs: readonly MemoryScopeRef[],
  ): MemoryScopeMeasurement[] {
    const out: MemoryScopeMeasurement[] = [];
    for (const ref of refs) {
      const lines = readText(ref.scope, ref.scopeId)
        .split("\n")
        .filter((l) => l.trim() !== "");
      if (lines.length === 0) continue;
      out.push({
        scope: ref.scope,
        label: ref.label,
        contentChars: lines.join("\n").length,
        cap: caps[ref.scope],
      });
    }
    return out;
  }

  return {
    read,
    append,
    replace,
    findDuplicate,
    renderForPrompt,
    renderForPromptMulti,
    measureForPromptMulti,
  };
}

// Default production store against the real STATE_ROOT. Used by the route handler,
// agent-manager auto-load, and the /isomux-system-prompt inspector.
export const memoryStore = createMemoryStore();

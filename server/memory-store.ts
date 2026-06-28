// isomux-memory storage — the leaf module (slice 3a). Plain-markdown,
// one-fact-per-line memory under STATE_ROOT/memory/. See
// internal-docs/isomux-memory-design.md and plans/isomux-memory-loop.md.
//
// The directory tree IS the schema:
//   <STATE_ROOT>/memory/office.md
//   <STATE_ROOT>/memory/rooms/<roomId>.md
//   <STATE_ROOT>/memory/agents/<agentId>.md
//   <STATE_ROOT>/memory/bosses/<userId>.md
//
// Each fact is one provenance-stamped, id-tagged markdown line:
//   - <!-- mem:ab12cd --> [Author, 2026-06-27] the self-contained fact
// The leading mem:ID renders invisibly in markdown and is the stable handle
// update/retract target (slice 3d).
//
// Pure helpers (format/parse) + an INJECTABLE store (read/append) so unit tests
// can pin deterministic ids/dates and target a temp dir, while production uses
// the default singleton against the real STATE_ROOT. Server-only; never reached
// by the browser bundle.

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { STATE_ROOT } from "./config.ts";
import type { MemoryItem, MemoryScope } from "../shared/types.ts";

// A scopeId (roomId / agentId / userId) is interpolated into a filesystem path,
// so it MUST be a strict identifier — this is the only thing between a
// caller-supplied scopeId and path traversal. Reject slashes, dots, anything else.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export function isSafeScopeId(id: string): boolean {
  return SAFE_ID.test(id);
}

// The persisted grammar for an id (mem:ab12cd). append() guards against an
// injected/buggy generator ever writing an id parseMemoryLine can't read back.
const MEM_ID_RE = /^[0-9a-f]{6}$/;

// 6 lowercase-hex chars, matching the design example (mem:ab12cd).
export function genMemId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- pure format / parse ----------------------------------------------------

export function formatMemoryLine(input: {
  id: string;
  author: string;
  date: string;
  text: string;
  supersedes?: string | null;
  tombstones?: string | null;
}): string {
  let tag = `mem:${input.id}`;
  if (input.supersedes) tag += ` supersedes:${input.supersedes}`;
  else if (input.tombstones) tag += ` tombstones:${input.tombstones}`;
  return `- <!-- ${tag} --> [${input.author}, ${input.date}] ${input.text}`;
}

// Strictly the formatMemoryLine shape (tolerant of trailing whitespace). Returns
// null for any non-conforming line (blanks, prose, future grammar) so the loader
// silently skips junk rather than corrupting the list. The id is anchored to 6
// hex; the author capture is lazy so a comma in a name still parses (the date
// pattern is the real delimiter).
// The optional ` supersedes:OLD` / ` tombstones:OLD` token (slice 3d) is anchored
// to a 6-hex target — a malformed relation id makes the WHOLE line fail to match
// (skipped as junk), so the resolver never sees a bad relation id.
const LINE_RE =
  /^- <!-- mem:([0-9a-f]{6})(?: (supersedes|tombstones):([0-9a-f]{6}))? --> \[(.+?), (\d{4}-\d{2}-\d{2})\] (.*\S)\s*$/;

export function parseMemoryLine(
  raw: string,
  scope: MemoryScope,
  scopeId: string | null,
): MemoryItem | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  const relType = m[2]; // "supersedes" | "tombstones" | undefined
  const relTarget = m[3] ?? null;
  return {
    id: m[1],
    scope,
    scopeId,
    author: m[4],
    date: m[5],
    text: m[6],
    factType: null, // not persisted in the line as of slice 3a
    supersedes: relType === "supersedes" ? relTarget : null,
    tombstones: relType === "tombstones" ? relTarget : null,
    raw: raw.replace(/\s+$/, ""),
  };
}

// Every conforming line (plain fact + supersede/tombstone control lines), in
// file order. This is the RAW view; resolveActiveMemory derives the active set.
export function parseMemoryFile(
  content: string,
  scope: MemoryScope,
  scopeId: string | null,
): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (const line of content.split("\n")) {
    const item = parseMemoryLine(line, scope, scopeId);
    if (item) out.push(item);
  }
  return out;
}

// Resolve the ACTIVE set from raw parsed lines: drop tombstone control lines and
// any id referenced by a supersedes:/tombstones: relation. Chains resolve
// naturally (old suppressed by new, new suppressed by newer -> only newest
// active). A relation pointing at an id not present in the file is ignored.
export function resolveActiveMemory(raw: readonly MemoryItem[]): MemoryItem[] {
  const suppressed = new Set<string>();
  for (const m of raw) {
    if (m.supersedes) suppressed.add(m.supersedes);
    if (m.tombstones) suppressed.add(m.tombstones);
  }
  return raw.filter((m) => !m.tombstones && !suppressed.has(m.id));
}

// --- write-time dedup guard (slice 3e) --------------------------------------

// A single central threshold, identical across scopes (design Q3). 0.9 mostly
// catches reordered or tiny-restated facts — the right blast radius for v1.
export const DEDUP_THRESHOLD = 0.9;

// trim -> lowercase -> collapse internal whitespace -> strip ONLY terminal
// punctuation (so internal hyphens/slashes/dots in `isomux-active`, paths, IPs,
// and IDs survive).
export function normalizeForDedup(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

// Token-set Jaccard over whitespace tokens. No stemming / synonyms / stop-words.
export function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// True when `text` is a normalized-exact or fuzzy (Jaccard >= threshold) restatement
// of `existing`.
export function isDuplicateText(text: string, existing: string): boolean {
  const a = normalizeForDedup(text);
  const b = normalizeForDedup(existing);
  return a === b || jaccardSimilarity(a, b) >= DEDUP_THRESHOLD;
}

// --- per-scope injected-size caps (slice 3f) --------------------------------

// Max injected size per scope, in characters (Nil-set). Office/room are smaller
// than boss/agent because they reach more people. Central + exported; injectable
// via MemoryStoreDeps.caps so tests use tiny fixtures.
export const MEMORY_CAPS: Record<MemoryScope, number> = {
  office: 2500,
  room: 3500,
  agent: 5000,
  boss: 5000,
};

// Appended when a scope is truncated. A fixed diagnostic OUTSIDE the cap budget
// (the cap budgets memory lines; the notice is always added when over cap).
export const OVER_CAP_NOTICE =
  "Not all memories fit. Consider suggesting the boss to trim them.";

// Join active raw lines under a char cap: keep the NEWEST (end of file) that fit,
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

// --- the injectable store ---------------------------------------------------

// One scope to fold into the auto-load block, with the plain label shown above
// its lines (e.g. "Office-wide", `Room "Isomux Dev"`, "Your agent").
export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string | null;
  label: string;
}

export interface MemoryStore {
  // The RESOLVED ACTIVE set (superseded/retracted lines removed, tombstone
  // control lines dropped). For GET, prompt injection, and the active-id checks.
  read(scope: MemoryScope, scopeId: string | null): MemoryItem[];
  // Every CONFORMING memory entry in file order (active + superseded + tombstone
  // control); non-memory junk lines are skipped. For provenance/audit and the
  // active-id checks. (Slice 3g's textarea, which needs the verbatim file text
  // including junk, will read the raw bytes separately.)
  readRaw(scope: MemoryScope, scopeId: string | null): MemoryItem[];
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryItem;
  // Edit: append a supersede line replacing targetId with new text. Returns null
  // if targetId is not an ACTIVE id in the target file (absent / already
  // superseded / already tombstoned). Append-only — never rewrites.
  supersede(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
    text: string;
  }): MemoryItem | null;
  // Retract: append a tombstone control line for targetId. Returns null if
  // targetId is not an ACTIVE id in the target file. Append-only.
  tombstone(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
  }): MemoryItem | null;
  // The first ACTIVE line in this scope that `text` restates (normalized-exact or
  // fuzzy), or null. The write-time dedup guard (slice 3e); matches the active
  // set only, so a duplicate of a superseded/retracted line is allowed.
  findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null;
  // Active raw lines joined for prompt injection, or null when empty/missing.
  renderForPrompt(scope: MemoryScope, scopeId: string | null): string | null;
  // Several scopes combined into one body for the single auto-load layer: each
  // NON-EMPTY scope contributes a "<label>:\n<lines>" block, in the given order;
  // returns null when every scope is empty. Labels are plain text, NOT markdown
  // headings, so the memory layer stays one visual section.
  renderForPromptMulti(refs: readonly MemoryScopeRef[]): string | null;
}

export interface MemoryStoreDeps {
  stateRoot?: string;
  genId?: () => string;
  today?: () => string;
  // Per-scope injected-size caps; defaults to MEMORY_CAPS. Tests inject tiny caps.
  caps?: Record<MemoryScope, number>;
}

// A bad injected generator (always-collide) must error, never spin forever.
const MAX_ID_RETRIES = 50;

export function createMemoryStore(deps: MemoryStoreDeps = {}): MemoryStore {
  const stateRoot = deps.stateRoot ?? STATE_ROOT;
  const genId = deps.genId ?? genMemId;
  const today = deps.today ?? todayUtc;
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

  function readRaw(scope: MemoryScope, scopeId: string | null): MemoryItem[] {
    let content: string;
    try {
      content = readFileSync(filePath(scope, scopeId), "utf8");
    } catch {
      return []; // missing file => no memory
    }
    return parseMemoryFile(content, scope, scopeId);
  }

  function read(scope: MemoryScope, scopeId: string | null): MemoryItem[] {
    return resolveActiveMemory(readRaw(scope, scopeId));
  }

  // The shared writer for all line kinds (plain fact, supersede, tombstone). The
  // collision set is built from the RAW ids so a fresh id never reuses a
  // superseded/tombstoned id still present on disk.
  function appendLine(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
    supersedes?: string | null;
    tombstones?: string | null;
  }): MemoryItem {
    const existing = new Set(
      readRaw(input.scope, input.scopeId).map((m) => m.id),
    );
    // Retry on a collision OR a malformed id, so the store NEVER persists a line
    // parseMemoryLine can't read back (the invariant: no malformed ids on disk).
    let id = genId();
    let tries = 0;
    while (existing.has(id) || !MEM_ID_RE.test(id)) {
      if (++tries > MAX_ID_RETRIES) {
        throw new Error(
          `memory-store: could not mint a unique valid id after ${MAX_ID_RETRIES} tries`,
        );
      }
      id = genId();
    }
    const date = today();
    const supersedes = input.supersedes ?? null;
    const tombstones = input.tombstones ?? null;
    const line = formatMemoryLine({
      id,
      author: input.author,
      date,
      text: input.text,
      supersedes,
      tombstones,
    });
    const path = filePath(input.scope, input.scopeId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
    return {
      id,
      scope: input.scope,
      scopeId: input.scopeId,
      author: input.author,
      date,
      text: input.text,
      factType: null,
      supersedes,
      tombstones,
      raw: line,
    };
  }

  function append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryItem {
    return appendLine(input);
  }

  function supersede(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
    text: string;
  }): MemoryItem | null {
    const active = read(input.scope, input.scopeId);
    if (!active.some((m) => m.id === input.targetId)) return null;
    return appendLine({
      scope: input.scope,
      scopeId: input.scopeId,
      author: input.author,
      text: input.text,
      supersedes: input.targetId,
    });
  }

  function tombstone(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
  }): MemoryItem | null {
    const active = read(input.scope, input.scopeId);
    if (!active.some((m) => m.id === input.targetId)) return null;
    return appendLine({
      scope: input.scope,
      scopeId: input.scopeId,
      author: input.author,
      text: "(retracted)",
      tombstones: input.targetId,
    });
  }

  function findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null {
    for (const m of read(scope, scopeId)) {
      if (isDuplicateText(text, m.text)) return m;
    }
    return null;
  }

  function renderForPrompt(
    scope: MemoryScope,
    scopeId: string | null,
  ): string | null {
    const items = read(scope, scopeId);
    if (items.length === 0) return null;
    return renderCapped(
      items.map((m) => m.raw),
      caps[scope],
    );
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
    readRaw,
    append,
    supersede,
    tombstone,
    findDuplicate,
    renderForPrompt,
    renderForPromptMulti,
  };
}

// Default production store against the real STATE_ROOT. Used by the route
// handler, agent-manager auto-load, and the /isomux-system-prompt inspector.
export const memoryStore = createMemoryStore();

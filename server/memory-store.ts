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
}): string {
  return `- <!-- mem:${input.id} --> [${input.author}, ${input.date}] ${input.text}`;
}

// Strictly the formatMemoryLine shape (tolerant of trailing whitespace). Returns
// null for any non-conforming line (blanks, prose, future grammar) so the loader
// silently skips junk rather than corrupting the list. The id is anchored to 6
// hex; the author capture is lazy so a comma in a name still parses (the date
// pattern is the real delimiter).
const LINE_RE =
  /^- <!-- mem:([0-9a-f]{6}) --> \[(.+?), (\d{4}-\d{2}-\d{2})\] (.*\S)\s*$/;

export function parseMemoryLine(
  raw: string,
  scope: MemoryScope,
  scopeId: string | null,
): MemoryItem | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  return {
    id: m[1],
    scope,
    scopeId,
    author: m[2],
    date: m[3],
    text: m[4],
    factType: null, // not persisted in the line as of slice 3a
    raw: raw.replace(/\s+$/, ""),
  };
}

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

// --- the injectable store ---------------------------------------------------

// One scope to fold into the auto-load block, with the plain label shown above
// its lines (e.g. "Office-wide", `Room "Isomux Dev"`, "Your agent").
export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string | null;
  label: string;
}

export interface MemoryStore {
  read(scope: MemoryScope, scopeId: string | null): MemoryItem[];
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryItem;
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
}

// A bad injected generator (always-collide) must error, never spin forever.
const MAX_ID_RETRIES = 50;

export function createMemoryStore(deps: MemoryStoreDeps = {}): MemoryStore {
  const stateRoot = deps.stateRoot ?? STATE_ROOT;
  const genId = deps.genId ?? genMemId;
  const today = deps.today ?? todayUtc;

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

  function read(scope: MemoryScope, scopeId: string | null): MemoryItem[] {
    let content: string;
    try {
      content = readFileSync(filePath(scope, scopeId), "utf8");
    } catch {
      return []; // missing file => no memory
    }
    return parseMemoryFile(content, scope, scopeId);
  }

  function append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryItem {
    const existing = new Set(read(input.scope, input.scopeId).map((m) => m.id));
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
    const line = formatMemoryLine({
      id,
      author: input.author,
      date,
      text: input.text,
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
      raw: line,
    };
  }

  function renderForPrompt(
    scope: MemoryScope,
    scopeId: string | null,
  ): string | null {
    const items = read(scope, scopeId);
    if (items.length === 0) return null;
    return items.map((m) => m.raw).join("\n");
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

  return { read, append, renderForPrompt, renderForPromptMulti };
}

// Default production store against the real STATE_ROOT. Used by the route
// handler, agent-manager auto-load, and the /isomux-system-prompt inspector.
export const memoryStore = createMemoryStore();

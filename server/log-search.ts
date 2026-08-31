// Conversation-log search and retrieval - the read core behind
// GET /api/agents/:id/logs (tasks da7b2899 + b6d07978).
//
// Three modes, resolved from the query with no ambiguity (see parseLogQuery):
//   q present            -> SEARCH    (optionally narrowed to one session)
//   else session present -> RETRIEVE  (a whole session, or a window via `around`)
//   else                 -> INDEX     (the agent's session list)
//
// LEAF MODULE. It reads the log tree through an injected LogSource seam and
// never touches STATE_ROOT, the managers, or the route layer. Two reasons that
// matters here:
//   1. The SEARCH scan runs inside a child PROCESS (see log-search-child.ts),
//      which shares nothing with the server. Handing it an explicit logs
//      directory instead of letting it re-resolve STATE_ROOT removes any
//      dependence on environment inheritance across the process boundary.
//   2. Unit tests drive the same code with a fake source or a temp directory.
//
// DECODE BEFORE MATCHING is the central rule. A raw JSONL grep both misses text
// (an apostrophe written as \" or a newline written as \n never matches the
// literal the caller typed) and, when it does hit, drags a whole 100 KB
// tool-result line into the caller's context. Everything below matches against
// the DECODED `content` field and returns a bounded snippet of it. The raw-line
// prefilter in scanForMatches is a pure speed optimization layered on top, and
// is only applied when it is provably a superset test.

import type { LogEntry } from "../shared/types.ts";
// The response shapes are the WIRE contract, so they live in shared/ next to
// every other route shape; this module only implements them.
import type {
  LogEntryKind,
  LogRetrievedEntry,
  LogRetrieveResp,
  LogSearchHit,
  LogSearchResp,
  LogSessionIndexEntry,
  LogSessionIndexResp,
  LogTier,
} from "../shared/contract-shapes.ts";

export type {
  LogEntryKind,
  LogRetrievedEntry,
  LogRetrieveResp,
  LogSearchHit,
  LogSearchResp,
  LogSessionIndexEntry,
  LogSessionIndexResp,
  LogTier,
};

// --- Bounds -----------------------------------------------------------------
// Plain named constants, not configuration. Nothing here differs per
// deployment, so none of it is worth an env var.

// Substring queries are generous; regex patterns are held much shorter, since
// pattern length is the one input that multiplies backtracking cost.
export const MAX_QUERY_LENGTH = 500;
export const MAX_PATTERN_LENGTH = 200;

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export const DEFAULT_RETRIEVE_LIMIT = 200;
export const MAX_RETRIEVE_LIMIT = 1000;

export const DEFAULT_WINDOW = 5;
export const MAX_WINDOW = 50;

// Snippet geometry: SNIPPET_RADIUS characters either side of the match, then a
// hard cap so a match inside a very long word still can't run away.
export const SNIPPET_RADIUS = 120;
export const MAX_SNIPPET = 300;

// Per-entry content cap for the retrieval modes. `tier=full` on a session with
// 100 KB tool results would otherwise detonate the caller's context window -
// the entry is still returned, marked, and its true length reported.
export const ENTRY_CONTENT_CAP = 4000;

// --- Kind tiers -------------------------------------------------------------
// Nil's three retrieval tiers ((i) user messages, (ii) user + assistant without
// thinking traces, (iii) everything) and the search kind filter are the same
// knob: both select a set of entry kinds. They are ONE parameter here rather
// than two overlapping ones. `conversation` is the default in every mode, which
// is also the default the search spec asked for (user_message + text), so
// thinking traces stay opt-in via an explicit `kind=` or `tier=full`.

export type LogKind = LogEntryKind;

export const ALL_KINDS = [
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "error",
  "system",
  "user_message",
  "api_token_outbound",
  "diff",
  "edit-request",
  "terminal-command",
  "file-view",
] as const satisfies readonly LogKind[];

// Compile-time completeness guard. normalizeEntry() DROPS entries whose kind is
// not in the list above, which is right for a corrupt line but would be silently
// wrong for a kind someone adds to LogEntry later: those entries would quietly
// vanish from search with no error anywhere. If a new kind is added and not
// listed, UnlistedKind stops being `never` and this assignment fails to compile.
type UnlistedKind = Exclude<LogKind, (typeof ALL_KINDS)[number]>;
const _kindsAreExhaustive: [UnlistedKind] extends [never] ? true : false = true;
void _kindsAreExhaustive;

export const TIERS: Record<LogTier, readonly LogKind[] | null> = {
  prompts: ["user_message"],
  conversation: ["user_message", "text", "api_token_outbound"],
  // null means "no filter at all", which is what makes `full` genuinely
  // everything rather than everything-we-remembered-to-list.
  full: null,
};

export const DEFAULT_TIER: LogTier = "conversation";

// --- The log-tree seam ------------------------------------------------------

// Per-session metadata, narrowed to what search needs. Mirrors the fields
// persistence.ts writes into `<logs>/<agentId>/sessions.json`.
export interface SessionMeta {
  topic: string | null;
  lastModified: number;
  forkedFrom?: string;
  forkMessageId?: string;
}

export interface LogSource {
  // Sessions that have a physical `<sessionId>.jsonl` on disk, in no particular
  // order. The authoritative set: a session id from the caller is validated
  // against THIS before any path is constructed.
  //
  // `mtime` is carried alongside because sessions.json is not guaranteed to
  // hold a `lastModified` for every session (sessions persisted before that
  // field existed, and migrated state, lack it). persistence.listAgentSessions
  // falls back to the JSONL file's mtime in exactly that case, and this seam
  // exists so ordering here matches rather than sorting those sessions to the
  // bottom under a substituted 0.
  listSessions(
    agentId: string,
  ): Promise<{ sessionId: string; mtime: number }[]>;
  // The agent's sessions.json, or {} when it is missing or unreadable.
  readSessionsMeta(agentId: string): Promise<Record<string, SessionMeta>>;
  // One session's PHYSICAL entries (branch-local; ancestors not included).
  readEntries(agentId: string, sessionId: string): Promise<LogEntry[]>;
  // One session's physical lines, streamed. The scan path uses this so a large
  // session is never materialized as an array of parsed objects.
  streamLines(agentId: string, sessionId: string): AsyncIterable<string>;
}

// --- Query parsing / validation ---------------------------------------------

export type LogQueryMode = "index" | "search" | "retrieve";

export interface LogQuery {
  mode: LogQueryMode;
  // SEARCH only.
  q?: string;
  regex?: boolean;
  before?: number;
  after?: number;
  // SEARCH (optional narrowing) and RETRIEVE (required).
  session?: string;
  // RETRIEVE only.
  around?: string;
  window?: number;
  // Shared. `kinds` is the RESOLVED selection (null = every kind); `tier` is
  // the preset it came from, or null when an explicit kind= replaced it. Both
  // are echoed on the wire, so a response never labels an arbitrary kind set
  // with a preset name it does not correspond to.
  kinds: readonly LogKind[] | null;
  tier: LogTier | null;
  limit: number;
}

export interface QueryError {
  code: string;
  message: string;
}

function parseIntParam(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): number | QueryError | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      code: `invalid_${name}`,
      message: `${name} must be an integer between ${min} and ${max}`,
    };
  }
  return n;
}

function isQueryError(v: unknown): v is QueryError {
  return typeof v === "object" && v !== null && "code" in v;
}

// Parse and validate the query string into a LogQuery, or return the single
// error that rejects it. Pure - no filesystem access, so a malformed request is
// refused before anything is opened. Session-id EXISTENCE is checked later
// (it needs the source); this only bounds its shape.
export function parseLogQuery(query: URLSearchParams): LogQuery | QueryError {
  const q = query.get("q");
  const session = query.get("session");
  const around = query.get("around");

  const regex = isTruthyFlag(query.get("regex"));

  if (q !== null) {
    if (q.length === 0) {
      return { code: "invalid_q", message: "q must not be empty" };
    }
    const cap = regex ? MAX_PATTERN_LENGTH : MAX_QUERY_LENGTH;
    if (q.length > cap) {
      return {
        code: "query_too_long",
        message: `q must be at most ${cap} characters${regex ? " when regex=1" : ""}`,
      };
    }
  }

  // Mode resolution. `q` wins over `session` so that session=<id>&q=... reads as
  // "search inside this session" rather than as an ambiguous hybrid.
  const mode: LogQueryMode =
    q !== null ? "search" : session !== null ? "retrieve" : "index";

  if (around !== null && mode !== "retrieve") {
    return {
      code: "invalid_around",
      message: "around requires session and cannot be combined with q",
    };
  }
  // `around` is never used to build a path, but it IS reflected in the response
  // and compared against every entry in a timeline, so an unbounded value would
  // let a giant query inflate both the work and the reply. Held to the same
  // shape as the ids it is matched against (`log-<epoch>-<suffix>`).
  if (around !== null && !isSafeId(around)) {
    return {
      code: "invalid_around",
      message: "around is not a valid entry id",
    };
  }
  if (session !== null && !isSafeId(session)) {
    return { code: "unknown_session", message: "no such session" };
  }

  // Tier / kind. An explicit kind= overrides the tier preset entirely.
  const tierRaw = query.get("tier");
  if (tierRaw !== null && !(tierRaw in TIERS)) {
    return {
      code: "invalid_tier",
      message: `tier must be one of: ${Object.keys(TIERS).join(", ")}`,
    };
  }
  const presetTier = (tierRaw as LogTier | null) ?? DEFAULT_TIER;
  // A malformed `tier` is rejected above even when `kind` is also supplied:
  // every parameter the caller actually sent is validated, none is silently
  // dropped just because something else would have overridden it.
  let tier: LogTier | null = presetTier;

  const kindRaw = query.get("kind");
  let kinds: readonly LogKind[] | null = TIERS[presetTier];
  if (kindRaw !== null) {
    const parts = kindRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) {
      return { code: "invalid_kind", message: "kind must not be empty" };
    }
    for (const p of parts) {
      if (!ALL_KINDS.includes(p as LogKind)) {
        return {
          code: "invalid_kind",
          message: `kind must be a comma-separated subset of: ${ALL_KINDS.join(", ")}`,
        };
      }
    }
    kinds = parts as LogKind[];
    // The override replaces the preset outright, so there is no longer a tier
    // to name. Reporting one would be a lie the caller could act on.
    tier = null;
  }

  const limitMax = mode === "retrieve" ? MAX_RETRIEVE_LIMIT : MAX_SEARCH_LIMIT;
  const limitDefault =
    mode === "retrieve" ? DEFAULT_RETRIEVE_LIMIT : DEFAULT_SEARCH_LIMIT;
  const limitParsed = parseIntParam(query.get("limit"), "limit", 1, limitMax);
  if (isQueryError(limitParsed)) return limitParsed;
  const limit = limitParsed ?? limitDefault;

  const windowParsed = parseIntParam(
    query.get("window"),
    "window",
    0,
    MAX_WINDOW,
  );
  if (isQueryError(windowParsed)) return windowParsed;

  const beforeParsed = parseIntParam(
    query.get("before"),
    "before",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (isQueryError(beforeParsed)) return beforeParsed;
  const afterParsed = parseIntParam(
    query.get("after"),
    "after",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (isQueryError(afterParsed)) return afterParsed;

  if (regex && q !== null) {
    const compiled = compileRegex(q);
    if (compiled === null) {
      return {
        code: "invalid_regex",
        message: "q is not a valid regular expression",
      };
    }
  }

  return {
    mode,
    ...(q !== null ? { q } : {}),
    ...(regex ? { regex: true } : {}),
    ...(session !== null ? { session } : {}),
    ...(around !== null ? { around } : {}),
    ...(windowParsed !== null ? { window: windowParsed } : {}),
    ...(beforeParsed !== null ? { before: beforeParsed } : {}),
    ...(afterParsed !== null ? { after: afterParsed } : {}),
    kinds,
    tier,
    limit,
  };
}

function isTruthyFlag(raw: string | null): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

// Ids that index into the log tree are validated to this shape BEFORE any path
// is built from them, so no caller-supplied string can walk out of the log
// directory via `..` or an absolute path.
export function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  // "." and ".." pass the character class below but name directories. They are
  // caught later anyway (an id must also appear in the agent's own session
  // list), but rejecting them here means no reader has to reconstruct that
  // argument to convince themselves a path cannot escape.
  if (id === "." || id === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

// Compile a caller-supplied pattern, or null when it does not compile.
// Case-insensitive to match substring behavior; there is deliberately no
// case knob, because one search posture across both modes is easier to
// describe than two.
export function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

// --- Fork reconstruction ----------------------------------------------------

// The chain of sessions ending at `sessionId`, oldest ancestor first, each with
// the fork point at which its child branched off. Mirrors the walk in
// persistence.loadLogWithAncestors (which log-search.test.ts pins against, so
// the two cannot drift silently).
export function forkChain(
  sessionId: string,
  meta: Record<string, SessionMeta>,
): { sessionId: string; forkMessageId?: string }[] {
  const chain: { sessionId: string; forkMessageId?: string }[] = [];
  let current: string | undefined = sessionId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);
    const m: SessionMeta | undefined = meta[current];
    chain.unshift({ sessionId: current, forkMessageId: m?.forkMessageId });
    current = m?.forkedFrom;
  }
  return chain;
}

// The reconstructed timeline for one session: ancestors truncated at the point
// their child forked away, then the session's own entries.
//
// This is why searching ONE session and scanning ALL sessions are deliberately
// asymmetric. A forked session's JSONL holds only its branch-local entries, so
// reconstructing is the only way `session=<id>` can see the conversation the
// agent actually experienced. An all-session scan instead reads each PHYSICAL
// entry exactly once, so a shared ancestor is not reported N times over.
export async function reconstructTimeline(
  source: LogSource,
  agentId: string,
  sessionId: string,
): Promise<LogEntry[]> {
  const meta = await source.readSessionsMeta(agentId);
  const chain = forkChain(sessionId, meta);
  const out: LogEntry[] = [];
  for (let i = 0; i < chain.length; i++) {
    const entries = await source.readEntries(agentId, chain[i].sessionId);
    if (i < chain.length - 1) {
      const cutoffId = chain[i + 1].forkMessageId;
      for (const entry of entries) {
        if (entry.id === cutoffId) break;
        out.push(entry);
      }
    } else {
      out.push(...entries);
    }
  }
  return out;
}

// --- Matching ---------------------------------------------------------------

// Whether the raw JSONL line can be substring-prefiltered for `q`.
//
// The prefilter is only sound as a SUPERSET test: it may let through a line
// that does not really match, but it must NEVER reject one that does.
//
// PREMISE: these files are written by THIS codebase, via JSON.stringify
// (persistence.appendLog). That matters, because the property is NOT true of
// arbitrary valid JSON - a different writer may legally encode a plain ASCII
// "a" as "a", which no substring test on the raw line would find. What
// holds for a JSON.stringify-produced line is that encoding is
// character-by-character and leaves every non-escapable character alone, so a
// query containing only such characters appears verbatim inside the encoded
// string. `JSON.stringify(q).slice(1, -1) === q` is precisely that test.
//
// The ASCII restriction is a second, separate soundness condition: the
// prefilter lowercases both sides for case-insensitivity, and Unicode case
// folding can CHANGE A STRING'S LENGTH (e.g. "İ".toLowerCase()), which
// would break the substring relation and cause a false negative. Non-ASCII
// queries therefore take the full-parse path.
export function canPrefilter(q: string): boolean {
  if (JSON.stringify(q).slice(1, -1) !== q) return false;
  return /^[\x20-\x7E]+$/.test(q);
}

// The bounded, whitespace-collapsed excerpt around a match. Reported from the
// DECODED content, never the raw line.
export function buildSnippet(
  content: string,
  matchIndex: number,
  matchLength: number,
): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(
    content.length,
    matchIndex + matchLength + SNIPPET_RADIUS,
  );
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (snippet.length > MAX_SNIPPET)
    snippet = snippet.slice(0, MAX_SNIPPET).trimEnd();
  return (
    (start > 0 ? "..." : "") + snippet + (end < content.length ? "..." : "")
  );
}

// Locate the first match of the query in decoded content, or null.
export function findMatch(
  content: string,
  q: string,
  re: RegExp | null,
): { index: number; length: number } | null {
  if (re) {
    // Fresh lastIndex every call: the compiled pattern carries no /g, but
    // being explicit keeps this safe if that ever changes.
    re.lastIndex = 0;
    const m = re.exec(content);
    return m ? { index: m.index, length: m[0].length } : null;
  }
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  return idx === -1 ? null : { index: idx, length: q.length };
}

// --- Results ----------------------------------------------------------------

// Local aliases for the wire shapes imported above, so the implementation below
// reads in its own vocabulary while there is still exactly one definition of
// each shape (in shared/contract-shapes.ts).
export type SearchHit = LogSearchHit;
export type SearchResult = LogSearchResp;
export type SessionIndexEntry = LogSessionIndexEntry;
export type RetrievedEntry = LogRetrievedEntry;
// What this module PRODUCES is the session-history half of the response. The
// live `pendingPrompt` field is added by the route handler, which is the only
// layer that knows the agent's current state - log-search reads files and has
// no view of a running agent. Declaring the producer as "the response minus
// that field" keeps the wire type honest (a handler that forgot to add it does
// not compile) without pretending this module could supply it.
export type RetrieveResult = Omit<
  LogRetrieveResp,
  "pendingPrompt" | "inFlightTurn"
>;
export type SessionIndexResult = Omit<
  LogSessionIndexResp,
  "pendingPrompt" | "inFlightTurn"
>;

// --- Index mode -------------------------------------------------------------

export async function buildSessionIndex(
  source: LogSource,
  agentId: string,
): Promise<SessionIndexResult> {
  const listed = await source.listSessions(agentId);
  const meta = await source.readSessionsMeta(agentId);
  const branchedFrom = new Set<string>();
  for (const m of Object.values(meta)) {
    if (m.forkedFrom) branchedFrom.add(m.forkedFrom);
  }
  const sessions = listed
    .map(({ sessionId, mtime }) => {
      const m = meta[sessionId];
      return {
        sessionId,
        topic: m?.topic ?? null,
        // File mtime when sessions.json has no lastModified for this session,
        // matching persistence.listAgentSessions. Substituting 0 would sort
        // pre-field and migrated sessions to the bottom of a list whose whole
        // job is recency.
        lastModified: m?.lastModified ?? mtime,
        ...(branchedFrom.has(sessionId) ? { branched: true as const } : {}),
        ...(m?.forkedFrom ? { forked: true as const } : {}),
      };
    })
    .sort((a, b) => b.lastModified - a.lastModified);
  return { agentId, sessions };
}

// --- Retrieval modes --------------------------------------------------------

function projectEntry(entry: NormalizedEntry): RetrievedEntry {
  const content = entry.content;
  const over = content.length > ENTRY_CONTENT_CAP;
  return {
    entryId: entry.id,
    timestamp: entry.timestamp,
    kind: entry.kind,
    content: over ? content.slice(0, ENTRY_CONTENT_CAP) : content,
    ...(over
      ? { contentTruncated: true as const, contentLength: content.length }
      : {}),
  };
}

function kindAllowed(kind: LogKind, kinds: readonly LogKind[] | null): boolean {
  return kinds === null || kinds.includes(kind);
}

// Timestamps come off disk and are only as trustworthy as the file. A missing
// or non-numeric one becomes 0 (sorts last, which is where an entry of unknown
// age belongs) rather than NaN, which would poison every comparison it touches.
function safeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// A log entry after the ONE normalization seam every consumer goes through.
// Fields are guaranteed to be the types the rest of the pipeline (and the wire
// contract) assume.
interface NormalizedEntry {
  id: string;
  timestamp: number;
  kind: LogKind;
  content: string;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(ALL_KINDS);

// Normalize one entry read off disk, or return null when it is too malformed to
// use. THE SINGLE PLACE untrusted file content becomes trusted values.
//
// This module already promises to tolerate torn and malformed JSONL, and that
// promise is worthless if it only covers unparseable LINES. A line can parse
// perfectly and still carry a field of the wrong type, and every one of those
// used to leak straight through:
//   - `content: 42` reached String.prototype.toLowerCase and threw a TypeError,
//     failing the ENTIRE search with a 500. One bad line made an agent's whole
//     history unsearchable for any query that could not be prefiltered away.
//   - A missing timestamp bypassed before/after entirely (every comparison
//     against undefined/NaN is false) and was then reported as 0 - filtered by
//     one rule, displayed by another.
//   - An unrecognized `kind` was emitted verbatim, so the response could carry
//     a value outside the LogEntryKind union it declares.
// Normalizing once, at the boundary, is what makes those three impossible
// rather than three separate guards that can each be forgotten.
function normalizeEntry(
  raw: LogEntry | null | undefined,
): NormalizedEntry | null {
  if (!raw || typeof raw.id !== "string" || raw.id.length === 0) return null;
  // An unknown kind is a corrupt record, not a new feature - see the
  // exhaustiveness guard on ALL_KINDS, which is what keeps that true.
  if (!KNOWN_KINDS.has(raw.kind)) return null;
  return {
    id: raw.id,
    timestamp: safeTimestamp(raw.timestamp),
    kind: raw.kind,
    content: typeof raw.content === "string" ? raw.content : "",
  };
}

// Pull one session's conversation at the requested tier. `around` narrows to a
// window of neighbours; otherwise the tail of the session is returned (the tail,
// not the head, because when a long session must be cut it is the recent end
// that the caller is asking about).
export async function retrieveSession(
  source: LogSource,
  agentId: string,
  sessionId: string,
  query: LogQuery,
): Promise<RetrieveResult> {
  // Normalize the whole timeline up front, through the same seam the scan uses,
  // so retrieval cannot emit a non-string `content` or a kind outside the union
  // its wire type declares.
  const timeline = (await reconstructTimeline(source, agentId, sessionId))
    .map(normalizeEntry)
    .filter((e): e is NormalizedEntry => e !== null);
  const meta = await source.readSessionsMeta(agentId);
  const topic = meta[sessionId]?.topic ?? null;

  const base = {
    agentId,
    sessionId,
    topic,
    ...selectionOf(query),
  };

  if (query.around !== undefined) {
    // The anchor is kept even when its own kind is filtered out by the tier -
    // otherwise asking for context around a tool_call at tier=conversation
    // would silently drop the very entry the caller named.
    const filtered = timeline.filter(
      (e) => kindAllowed(e.kind, query.kinds) || e.id === query.around,
    );
    const at = filtered.findIndex((e) => e.id === query.around);
    const window = query.window ?? DEFAULT_WINDOW;
    if (at === -1) {
      return {
        ...base,
        totalEntries: filtered.length,
        truncated: false,
        entries: [],
        around: query.around,
        window,
        found: false,
      };
    }
    const slice = filtered.slice(Math.max(0, at - window), at + window + 1);
    return {
      ...base,
      totalEntries: filtered.length,
      truncated: slice.length < filtered.length,
      entries: slice.map(projectEntry),
      around: query.around,
      window,
      found: true,
    };
  }

  const filtered = timeline.filter((e) => kindAllowed(e.kind, query.kinds));
  const tail = filtered.slice(Math.max(0, filtered.length - query.limit));
  return {
    ...base,
    totalEntries: filtered.length,
    truncated: tail.length < filtered.length,
    entries: tail.map(projectEntry),
  };
}

// --- Search mode ------------------------------------------------------------

// The resolved kind selection, echoed on every response. Shared so search and
// retrieval cannot describe the same query differently.
function selectionOf(query: LogQuery): {
  kinds: LogKind[] | null;
  tier: LogTier | null;
} {
  return {
    kinds: query.kinds === null ? null : [...query.kinds],
    tier: query.tier,
  };
}

export interface ScanOptions {
  // Wall-clock budget for the scan. The parent (log-search-runner.ts) enforces
  // a hard outer bound by SIGKILLing the child; this inner check is the
  // cooperative one, so an ordinary large scan returns a clean partial result
  // instead of being killed.
  budgetMs: number;
  // Injectable clock so the timeout path is testable without real waiting.
  now?: () => number;
  // TEST SEAM. Reports the largest the hit buffer ever grew to, so the memory
  // bound can be asserted directly rather than inferred from a comment. Called
  // once, after the scan.
  onBufferHighWater?: (n: number) => void;
}

// Scan an agent's logs for `q` and return the most recent `limit` hits.
//
// Two shapes, per the fork asymmetry documented on reconstructTimeline:
//   session given -> the reconstructed timeline for that session
//   otherwise     -> every physical session file, each entry read exactly once
export async function searchLogs(
  source: LogSource,
  agentId: string,
  query: LogQuery,
  opts: ScanOptions,
): Promise<SearchResult> {
  const q = query.q ?? "";
  const re = query.regex ? compileRegex(q) : null;
  const meta = await source.readSessionsMeta(agentId);
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;

  const hits: SearchHit[] = [];
  let totalMatches = 0;
  let timedOut = false;

  // `hits` must not grow with the match count. A one-character query at
  // tier=full can match essentially every entry in every session, and one
  // ~300-character snippet per match would be tens of megabytes on a busy
  // agent. So the buffer is pruned back to the top `limit` by timestamp
  // whenever it gets large: what is discarded is always older than `limit`
  // retained hits, so the final answer is unchanged. `totalMatches` keeps
  // counting past the prune and stays the TRUE total.
  const pruneAt = Math.max(query.limit * 8, 200);
  let bufferHighWater = 0;
  const prune = (): void => {
    hits.sort((a, b) => b.timestamp - a.timestamp);
    hits.length = Math.min(hits.length, query.limit);
  };

  const consider = (raw: LogEntry, sessionId: string): void => {
    // Normalize ONCE, at the top, and use these values for every decision
    // below. Filtering on the raw field and reporting the normalized one is how
    // an unstamped entry used to slip past `after` and then be displayed as 0.
    const entry = normalizeEntry(raw);
    if (!entry) return;
    if (!kindAllowed(entry.kind, query.kinds)) return;
    // An entry of unknown age normalizes to timestamp 0, i.e. "as old as
    // possible": any `after` above 0 excludes it, any `before` includes it.
    if (query.after !== undefined && entry.timestamp < query.after) return;
    if (query.before !== undefined && entry.timestamp > query.before) return;
    const content = entry.content;
    const m = findMatch(content, q, re);
    if (!m) return;
    totalMatches++;
    hits.push({
      sessionId,
      topic: meta[sessionId]?.topic ?? null,
      timestamp: entry.timestamp,
      kind: entry.kind,
      entryId: entry.id,
      snippet: buildSnippet(content, m.index, m.length),
    });
    if (hits.length > bufferHighWater) bufferHighWater = hits.length;
    if (hits.length >= pruneAt) prune();
  };

  if (query.session !== undefined) {
    // NOTE the limit of this branch: reconstruction materializes the whole
    // ancestry BEFORE the first deadline check, so a single enormous session
    // can blow past the cooperative budget and end at the hard deadline (a
    // SIGKILL, so no partial at all) instead of returning one. The per-entry
    // check below bounds the MATCHING, not the reading. Acceptable because the
    // scan is process-isolated and hard-bounded either way; a streaming
    // reconstructed iterator is the fix if this ever bites.
    const timeline = await reconstructTimeline(source, agentId, query.session);
    for (const entry of timeline) {
      if (now() > deadline) {
        timedOut = true;
        break;
      }
      consider(entry, query.session);
    }
  } else {
    const prefilter = !re && canPrefilter(q) ? q.toLowerCase() : null;
    const sessions = await source.listSessions(agentId);
    // Newest session first, so a scan that runs out of budget has already
    // covered the recent history the caller most likely wants. Falls back to
    // the file mtime when sessions.json has no lastModified, matching
    // persistence.listAgentSessions rather than sorting those to the bottom.
    const recency = (s: { sessionId: string; mtime: number }): number =>
      meta[s.sessionId]?.lastModified ?? s.mtime;
    const ordered = [...sessions].sort((a, b) => recency(b) - recency(a));
    outer: for (const { sessionId } of ordered) {
      for await (const line of source.streamLines(agentId, sessionId)) {
        if (now() > deadline) {
          timedOut = true;
          break outer;
        }
        if (line.length === 0) continue;
        if (prefilter !== null && !line.toLowerCase().includes(prefilter)) {
          continue;
        }
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch {
          continue; // a torn or malformed line is skipped, never fatal
        }
        // Only the id is required, matching readEntries and the reconstructed
        // path. A missing `content` is handled by consider() as empty rather
        // than skipped here, so the same entry behaves identically whether it
        // was reached by a scan or by session=.
        if (typeof entry?.id !== "string") continue;
        consider(entry, sessionId);
      }
    }
  }

  // Most recent first (Nil). Array.prototype.sort is stable, so same-timestamp
  // hits keep the order they were discovered in - within a session, file order.
  // Ties spanning a prune can reshuffle relative to each other; that is not a
  // contract, only the timestamp ordering is.
  hits.sort((a, b) => b.timestamp - a.timestamp);
  const results = hits.slice(0, query.limit);
  opts.onBufferHighWater?.(bufferHighWater);

  return {
    agentId,
    query: q,
    regex: Boolean(query.regex),
    ...selectionOf(query),
    // A scan that stopped early cannot know a total, so it does not claim one.
    // The count it DID reach is reported under a name that says so. The failure
    // this avoids is a caller reading a partial 0 as "nothing matches" and
    // concluding their history is empty.
    totalMatches: timedOut ? null : totalMatches,
    ...(timedOut ? { matchesFoundBeforeTimeout: totalMatches } : {}),
    // Limit omission among the hits that were actually found - well defined
    // whether or not the scan completed. Derived from the count rather than the
    // buffer, which the prune above may already have trimmed.
    truncated: totalMatches > results.length,
    timedOut,
    results,
  };
}

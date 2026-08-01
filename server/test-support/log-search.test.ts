// Conversation-log search + retrieval core (server/log-search.ts, tasks
// da7b2899 + b6d07978). T0: no server, no LLM - fixture JSONL written into the
// preload's temp STATE_ROOT and read through the real filesystem source.
//
// What these freeze, in order of how easy each is to break by accident:
//   1. MATCHING HAPPENS ON DECODED CONTENT. Every "raw grep would miss this"
//      case (escaped quotes, embedded newlines, tabs, non-ASCII) is asserted
//      positively, and canPrefilter is asserted to REFUSE those queries - which
//      is the actual mechanism that keeps the optimization sound.
//   2. Fork asymmetry: session= reconstructs the ancestor timeline, an
//      all-session scan reads each PHYSICAL entry once. reconstructTimeline is
//      pinned against persistence.loadLogWithAncestors on the same fixture, so
//      the duplicated walk cannot drift.
//   3. The tier ladder, the around-window (including an anchor its own tier
//      filters out), ordering, and the truncated/timedOut split.
//   4. Query validation bounds - every rejection path, since those are what
//      stand between a caller-supplied string and the filesystem.

import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { loadLogWithAncestors } from "../persistence.ts";
import { fileLogSource } from "../log-source.ts";
import {
  ALL_KINDS,
  ENTRY_CONTENT_CAP,
  MAX_PATTERN_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_SNIPPET,
  buildSessionIndex,
  canPrefilter,
  forkChain,
  parseLogQuery,
  reconstructTimeline,
  retrieveSession,
  searchLogs,
  type LogQuery,
} from "../log-search.ts";
import type { LogEntry } from "../../shared/types.ts";

const LOGS_DIR = join(STATE_ROOT, "logs");
const AGENT = "agent-logsearch-fixture";
const EMPTY_AGENT = "agent-logsearch-empty";

// s1 is the root session; s2 forked off it at e3, so s2's own JSONL holds only
// its branch-local entries and e1/e2 reach it only through reconstruction.
const S1 = "sess-one";
const S2 = "sess-two";

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  timestamp: number,
): LogEntry {
  return { id, agentId: AGENT, kind, content, timestamp };
}

// The decode-before-match fixtures. Each of these is written to disk through
// JSON.stringify, so on the raw line the marked characters appear ESCAPED - a
// grep for the literal the caller typed would not find them.
const QUOTED = `The boss said "ship it on Friday" and left`;
const NEWLINED = `alpha\nbeta gamma`;
const TABBED = `col-one\tcol-two`;
const UNICODE = `café ☕ móvil`;
const LONG = "x".repeat(400) + "NEEDLE" + "y".repeat(400);
const HUGE = "z".repeat(ENTRY_CONTENT_CAP + 250);

const S1_ENTRIES: LogEntry[] = [
  entry("e1", "user_message", "first prompt about slide mode", 1_000),
  entry("e2", "text", QUOTED, 2_000),
  entry("e3", "user_message", "the message that got edited", 3_000),
  entry("e4", "thinking", "private reasoning about slide mode", 4_000),
  entry("e5", "tool_call", "Bash", 5_000),
];

const S2_ENTRIES: LogEntry[] = [
  entry("e6", "user_message", NEWLINED, 6_000),
  entry("e7", "text", UNICODE, 7_000),
  entry("e8", "text", LONG, 8_000),
  entry("e9", "tool_result", HUGE, 9_000),
  entry("e10", "text", TABBED, 10_000),
];

function writeSession(sessionId: string, entries: LogEntry[]): void {
  writeFileSync(
    join(LOGS_DIR, AGENT, `${sessionId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

const source = fileLogSource(LOGS_DIR);

beforeAll(() => {
  mkdirSync(join(LOGS_DIR, AGENT), { recursive: true });
  mkdirSync(join(LOGS_DIR, EMPTY_AGENT), { recursive: true });
  writeSession(S1, S1_ENTRIES);
  writeSession(S2, S2_ENTRIES);
  writeFileSync(
    join(LOGS_DIR, AGENT, "sessions.json"),
    JSON.stringify({
      [S1]: { topic: "Slide mode design", lastModified: 5_000 },
      [S2]: {
        topic: "Follow-up branch",
        lastModified: 10_000,
        forkedFrom: S1,
        forkMessageId: "e3",
      },
    }),
  );
});

// Build a LogQuery the way the route would, so tests exercise the real parser
// rather than hand-rolling the shape it produces.
function q(qs: string): LogQuery {
  const parsed = parseLogQuery(new URLSearchParams(qs));
  if ("code" in parsed) {
    throw new Error(`expected a valid query, got ${parsed.code}`);
  }
  return parsed;
}

const scan = { budgetMs: 10_000 };

describe("log search: decoding happens before matching", () => {
  it("finds text that JSON escaped on disk (quotes) - a raw grep would miss it", async () => {
    // Prove the premise first: the literal is NOT present in the raw file.
    const raw = await Bun.file(join(LOGS_DIR, AGENT, `${S1}.jsonl`)).text();
    expect(raw.includes(`said "ship it`)).toBe(false);

    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent('said "ship it')}`),
      scan,
    );
    expect(res.totalMatches).toBe(1);
    expect(res.results[0].entryId).toBe("e2");
  });

  it("finds text across an embedded newline", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent("alpha\nbeta")}`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e6"]);
  });

  it("finds text across an embedded tab", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent("one\tcol")}`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e10"]);
  });

  it("finds non-ASCII text", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent("café ☕")}`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e7"]);
  });

  it("refuses the raw-line prefilter exactly for the queries it would break on", () => {
    // Plain ASCII survives JSON encoding unchanged, so the prefilter is a sound
    // superset test and gets used.
    expect(canPrefilter("slide mode")).toBe(true);
    expect(canPrefilter("a-b_c.d/e 1")).toBe(true);
    // These do NOT survive encoding (or survive it but break case folding), so
    // the scan must fall back to parsing every line. If this ever returns true,
    // the four tests above are what start failing.
    expect(canPrefilter('said "ship')).toBe(false);
    expect(canPrefilter("alpha\nbeta")).toBe(false);
    expect(canPrefilter("one\tcol")).toBe(false);
    expect(canPrefilter("back\\slash")).toBe(false);
    expect(canPrefilter("café")).toBe(false);
  });

  it("matches case-insensitively", async () => {
    const res = await searchLogs(source, AGENT, q("q=SLIDE+MODE"), scan);
    expect(res.totalMatches).toBeGreaterThan(0);
  });

  it("agrees with itself when case folding crosses out of ASCII", async () => {
    // The prefilter lowercases the RAW line while the real match lowercases the
    // DECODED content. Those are different strings, so anywhere case folding
    // does something surprising they could disagree - and a disagreement in the
    // prefilter's direction is a silent false NEGATIVE, the one failure mode
    // that never surfaces as an error. Kelvin sign (U+212A) folds to plain "k",
    // so an ASCII query reaches content the caller never typed in ASCII; both
    // stages must reach the same verdict.
    const agent = "agent-logsearch-folding";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "f.jsonl"),
      JSON.stringify(entry("f1", "text", "temperature in Kelvin", 1)) + "\n",
    );
    // ASCII query, so the prefilter IS engaged (this would prove nothing if it
    // silently took the full-parse path instead).
    expect(canPrefilter("kelvin")).toBe(true);
    const res = await searchLogs(
      fileLogSource(LOGS_DIR),
      agent,
      q("q=kelvin"),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["f1"]);
  });
});

describe("log search: fork semantics", () => {
  it("reconstructTimeline agrees with persistence.loadLogWithAncestors", () => {
    // The search core walks the fork chain itself (it must work inside the
    // worker, over an injected source). Pinning it against the production
    // walker on the same fixture is what stops the two drifting apart.
    const viaCore = reconstructTimeline(source, AGENT, S2);
    const viaPersistence = loadLogWithAncestors(AGENT, S2);
    return viaCore.then((entries) => {
      expect(entries.map((e) => e.id)).toEqual(viaPersistence.map((e) => e.id));
    });
  });

  it("truncates the ancestor at the fork point", async () => {
    const timeline = await reconstructTimeline(source, AGENT, S2);
    // e1, e2 come from s1 (up to but NOT including the edited e3), then s2's own.
    expect(timeline.map((e) => e.id)).toEqual([
      "e1",
      "e2",
      "e6",
      "e7",
      "e8",
      "e9",
      "e10",
    ]);
  });

  it("forkChain guards against a cycle instead of looping forever", () => {
    const chain = forkChain("a", {
      a: { topic: null, lastModified: 0, forkedFrom: "b" },
      b: { topic: null, lastModified: 0, forkedFrom: "a" },
    });
    expect(chain.map((c) => c.sessionId)).toEqual(["b", "a"]);
  });

  it("an all-session scan reports a shared ancestor entry ONCE, not once per branch", async () => {
    // "slide mode" appears in e1 (user_message, physically in s1). s2 inherits
    // it through reconstruction, so a scan that reconstructed every session
    // would report it twice.
    const res = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(res.totalMatches).toBe(1);
    expect(res.results[0].sessionId).toBe(S1);
  });

  it("a session-scoped search DOES see inherited ancestor entries", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=first+prompt&session=${S2}`),
      scan,
    );
    expect(res.totalMatches).toBe(1);
    // Reported under the session that was searched - that is the timeline the
    // agent actually experienced.
    expect(res.results[0].sessionId).toBe(S2);
  });
});

describe("log search: kinds, tiers and filters", () => {
  it("defaults to user_message + text, so thinking traces stay out", async () => {
    const res = await searchLogs(source, AGENT, q("q=slide+mode"), scan);
    // e1 (user_message) matches; e4 (thinking) also contains the phrase but is
    // not in the default tier.
    expect(res.results.map((r) => r.entryId)).toEqual(["e1"]);
  });

  it("reaches thinking traces via an explicit kind=", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q("q=slide+mode&kind=thinking"),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e4"]);
  });

  it("reaches thinking traces via tier=full", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q("q=slide+mode&tier=full"),
      scan,
    );
    expect(res.results.map((r) => r.entryId).sort()).toEqual(["e1", "e4"]);
  });

  it("tier=prompts sees only user messages", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q("q=slide+mode&tier=prompts"),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e1"]);
  });

  it("honours before/after time bounds", async () => {
    const all = await searchLogs(source, AGENT, q("q=e&tier=full"), scan);
    expect(all.totalMatches).toBeGreaterThan(1);
    const after = await searchLogs(
      source,
      AGENT,
      q("q=e&tier=full&after=6000"),
      scan,
    );
    expect(after.results.every((r) => r.timestamp >= 6_000)).toBe(true);
    const before = await searchLogs(
      source,
      AGENT,
      q("q=e&tier=full&before=3000"),
      scan,
    );
    expect(before.results.every((r) => r.timestamp <= 3_000)).toBe(true);
  });
});

describe("log search: results, ordering and bounds", () => {
  it("returns most recent first", async () => {
    const res = await searchLogs(source, AGENT, q("q=e&tier=full"), scan);
    const stamps = res.results.map((r) => r.timestamp);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it("reports the TRUE total when results are capped, and flags truncation", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q("q=e&tier=full&limit=2"),
      scan,
    );
    expect(res.results).toHaveLength(2);
    expect(res.totalMatches).toBeGreaterThan(2);
    expect(res.truncated).toBe(true);
    expect(res.timedOut).toBe(false);
  });

  it("does not flag truncation when everything fit", async () => {
    const res = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(res.truncated).toBe(false);
  });

  it("joins each hit to its session topic", async () => {
    const res = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(res.results[0].topic).toBe("Slide mode design");
  });

  it("bounds the snippet and centres it on the match", async () => {
    const res = await searchLogs(source, AGENT, q("q=NEEDLE"), scan);
    expect(res.results).toHaveLength(1);
    const snippet = res.results[0].snippet;
    expect(snippet).toContain("NEEDLE");
    // 400 filler characters either side, so both ends are elided.
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET + 6);
  });

  it("timedOut is a SEPARATE signal from truncated", async () => {
    // A zero budget stops the scan on its first entry. `truncated` must stay
    // about the limit alone - conflating the two would tell a caller to narrow
    // their query when the real answer is "ask again".
    const res = await searchLogs(source, AGENT, q("q=e&tier=full"), {
      budgetMs: -1,
    });
    expect(res.timedOut).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(res.truncated).toBe(false);
  });

  it("refuses to report a total it could not know when the scan stopped early", async () => {
    // The dangerous confusion this prevents: a caller reading a partial 0 as
    // "there are no matches" and concluding their history is empty. A scan that
    // stopped early reports null, and its partial count under a name that says
    // what it is.
    const res = await searchLogs(source, AGENT, q("q=e&tier=full"), {
      budgetMs: -1,
    });
    expect(res.totalMatches).toBeNull();
    expect(res.matchesFoundBeforeTimeout).toBe(0);

    // A completed scan does know, and says so.
    const done = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(done.totalMatches).toBe(1);
    expect(done.matchesFoundBeforeTimeout).toBeUndefined();
  });

  it("never buffers more hits than its bound, whatever the match count", async () => {
    // The memory bound asserted DIRECTLY through a test seam, rather than
    // inferred from the fact that the answer came out right - an unbounded
    // implementation produces the same answer.
    const agent = "agent-logsearch-highwater";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "h.jsonl"),
      Array.from({ length: 900 }, (_, i) =>
        JSON.stringify(entry(`h${i}`, "text", `haystack ${i}`, 1_000 + i)),
      ).join("\n") + "\n",
    );
    let highWater = 0;
    const res = await searchLogs(
      fileLogSource(LOGS_DIR),
      agent,
      q("q=haystack&limit=5"),
      { ...scan, onBufferHighWater: (n) => (highWater = n) },
    );
    expect(res.totalMatches).toBe(900);
    // 900 matches, but the buffer never held more than the prune threshold.
    expect(highWater).toBeLessThanOrEqual(Math.max(5 * 8, 200));
    expect(highWater).toBeLessThan(900);
  });

  it("survives an entry with a missing or non-numeric timestamp", async () => {
    // A NaN timestamp would compare false against everything in the sort
    // comparator and silently corrupt the ordering of the WHOLE result set,
    // not just its own position - so it is normalized to 0 (sorts last).
    const agent = "agent-logsearch-badstamp";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "s.jsonl"),
      [
        JSON.stringify({ id: "n1", kind: "text", content: "stamped findme" }),
        JSON.stringify({
          id: "n2",
          kind: "text",
          content: "unstamped findme",
          timestamp: "not-a-number",
        }),
        JSON.stringify(entry("n3", "text", "real findme", 5_000)),
      ].join("\n") + "\n",
    );
    const res = await searchLogs(
      fileLogSource(LOGS_DIR),
      agent,
      q("q=findme"),
      scan,
    );
    expect(res.totalMatches).toBe(3);
    // The properly stamped entry sorts first; the two unusable stamps land at 0.
    expect(res.results[0].entryId).toBe("n3");
    expect(res.results.every((r) => Number.isFinite(r.timestamp))).toBe(true);
  });

  it("survives a line that PARSES but carries fields of the wrong type", async () => {
    // Tolerating "malformed JSONL" is worthless if it only covers unparseable
    // lines. These parse perfectly and are still wrong, and each used to leak
    // through a different hole:
    //   content: 42        -> String.prototype.toLowerCase, TypeError, 500 for
    //                         the WHOLE search. One bad line made an agent's
    //                         entire history unsearchable.
    //   no timestamp       -> bypassed before/after (comparisons against NaN
    //                         are all false), then reported as 0.
    //   unknown kind       -> emitted verbatim, outside the declared union.
    const agent = "agent-logsearch-typed";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "t.jsonl"),
      [
        JSON.stringify(entry("t-ok", "text", "findme normal", 5_000)),
        JSON.stringify({
          id: "t-num",
          kind: "text",
          content: 42,
          timestamp: 6_000,
        }),
        JSON.stringify({
          id: "t-nostamp",
          kind: "text",
          content: "findme unstamped",
        }),
        JSON.stringify({
          id: "t-badkind",
          kind: "not_a_real_kind",
          content: "findme odd",
          timestamp: 7_000,
        }),
      ].join("\n") + "\n",
    );
    const src = fileLogSource(LOGS_DIR);

    // The crash was masked by the raw-line prefilter, so the query has to be one
    // that CANNOT be prefiltered - otherwise the bad line is skipped before it
    // is ever parsed and the test proves nothing. "café" is non-ASCII, which
    // forces the full-parse path over every line including the malformed one.
    expect(canPrefilter("café")).toBe(false);
    const forcedParse = await searchLogs(
      src,
      agent,
      q(`q=${encodeURIComponent("café")}`),
      scan,
    );
    expect(forcedParse.totalMatches).toBe(0);

    // A corrupt record is dropped rather than reported under a kind the wire
    // contract does not have.
    const all = await searchLogs(src, agent, q("q=findme&tier=full"), scan);
    expect(all.results.map((r) => r.entryId).sort()).toEqual([
      "t-nostamp",
      "t-ok",
    ]);
    for (const r of all.results) expect(ALL_KINDS).toContain(r.kind);

    // Unknown age normalizes to 0 ("as old as possible"), so `after` excludes it
    // and `before` includes it - filtered and displayed by the SAME value.
    const after = await searchLogs(
      src,
      agent,
      q("q=findme&tier=full&after=1"),
      scan,
    );
    expect(after.results.map((r) => r.entryId)).toEqual(["t-ok"]);
    const before = await searchLogs(
      src,
      agent,
      q("q=findme&tier=full&before=4999"),
      scan,
    );
    expect(before.results.map((r) => r.entryId)).toEqual(["t-nostamp"]);

    // Retrieval honours the same contract: every content a string, every kind
    // in the union.
    const got = await retrieveSession(
      src,
      agent,
      "t",
      q("session=t&tier=full"),
    );
    expect(got.entries.map((e) => e.entryId)).toEqual([
      "t-ok",
      "t-num",
      "t-nostamp",
    ]);
    for (const e of got.entries) {
      expect(typeof e.content).toBe("string");
      expect(ALL_KINDS).toContain(e.kind);
    }
  });

  it("skips malformed and blank JSONL lines instead of failing the scan", async () => {
    const agent = "agent-logsearch-torn";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "s.jsonl"),
      [
        JSON.stringify(entry("g1", "text", "good one findme", 1)),
        "{ this is not json",
        "",
        JSON.stringify({ id: "g2", kind: "text" }), // no content field
        JSON.stringify(entry("g3", "text", "good two findme", 2)),
      ].join("\n") + "\n",
    );
    const res = await searchLogs(
      fileLogSource(LOGS_DIR),
      agent,
      q("q=findme"),
      scan,
    );
    expect(res.results.map((r) => r.entryId).sort()).toEqual(["g1", "g3"]);
  });

  it("keeps the newest hits without buffering one snippet per match", async () => {
    // A broad query can match essentially every entry, so the hit buffer is
    // pruned back to `limit` as it goes rather than growing with the match
    // count. The property that pruning must not break is that the ANSWER is
    // still the newest `limit` overall.
    //
    // The fixture is shaped to actually exercise the discard. Sessions are
    // scanned newest-first, and entries within a file oldest-first, so a naive
    // fixture would leave the newest hits sitting safely at the END of the scan
    // where no prune can reach them - and a prune that kept the wrong end would
    // still produce the right answer. Here the NEWEST session is scanned first,
    // so its hits must survive 250 subsequent prunes triggered by an older one.
    const agent = "agent-logsearch-many";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    const write = (sid: string, prefix: string, base: number) =>
      writeFileSync(
        join(LOGS_DIR, agent, `${sid}.jsonl`),
        Array.from({ length: 250 }, (_, i) =>
          JSON.stringify(
            entry(`${prefix}${i}`, "text", `haystack ${i}`, base + i),
          ),
        ).join("\n") + "\n",
      );
    write("recent", "new", 900_000);
    write("ancient", "old", 1_000);
    writeFileSync(
      join(LOGS_DIR, agent, "sessions.json"),
      JSON.stringify({
        recent: { topic: "Recent", lastModified: 999_999 },
        ancient: { topic: "Ancient", lastModified: 2_000 },
      }),
    );

    const res = await searchLogs(
      fileLogSource(LOGS_DIR),
      agent,
      q("q=haystack&limit=3"),
      scan,
    );
    expect(res.totalMatches).toBe(500);
    expect(res.results).toHaveLength(3);
    expect(res.truncated).toBe(true);
    // The three newest overall, from the session that was scanned FIRST.
    expect(res.results.map((r) => r.entryId)).toEqual([
      "new249",
      "new248",
      "new247",
    ]);
  });

  it("stops a single long session at the budget too, not just an all-session scan", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=e&tier=full&session=${S2}`),
      {
        budgetMs: -1,
      },
    );
    expect(res.timedOut).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it("an agent with no logs searches to an empty result, not an error", async () => {
    const res = await searchLogs(source, EMPTY_AGENT, q("q=anything"), scan);
    expect(res.totalMatches).toBe(0);
    expect(res.results).toEqual([]);
  });
});

describe("log search: regex mode", () => {
  it("matches a regular expression", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent("sl.de\\s+mode")}&regex=1`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e1"]);
    expect(res.regex).toBe(true);
  });

  it("regex mode never uses the raw-line prefilter", async () => {
    // A pattern that only matches DECODED content: the raw line has \" where
    // the decoded content has a bare quote.
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent('said "ship')}&regex=1`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e2"]);
  });

  it("rejects a pattern that does not compile", () => {
    const parsed = parseLogQuery(new URLSearchParams("q=%5B&regex=1"));
    expect("code" in parsed && parsed.code).toBe("invalid_regex");
  });
});

describe("log retrieval: tiers and windows", () => {
  it("returns the session's conversation at the default tier", async () => {
    const res = await retrieveSession(source, AGENT, S2, q(`session=${S2}`));
    // The reconstructed timeline minus thinking/tool entries.
    expect(res.entries.map((e) => e.entryId)).toEqual([
      "e1",
      "e2",
      "e6",
      "e7",
      "e8",
      "e10",
    ]);
    expect(res.tier).toBe("conversation");
    expect(res.topic).toBe("Follow-up branch");
    expect(res.truncated).toBe(false);
  });

  it("tier=prompts returns only user messages", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&tier=prompts`),
    );
    expect(res.entries.map((e) => e.entryId)).toEqual(["e1", "e6"]);
  });

  it("tier=full returns everything, including thinking and tool entries", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S1,
      q(`session=${S1}&tier=full`),
    );
    expect(res.entries.map((e) => e.entryId)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
      "e5",
    ]);
  });

  it("caps a very long entry and reports its true length", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&tier=full`),
    );
    const huge = res.entries.find((e) => e.entryId === "e9");
    expect(huge?.content).toHaveLength(ENTRY_CONTENT_CAP);
    expect(huge?.contentTruncated).toBe(true);
    expect(huge?.contentLength).toBe(HUGE.length);
  });

  it("keeps the TAIL when a session exceeds the limit", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&tier=full&limit=2`),
    );
    expect(res.entries.map((e) => e.entryId)).toEqual(["e9", "e10"]);
    expect(res.truncated).toBe(true);
    expect(res.totalEntries).toBe(7);
  });

  it("around= returns the neighbours of an entry", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&around=e7&window=1`),
    );
    expect(res.found).toBe(true);
    expect(res.entries.map((e) => e.entryId)).toEqual(["e6", "e7", "e8"]);
    expect(res.window).toBe(1);
  });

  it("around= keeps the anchor even when its own kind is outside the tier", async () => {
    // e9 is a tool_result; the default tier is user_message + text. Dropping the
    // anchor would answer a question about e9 with a window that excludes it.
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&around=e9&window=1`),
    );
    expect(res.found).toBe(true);
    expect(res.entries.map((e) => e.entryId)).toEqual(["e8", "e9", "e10"]);
  });

  it("around= an unknown entry reports found:false rather than an error", async () => {
    const res = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&around=nope`),
    );
    expect(res.found).toBe(false);
    expect(res.entries).toEqual([]);
  });
});

describe("log index", () => {
  it("lists sessions newest first with topic and fork markers", async () => {
    const res = await buildSessionIndex(source, AGENT);
    expect(res.sessions.map((s) => s.sessionId)).toEqual([S2, S1]);
    expect(res.sessions[0]).toMatchObject({
      topic: "Follow-up branch",
      lastModified: 10_000,
      forked: true,
    });
    expect(res.sessions[1]).toMatchObject({
      topic: "Slide mode design",
      branched: true,
    });
  });

  it("an agent with no sessions lists nothing", async () => {
    const res = await buildSessionIndex(source, EMPTY_AGENT);
    expect(res.sessions).toEqual([]);
  });
});

describe("log query parsing: mode resolution and bounds", () => {
  const err = (qs: string): string | false => {
    const parsed = parseLogQuery(new URLSearchParams(qs));
    return "code" in parsed ? parsed.code : false;
  };

  it("resolves the three modes unambiguously", () => {
    expect(q("").mode).toBe("index");
    expect(q("session=s").mode).toBe("retrieve");
    expect(q("q=hi").mode).toBe("search");
    // q wins over session: "search inside this session", not a hybrid.
    expect(q("q=hi&session=s").mode).toBe("search");
  });

  it("rejects around= outside retrieval mode", () => {
    expect(err("around=e1")).toBe("invalid_around");
    expect(err("q=hi&session=s&around=e1")).toBe("invalid_around");
  });

  it("caps query length, with a tighter cap for regex patterns", () => {
    expect(err(`q=${"a".repeat(MAX_QUERY_LENGTH)}`)).toBe(false);
    expect(err(`q=${"a".repeat(MAX_QUERY_LENGTH + 1)}`)).toBe("query_too_long");
    expect(err(`q=${"a".repeat(MAX_PATTERN_LENGTH + 1)}&regex=1`)).toBe(
      "query_too_long",
    );
  });

  it("rejects an empty query", () => {
    expect(err("q=")).toBe("invalid_q");
  });

  it("rejects an unsafe session id before any path is built from it", () => {
    expect(err("session=../../etc/passwd")).toBe("unknown_session");
    expect(err("session=/abs/path")).toBe("unknown_session");
    expect(err("session=a%00b")).toBe("unknown_session");
  });

  it("rejects unknown tiers and kinds", () => {
    expect(err("tier=everything")).toBe("invalid_tier");
    expect(err("kind=gossip")).toBe("invalid_kind");
    expect(err("kind=text,gossip")).toBe("invalid_kind");
    expect(err("kind=")).toBe("invalid_kind");
  });

  it("bounds limit and window", () => {
    expect(err("q=hi&limit=0")).toBe("invalid_limit");
    expect(err("q=hi&limit=101")).toBe("invalid_limit");
    expect(err("q=hi&limit=abc")).toBe("invalid_limit");
    expect(err("q=hi&limit=1.5")).toBe("invalid_limit");
    // Retrieval has its own, larger ceiling.
    expect(err("session=s&limit=101")).toBe(false);
    expect(err("session=s&limit=1001")).toBe("invalid_limit");
    expect(err("session=s&around=e&window=51")).toBe("invalid_window");
    expect(err("session=s&around=e&window=-1")).toBe("invalid_window");
  });

  it("an explicit kind= overrides the tier preset", () => {
    expect(q("tier=full&kind=user_message").kinds).toEqual(["user_message"]);
    expect(q("tier=prompts&kind=text,thinking").kinds).toEqual([
      "text",
      "thinking",
    ]);
  });

  it("tier=full means no kind filter at all, not a hardcoded list", () => {
    expect(q("tier=full").kinds).toBeNull();
  });

  it("rejects a malformed tier even when kind= would have overridden it", () => {
    // Every parameter the caller actually sent is validated. Silently dropping
    // a bad one because something else superseded it would teach them the
    // typo was fine.
    expect(err("tier=nope&kind=text")).toBe("invalid_tier");
  });

  it("bounds the around id rather than reflecting an arbitrary string", () => {
    expect(err(`session=s&around=${"x".repeat(200)}`)).toBe("invalid_around");
    expect(err("session=s&around=has%20a%20space")).toBe("invalid_around");
    expect(err("session=s&around=log-123-ab")).toBe(false);
  });
});

describe("log search: the response describes the selection it actually applied", () => {
  it("names the tier when a preset was used", async () => {
    const res = await searchLogs(source, AGENT, q("q=slide+mode"), scan);
    expect(res.tier).toBe("conversation");
    expect(res.kinds).toEqual(["user_message", "text"]);
  });

  it("reports tier:null when kind= overrode the preset", async () => {
    // The self-contradiction this prevents: `tier=full&kind=user_message`
    // answering `tier:"full"` while having excluded tool and thinking entries.
    const res = await searchLogs(
      source,
      AGENT,
      q("q=slide+mode&tier=full&kind=user_message"),
      scan,
    );
    expect(res.tier).toBeNull();
    expect(res.kinds).toEqual(["user_message"]);
  });

  it("reports kinds:null for tier=full, meaning no filter at all", async () => {
    const res = await searchLogs(
      source,
      AGENT,
      q("q=slide+mode&tier=full"),
      scan,
    );
    expect(res.tier).toBe("full");
    expect(res.kinds).toBeNull();
  });

  it("retrieval describes its selection the same way", async () => {
    const preset = await retrieveSession(source, AGENT, S1, q(`session=${S1}`));
    expect(preset.tier).toBe("conversation");
    expect(preset.kinds).toEqual(["user_message", "text"]);
    const override = await retrieveSession(
      source,
      AGENT,
      S1,
      q(`session=${S1}&kind=thinking`),
    );
    expect(override.tier).toBeNull();
    expect(override.kinds).toEqual(["thinking"]);
  });
});

describe("log index: recency without a recorded lastModified", () => {
  it("falls back to the log file's mtime instead of sorting to the bottom", async () => {
    // persistence.listAgentSessions falls back to the JSONL mtime for sessions
    // whose sessions.json entry predates the lastModified field (and for
    // migrated state). Substituting 0 here would bury exactly those sessions at
    // the end of a list whose entire job is recency.
    const agent = "agent-logsearch-nomtime";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "untracked.jsonl"),
      JSON.stringify(entry("u1", "text", "no metadata for me", 1)) + "\n",
    );
    writeFileSync(
      join(LOGS_DIR, agent, "tracked.jsonl"),
      JSON.stringify(entry("t1", "text", "recorded", 1)) + "\n",
    );
    writeFileSync(
      join(LOGS_DIR, agent, "sessions.json"),
      // `tracked` carries an ancient lastModified; `untracked` has no entry at
      // all, so only its file mtime (just now) can place it.
      JSON.stringify({ tracked: { topic: "Old", lastModified: 5_000 } }),
    );

    const res = await buildSessionIndex(fileLogSource(LOGS_DIR), agent);
    expect(res.sessions[0].sessionId).toBe("untracked");
    expect(res.sessions[0].lastModified).toBeGreaterThan(5_000);
  });
});

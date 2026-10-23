// Conversation-log search + retrieval core (server/log-search.ts, tasks
// da7b2899 + b6d07978). T0: no server, no LLM - fixture JSONL written into the
// preload's temp STATE_ROOT and read through the real filesystem source.
//
// What these freeze, in order of how easy each is to break by accident:
//   1. MATCHING HAPPENS ON DECODED CONTENT. Every "raw grep would miss this"
//      case (escaped quotes, embedded newlines, tabs) is asserted positively.
//   2. Fork asymmetry: session= reconstructs the ancestor timeline, an
//      all-session scan reads each PHYSICAL entry once. Retrieval is pinned
//      against persistence.loadLogWithAncestors on the same fixture, so the
//      duplicated walk cannot drift.
//   3. The tier ladder, the around-window (including an anchor its own tier
//      filters out), ordering, and the truncated/timedOut split.
//   4. Query validation bounds - every rejection path, since those are what
//      stand between a caller-supplied string and the filesystem.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "fs";
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
  parseLogQuery,
  retrieveSession,
  searchLogs,
  type LogQuery,
} from "../log-search.ts";
import type { LogEntry } from "../../shared/types.ts";

const LOGS_DIR = join(STATE_ROOT, "logs");
const AGENT = "agent-logsearch-fixture";
const MISSING_AGENT = "agent-logsearch-missing";

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
const QUOTED = `The morgan said "ship it on Friday" and left`;
const NEWLINED = `alpha\nbeta gamma`;
const TABBED = `col-one\tcol-two`;
const UNICODE = `café ☕ móvil`;
const LONG = "x".repeat(400) + "NEEDLE" + "y".repeat(400);
const HUGE = "z".repeat(ENTRY_CONTENT_CAP + 250);

const S1_ENTRIES: LogEntry[] = [
  entry("e1", "user_message", "first prompt about permission prompt", 1_000),
  entry("e2", "text", QUOTED, 2_000),
  entry("e3", "user_message", "the message that got edited", 3_000),
  entry("e4", "thinking", "private reasoning about permission prompt", 4_000),
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
  writeSession(S1, S1_ENTRIES);
  writeSession(S2, S2_ENTRIES);
  writeFileSync(
    join(LOGS_DIR, AGENT, "sessions.json"),
    JSON.stringify({
      [S1]: { topic: "permission prompt design", lastModified: 5_000 },
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
  // Each query's literal is ESCAPED on disk, so a raw grep would miss it.
  for (const [what, query, session, id] of [
    ["quotes", 'said "ship it', S1, "e2"],
    ["an embedded newline", "alpha\nbeta", S2, "e6"],
    ["an embedded tab", "one\tcol", S2, "e10"],
  ] as const) {
    it(`finds text across ${what} that JSON escaped on disk`, async () => {
      // Prove the premise first: the literal is NOT present in the raw file.
      const raw = await Bun.file(
        join(LOGS_DIR, AGENT, `${session}.jsonl`),
      ).text();
      expect(raw.includes(query)).toBe(false);
      const res = await searchLogs(
        source,
        AGENT,
        q(`q=${encodeURIComponent(query)}`),
        scan,
      );
      expect(res.results.map((r) => r.entryId)).toEqual([id]);
    });
  }

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
  it("retrieval walks the fork chain the way persistence.loadLogWithAncestors does", async () => {
    // The search core walks the fork chain itself (it must work inside the
    // worker, over an injected source). Pinning it against the production
    // walker on the same fixture is what stops the two drifting apart.
    const viaCore = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&tier=full`),
    );
    const viaPersistence = loadLogWithAncestors(AGENT, S2);
    // e1, e2 come from s1 (up to but NOT including the edited e3), then s2's own.
    expect(viaPersistence.map((e) => e.id)).toEqual([
      "e1",
      "e2",
      "e6",
      "e7",
      "e8",
      "e9",
      "e10",
    ]);
    expect(viaCore.entries.map((e) => e.entryId)).toEqual(
      viaPersistence.map((e) => e.id),
    );
  });

  it("retrieval survives a fork cycle in sessions.json instead of looping forever", async () => {
    const agent = "agent-logsearch-cycle";
    mkdirSync(join(LOGS_DIR, agent), { recursive: true });
    writeFileSync(
      join(LOGS_DIR, agent, "a.jsonl"),
      JSON.stringify(entry("a1", "text", "in a", 1)) + "\n",
    );
    writeFileSync(
      join(LOGS_DIR, agent, "b.jsonl"),
      JSON.stringify(entry("b1", "text", "in b", 2)) + "\n",
    );
    writeFileSync(
      join(LOGS_DIR, agent, "sessions.json"),
      JSON.stringify({
        a: { topic: null, lastModified: 0, forkedFrom: "b" },
        b: { topic: null, lastModified: 0, forkedFrom: "a" },
      }),
    );
    const res = await retrieveSession(
      source,
      agent,
      "a",
      q("session=a&tier=full"),
    );
    expect(res.entries.map((e) => e.entryId)).toContain("a1");
  });

  it("an all-session scan reports a shared ancestor entry ONCE, not once per branch", async () => {
    // "permission prompt" appears in e1 (user_message, physically in s1). s2 inherits
    // it through reconstruction, so a scan that reconstructed every session
    // would report it twice.
    const res = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(res.totalMatches).toBe(1);
    expect(res.results[0].sessionId).toBe(S1);
    // Each hit carries its session topic; everything fit, so no truncation.
    expect(res.results[0].topic).toBe("permission prompt design");
    expect(res.truncated).toBe(false);
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
    const res = await searchLogs(source, AGENT, q("q=permission+prompt"), scan);
    // e1 (user_message) matches; e4 (thinking) also contains the phrase but is
    // not in the default tier.
    expect(res.results.map((r) => r.entryId)).toEqual(["e1"]);
    // tier=full has no kind filter, so the thinking trace is reached.
    const full = await searchLogs(
      source,
      AGENT,
      q("q=permission+prompt&tier=full"),
      scan,
    );
    expect(full.results.map((r) => r.entryId).sort()).toEqual(["e1", "e4"]);
  });
});

describe("log search: results, ordering and bounds", () => {
  it("returns most recent first", async () => {
    const res = await searchLogs(source, AGENT, q("q=e&tier=full"), scan);
    const stamps = res.results.map((r) => r.timestamp);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
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
    // timedOut is a separate signal from truncated: conflating the two would
    // tell a caller to narrow their query when the real answer is "ask again".
    expect(res.timedOut).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(res.truncated).toBe(false);

    // A completed scan does know, and says so.
    const done = await searchLogs(source, AGENT, q("q=first+prompt"), scan);
    expect(done.totalMatches).toBe(1);
    expect(done.matchesFoundBeforeTimeout).toBeUndefined();
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
          id: "t-strstamp",
          kind: "text",
          content: "findme string stamp",
          timestamp: "not-a-number",
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
      "t-strstamp",
    ]);
    for (const r of all.results) {
      expect(ALL_KINDS).toContain(r.kind);
      expect(Number.isFinite(r.timestamp)).toBe(true);
    }

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
    expect(before.results.map((r) => r.entryId).sort()).toEqual([
      "t-nostamp",
      "t-strstamp",
    ]);

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
      "t-strstamp",
    ]);
    for (const e of got.entries) {
      expect(typeof e.content).toBe("string");
      expect(Number.isFinite(e.timestamp)).toBe(true);
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
});

describe("log search: regex mode", () => {
  it("matches a regular expression, and never through the raw-line prefilter", async () => {
    // Plain ASCII, so a prefilter would look for the literal "perm.ssion" on
    // the raw line and skip every entry.
    const res = await searchLogs(
      source,
      AGENT,
      q(`q=${encodeURIComponent("perm.ssion")}&regex=1`),
      scan,
    );
    expect(res.results.map((r) => r.entryId)).toEqual(["e1"]);
    expect(res.regex).toBe(true);
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

  it("tier=prompts returns only user messages, tier=full everything", async () => {
    const prompts = await retrieveSession(
      source,
      AGENT,
      S2,
      q(`session=${S2}&tier=prompts`),
    );
    expect(prompts.entries.map((e) => e.entryId)).toEqual(["e1", "e6"]);
    const full = await retrieveSession(
      source,
      AGENT,
      S1,
      q(`session=${S1}&tier=full`),
    );
    expect(full.entries.map((e) => e.entryId)).toEqual([
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
      topic: "permission prompt design",
      branched: true,
    });
  });

  it("an agent with no log directory lists nothing", async () => {
    // A spawned agent before its first session has no directory at all.
    expect(existsSync(join(LOGS_DIR, MISSING_AGENT))).toBe(false);
    const res = await buildSessionIndex(source, MISSING_AGENT);
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

  it("caps query length, with a tighter cap for regex patterns", () => {
    expect(err(`q=${"a".repeat(MAX_QUERY_LENGTH)}`)).toBe(false);
    expect(err(`q=${"a".repeat(MAX_QUERY_LENGTH + 1)}`)).toBe("query_too_long");
    expect(err(`q=${"a".repeat(MAX_PATTERN_LENGTH + 1)}&regex=1`)).toBe(
      "query_too_long",
    );
    expect(err("q=")).toBe("invalid_q");
  });

  it("rejects an unsafe session id before any path is built from it", () => {
    expect(err("session=../../etc/passwd")).toBe("unknown_session");
    expect(err("session=..")).toBe("unknown_session");
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
    // The index has its own ceiling, and no limit when none is given.
    expect(q("").indexLimit).toBeUndefined();
    expect(q("limit=1000").indexLimit).toBe(1000);
    expect(err("limit=1001")).toBe("invalid_limit");
  });

  it("rejects a malformed tier even when kind= would have overridden it", () => {
    // Every parameter the caller actually sent is validated. Silently dropping
    // a bad one because something else superseded it would teach them the
    // typo was fine.
    expect(err("tier=nope&kind=text")).toBe("invalid_tier");
  });

  it("bounds the around id rather than reflecting an arbitrary string", () => {
    expect(err("around=e1")).toBe("invalid_around");
    expect(err("q=hi&session=s&around=e1")).toBe("invalid_around");
    expect(err(`session=s&around=${"x".repeat(200)}`)).toBe("invalid_around");
    expect(err("session=s&around=has%20a%20space")).toBe("invalid_around");
    expect(err("session=s&around=log-123-ab")).toBe(false);
  });
});

describe("log search: the response describes the selection it actually applied", () => {
  it("reports tier:null when kind= overrode the preset", async () => {
    // The self-contradiction this prevents: `tier=full&kind=user_message`
    // answering `tier:"full"` while having excluded tool and thinking entries.
    const res = await searchLogs(
      source,
      AGENT,
      q("q=permission+prompt&tier=full&kind=user_message,thinking"),
      scan,
    );
    expect(res.tier).toBeNull();
    // A comma list is several kinds, and the search applies all of them.
    expect(res.kinds).toEqual(["user_message", "thinking"]);
    expect(res.results.map((r) => r.entryId).sort()).toEqual(["e1", "e4"]);
    // tier=full reports kinds:null, meaning no filter at all.
    const full = await searchLogs(
      source,
      AGENT,
      q("q=permission+prompt&tier=full"),
      scan,
    );
    expect(full.tier).toBe("full");
    expect(full.kinds).toBeNull();
  });

  it("retrieval describes its selection the same way", async () => {
    const preset = await retrieveSession(source, AGENT, S1, q(`session=${S1}`));
    expect(preset.tier).toBe("conversation");
    expect(preset.kinds).toEqual([
      "user_message",
      "text",
      "api_token_outbound",
      "agent_outbound",
    ]);
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

// Conversation summaries (task ac41c60e). A session's paragraph and topic are
// searchable and come back as summaryHits, apart from the entry hits; the
// index pages with limit= and a before= cursor; retrieval carries the
// paragraph.
describe("log summaries: search, index and retrieval", () => {
  const SUM_AGENT = "agent-logsearch-summary";
  const META: Record<string, Record<string, unknown>> = {
    a: {
      topic: "Alpha work",
      lastModified: 1_000,
      summary:
        "We fixed the QUINCE importer in server/quince.ts for task 1234abcd.",
    },
    b: { topic: "Quince follow-up", lastModified: 2_000 },
    c: {
      topic: "Unrelated",
      lastModified: 3_000,
      summary: "Nothing here about that fruit.",
    },
    d: {
      topic: "Other",
      lastModified: 4_000,
      summary: "The quince again, now in the export.",
    },
    // Untrusted file content: a summary of the wrong type is ignored, never
    // matched or echoed.
    e: { topic: "Broken record", lastModified: 5_000, summary: 42 },
  };

  beforeAll(() => {
    const dir = join(LOGS_DIR, SUM_AGENT);
    mkdirSync(dir, { recursive: true });
    for (const id of Object.keys(META))
      writeFileSync(
        join(dir, `${id}.jsonl`),
        JSON.stringify({
          id: `${id}-1`,
          agentId: SUM_AGENT,
          kind: "user_message",
          content: `plain message in ${id}`,
          timestamp: 10,
        }) + "\n",
      );
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(META));
  });

  const search = (qs: string) => searchLogs(source, SUM_AGENT, q(qs), scan);
  const hitIds = (res: Awaited<ReturnType<typeof search>>) =>
    res.summaryHits.map((h) => h.sessionId);

  it("matches paragraphs and topics, newest first, apart from the entry hits", async () => {
    const res = await search("q=quince");
    expect(res.results).toEqual([]);
    expect(hitIds(res)).toEqual(["d", "b", "a"]);
    const [d, b, a] = res.summaryHits;
    expect(d).toMatchObject({ topic: "Other", lastModified: 4_000 });
    expect(d.snippet).toContain("quince again");
    // A paragraph hit is cut around the match, like an entry snippet.
    expect(a.snippet).toContain("QUINCE importer");
    // A topic-only hit shows the topic.
    expect(b.snippet).toBe("Quince follow-up");
  });

  it("applies regex, session, limit, before and after; a kind filter does not narrow it", async () => {
    expect(hitIds(await search("q=quince%5Cs%2Bagain&regex=1"))).toEqual(["d"]);
    expect(hitIds(await search("q=quince&session=a"))).toEqual(["a"]);
    expect(hitIds(await search("q=quince&limit=2"))).toEqual(["d", "b"]);
    // Inclusive on both ends, like the entry hits.
    expect(hitIds(await search("q=quince&after=2000&before=4000"))).toEqual([
      "d",
      "b",
    ]);
    expect(hitIds(await search("q=quince&kind=tool_call"))).toEqual([
      "d",
      "b",
      "a",
    ]);
  });

  it("ignores a stored paragraph of the wrong type", async () => {
    expect(hitIds(await search("q=42"))).toEqual([]);
    const index = await buildSessionIndex(source, SUM_AGENT);
    const e = index.sessions.find((s) => s.sessionId === "e");
    expect(e && "summary" in e).toBe(false);
  });

  it("the index carries each paragraph, and no key for a session without one", async () => {
    const res = await buildSessionIndex(source, SUM_AGENT);
    expect(res.sessions.map((s) => s.sessionId)).toEqual([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
    expect(res.truncated).toBe(false);
    const byId = new Map(res.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("a")?.summary).toBe(META.a.summary as string);
    expect(byId.has("b") && "summary" in byId.get("b")!).toBe(false);
  });

  it("retrieval carries the session's paragraph, and no key without one", async () => {
    const a = await retrieveSession(source, SUM_AGENT, "a", q("session=a"));
    expect(a.summary).toBe(META.a.summary as string);
    const b = await retrieveSession(source, SUM_AGENT, "b", q("session=b"));
    expect("summary" in b).toBe(false);
  });
});

describe("log index: pages", () => {
  const PAGE_AGENT = "agent-logsearch-pages";
  const COUNT = 25;
  // Newest first: s24 (lastModified 24_000) down to s00 (0).
  const all = Array.from(
    { length: COUNT },
    (_, i) => `s${String(COUNT - 1 - i).padStart(2, "0")}`,
  );

  beforeAll(() => {
    const dir = join(LOGS_DIR, PAGE_AGENT);
    mkdirSync(dir, { recursive: true });
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < COUNT; i++) {
      const id = `s${String(i).padStart(2, "0")}`;
      writeFileSync(join(dir, `${id}.jsonl`), "");
      meta[id] = { topic: id, lastModified: i * 1_000 };
    }
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(meta));
  });

  const ids = (res: { sessions: { sessionId: string }[] }) =>
    res.sessions.map((s) => s.sessionId);

  it("pages newest first with limit and a before cursor, and says when it cut", async () => {
    const seen: string[] = [];
    let before: number | undefined;
    const truncatedFlags: boolean[] = [];
    for (let page = 0; page < 3; page++) {
      const res = await buildSessionIndex(source, PAGE_AGENT, {
        limit: 10,
        before,
      });
      seen.push(...ids(res));
      truncatedFlags.push(res.truncated);
      before = res.sessions.at(-1)?.lastModified;
    }
    expect(seen).toEqual(all);
    expect(truncatedFlags).toEqual([true, true, false]);
    // A cursor without a limit lists every older session.
    const older = await buildSessionIndex(source, PAGE_AGENT, {
      before: 20_000,
    });
    expect(ids(older)).toEqual(all.slice(5));
    expect(older.truncated).toBe(false);
  });
});

// Compressed transcripts (task e9776386). The conversation-history routes and
// the search child read through fileLogSource; a session the storage panel
// gzipped must index, retrieve and search exactly like its plain twin.
describe("log search: compressed transcripts read the same", () => {
  const ZIP = "agent-logsearch-gzipped";

  beforeAll(() => {
    const dir = join(LOGS_DIR, ZIP);
    mkdirSync(dir, { recursive: true });
    for (const [sid, entries] of [
      [S1, S1_ENTRIES],
      [S2, S2_ENTRIES],
    ] as const) {
      writeFileSync(
        join(dir, `${sid}.jsonl.gz`),
        Bun.gzipSync(entries.map((e) => JSON.stringify(e)).join("\n") + "\n"),
      );
    }
    writeFileSync(
      join(dir, "sessions.json"),
      readFileSync(join(LOGS_DIR, AGENT, "sessions.json")),
    );
    // No sessions.json entry: only the file time can place it.
    const untracked = join(dir, "untracked.jsonl.gz");
    writeFileSync(
      untracked,
      Bun.gzipSync(JSON.stringify(entry("u1", "text", "loose", 1)) + "\n"),
    );
    utimesSync(untracked, 1_700_000_000, 1_700_000_000);
  });

  it("indexes the same sessions, and dates an untracked one by its file", async () => {
    const plain = await buildSessionIndex(source, AGENT);
    const zipped = await buildSessionIndex(source, ZIP);
    const tracked = zipped.sessions.filter((s) => s.sessionId !== "untracked");
    expect(tracked).toEqual(plain.sessions);
    expect(
      zipped.sessions.find((s) => s.sessionId === "untracked")?.lastModified,
    ).toBe(1_700_000_000_000);
  });

  it("retrieves the same fork timeline", async () => {
    const query = q(`session=${S2}&tier=full`);
    const plain = await retrieveSession(source, AGENT, S2, query);
    const zipped = await retrieveSession(source, ZIP, S2, query);
    // e1/e2 come out of the compressed ancestor, e6.. out of the compressed fork.
    expect(zipped.entries.map((e) => e.entryId).slice(0, 3)).toEqual([
      "e1",
      "e2",
      "e6",
    ]);
    expect(zipped.entries).toEqual(plain.entries);
  });

  it("finds the same hits, through the raw-line prefilter and without it", async () => {
    for (const query of [
      "q=permission+prompt&tier=full",
      `q=${encodeURIComponent("café")}`,
    ]) {
      const plain = await searchLogs(source, AGENT, q(query), scan);
      const zipped = await searchLogs(source, ZIP, q(query), scan);
      expect(zipped.totalMatches).toBeGreaterThan(0);
      expect(zipped.results).toEqual(plain.results);
    }
  });
});

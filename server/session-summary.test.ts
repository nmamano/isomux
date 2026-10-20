// Conversation summaries (task ac41c60e, internal-docs/conversation-summary-design.md):
// the write loop, driven through createSessionSummarizer with a fake model and
// an in-memory session. The pure helpers are covered through it: what reaches
// the model and what gets stored is the contract, not the helpers' shapes.
//
// The fake persist moves the stored state the way persistSessionSummary does,
// so a later write reads the marker the earlier one stored.

import { afterEach, describe, expect, it } from "bun:test";
import type { LogEntry } from "../shared/types.ts";
import { setSecretValuesForRedaction } from "./log-redaction.ts";
import {
  SUMMARY_CHUNK_CHARS,
  SUMMARY_ENTRY_CAP,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_ENTRIES,
  SUMMARY_RETRY_BASE_MS,
  SUMMARY_RETRY_MAX_MS,
  createSessionSummarizer,
  type SessionSummaryState,
  type SessionSummaryWrite,
  type SummaryPrompt,
} from "./session-summary.ts";

const AGENT = "agent-summary";
const SESSION = "session-summary";
const START = 1_800_000_000_000;

afterEach(() => setSecretValuesForRedaction([]));

function entry(id: string, kind: LogEntry["kind"], content: string): LogEntry {
  return { id, agentId: AGENT, kind, content, timestamp: 0 };
}

// `n` conversation entries, user and assistant in turn, each tagged with a
// unique padded marker so "ENTRY-001" is never a substring of another.
function conversation(n: number, from = 0, body = ""): LogEntry[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const tag = `ENTRY-${String(i).padStart(3, "0")}`;
    return entry(
      `c${i}`,
      i % 2 === 0 ? "user_message" : "text",
      `${tag}: ${body}`,
    );
  });
}

type Reply = string | null | Error | (() => Promise<string | null>);

function rig(
  opts: {
    entries?: LogEntry[];
    state?: SessionSummaryState | null;
    replies?: Reply[];
    persistResult?: boolean;
  } = {},
) {
  const file: LogEntry[] = [...(opts.entries ?? [])];
  let state: SessionSummaryState | null = opts.state ?? null;
  const writes: SessionSummaryWrite[] = [];
  const prompts: SummaryPrompt[] = [];
  const replies = [...(opts.replies ?? [])];
  let key: string | null = "claude:sonnet";
  let now = START;
  let running = 0;
  let maxRunning = 0;
  let loadEntriesError: Error | null = null;
  const summarizer = createSessionSummarizer({
    loadEntries: async (agentId, sessionId) => {
      expect([agentId, sessionId]).toEqual([AGENT, SESSION]);
      if (loadEntriesError) throw loadEntriesError;
      return [...file];
    },
    loadState: () => state,
    persist: (agentId, sessionId, write) => {
      expect([agentId, sessionId]).toEqual([AGENT, SESSION]);
      if (opts.persistResult === false) return false;
      writes.push(write);
      state = { summary: write.summary, throughEntryId: write.throughEntryId };
      return true;
    },
    backoffKey: () => key,
    summarize: async (_agentId, prompt) => {
      prompts.push(prompt);
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        const reply = replies.shift();
        if (reply === undefined) return `Paragraph ${prompts.length}`;
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? await reply() : reply;
      } finally {
        running--;
      }
    },
    isAuthError: (_agentId, message) => message.includes("AUTH-FAILURE"),
    now: () => now,
    logError: () => {},
  });
  return {
    file,
    writes,
    prompts,
    trigger: () => summarizer.trigger(AGENT, SESSION),
    setKey: (k: string | null) => (key = k),
    at: (ms: number) => (now = START + ms),
    maxRunning: () => maxRunning,
    failLoad: (err: Error | null) => (loadEntriesError = err),
  };
}

function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((res) => (resolve = res));
  return { reply: () => promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(1);
  expect(check()).toBe(true);
}

const text = (p: SummaryPrompt) => `${p.systemPrompt}\n${p.prompt}`;

describe("conversation summary: what one write reads and stores", () => {
  it("reads only conversation entries and stores the marker of the last one it covered", async () => {
    const r = rig({
      entries: [
        entry("u1", "user_message", "QUINCE-1 please look"),
        entry("x1", "tool_call", "TOOLNOISE-1"),
        entry("t1", "text", "QUINCE-2 looked"),
        entry("h1", "thinking", "THINKNOISE-1"),
        entry("r1", "tool_result", "TOOLNOISE-2"),
        entry("o1", "api_token_outbound", "QUINCE-3 sent to a token"),
        entry("o2", "agent_outbound", "QUINCE-5 sent to an agent"),
        entry("u2", "user_message", "QUINCE-4 next"),
        entry("r2", "tool_result", "TOOLNOISE-3"),
      ],
      replies: ["  A paragraph about QUINCE.  \n"],
    });
    r.at(5_000);
    await r.trigger();

    expect(r.prompts).toHaveLength(1);
    const input = text(r.prompts[0]);
    for (const m of [
      "QUINCE-1",
      "QUINCE-2",
      "QUINCE-3",
      "QUINCE-4",
      "QUINCE-5",
    ])
      expect(input).toContain(m);
    for (const m of ["TOOLNOISE-1", "TOOLNOISE-2", "TOOLNOISE-3", "THINKNOISE"])
      expect(input).not.toContain(m);
    expect(r.writes).toEqual([
      {
        summary: "A paragraph about QUINCE.",
        throughEntryId: "u2",
        at: START + 5_000,
      },
    ]);
  });

  it("writes nothing below the minimum of conversation entries, however long the log", async () => {
    const r = rig({
      entries: [
        ...conversation(SUMMARY_MIN_ENTRIES - 1),
        ...Array.from({ length: 30 }, (_, i) =>
          entry(`x${i}`, "tool_result", `noise ${i}`),
        ),
      ],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(0);
    expect(r.writes).toHaveLength(0);

    // One more conversation entry reaches the minimum.
    r.file.push(...conversation(1, SUMMARY_MIN_ENTRIES - 1));
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    expect(r.writes).toHaveLength(1);
  });

  it("a later write reads the previous paragraph and only the entries after the marker", async () => {
    const r = rig({ entries: conversation(6), replies: ["FIRST-PARAGRAPH"] });
    await r.trigger();
    expect(r.writes.map((w) => w.throughEntryId)).toEqual(["c5"]);

    // Nothing new after the marker: no call.
    await r.trigger();
    expect(r.prompts).toHaveLength(1);

    r.file.push(...conversation(2, 6));
    await r.trigger();
    expect(r.prompts).toHaveLength(2);
    const input = text(r.prompts[1]);
    expect(input).toContain("FIRST-PARAGRAPH");
    expect(input).toContain("ENTRY-006");
    expect(input).toContain("ENTRY-007");
    for (let i = 0; i <= 5; i++) expect(input).not.toContain(`ENTRY-00${i}`);
    expect(r.writes.map((w) => w.throughEntryId)).toEqual(["c5", "c7"]);
  });

  it("a marker missing from the file makes every entry new and keeps the previous paragraph", async () => {
    const r = rig({
      entries: conversation(5),
      state: { summary: "PREVIOUS-PARAGRAPH", throughEntryId: "trimmed-away" },
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    const input = text(r.prompts[0]);
    expect(input).toContain("PREVIOUS-PARAGRAPH");
    for (let i = 0; i < 5; i++) expect(input).toContain(`ENTRY-00${i}`);
    expect(r.writes.map((w) => w.throughEntryId)).toEqual(["c4"]);
  });

  it("cuts a long entry to the cap and keeps its head and tail", async () => {
    const long = `HEAD-MARK ${"x".repeat(50_000)} TAIL-MARK`;
    const r = rig({
      entries: [...conversation(3), entry("big", "text", long)],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    const input = text(r.prompts[0]);
    expect(input).toContain("HEAD-MARK");
    expect(input).toContain("TAIL-MARK");
    // Three short entries, one capped entry and the prompt's own text.
    expect(input.length).toBeLessThan(SUMMARY_ENTRY_CAP + 10_000);
  });

  it("stores the reply redacted and capped, and stores nothing for an empty reply", async () => {
    const secret = "quince-secret-value-123456";
    setSecretValuesForRedaction([secret]);
    const r = rig({
      entries: conversation(4),
      replies: [`Uses ${secret} for the import.`],
    });
    await r.trigger();
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].summary).not.toContain(secret);
    expect(r.writes[0].summary).toContain("for the import.");

    const long = rig({
      entries: conversation(4),
      replies: ["w".repeat(5_000)],
    });
    await long.trigger();
    expect(long.writes).toHaveLength(1);
    expect(long.writes[0].summary.length).toBeGreaterThan(0);
    expect(long.writes[0].summary.length).toBeLessThanOrEqual(
      SUMMARY_MAX_CHARS,
    );

    const empty = rig({ entries: conversation(4), replies: ["  \n "] });
    await empty.trigger();
    expect(empty.prompts).toHaveLength(1);
    expect(empty.writes).toHaveLength(0);
  });
});

describe("conversation summary: a long backlog", () => {
  // 120 entries of about the cap each: more than one chunk holds.
  const backlog = () => conversation(120, 0, "y".repeat(3 * SUMMARY_ENTRY_CAP));
  const tags = Array.from(
    { length: 120 },
    (_, i) => `ENTRY-${String(i).padStart(3, "0")}`,
  );

  it("is written in chunks, oldest first, each a normal write that moves the marker", async () => {
    const r = rig({ entries: backlog(), replies: ["CHUNK-ONE-PARAGRAPH"] });
    await r.trigger();

    expect(r.prompts.length).toBeGreaterThanOrEqual(2);
    expect(r.writes).toHaveLength(r.prompts.length);
    // Every entry reaches exactly one prompt: none dropped, none read twice.
    for (const tag of tags)
      expect(r.prompts.filter((p) => text(p).includes(tag))).toHaveLength(1);
    // Oldest first: the first prompt starts with the first entry, and each
    // write's marker is the newest entry its prompt read.
    expect(text(r.prompts[0])).toContain(tags[0]);
    r.writes.forEach((w, i) => {
      const n = Number(w.throughEntryId.slice(1));
      expect(text(r.prompts[i])).toContain(tags[n]);
      if (n + 1 < tags.length)
        expect(text(r.prompts[i])).not.toContain(tags[n + 1]);
    });
    expect(r.writes.at(-1)?.throughEntryId).toBe("c119");
    // Each chunk reads the paragraph the one before it stored.
    expect(text(r.prompts[1])).toContain("CHUNK-ONE-PARAGRAPH");
    for (const p of r.prompts)
      expect(p.prompt.length).toBeLessThanOrEqual(SUMMARY_CHUNK_CHARS + 10_000);
  });

  it("stops at a dropped write", async () => {
    const r = rig({ entries: backlog(), persistResult: false });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    expect(r.writes).toHaveLength(0);
  });

  it("keeps the chunks already stored when a later chunk fails, and goes on from the marker", async () => {
    const r = rig({
      entries: backlog(),
      replies: ["CHUNK-ONE-PARAGRAPH", new Error("model timed out")],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(2);
    expect(r.writes).toHaveLength(1);
    const marker = Number(r.writes[0].throughEntryId.slice(1));

    r.at(SUMMARY_RETRY_BASE_MS);
    await r.trigger();
    const resumed = text(r.prompts[2]);
    expect(resumed).toContain("CHUNK-ONE-PARAGRAPH");
    expect(resumed).toContain(tags[marker + 1]);
    expect(resumed).not.toContain(tags[marker]);
  });
});

describe("conversation summary: one write per session at a time", () => {
  it("runs a trigger that arrives during a write once after it", async () => {
    const hold = deferred();
    const r = rig({ entries: conversation(4), replies: [hold.reply] });
    const first = r.trigger();
    await waitFor(() => r.prompts.length === 1);

    r.file.push(...conversation(2, 4));
    const second = r.trigger();
    const third = r.trigger();
    await Bun.sleep(20);
    expect(r.prompts).toHaveLength(1);

    hold.resolve("HELD-PARAGRAPH");
    await second;
    // The promise of a queued trigger resolves after the rerun.
    expect(r.prompts).toHaveLength(2);
    await Promise.all([first, third]);
    expect(r.prompts).toHaveLength(2);
    expect(r.maxRunning()).toBe(1);
    expect(text(r.prompts[1])).toContain("ENTRY-005");
    expect(r.writes.map((w) => w.throughEntryId)).toEqual(["c3", "c5"]);
  });

  it("never rejects, even when the entries cannot be read", async () => {
    const r = rig({ entries: conversation(4) });
    r.failLoad(new Error("disk gone"));
    // A rejection would throw here.
    await r.trigger();
    expect(r.writes).toHaveLength(0);

    // The failure did not wedge the session.
    r.failLoad(null);
    await r.trigger();
    expect(r.writes).toHaveLength(1);
  });
});

describe("conversation summary: failure backoff", () => {
  it("waits after a failure for the same model, doubling per failure; a success restarts it", async () => {
    const r = rig({
      entries: conversation(4),
      replies: [
        new Error("timed out"),
        new Error("timed out"),
        "STORED",
        new Error("timed out"),
      ],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);

    r.at(SUMMARY_RETRY_BASE_MS - 1);
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    r.at(SUMMARY_RETRY_BASE_MS);
    await r.trigger();
    expect(r.prompts).toHaveLength(2);

    // The second failure waits twice as long.
    r.at(3 * SUMMARY_RETRY_BASE_MS - 1);
    await r.trigger();
    expect(r.prompts).toHaveLength(2);
    r.at(3 * SUMMARY_RETRY_BASE_MS);
    await r.trigger();
    expect(r.prompts).toHaveLength(3);
    expect(r.writes.map((w) => w.summary)).toEqual(["STORED"]);

    // After the success, a failure waits the base again.
    r.file.push(...conversation(1, 4));
    await r.trigger();
    expect(r.prompts).toHaveLength(4);
    r.at(4 * SUMMARY_RETRY_BASE_MS - 1);
    await r.trigger();
    expect(r.prompts).toHaveLength(4);
    r.at(4 * SUMMARY_RETRY_BASE_MS);
    await r.trigger();
    expect(r.prompts).toHaveLength(5);
  });

  it("caps the wait", async () => {
    const r = rig({
      entries: conversation(4),
      replies: Array.from({ length: 12 }, () => new Error("timed out")),
    });
    // Each try comes a full cap after the last, so every try runs.
    let t = 0;
    for (let i = 0; i < 10; i++) {
      r.at(t);
      await r.trigger();
      t += SUMMARY_RETRY_MAX_MS;
    }
    expect(r.prompts).toHaveLength(10);
    // After ten failures the doubled wait is far past the cap; the cap holds.
    const last = t - SUMMARY_RETRY_MAX_MS;
    r.at(last + SUMMARY_RETRY_MAX_MS - 1);
    await r.trigger();
    expect(r.prompts).toHaveLength(10);
    r.at(last + SUMMARY_RETRY_MAX_MS);
    await r.trigger();
    expect(r.prompts).toHaveLength(11);
  });

  it("does not hold another model back", async () => {
    const r = rig({
      entries: conversation(4),
      replies: [new Error("timed out")],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    r.setKey("claude:opus");
    await r.trigger();
    expect(r.prompts).toHaveLength(2);
    expect(r.writes).toHaveLength(1);
  });

  it("an auth failure or a skipped call stores nothing and starts no wait", async () => {
    const r = rig({
      entries: conversation(4),
      replies: [new Error("AUTH-FAILURE: signed out"), null],
    });
    await r.trigger();
    expect(r.prompts).toHaveLength(1);
    await r.trigger();
    expect(r.prompts).toHaveLength(2);
    expect(r.writes).toHaveLength(0);
    await r.trigger();
    expect(r.prompts).toHaveLength(3);
    expect(r.writes).toHaveLength(1);
  });

  it("does not call the model for an agent that cannot summarize", async () => {
    const r = rig({ entries: conversation(4) });
    r.setKey(null);
    await r.trigger();
    expect(r.prompts).toHaveLength(0);
    expect(r.writes).toHaveLength(0);
    r.setKey("claude:sonnet");
    await r.trigger();
    expect(r.writes).toHaveLength(1);
  });
});

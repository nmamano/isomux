// isomux-memory storage — T0 unit tests. Raw one-fact-per-line markdown + the
// injectable store against a temp dir with deterministic date/timestamp. No
// server, no LLM, no network. See server/memory-store.ts.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatMemoryLine,
  parseMemoryLine,
  createMemoryStore,
  isSafeScopeId,
  normalizeForDedup,
  isExactDuplicateText,
  versionOf,
  MEMORY_CAPS,
  OVER_CAP_NOTICE,
  renderCapped,
  type OpLogEntry,
} from "../memory-store.ts";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "isomux-mem-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DATE = "2026-06-28";
const TS = "2026-06-28T12:00:00.000Z";
function freshStore(opts?: { caps?: Record<string, number> }) {
  const root = tempRoot();
  const store = createMemoryStore({
    stateRoot: root,
    today: () => DATE,
    now: () => TS,
    caps: opts?.caps as
      | Record<"office" | "room" | "agent" | "boss", number>
      | undefined,
  });
  return { root, store };
}
function opLog(root: string): OpLogEntry[] {
  const path = join(root, "memory", ".oplog.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OpLogEntry);
}

describe("memory-store: format/parse", () => {
  it("formatMemoryLine renders the raw bullet shape", () => {
    expect(
      formatMemoryLine({
        author: "Isomuxer3",
        date: "2026-06-28",
        text: "no em dashes in prose",
      }),
    ).toBe("- Isomuxer3, 2026-06-28: no em dashes in prose");
  });

  it("parseMemoryLine round-trips a formatted line", () => {
    const raw = formatMemoryLine({
      author: "Bot",
      date: "2026-06-28",
      text: "a fact",
    });
    const item = parseMemoryLine(raw, "office", null);
    expect(item).toEqual({
      scope: "office",
      scopeId: null,
      author: "Bot",
      date: "2026-06-28",
      text: "a fact",
      raw,
    });
  });

  it("parseMemoryLine tolerates a comma in the author (date is the anchor)", () => {
    const item = parseMemoryLine(
      "- Dr. No, Esq., 2026-06-28: spies are durable",
      "agent",
      "a1",
    );
    expect(item?.author).toBe("Dr. No, Esq.");
    expect(item?.text).toBe("spies are durable");
  });

  it("parseMemoryLine returns null for free-form / non-matching lines", () => {
    expect(parseMemoryLine("just some prose", "office", null)).toBeNull();
    expect(parseMemoryLine("", "office", null)).toBeNull();
    // old id-tagged format no longer parses (treated as raw text)
    expect(
      parseMemoryLine(
        "- <!-- mem:ab12cd --> [X, 2026-06-28] y",
        "office",
        null,
      ),
    ).toBeNull();
  });
});

describe("memory-store: version", () => {
  it("is deterministic and 12 hex chars", () => {
    const v = versionOf("hello\n");
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(versionOf("hello\n")).toBe(v);
  });
  it("empty content hashes to a fixed sentinel; different content differs", () => {
    expect(versionOf("")).toBe(versionOf(""));
    expect(versionOf("a")).not.toBe(versionOf("b"));
    // same length, different bytes still differ (sha, not size)
    expect(versionOf("ab")).not.toBe(versionOf("ba"));
  });
});

describe("memory-store: dedup helpers", () => {
  it("normalizeForDedup trims, lowercases, collapses ws, strips terminal punct", () => {
    expect(normalizeForDedup("  Hello   World!! ")).toBe("hello world");
    // internal punctuation survives
    expect(normalizeForDedup("use ~/isomux-active.")).toBe(
      "use ~/isomux-active",
    );
  });
  it("isExactDuplicateText matches normalized restatements, not rewords", () => {
    expect(isExactDuplicateText("Foo bar.", "foo  bar")).toBe(true);
    expect(isExactDuplicateText("foo bar baz", "foo bar")).toBe(false);
  });
});

describe("memory-store: caps", () => {
  it("MEMORY_CAPS are the Nil-set values", () => {
    expect(MEMORY_CAPS).toEqual({
      office: 2500,
      room: 3500,
      agent: 5000,
      boss: 5000,
    });
  });
  it("renderCapped: under cap returns all; over cap keeps newest + notice", () => {
    const lines = ["- a", "- b", "- c"];
    expect(renderCapped(lines, 100)).toBe("- a\n- b\n- c");
    // tiny cap: only the newest line(s) that fit survive, in file order
    const capped = renderCapped(lines, 4);
    expect(capped).toBe(`- c\n${OVER_CAP_NOTICE}`);
  });
  it("renderCapped: a single line longer than the cap yields the notice alone", () => {
    expect(renderCapped(["- way too long for the cap"], 5)).toBe(
      OVER_CAP_NOTICE,
    );
  });
});

describe("memory-store: isSafeScopeId", () => {
  it("accepts identifiers, rejects traversal/slashes", () => {
    expect(isSafeScopeId("room-1_A")).toBe(true);
    expect(isSafeScopeId("../etc")).toBe(false);
    expect(isSafeScopeId("a/b")).toBe(false);
    expect(isSafeScopeId("")).toBe(false);
  });
});

describe("memory-store: append", () => {
  it("writes a server-stamped raw line and bumps the version", () => {
    const { root, store } = freshStore();
    const before = store.read("agent", "a1");
    expect(before).toEqual({ text: "", version: versionOf("") });

    const res = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Bot",
      text: "a durable fact",
    });
    expect(res.item.raw).toBe("- Bot, 2026-06-28: a durable fact");
    const after = store.read("agent", "a1");
    expect(after.text).toBe("- Bot, 2026-06-28: a durable fact\n");
    expect(after.version).toBe(res.version);
    expect(after.version).not.toBe(before.version);
    void root;
  });

  it("logs an append op with server-stamped actor + post-op content", () => {
    const { root, store } = freshStore();
    store.append({ scope: "office", scopeId: null, author: "Nil", text: "x" });
    const log = opLog(root);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      ts: TS,
      actor: "Nil",
      scope: "office",
      scopeId: null,
      op: "append",
      text: "x",
      content: "- Nil, 2026-06-28: x\n",
    });
    expect(log[0].version).toBe(store.read("office", null).version);
  });

  it("findDuplicate matches an exact active restatement, not a reword", () => {
    const { store } = freshStore();
    store.append({
      scope: "room",
      scopeId: "r1",
      author: "A",
      text: "Deploys at 9.",
    });
    expect(store.findDuplicate("room", "r1", "deploys at 9")).not.toBeNull();
    expect(store.findDuplicate("room", "r1", "deploys at 09:00")).toBeNull();
    // per-scope: same text in another scope is not a dup
    expect(store.findDuplicate("office", null, "deploys at 9")).toBeNull();
  });
});

describe("memory-store: replace", () => {
  it("overwrites with the correct version and returns the new version", () => {
    const { root, store } = freshStore();
    store.append({ scope: "agent", scopeId: "a1", author: "Bot", text: "one" });
    const { version } = store.read("agent", "a1");
    const res = store.replace({
      scope: "agent",
      scopeId: "a1",
      text: "- hand-edited line\n- another\n",
      author: "Nil",
      expectedVersion: version,
    });
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.version).toBe(versionOf("- hand-edited line\n- another\n"));
    expect(store.read("agent", "a1").text).toBe(
      "- hand-edited line\n- another\n",
    );
    const log = opLog(root);
    expect(log[log.length - 1]).toMatchObject({
      op: "replace",
      actor: "Nil",
      text: "(full rewrite)",
      previousVersion: version,
    });
  });

  it("rejects a stale version (409-equivalent) and writes nothing", () => {
    const { store } = freshStore();
    store.append({ scope: "agent", scopeId: "a1", author: "Bot", text: "one" });
    const original = store.read("agent", "a1");
    const res = store.replace({
      scope: "agent",
      scopeId: "a1",
      text: "clobber",
      author: "Bot",
      expectedVersion: "deadbeef0000",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.version).toBe(original.version);
    // file unchanged
    expect(store.read("agent", "a1").text).toBe(original.text);
  });

  it("force-overwrites when expectedVersion is omitted (curation save)", () => {
    const { store } = freshStore();
    store.append({
      scope: "office",
      scopeId: null,
      author: "Bot",
      text: "one",
    });
    const res = store.replace({
      scope: "office",
      scopeId: null,
      text: "- curated\n",
      author: "Nil",
    });
    expect(res.ok).toBe(true);
    expect(store.read("office", null).text).toBe("- curated\n");
  });

  it("writes raw text verbatim; empty text clears the file", () => {
    const { store } = freshStore();
    store.replace({
      scope: "room",
      scopeId: "r1",
      text: "anything\ngoes here",
      author: "Nil",
    });
    expect(store.read("room", "r1").text).toBe("anything\ngoes here");
    const v = store.read("room", "r1").version;
    store.replace({
      scope: "room",
      scopeId: "r1",
      text: "",
      author: "Nil",
      expectedVersion: v,
    });
    expect(store.read("room", "r1").text).toBe("");
  });
});

describe("memory-store: render for prompt", () => {
  it("joins non-empty lines, null when empty", () => {
    const { store } = freshStore();
    expect(store.renderForPrompt("agent", "a1")).toBeNull();
    store.append({ scope: "agent", scopeId: "a1", author: "Bot", text: "one" });
    store.append({ scope: "agent", scopeId: "a1", author: "Bot", text: "two" });
    expect(store.renderForPrompt("agent", "a1")).toBe(
      "- Bot, 2026-06-28: one\n- Bot, 2026-06-28: two",
    );
  });

  it("applies the per-scope cap (newest-first) with the notice", () => {
    const { store } = freshStore({
      caps: { office: 30, room: 30, agent: 30, boss: 30 },
    });
    store.append({
      scope: "office",
      scopeId: null,
      author: "A",
      text: "oldest",
    });
    store.append({
      scope: "office",
      scopeId: null,
      author: "A",
      text: "newest",
    });
    const out = store.renderForPrompt("office", null)!;
    expect(out).toContain("newest");
    expect(out).toContain(OVER_CAP_NOTICE);
  });

  it("renderForPromptMulti labels each non-empty scope and skips empties", () => {
    const { store } = freshStore();
    store.append({ scope: "office", scopeId: null, author: "A", text: "o" });
    store.append({ scope: "agent", scopeId: "a1", author: "B", text: "g" });
    const out = store.renderForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      { scope: "room", scopeId: "r1", label: 'Room "X"' }, // empty -> skipped
      { scope: "agent", scopeId: "a1", label: "Your agent" },
    ]);
    expect(out).toBe(
      "Office-wide:\n- A, 2026-06-28: o\n\nYour agent:\n- B, 2026-06-28: g",
    );
    expect(
      store.renderForPromptMulti([
        { scope: "room", scopeId: "r9", label: "X" },
      ]),
    ).toBeNull();
  });
});

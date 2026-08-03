// isomux-memory storage - T0 unit tests. Raw one-fact-per-line markdown + the
// injectable store against a temp dir with deterministic date/timestamp. No
// server, no LLM, no network. See server/memory-store.ts.

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs";
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
  MemoryCapError,
  injectedSize,
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

  // The author-less shape (task f9d2bbac): an agent's note to its own scope.
  it("formatMemoryLine drops the author when it is null", () => {
    expect(
      formatMemoryLine({
        author: null,
        date: "2026-06-28",
        text: "no em dashes in prose",
      }),
    ).toBe("- 2026-06-28: no em dashes in prose");
  });

  it("parseMemoryLine round-trips an author-less line", () => {
    const raw = formatMemoryLine({
      author: null,
      date: "2026-06-28",
      text: "a fact",
    });
    expect(parseMemoryLine(raw, "agent", "a1")).toEqual({
      scope: "agent",
      scopeId: "a1",
      author: null,
      date: "2026-06-28",
      text: "a fact",
      raw,
    });
  });

  // Both shapes coexist in one file: existing memory across deployments keeps
  // its author stamp and has to keep parsing next to new self-notes.
  it("parseMemoryLine handles both shapes in the same scope", () => {
    expect(
      parseMemoryLine("- Bot, 2026-06-28: named", "agent", "a1")?.author,
    ).toBe("Bot");
    expect(
      parseMemoryLine("- 2026-06-28: unnamed", "agent", "a1")?.author,
    ).toBeNull();
  });

  // The reason the parser tries authorless FIRST instead of using one regex with
  // an optional author group: a greedy optional group fills itself off a comma
  // inside the TEXT, inventing an author out of the line's own body.
  it("parseMemoryLine does not invent an author from a comma+date inside the text", () => {
    const item = parseMemoryLine(
      "- 2026-06-28: shipped, 2026-07-01: done",
      "agent",
      "a1",
    );
    expect(item?.author).toBeNull();
    expect(item?.date).toBe("2026-06-28");
    expect(item?.text).toBe("shipped, 2026-07-01: done");
  });

  it("parseMemoryLine keeps an author that itself looks like a date", () => {
    const item = parseMemoryLine(
      "- 2026-06-28, 2026-07-01: odd but authored",
      "office",
      null,
    );
    expect(item?.author).toBe("2026-06-28");
    expect(item?.date).toBe("2026-07-01");
  });

  it("parseMemoryLine trims trailing whitespace on both shapes", () => {
    expect(
      parseMemoryLine("- 2026-06-28: a fact   ", "agent", "a1"),
    ).toMatchObject({
      author: null,
      text: "a fact",
      raw: "- 2026-06-28: a fact",
    });
    expect(
      parseMemoryLine("- Bot, 2026-06-28: a fact  ", "agent", "a1"),
    ).toMatchObject({
      author: "Bot",
      text: "a fact",
      raw: "- Bot, 2026-06-28: a fact",
    });
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
      room: 10000,
      agent: 5000,
      boss: 5000,
    });
  });
  it("injectedSize: counts non-empty lines joined, as the prompt renders them", () => {
    expect(injectedSize("- a\n- b\n- c")).toBe(11);
    expect(injectedSize("- a\n\n\n- b\n")).toBe(7); // blank lines don't count
    expect(injectedSize("")).toBe(0);
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

  // authorAgentId is what makes a line a self-note. The store owns the rule, so
  // these pin it at the store seam rather than only through the route.
  it("drops the author when the caller is the agent scope's own agent", () => {
    const { store } = freshStore();
    const res = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Bot",
      authorAgentId: "a1",
      text: "a durable fact",
    });
    expect(res.item.raw).toBe("- 2026-06-28: a durable fact");
    expect(res.item.author).toBeNull();
    expect(store.read("agent", "a1").text).toBe(
      "- 2026-06-28: a durable fact\n",
    );
  });

  it("keeps the author for every writer that is not the scope's own agent", () => {
    const { store } = freshStore();
    // another agent -> named
    expect(
      store.append({
        scope: "agent",
        scopeId: "a1",
        author: "Other",
        authorAgentId: "a2",
        text: "one",
      }).item.raw,
    ).toBe("- Other, 2026-06-28: one");
    // a human (no agentId at all) -> named
    expect(
      store.append({
        scope: "agent",
        scopeId: "a1",
        author: "Nil",
        authorAgentId: null,
        text: "two",
      }).item.raw,
    ).toBe("- Nil, 2026-06-28: two");
    // the same agent writing to a NON-agent scope -> named
    expect(
      store.append({
        scope: "room",
        scopeId: "a1",
        author: "Bot",
        authorAgentId: "a1",
        text: "three",
      }).item.raw,
    ).toBe("- Bot, 2026-06-28: three");
  });

  // The whole point of task f9d2bbac is cap space, so prove the bytes are
  // actually reclaimed rather than just absent from the rendered line: with a
  // cap that fits exactly one authored line, a self-note leaves room for a
  // second one and the authored form does not.
  it("the dropped author is reclaimed against the scope's hard cap", () => {
    const { store } = freshStore({ caps: { ...MEMORY_CAPS, agent: 60 } });
    // "- 2026-06-28: 0123456789" = 24 chars; authored adds "SomeAgent, " = 11.
    const text = "0123456789";
    const first = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "SomeAgent",
      authorAgentId: "a1",
      text,
    });
    expect(first.item.raw.length).toBe(24);
    // 24 + 1 newline + 24 + 1 = 50 <= 60, so a second self-note fits.
    expect(() =>
      store.append({
        scope: "agent",
        scopeId: "a1",
        author: "SomeAgent",
        authorAgentId: "a1",
        text: "9876543210",
      }),
    ).not.toThrow();
    // The same two lines WITH the author would be 35 + 1 + 35 + 1 = 72 > 60.
    const { store: authored } = freshStore({
      caps: { ...MEMORY_CAPS, agent: 60 },
    });
    authored.append({
      scope: "agent",
      scopeId: "a1",
      author: "SomeAgent",
      authorAgentId: "a2", // not the scope's own agent -> stays named
      text,
    });
    expect(() =>
      authored.append({
        scope: "agent",
        scopeId: "a1",
        author: "SomeAgent",
        authorAgentId: "a2",
        text: "9876543210",
      }),
    ).toThrow(MemoryCapError);
  });

  it("a self-note's op-log actor still names the agent", () => {
    const { root, store } = freshStore();
    store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Bot",
      authorAgentId: "a1",
      text: "x",
    });
    expect(opLog(root)[0]).toMatchObject({
      actor: "Bot",
      op: "append",
      content: "- 2026-06-28: x\n",
    });
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

  it("renders a legacy over-cap scope in FULL - caps never drop lines at render", () => {
    // Write the over-cap file directly, as a legacy file would exist on disk:
    // the write API itself refuses to create this state.
    const { root, store } = freshStore({
      caps: { office: 30, room: 30, agent: 30, boss: 30 },
    });
    const legacy =
      "- A, 2026-01-01: oldest fact kept\n- A, 2026-01-02: newest fact kept\n";
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "office.md"), legacy);
    const out = store.renderForPrompt("office", null)!;
    expect(out).toContain("oldest fact kept");
    expect(out).toContain("newest fact kept");
  });

  it("append refuses a line that would put the scope over its cap", () => {
    const { store } = freshStore({
      caps: { office: 60, room: 60, agent: 60, boss: 60 },
    });
    store.append({ scope: "office", scopeId: null, author: "A", text: "one" });
    let err: unknown;
    try {
      store.append({
        scope: "office",
        scopeId: null,
        author: "A",
        text: "a fact long enough to overflow the tiny cap for sure",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryCapError);
    // and the file was not written
    expect(store.readText("office", null)).not.toContain("overflow");
  });

  it("replace refuses growth over the cap but allows a shrinking trim of a legacy over-cap file", () => {
    const { root, store } = freshStore({
      caps: { office: 30, room: 30, agent: 30, boss: 30 },
    });
    const legacy =
      "- A, 2026-01-01: aaaaaaaaaaaaaaaa\n- A, 2026-01-02: bbbbbbbbbbbbbbbb\n";
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "office.md"), legacy);
    // still over cap but SMALLER: allowed (incremental trim)
    const smaller = "- A, 2026-01-01: aaaaaaaaaaaaaaaa\n- A, 2026-01-02: bbb\n";
    expect(injectedSize(smaller)).toBeGreaterThan(30);
    const res = store.replace({
      scope: "office",
      scopeId: null,
      text: smaller,
      author: "A",
    });
    expect(res.ok).toBe(true);
    // growth over the cap: refused
    let err: unknown;
    try {
      store.replace({
        scope: "office",
        scopeId: null,
        text: smaller + "- A, 2026-01-03: cccccccccccccccc\n",
        author: "A",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryCapError);
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

  it("measureForPromptMulti sizes each non-empty scope against its cap", () => {
    const { store } = freshStore({ caps: { ...MEMORY_CAPS, office: 100 } });
    store.append({ scope: "office", scopeId: null, author: "A", text: "o" });
    store.append({ scope: "agent", scopeId: "a1", author: "B", text: "g" });
    const out = store.measureForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      { scope: "room", scopeId: "r1", label: 'Room "X"' }, // empty -> skipped
      { scope: "agent", scopeId: "a1", label: "Your agent" },
    ]);
    expect(out).toEqual([
      {
        scope: "office",
        label: "Office-wide",
        contentChars: "- A, 2026-06-28: o".length,
        cap: 100,
      },
      {
        scope: "agent",
        label: "Your agent",
        contentChars: "- B, 2026-06-28: g".length,
        cap: MEMORY_CAPS.agent,
      },
    ]);
  });

  it("measureForPromptMulti reports a legacy over-cap scope with fill above its cap", () => {
    // The write API refuses to create this state, so lay the file down
    // directly, as a pre-cap-enforcement legacy file would exist on disk.
    const { root, store } = freshStore({
      caps: { ...MEMORY_CAPS, office: 40 },
    });
    const legacy =
      "- A, 2026-06-28: one\n- A, 2026-06-28: two\n- A, 2026-06-28: three\n";
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "office.md"), legacy);
    const [m] = store.measureForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
    ]);
    expect(m.contentChars).toBeGreaterThan(m.cap);
    // ...and the rendered form still carries everything (no trimming).
    expect(store.renderForPrompt("office", null)).toContain("one");
    expect(store.renderForPrompt("office", null)).toContain("three");
  });
});

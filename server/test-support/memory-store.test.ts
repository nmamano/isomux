import { withAuditContextSync } from "../audit-context.ts";
import type { AuditWrite } from "../audit-store.ts";
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
  createMemoryStore,
  isSafeScopeId,
  versionOf,
  MEMORY_LINE_MAX,
  MemoryCapError,
  injectedSize,
} from "../memory-store.ts";
import { MEMORY_CAPS } from "../../shared/memory-caps.ts";

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
  const audits: AuditWrite[] = [];
  const rawStore = createMemoryStore({
    audit: (entry) => audits.push(entry),
    stateRoot: root,
    today: () => DATE,
    now: () => TS,
    caps: opts?.caps as
      | Record<"office" | "room" | "agent" | "member", number>
      | undefined,
  });
  const store = {
    ...rawStore,
    append: (input: Parameters<typeof rawStore.append>[0]) =>
      withAuditContextSync(
        {
          kind: input.authorAgentId ? "agent" : "member",
          id: input.authorAgentId ?? "member",
          name: input.author,
        },
        "memory.append",
        () => rawStore.append(input),
      ),
    replace: (input: Parameters<typeof rawStore.replace>[0]) =>
      withAuditContextSync(
        { kind: "member", id: "member", name: input.author },
        "memory.replace",
        () => rawStore.replace(input),
      ),
  };
  return { root, store, audits };
}

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
    expect(res.size).toBe(injectedSize(after.text));
    expect(res.cap).toBe(MEMORY_CAPS.agent);
    void root;
  });

  // The audit target names the scope's file; office memory has no id, so
  // it is named "office" (the audit filter matches on it).
  it("audits each write against its scope's target", () => {
    const { store, audits } = freshStore();
    store.append({ scope: "office", scopeId: null, author: "Nil", text: "x" });
    store.append({ scope: "agent", scopeId: "a1", author: "Nil", text: "y" });
    expect(audits.map((a) => a.targets)).toEqual([
      ["memory:office:office"],
      ["memory:agent:a1"],
    ]);
  });

  it("separates an append from raw REPLACE content without a trailing newline", () => {
    const { store } = freshStore();
    const replaced = "- Nil, 2026-06-27: first fact";
    store.replace({
      scope: "agent",
      scopeId: "a1",
      text: replaced,
      author: "Nil",
      expectedVersion: versionOf(""),
    });
    const res = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Bot",
      text: "second fact",
    });
    const expected = `${replaced}\n- Bot, 2026-06-28: second fact\n`;
    expect(store.read("agent", "a1").text).toBe(expected);
    expect(res.size).toBe(injectedSize(expected));
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

  it("findDuplicate matches an exact active restatement, not a reword", () => {
    const { store } = freshStore();
    store.append({
      scope: "room",
      scopeId: "r1",
      author: "A",
      text: "Deploys at 9.",
    });
    expect(store.findDuplicate("room", "r1", "deploys at 9")).not.toBeNull();
    // Inner whitespace collapses; inner punctuation counts.
    expect(store.findDuplicate("room", "r1", "Deploys   at 9")).not.toBeNull();
    expect(store.findDuplicate("room", "r1", "deploys at 09:00")).toBeNull();
    store.append({
      scope: "room",
      scopeId: "r1",
      author: "A",
      text: "use ~/isomux-active.",
    });
    expect(store.findDuplicate("room", "r1", "use ~/isomuxactive")).toBeNull();
    // per-scope: same text in another scope is not a dup
    expect(store.findDuplicate("office", null, "deploys at 9")).toBeNull();
  });

  it("findDuplicate reads both line shapes, whatever the author or text holds", () => {
    const { store } = freshStore();
    // The date anchors the author, so a comma in it is fine.
    store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Dr. No, Esq.",
      text: "spies are durable",
    });
    // A self-note has no author; a comma and a date in its text do not
    // make one.
    store.append({
      scope: "agent",
      scopeId: "a1",
      author: "Bot",
      authorAgentId: "a1",
      text: "shipped, 2026-07-01: done",
    });
    expect(
      store.findDuplicate("agent", "a1", "spies are durable"),
    ).not.toBeNull();
    expect(
      store.findDuplicate("agent", "a1", "shipped, 2026-07-01: done"),
    ).not.toBeNull();
    expect(store.findDuplicate("agent", "a1", "done")).toBeNull();
  });
});

describe("memory-store: replace", () => {
  it("keeps REPLACE raw-in-raw-out and accepts a line over the APPEND limit", () => {
    const { store } = freshStore();
    const text = "x".repeat(MEMORY_LINE_MAX + 1);
    const res = store.replace({
      scope: "agent",
      scopeId: "a1",
      text,
      author: "Nil",
      expectedVersion: versionOf(""),
    });
    expect(res.ok).toBe(true);
    expect(store.read("agent", "a1").text).toBe(text);
  });
  it("overwrites with the correct version and returns the new version", () => {
    const { store } = freshStore();
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
    // A stale version writes nothing and answers with the CURRENT version,
    // which the client needs for its next try.
    const current = store.read("agent", "a1");
    expect(
      store.replace({
        scope: "agent",
        scopeId: "a1",
        text: "clobber",
        author: "Nil",
        expectedVersion: version,
      }),
    ).toEqual({ ok: false, conflict: true, version: current.version });
    expect(store.read("agent", "a1")).toEqual(current);
    // Empty text clears the file.
    store.replace({
      scope: "agent",
      scopeId: "a1",
      text: "",
      author: "Nil",
      expectedVersion: versionOf("- hand-edited line\n- another\n"),
    });
    expect(store.read("agent", "a1").text).toBe("");
  });

  it("replace refuses growth over the cap but allows a shrinking trim of a legacy over-cap file", () => {
    const { root, store } = freshStore({
      caps: { office: 30, room: 30, agent: 30, member: 30 },
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
      expectedVersion: versionOf(legacy),
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
        expectedVersion: versionOf(smaller),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryCapError);
  });
});

describe("memory-store: render for prompt", () => {
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
it("refuses a memory write without an active actor before creating a file", () => {
  const root = tempRoot();
  const store = createMemoryStore({ stateRoot: root });
  expect(() =>
    store.append({
      scope: "office",
      scopeId: null,
      author: "Untrusted display",
      text: "fact",
    }),
  ).toThrow();
  expect(existsSync(join(root, "memory", "office.md"))).toBe(false);
});
it("preserves a legacy oplog and returns success if the new audit insert fails", () => {
  const root = tempRoot();
  mkdirSync(join(root, "memory"));
  const old = join(root, "memory", ".oplog.jsonl");
  writeFileSync(old, "legacy bytes\n");
  const store = createMemoryStore({
    stateRoot: root,
    audit: () => {
      throw new Error("audit insert failed");
    },
  });
  // The injected writer follows the same best-effort boundary as production.
  withAuditContextSync(
    { kind: "member", id: "u", name: "Member" },
    "memory.append",
    () =>
      store.append({
        scope: "office",
        scopeId: null,
        author: "Member",
        text: "fact",
      }),
  );
  expect(store.read("office", null).text).toContain("fact");
  expect(readFileSync(old, "utf8")).toBe("legacy bytes\n");
});

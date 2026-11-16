import { withAuditContextSync } from "../audit-context.ts";
import type { AuditWrite } from "../audit-store.ts";
import type { AuditActor } from "../../shared/audit.ts";
// isomux-memory storage - T0 unit tests. Raw one-fact-per-line markdown + the
// injectable store against a temp dir with a deterministic timestamp. No
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

const TS = "2026-06-28T12:00:00.000Z";
// The caller lives only in the audit context: the store API takes no author.
const MEMBER: AuditActor = { kind: "member", id: "u1", name: "Nil" };
function freshStore(opts?: { caps?: Record<string, number> }) {
  const root = tempRoot();
  const audits: AuditWrite[] = [];
  const rawStore = createMemoryStore({
    audit: (entry) => audits.push(entry),
    stateRoot: root,
    now: () => TS,
    caps: opts?.caps as
      Record<"office" | "room" | "agent" | "member", number> | undefined,
  });
  const store = {
    ...rawStore,
    append: (
      input: Parameters<typeof rawStore.append>[0],
      actor: AuditActor = MEMBER,
    ) =>
      withAuditContextSync(actor, "memory.append", () =>
        rawStore.append(input),
      ),
    replace: (
      input: Parameters<typeof rawStore.replace>[0],
      actor: AuditActor = MEMBER,
    ) =>
      withAuditContextSync(actor, "memory.replace", () =>
        rawStore.replace(input),
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
  // Task faee4332: the line in context is the rule only. Who wrote it and
  // when lives in the audit row, so no scope and no caller gets a stamp.
  it("writes the text alone as the line in every scope, and bumps the version", () => {
    const scopes = [
      ["office", null],
      ["room", "r1"],
      ["agent", "a1"],
      ["member", "u1"],
    ] as const;
    for (const [scope, scopeId] of scopes) {
      const { store } = freshStore();
      const before = store.read(scope, scopeId);
      expect(before).toEqual({ text: "", version: versionOf("") });
      const res = store.append({ scope, scopeId, text: "a durable fact" });
      expect(res.item).toStrictEqual({
        scope,
        scopeId,
        text: "a durable fact",
        raw: "- a durable fact",
      });
      const after = store.read(scope, scopeId);
      expect(after.text).toBe("- a durable fact\n");
      expect(after.version).toBe(res.version);
      expect(after.version).not.toBe(before.version);
      expect(res.size).toBe(injectedSize(after.text));
      expect(res.cap).toBe(MEMORY_CAPS[scope]);
    }
  });

  // The audit row is now the only record of who wrote a line: it names the
  // caller from the audit context and keeps the whole file after the op.
  // The office target has no id, so it is named "office" (the audit filter
  // matches on it).
  it("audits each write with the context actor, its scope's target and the full file", () => {
    const { store, audits } = freshStore();
    const bot: AuditActor = { kind: "agent", id: "a1", name: "Bot" };
    store.append({ scope: "office", scopeId: null, text: "x" });
    store.append({ scope: "agent", scopeId: "a1", text: "y" }, bot);
    store.append({ scope: "agent", scopeId: "a1", text: "z" }, MEMBER);
    store.replace(
      {
        scope: "agent",
        scopeId: "a1",
        text: "- w\n",
        expectedVersion: versionOf("- y\n- z\n"),
      },
      bot,
    );
    expect(
      audits.map((a) => [a.actor, a.operation, a.targets, a.memoryContent]),
    ).toEqual([
      [MEMBER, "memory.append", ["memory:office:office"], "- x\n"],
      [bot, "memory.append", ["memory:agent:a1"], "- y\n"],
      [MEMBER, "memory.append", ["memory:agent:a1"], "- y\n- z\n"],
      [bot, "memory.replace", ["memory:agent:a1"], "- w\n"],
    ]);
  });

  it("separates an append from raw REPLACE content without a trailing newline", () => {
    const { store } = freshStore();
    const replaced = "- Nil, 2026-06-27: first fact";
    store.replace({
      scope: "agent",
      scopeId: "a1",
      text: replaced,
      expectedVersion: versionOf(""),
    });
    const res = store.append({
      scope: "agent",
      scopeId: "a1",
      text: "second fact",
    });
    const expected = `${replaced}\n- second fact\n`;
    expect(store.read("agent", "a1").text).toBe(expected);
    expect(res.size).toBe(injectedSize(expected));
  });

  it("findDuplicate matches an exact active restatement, not a reword", () => {
    const { store } = freshStore();
    store.append({
      scope: "room",
      scopeId: "r1",
      text: "Deploys at 9.",
    });
    expect(store.findDuplicate("room", "r1", "deploys at 9")).not.toBeNull();
    // Inner whitespace collapses; inner punctuation counts.
    expect(store.findDuplicate("room", "r1", "Deploys   at 9")).not.toBeNull();
    expect(store.findDuplicate("room", "r1", "deploys at 09:00")).toBeNull();
    store.append({
      scope: "room",
      scopeId: "r1",
      text: "use ~/isomux-active.",
    });
    expect(store.findDuplicate("room", "r1", "use ~/isomuxactive")).toBeNull();
    // per-scope: same text in another scope is not a dup
    expect(store.findDuplicate("office", null, "deploys at 9")).toBeNull();
  });

  // Old offices keep their stamped lines (Nil: "left as are"), so a
  // restatement of one is still a duplicate. The date anchors the author, so
  // a comma in the author is fine, and a comma and a date in the TEXT of an
  // authorless line do not make an author.
  it("findDuplicate matches a restatement of a legacy stamped line of either shape", () => {
    const { root, store } = freshStore();
    mkdirSync(join(root, "memory", "agents"), { recursive: true });
    writeFileSync(
      join(root, "memory", "agents", "a1.md"),
      "- Dr. No, Esq., 2026-06-28: spies are durable\n" +
        "- 2026-06-28: shipped, 2026-07-01: done\n",
    );
    expect(
      store.findDuplicate("agent", "a1", "spies are durable"),
    ).not.toBeNull();
    expect(
      store.findDuplicate("agent", "a1", "shipped, 2026-07-01: done"),
    ).not.toBeNull();
    expect(store.findDuplicate("agent", "a1", "done")).toBeNull();
  });

  // An agent may still put its own "Name, date:" in the text. The new line
  // then has a legacy shape, so the guard must also compare the whole text,
  // or the same append goes in twice.
  it("findDuplicate matches a new line whose text looks like a legacy stamp", () => {
    const { store } = freshStore();
    const text = "Nil, 2026-11-16: rule";
    const res = store.append({ scope: "room", scopeId: "r1", text });
    expect(res.item.raw).toBe(`- ${text}`);
    expect(store.findDuplicate("room", "r1", text)).not.toBeNull();
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
      expectedVersion: versionOf(""),
    });
    expect(res.ok).toBe(true);
    expect(store.read("agent", "a1").text).toBe(text);
  });
  it("overwrites with the correct version and returns the new version", () => {
    const { store } = freshStore();
    store.append({ scope: "agent", scopeId: "a1", text: "one" });
    const { version } = store.read("agent", "a1");
    const res = store.replace({
      scope: "agent",
      scopeId: "a1",
      text: "- hand-edited line\n- another\n",
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
        expectedVersion: version,
      }),
    ).toEqual({ ok: false, conflict: true, version: current.version });
    expect(store.read("agent", "a1")).toEqual(current);
    // Empty text clears the file.
    store.replace({
      scope: "agent",
      scopeId: "a1",
      text: "",
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
    store.append({ scope: "office", scopeId: null, text: "o" });
    store.append({ scope: "agent", scopeId: "a1", text: "g" });
    const out = store.renderForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      { scope: "room", scopeId: "r1", label: 'Room "X"' }, // empty -> skipped
      { scope: "agent", scopeId: "a1", label: "Your agent" },
    ]);
    expect(out).toBe("Office-wide:\n- o\n\nYour agent:\n- g");
    expect(
      store.renderForPromptMulti([
        { scope: "room", scopeId: "r9", label: "X" },
      ]),
    ).toBeNull();
  });

  it("measureForPromptMulti sizes each non-empty scope against its cap", () => {
    const { store } = freshStore({ caps: { ...MEMORY_CAPS, office: 100 } });
    store.append({ scope: "office", scopeId: null, text: "o" });
    store.append({ scope: "agent", scopeId: "a1", text: "g" });
    const out = store.measureForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      { scope: "room", scopeId: "r1", label: 'Room "X"' }, // empty -> skipped
      { scope: "agent", scopeId: "a1", label: "Your agent" },
    ]);
    expect(out).toEqual([
      {
        scope: "office",
        label: "Office-wide",
        contentChars: "- o".length,
        cap: 100,
      },
      {
        scope: "agent",
        label: "Your agent",
        contentChars: "- g".length,
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
        text: "fact",
      }),
  );
  expect(store.read("office", null).text).toContain("fact");
  expect(readFileSync(old, "utf8")).toBe("legacy bytes\n");
});

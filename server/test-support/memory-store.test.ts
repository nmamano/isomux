// isomux-memory storage — T0 unit tests (slice 3a). Pure format/parse + the
// injectable store against a temp dir with deterministic id/date. No server, no
// LLM, no network. See server/memory-store.ts.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatMemoryLine,
  parseMemoryLine,
  parseMemoryFile,
  createMemoryStore,
  isSafeScopeId,
  genMemId,
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

describe("memory-store: format/parse", () => {
  it("formatMemoryLine renders the exact design line shape", () => {
    expect(
      formatMemoryLine({
        id: "ab12cd",
        author: "Isomuxer3",
        date: "2026-06-27",
        text: "no em dashes in prose",
      }),
    ).toBe(
      "- <!-- mem:ab12cd --> [Isomuxer3, 2026-06-27] no em dashes in prose",
    );
  });

  it("parseMemoryLine round-trips a formatted line", () => {
    const raw = formatMemoryLine({
      id: "00ffaa",
      author: "Bot",
      date: "2026-01-02",
      text: "this room uses Bun",
    });
    const item = parseMemoryLine(raw, "agent", "agent-1");
    expect(item).toEqual({
      id: "00ffaa",
      scope: "agent",
      scopeId: "agent-1",
      author: "Bot",
      date: "2026-01-02",
      text: "this room uses Bun",
      factType: null,
      supersedes: null,
      tombstones: null,
      raw,
    });
  });

  it("parseMemoryLine rejects junk (blank lines, prose, bad id)", () => {
    expect(parseMemoryLine("", "office", null)).toBeNull();
    expect(parseMemoryLine("just some prose", "office", null)).toBeNull();
    // 8-hex id (wrong width) does not parse — the grammar is strict.
    expect(
      parseMemoryLine(
        "- <!-- mem:deadbeef --> [X, 2026-01-01] hi",
        "office",
        null,
      ),
    ).toBeNull();
  });

  it("parseMemoryFile keeps only conforming lines, in file order", () => {
    const content = [
      "- <!-- mem:aaaaaa --> [A, 2026-01-01] first",
      "garbage",
      "",
      "- <!-- mem:bbbbbb --> [B, 2026-01-02] second",
    ].join("\n");
    const items = parseMemoryFile(content, "room", "room-1");
    expect(items.map((m) => m.id)).toEqual(["aaaaaa", "bbbbbb"]);
    expect(items.map((m) => m.text)).toEqual(["first", "second"]);
  });
});

describe("memory-store: isSafeScopeId / genMemId", () => {
  it("accepts plain identifiers, rejects path traversal", () => {
    expect(isSafeScopeId("agent-1779193515618-0wxo")).toBe(true);
    expect(isSafeScopeId("../etc/passwd")).toBe(false);
    expect(isSafeScopeId("a/b")).toBe(false);
    expect(isSafeScopeId("a.b")).toBe(false);
    expect(isSafeScopeId("a%2fb")).toBe(false);
    expect(isSafeScopeId("")).toBe(false);
  });

  it("genMemId is 6 lowercase hex chars", () => {
    for (let i = 0; i < 50; i++) {
      expect(genMemId()).toMatch(/^[0-9a-f]{6}$/);
    }
  });
});

describe("memory-store: append + read (injected id/date, temp dir)", () => {
  it("append writes a deterministic line and read parses it back", () => {
    const stateRoot = tempRoot();
    const store = createMemoryStore({
      stateRoot,
      genId: () => "abc123",
      today: () => "2026-06-27",
    });
    const item = store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "Isomuxer3",
      text: "pairs with Reviewer3",
    });
    expect(item.id).toBe("abc123");
    expect(item.date).toBe("2026-06-27");
    expect(item.author).toBe("Isomuxer3");
    expect(item.factType).toBeNull();

    // Evidence surface: the actual file on disk.
    const onDisk = readFileSync(
      join(stateRoot, "memory", "agents", "agent-1.md"),
      "utf8",
    );
    expect(onDisk).toBe(
      "- <!-- mem:abc123 --> [Isomuxer3, 2026-06-27] pairs with Reviewer3\n",
    );

    const back = store.read("agent", "agent-1");
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(item);
  });

  it("read returns [] for a missing file", () => {
    const store = createMemoryStore({ stateRoot: tempRoot() });
    expect(store.read("agent", "nope")).toEqual([]);
  });

  it("renderForPrompt joins raw active lines, or null when empty", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const store = createMemoryStore({
      stateRoot,
      genId: () => ["111111", "222222"][n++],
      today: () => "2026-06-27",
    });
    expect(store.renderForPrompt("agent", "agent-1")).toBeNull();
    store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "x",
    });
    store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "y",
    });
    expect(store.renderForPrompt("agent", "agent-1")).toBe(
      "- <!-- mem:111111 --> [A, 2026-06-27] x\n" +
        "- <!-- mem:222222 --> [A, 2026-06-27] y",
    );
  });

  it("regenerates the id on an in-file collision", () => {
    const stateRoot = tempRoot();
    // First append mints "aaaaaa". Second generator yields "aaaaaa" once (a
    // collision with the persisted line) then a fresh id; append must use fresh.
    // (Ids must be valid 6-hex or the persisted line won't parse back.)
    const seq = ["aaaaaa", "aaaaaa", "bbbbbb"];
    let i = 0;
    const store = createMemoryStore({
      stateRoot,
      genId: () => seq[i++],
      today: () => "2026-06-27",
    });
    const a = store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "one",
    });
    const b = store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "two",
    });
    expect(a.id).toBe("aaaaaa");
    expect(b.id).toBe("bbbbbb");
    expect(store.read("agent", "agent-1").map((m) => m.id)).toEqual([
      "aaaaaa",
      "bbbbbb",
    ]);
  });

  it("throws (does not spin) when the generator can never produce a fresh id", () => {
    const stateRoot = tempRoot();
    const store = createMemoryStore({
      stateRoot,
      genId: () => "cccccc",
      today: () => "2026-06-27",
    });
    store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "x",
    });
    expect(() =>
      store.append({
        scope: "agent",
        scopeId: "agent-1",
        author: "A",
        text: "y",
      }),
    ).toThrow(/unique valid id/);
  });

  it("retries a malformed generated id, never persisting an unparseable line", () => {
    const stateRoot = tempRoot();
    // A buggy generator yields a non-hex id first, then a valid one. append()
    // must skip the malformed one and persist only the valid id.
    const seq = ["NOThex", "abcdef"];
    let i = 0;
    const store = createMemoryStore({
      stateRoot,
      genId: () => seq[i++],
      today: () => "2026-06-27",
    });
    const item = store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "x",
    });
    expect(item.id).toBe("abcdef");
    // Round-trips: the persisted line parses back to exactly one item.
    expect(store.read("agent", "agent-1").map((m) => m.id)).toEqual(["abcdef"]);
  });

  it("throws when the generator only ever yields malformed ids", () => {
    const store = createMemoryStore({
      stateRoot: tempRoot(),
      genId: () => "ZZZZZZ",
      today: () => "2026-06-27",
    });
    expect(() =>
      store.append({
        scope: "agent",
        scopeId: "agent-1",
        author: "A",
        text: "x",
      }),
    ).toThrow(/unique valid id/);
  });

  it("office scope writes to office.md (no scopeId), boss to bosses/<id>.md", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const store = createMemoryStore({
      stateRoot,
      genId: () => ["0f0f0f", "a1a1a1"][n++],
      today: () => "2026-06-27",
    });
    store.append({ scope: "office", scopeId: null, author: "A", text: "o" });
    store.append({ scope: "boss", scopeId: "user-1", author: "A", text: "b" });
    mkdirSync(join(stateRoot, "memory"), { recursive: true });
    expect(
      readFileSync(join(stateRoot, "memory", "office.md"), "utf8"),
    ).toContain("[A, 2026-06-27] o");
    expect(
      readFileSync(join(stateRoot, "memory", "bosses", "user-1.md"), "utf8"),
    ).toContain("[A, 2026-06-27] b");
  });
});

describe("memory-store: renderForPromptMulti", () => {
  it("returns null when every scope is empty", () => {
    const store = createMemoryStore({ stateRoot: tempRoot() });
    expect(
      store.renderForPromptMulti([
        { scope: "office", scopeId: null, label: "Office-wide" },
        { scope: "room", scopeId: "room-1", label: 'Room "R"' },
        { scope: "agent", scopeId: "agent-1", label: "Your agent" },
      ]),
    ).toBeNull();
  });

  it("labels only non-empty scopes, in order (office -> room -> agent)", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["0a0a0a", "0b0b0b"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    store.append({
      scope: "office",
      scopeId: null,
      author: "O",
      text: "office fact",
    });
    store.append({
      scope: "agent",
      scopeId: "agent-1",
      author: "A",
      text: "agent fact",
    });
    // room is left empty on purpose -> its label must be omitted.
    const out = store.renderForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      { scope: "room", scopeId: "room-1", label: 'Room "R"' },
      { scope: "agent", scopeId: "agent-1", label: "Your agent" },
    ]);
    expect(out).toBe(
      "Office-wide:\n- <!-- mem:0a0a0a --> [O, 2026-06-27] office fact\n\n" +
        "Your agent:\n- <!-- mem:0b0b0b --> [A, 2026-06-27] agent fact",
    );
    expect(out).not.toContain('Room "R"');
  });

  it("cross-agent room visibility: a room fact reaches any reader of that room, not other rooms", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["111aaa", "222bbb"];
    // Agent A's session writes a room fact.
    const storeA = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    storeA.append({
      scope: "room",
      scopeId: "room-1",
      author: "AgentA",
      text: "shared room fact",
    });
    // A separate store instance (Agent B's session) reading the SAME room sees it.
    const storeB = createMemoryStore({ stateRoot });
    expect(
      storeB.renderForPromptMulti([
        { scope: "room", scopeId: "room-1", label: 'Room "R"' },
      ]),
    ).toContain("shared room fact");
    // Agent C in a different room does not.
    expect(
      storeB.renderForPromptMulti([
        { scope: "room", scopeId: "room-2", label: 'Room "R2"' },
      ]),
    ).toBeNull();
  });

  it("an office fact is included for agents in two different rooms", () => {
    const stateRoot = tempRoot();
    const store = createMemoryStore({
      stateRoot,
      genId: () => "0ff1ce",
      today: () => "2026-06-27",
    });
    store.append({
      scope: "office",
      scopeId: null,
      author: "O",
      text: "office-wide fact",
    });
    for (const roomId of ["room-1", "room-2"]) {
      const out = store.renderForPromptMulti([
        { scope: "office", scopeId: null, label: "Office-wide" },
        { scope: "room", scopeId: roomId, label: `Room "${roomId}"` },
      ]);
      expect(out).toContain("office-wide fact");
    }
  });

  it("boss notes render only under the matching boss ref (manager-boss scoping)", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["b0b0b0", "c0c0c0"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    store.append({
      scope: "boss",
      scopeId: "userA",
      author: "X",
      text: "A boss fact",
    });
    store.append({
      scope: "boss",
      scopeId: "userB",
      author: "Y",
      text: "B boss fact",
    });
    // An agent managed by userA loads only userA's boss lines (and vice-versa).
    const aOut = store.renderForPromptMulti([
      { scope: "boss", scopeId: "userA", label: 'Boss "A"' },
    ]);
    expect(aOut).toContain("A boss fact");
    expect(aOut).not.toContain("B boss fact");
    const bOut = store.renderForPromptMulti([
      { scope: "boss", scopeId: "userB", label: 'Boss "B"' },
    ]);
    expect(bOut).toContain("B boss fact");
    expect(bOut).not.toContain("A boss fact");
  });
});

describe("memory-store: supersede / tombstone (slice 3d)", () => {
  it("parses supersede and tombstone lines; rejects malformed relation ids", () => {
    const sup = parseMemoryLine(
      "- <!-- mem:bbbbbb supersedes:aaaaaa --> [A, 2026-06-27] new text",
      "agent",
      "a1",
    );
    expect(sup?.supersedes).toBe("aaaaaa");
    expect(sup?.tombstones).toBeNull();
    expect(sup?.text).toBe("new text");
    const tomb = parseMemoryLine(
      "- <!-- mem:cccccc tombstones:aaaaaa --> [A, 2026-06-27] (retracted)",
      "agent",
      "a1",
    );
    expect(tomb?.tombstones).toBe("aaaaaa");
    expect(tomb?.supersedes).toBeNull();
    // A non-hex relation target makes the whole line junk (skipped).
    expect(
      parseMemoryLine(
        "- <!-- mem:bbbbbb supersedes:XYZ --> [A, 2026-06-27] t",
        "agent",
        "a1",
      ),
    ).toBeNull();
  });

  it("supersede suppresses the old line and activates the new; raw retains both", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["aaaaaa", "bbbbbb"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    const orig = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "A",
      text: "old",
    });
    const sup = store.supersede({
      scope: "agent",
      scopeId: "a1",
      targetId: orig.id,
      author: "A",
      text: "new",
    });
    expect(sup?.id).toBe("bbbbbb");
    expect(sup?.supersedes).toBe("aaaaaa");
    expect(store.read("agent", "a1").map((m) => m.id)).toEqual(["bbbbbb"]);
    expect(store.read("agent", "a1")[0].text).toBe("new");
    // Raw retains both lines.
    expect(store.readRaw("agent", "a1").map((m) => m.id)).toEqual([
      "aaaaaa",
      "bbbbbb",
    ]);
    expect(store.renderForPrompt("agent", "a1")).toContain("new");
    expect(store.renderForPrompt("agent", "a1")).not.toContain("] old");
  });

  it("tombstone removes the target from active; control line never active; raw retains", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["aaaaaa", "dddddd"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    const orig = store.append({
      scope: "office",
      scopeId: null,
      author: "A",
      text: "fact",
    });
    const tomb = store.tombstone({
      scope: "office",
      scopeId: null,
      targetId: orig.id,
      author: "A",
    });
    expect(tomb?.tombstones).toBe("aaaaaa");
    expect(store.read("office", null)).toEqual([]);
    expect(store.readRaw("office", null).map((m) => m.id)).toEqual([
      "aaaaaa",
      "dddddd",
    ]);
    expect(store.renderForPrompt("office", null)).toBeNull();
  });

  it("supersede chain leaves only the newest active", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["aaaaaa", "bbbbbb", "cccccc"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    const o = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "A",
      text: "v1",
    });
    const s1 = store.supersede({
      scope: "agent",
      scopeId: "a1",
      targetId: o.id,
      author: "A",
      text: "v2",
    })!;
    store.supersede({
      scope: "agent",
      scopeId: "a1",
      targetId: s1.id,
      author: "A",
      text: "v3",
    });
    expect(store.read("agent", "a1").map((m) => m.text)).toEqual(["v3"]);
  });

  it("supersede/tombstone return null when target is not active", () => {
    const stateRoot = tempRoot();
    let n = 0;
    const ids = ["aaaaaa", "bbbbbb"];
    const store = createMemoryStore({
      stateRoot,
      genId: () => ids[n++],
      today: () => "2026-06-27",
    });
    // Absent target.
    expect(
      store.supersede({
        scope: "agent",
        scopeId: "a1",
        targetId: "ffffff",
        author: "A",
        text: "x",
      }),
    ).toBeNull();
    // Already-superseded target cannot be tombstoned.
    const o = store.append({
      scope: "agent",
      scopeId: "a1",
      author: "A",
      text: "old",
    });
    store.supersede({
      scope: "agent",
      scopeId: "a1",
      targetId: o.id,
      author: "A",
      text: "new",
    });
    expect(
      store.tombstone({
        scope: "agent",
        scopeId: "a1",
        targetId: o.id,
        author: "A",
      }),
    ).toBeNull();
  });

  it("cross-file id isolation: supersede in one file does not touch another", () => {
    const stateRoot = tempRoot();
    // Force the SAME id in two files, then a fresh id for the supersede.
    const seq = ["aaaaaa", "aaaaaa", "bbbbbb"];
    let i = 0;
    const store = createMemoryStore({
      stateRoot,
      genId: () => seq[i++],
      today: () => "2026-06-27",
    });
    store.append({ scope: "agent", scopeId: "a1", author: "A", text: "in A" });
    store.append({ scope: "agent", scopeId: "a2", author: "A", text: "in B" });
    store.supersede({
      scope: "agent",
      scopeId: "a1",
      targetId: "aaaaaa",
      author: "A",
      text: "A updated",
    });
    expect(store.read("agent", "a1").map((m) => m.text)).toEqual(["A updated"]);
    // File a2's identically-id'd line is untouched.
    expect(store.read("agent", "a2").map((m) => m.text)).toEqual(["in B"]);
  });
});

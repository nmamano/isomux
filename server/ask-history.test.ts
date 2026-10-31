// The ask history (task ff590b5e) under the ask store: each closed ask is
// recorded with how it closed, after its removal is committed, and an id
// names one ask forever. A real office database in a temp directory.

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openOfficeDatabase } from "./audit-store.ts";
import { createAskHistory, type AskHistory } from "./ask-history.ts";
import { createAskStore, type AskPersistence } from "./asks.ts";
import type { AskEvent } from "../shared/types.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-ask-history-"));
  dirs.push(dir);
  return join(dir, "office.sqlite");
}

function open(path = dbPath()): { history: AskHistory; path: string } {
  const db = openOfficeDatabase(path);
  dbs.push(db);
  return { history: createAskHistory(db), path };
}

// A store over memory; `failSave` makes the next writes throw.
function storeWith(history: AskHistory) {
  let clock = 100;
  const io = { failSave: false };
  const persistence: AskPersistence = {
    load: () => ({ kind: "missing" }),
    save: () => {
      if (io.failSave) throw new Error("disk full");
    },
    quarantine: () => true,
  };
  const store = createAskStore({
    persistence,
    history,
    now: () => clock,
  });
  const ask = (agentId: string, memberUserId: string, prompt: string) => {
    const made = store.create({
      agentId,
      memberUserId,
      prompt,
      options: ["Yes", "No"],
      recommended: "Yes",
      sessionId: "s-open",
    });
    if (!made.ok) throw new Error(made.code);
    return made.entry;
  };
  return {
    store,
    io,
    ask,
    at: (t: number) => {
      clock = t;
    },
  };
}

describe("a closed ask", () => {
  it("is recorded as it was, with how, by whom and when it closed; the agent's list is newest close first", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Ship it?");
    const b = ask("a1", "u2", "Rename it?");
    const c = ask("a1", "u1", "File it?");
    const d = ask("a2", "u1", "Other agent's?");

    at(10);
    store.remove(a.id, { outcome: "replied", byUserId: "u1", answer: "Yes" });
    at(20);
    store.remove(b.id, { outcome: "dismissed", byUserId: "u2" });
    at(30);
    store.remove(c.id, {
      outcome: "filed",
      byUserId: "u1",
      taskId: "t1",
      answer: "later",
    });

    // The entry as it was, options, mark and opening session included.
    expect(history.get("a1", a.id)!.entry).toEqual(a);
    expect(a.sessionId).toBe("s-open");
    expect(history.get("a1", a.id)!.closure).toEqual({
      outcome: "replied",
      byUserId: "u1",
      answer: "Yes",
      at: 10,
    });
    expect(history.get("a1", b.id)!.closure).toEqual({
      outcome: "dismissed",
      byUserId: "u2",
      at: 20,
    });
    expect(history.get("a1", c.id)!.closure).toEqual({
      outcome: "filed",
      byUserId: "u1",
      taskId: "t1",
      answer: "later",
      at: 30,
    });
    expect(history.has(a.id)).toBe(true);
    // Still open: not closed in the history.
    expect(history.get("a2", d.id)).toBeNull();
    // One agent's id is not another's.
    expect(history.get("a2", a.id)).toBeNull();

    const page = history.list("a1", { limit: 50 });
    expect(page.items.map((r) => r.entry.id)).toEqual([c.id, b.id, a.id]);
    expect(page.nextBefore).toBeNull();
    expect(history.list("a2", { limit: 50 }).items).toEqual([]);
  });

  it("is recorded as agent_removed for each open ask of a removed agent", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "One?");
    const b = ask("a1", "u2", "Two?");
    const kept = ask("a2", "u1", "Kept?");
    at(50);
    expect(store.removeAgent("a1")).toBe(2);
    const rows = history.list("a1", { limit: 50 }).items;
    expect(rows.map((r) => r.entry.id).sort()).toEqual([a.id, b.id].sort());
    for (const r of rows)
      expect(r.closure).toEqual({ outcome: "agent_removed", at: 50 });
    expect(history.get("a2", kept.id)).toBeNull();
  });

  it("is not recorded when its removal fails, and a failed record neither fails nor undoes the close", () => {
    const { history } = open();
    const { store, io, ask } = storeWith(history);
    const a = ask("a1", "u1", "Save fails?");
    io.failSave = true;
    expect(() => store.remove(a.id, { outcome: "withdrawn" })).toThrow();
    expect(() => store.removeAgent("a1")).toThrow();
    // Still open, and never in the history: open and closed at once is the
    // state the design rules out.
    expect(store.get(a.id)).toEqual(a);
    expect(history.get("a1", a.id)).toBeNull();

    const failing: AskHistory = {
      ...history,
      record: () => {
        throw new Error("database locked");
      },
    };
    const other = storeWith(failing);
    const b = other.ask("a1", "u1", "Record fails?");
    const c = other.ask("a1", "u1", "Record fails on removal?");
    expect(other.store.remove(b.id, { outcome: "withdrawn" })?.id).toBe(b.id);
    expect(other.store.get(b.id)).toBeNull();
    other.store.removeAgent("a1");
    expect(other.store.get(c.id)).toBeNull();
  });

  it("keeps its id: a new ask never takes an id the history holds", () => {
    const { history } = open();
    const asked: string[] = [];
    // The first id the store tries is "in the history".
    const { ask } = storeWith({
      ...history,
      has: (id) => {
        asked.push(id);
        return asked.length === 1;
      },
    });
    const a = ask("a1", "u1", "Fresh id?");
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(a.id).not.toBe(asked[0]);
    expect(a.id).toBe(asked[asked.length - 1]);
  });
});

// Task 62aa552f: what happened to an ask before its close.
describe("an ask's events", () => {
  it("are kept from the create to the close, oldest first: each edit with who made it and the values it changed, null for one the ask did not have", () => {
    const { history } = open();
    const { store, at } = storeWith(history);
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Ship it?",
      options: ["Yes", "No"],
      recommended: "Yes",
      priority: "P1",
      sessionId: "s-open",
    });
    if (!made.ok) throw new Error(made.code);
    const id = made.entry.id;
    at(110);
    store.edit(id, "Ship it today?");
    // New options without a mark clear the mark: the edit changed both.
    at(120);
    store.edit(id, "Ship it today?", undefined, ["Yes", "Later"], {}, null);
    at(130);
    store.edit(
      id,
      "Ship it today?",
      undefined,
      undefined,
      { commands: ["bun test"] },
      undefined,
      null,
      { app: "merger" },
    );
    // An edit that changes nothing is no event.
    at(135);
    store.edit(id, "Ship it today?");
    at(140);
    store.remove(id, { outcome: "replied", byUserId: "u1", answer: "Later" });

    const events: AskEvent[] = [
      {
        kind: "created",
        at: 100,
        ask: {
          prompt: "Ship it?",
          options: ["Yes", "No"],
          recommended: "Yes",
          priority: "P1",
        },
      },
      { kind: "edited", at: 110, before: { prompt: "Ship it?" } },
      {
        kind: "edited",
        at: 120,
        before: { options: ["Yes", "No"], recommended: "Yes" },
      },
      {
        kind: "edited",
        at: 130,
        app: "merger",
        before: { priority: "P1", commands: null },
      },
    ];
    expect(history.get("a1", id)!.events).toEqual(events);
    expect(history.list("a1", { limit: 50 }).items[0].events).toEqual(events);
    // The close stays the closure, not an event.
    expect(history.get("a1", id)!.closure).toEqual({
      outcome: "replied",
      byUserId: "u1",
      answer: "Later",
      at: 140,
    });
  });

  it("are listed with their own ask only, and an ask closed before events were kept has none", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    // Closed by an older server: a history row and no events.
    history.record(
      {
        id: "0ld0ld00",
        agentId: "a1",
        memberUserId: "u1",
        prompt: "Old?",
        createdAt: 1,
        updatedAt: 1,
      },
      { outcome: "withdrawn", at: 2 },
    );
    const a = ask("a1", "u1", "One?");
    const b = ask("a1", "u1", "Two?");
    at(110);
    store.edit(a.id, "One now?");
    at(120);
    store.edit(b.id, "Two now?");
    store.remove(a.id, { outcome: "withdrawn" });
    store.remove(b.id, { outcome: "withdrawn" });

    // Each ask's prompts as it read before each change.
    const prompts = (events: AskEvent[]) =>
      events.map((e) =>
        e.kind === "created" ? e.ask.prompt : e.before.prompt,
      );
    const page = history.list("a1", { limit: 50 }).items;
    expect(page.map((r) => [r.entry.id, prompts(r.events)])).toEqual([
      [b.id, ["Two?", "Two?"]],
      [a.id, ["One?", "One?"]],
      ["0ld0ld00", []],
    ]);
    expect(prompts(history.get("a1", b.id)!.events)).toEqual(["Two?", "Two?"]);
    expect(history.get("a1", "0ld0ld00")!.events).toEqual([]);
  });

  it("are kept only for a change that committed, and a failed write neither fails nor undoes the change", () => {
    const { history } = open();
    const { store, io, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Save fails?");
    io.failSave = true;
    at(110);
    expect(() => store.edit(a.id, "Never saved?")).toThrow();
    io.failSave = false;
    store.remove(a.id, { outcome: "withdrawn" });
    expect(history.get("a1", a.id)!.events.map((e) => e.kind)).toEqual([
      "created",
    ]);

    const failing: AskHistory = {
      ...history,
      recordEvent: () => {
        throw new Error("database locked");
      },
    };
    const other = storeWith(failing);
    const b = other.ask("a1", "u1", "Record fails?");
    expect(other.store.get(b.id)?.prompt).toBe("Record fails?");
    expect(other.store.edit(b.id, "Still edited?")?.prompt).toBe(
      "Still edited?",
    );
    expect(other.store.get(b.id)?.prompt).toBe("Still edited?");
  });

  it("keep their ask's id taken: an open ask, or one whose close was never recorded", () => {
    const { history } = open();
    const { ask } = storeWith(history);
    // Open, so the history has its create only.
    const a = ask("a1", "u1", "Open?");
    expect(history.get("a1", a.id)).toBeNull();
    expect(history.has(a.id)).toBe(true);
    history.recordEvent("a1", "abcd1234", {
      kind: "created",
      at: 1,
      ask: { prompt: "Lost with asks.json?" },
    });
    expect(history.has("abcd1234")).toBe(true);
    expect(history.has("abcd9999")).toBe(false);
  });
});

describe("the agent's list", () => {
  it("pages by its cursor and filters by member", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = ask("a1", i % 2 === 0 ? "u1" : "u2", `Q${i}?`);
      at(10 + i);
      store.remove(e.id, { outcome: "withdrawn" });
      ids.push(e.id);
    }
    const newest = [...ids].reverse();

    const first = history.list("a1", { limit: 2 });
    expect(first.items.map((r) => r.entry.id)).toEqual(newest.slice(0, 2));
    expect(first.nextBefore).toBe(first.items[1].seq);
    // Exactly `limit` left: the last page says there is no next one.
    const second = history.list("a1", {
      limit: 2,
      before: first.nextBefore!,
    });
    expect(second.items.map((r) => r.entry.id)).toEqual(newest.slice(2));
    expect(second.nextBefore).toBeNull();

    const u2 = history.list("a1", { limit: 50, memberUserId: "u2" });
    expect(u2.items.map((r) => r.entry.id)).toEqual([ids[3], ids[1]]);
    const u2Page = history.list("a1", {
      limit: 1,
      memberUserId: "u2",
      before: u2.items[0].seq,
    });
    expect(u2Page.items.map((r) => r.entry.id)).toEqual([ids[1]]);
    expect(u2Page.nextBefore).toBeNull();
  });
});

describe("the office database", () => {
  it("adds the table to a database an older server made, keeps version 1, and keeps the rows across a reopen", () => {
    const path = dbPath();
    // An older server's file: version 1, no ask_history.
    const old = new Database(path, { create: true });
    old.exec(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL); PRAGMA user_version=1;",
    );
    old.close();

    const first = open(path);
    const { store, ask } = storeWith(first.history);
    const a = ask("a1", "u1", "Kept?");
    store.remove(a.id, { outcome: "withdrawn" });
    dbs.pop()!.close();

    const again = openOfficeDatabase(path);
    dbs.push(again);
    expect(
      (again.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(1);
    const kept = createAskHistory(again).get("a1", a.id);
    expect(kept?.entry.prompt).toBe("Kept?");
    expect(kept?.events.map((e) => e.kind)).toEqual(["created"]);
  });
});

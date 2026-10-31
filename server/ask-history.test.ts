// The ask history (task ff590b5e) under the ask store: each closed ask is
// recorded with how it closed, after its removal is committed, and an id
// names one ask forever. A real office database in a temp directory.

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openOfficeDatabase } from "./audit-store.ts";
import {
  createAskHistory,
  type AskHistory,
  type AskLogRecord,
} from "./ask-history.ts";
import { createAskStore, type AskChange, type AskPersistence } from "./asks.ts";
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
  // Each committed change, as the office pushes it.
  const changes: AskChange[] = [];
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
    onChange: (change) => void changes.push(change),
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
    changes,
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
        e.kind === "created"
          ? e.ask.prompt
          : e.kind === "edited"
            ? e.before.prompt
            : undefined,
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

describe("a simplify request (task 30915188)", () => {
  it("marks the open ask and is kept as an event with the member who asked; a gone ask is null and records nothing", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Ship it?");
    at(110);
    const marked = store.requestSimplify(a.id, "u1");
    expect(marked?.simplifyRequestedAt).toBe(110);
    expect(store.get(a.id)?.simplifyRequestedAt).toBe(110);
    // Asking changes no field the agent wrote.
    expect(store.get(a.id)?.prompt).toBe("Ship it?");
    expect(store.get(a.id)?.originalPrompt).toBeUndefined();
    expect(store.requestSimplify("abcd9999", "u1")).toBeNull();
    at(120);
    store.remove(a.id, { outcome: "dismissed", byUserId: "u1" });
    expect(history.get("a1", a.id)!.events.slice(1)).toEqual([
      { kind: "simplify_requested", at: 110, byUserId: "u1" },
    ]);
    expect(history.has("abcd9999")).toBe(false);
  });

  it("keeps the request through an edit that keeps the prompt, and the rewrite clears it and keeps the first prompt across two rounds", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Merge t-1 after the CI on f00d?");
    at(110);
    store.requestSimplify(a.id, "u1");
    // Same prompt, new options: still waiting for the rewrite.
    at(120);
    store.edit(
      a.id,
      "Merge t-1 after the CI on f00d?",
      undefined,
      ["Go"],
      {},
      null,
    );
    expect(store.get(a.id)?.simplifyRequestedAt).toBe(110);
    expect(store.get(a.id)?.originalPrompt).toBeUndefined();
    // The rewrite.
    at(130);
    const first = store.edit(a.id, "Merge the fix now?");
    expect(first?.simplifyRequestedAt).toBeUndefined();
    expect(first?.originalPrompt).toBe("Merge t-1 after the CI on f00d?");
    expect(store.get(a.id)?.simplifyRequestedAt).toBeUndefined();
    // A later edit with no request pending keeps the original as it is.
    at(140);
    store.edit(a.id, "Merge the fix today?");
    expect(store.get(a.id)?.originalPrompt).toBe(
      "Merge t-1 after the CI on f00d?",
    );
    // A second round: the card still shows the prompt before the first.
    at(150);
    store.requestSimplify(a.id);
    at(160);
    const second = store.edit(a.id, "Merge it?");
    expect(second?.simplifyRequestedAt).toBeUndefined();
    expect(second?.originalPrompt).toBe("Merge t-1 after the CI on f00d?");
    at(170);
    store.remove(a.id, { outcome: "withdrawn" });

    // The events hold what the agent wrote and each request; the server's
    // fields are never an edited value. A request without a member has no
    // byUserId.
    expect(history.get("a1", a.id)!.events.slice(1)).toEqual([
      { kind: "simplify_requested", at: 110, byUserId: "u1" },
      {
        kind: "edited",
        at: 120,
        before: { options: ["Yes", "No"], recommended: "Yes" },
      },
      {
        kind: "edited",
        at: 130,
        before: { prompt: "Merge t-1 after the CI on f00d?" },
      },
      { kind: "edited", at: 140, before: { prompt: "Merge the fix now?" } },
      { kind: "simplify_requested", at: 150 },
      { kind: "edited", at: 160, before: { prompt: "Merge the fix today?" } },
    ]);
  });

  it("keeps no original for a rewrite nobody asked for", () => {
    const { history } = open();
    const { store, ask } = storeWith(history);
    const a = ask("a1", "u1", "Ship it?");
    expect(store.edit(a.id, "Ship it now?")?.originalPrompt).toBeUndefined();
  });

  // Undo of a simplify request (task fc2021b7).
  it("is withdrawn: the mark goes, pushed and kept as an event with the member; with no mark (rewritten first, or never asked) or a gone ask, null and nothing written", () => {
    const { history } = open();
    const { store, io, changes, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Merge t-1 after the CI on f00d?");
    at(110);
    store.requestSimplify(a.id, "u1");
    // A failed write throws and keeps the mark, with no event.
    io.failSave = true;
    at(115);
    expect(() => store.cancelSimplify(a.id, "u1")).toThrow("disk full");
    io.failSave = false;
    expect(store.get(a.id)?.simplifyRequestedAt).toBe(110);

    changes.length = 0;
    at(120);
    const withdrawn = store.cancelSimplify(a.id, "u1");
    expect(withdrawn?.simplifyRequestedAt).toBeUndefined();
    expect(withdrawn?.updatedAt).toBe(120);
    expect(store.get(a.id)?.simplifyRequestedAt).toBeUndefined();
    expect(store.get(a.id)?.prompt).toBe("Merge t-1 after the CI on f00d?");
    expect(
      changes.map((c) => [c.kind, c.entry.id, c.entry.simplifyRequestedAt]),
    ).toEqual([["upserted", a.id, undefined]]);

    // Nothing left to withdraw.
    changes.length = 0;
    at(125);
    expect(store.cancelSimplify(a.id, "u1")).toBeNull();
    expect(store.cancelSimplify("abcd9999", "u1")).toBeNull();
    // The agent's rewrite cleared the mark first: the rewrite stands.
    at(130);
    store.requestSimplify(a.id);
    at(140);
    store.edit(a.id, "Merge the fix now?");
    changes.length = 0;
    at(150);
    expect(store.cancelSimplify(a.id, "u1")).toBeNull();
    expect(changes).toEqual([]);
    expect(store.get(a.id)?.prompt).toBe("Merge the fix now?");
    expect(store.get(a.id)?.originalPrompt).toBe(
      "Merge t-1 after the CI on f00d?",
    );
    expect(store.get(a.id)?.updatedAt).toBe(140);

    at(160);
    store.remove(a.id, { outcome: "withdrawn" });
    expect(history.get("a1", a.id)!.events.slice(1)).toEqual([
      { kind: "simplify_requested", at: 110, byUserId: "u1" },
      { kind: "simplify_withdrawn", at: 120, byUserId: "u1" },
      { kind: "simplify_requested", at: 130 },
      {
        kind: "edited",
        at: 140,
        before: { prompt: "Merge t-1 after the CI on f00d?" },
      },
    ]);
    expect(history.has("abcd9999")).toBe(false);
  });

  it("is kept only when it committed: a failed write throws, leaves the ask unmarked and records nothing", () => {
    const { history } = open();
    const { store, io, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Save fails?");
    io.failSave = true;
    at(110);
    expect(() => store.requestSimplify(a.id, "u1")).toThrow();
    io.failSave = false;
    expect(store.get(a.id)?.simplifyRequestedAt).toBeUndefined();
    store.remove(a.id, { outcome: "withdrawn" });
    expect(history.get("a1", a.id)!.events.map((e) => e.kind)).toEqual([
      "created",
    ]);
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

// Task 302e7ea4: the agent's ask log, each event of its asks as it happens,
// the close included.
describe("the agent's ask log", () => {
  // A page as [ask id, event] pairs, after checking that its seqs fall.
  const pairs = (items: AskLogRecord[]) => {
    for (let i = 1; i < items.length; i++)
      expect(items[i].seq).toBeLessThan(items[i - 1].seq);
    return items.map((r) => [r.askId, r.event]);
  };
  const created = (prompt: string) => ({
    kind: "created" as const,
    at: 100,
    ask: { prompt, options: ["Yes", "No"], recommended: "Yes" },
  });

  it("has every event of the agent's asks, open or closed, newest first, the close included, while a closed ask's events stop before its close", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Ship it?");
    const b = ask("a1", "u2", "Rename it?");
    const c = ask("a2", "u1", "Other agent's?");
    at(110);
    store.edit(a.id, "Ship it today?");
    at(120);
    store.requestSimplify(a.id, "u1");
    at(130);
    store.remove(a.id, { outcome: "replied", byUserId: "u1", answer: "Yes" });
    at(140);
    store.edit(b.id, "Rename the room?");
    at(150);
    store.removeAgent("a2");

    const all = history.listEvents("a1", { limit: 50 });
    expect(pairs(all.items)).toEqual([
      [b.id, { kind: "edited", at: 140, before: { prompt: "Rename it?" } }],
      [
        a.id,
        {
          kind: "closed",
          at: 130,
          outcome: "replied",
          byUserId: "u1",
          answer: "Yes",
        },
      ],
      [a.id, { kind: "simplify_requested", at: 120, byUserId: "u1" }],
      [a.id, { kind: "edited", at: 110, before: { prompt: "Ship it?" } }],
      [b.id, created("Rename it?")],
      [a.id, created("Ship it?")],
    ]);
    expect(all.nextBefore).toBeNull();
    // The close of a removed agent's ask is in its log too.
    expect(pairs(history.listEvents("a2", { limit: 50 }).items)).toEqual([
      [c.id, { kind: "closed", at: 150, outcome: "agent_removed" }],
      [c.id, created("Other agent's?")],
    ]);
    // A closed ask's events are what happened before its close.
    const before: string[] = ["created", "edited", "simplify_requested"];
    expect(history.get("a1", a.id)!.events.map((e): string => e.kind)).toEqual(
      before,
    );
    expect(history.getById(a.id)!.events.map((e): string => e.kind)).toEqual(
      before,
    );
    expect(
      history
        .list("a1", { limit: 50 })
        .items[0].events.map((e): string => e.kind),
    ).toEqual(before);

    // One ask's events: a filter, so another agent's ask or an unknown id is
    // an empty page.
    expect(
      pairs(history.listEvents("a1", { askId: b.id, limit: 50 }).items),
    ).toEqual([
      [b.id, { kind: "edited", at: 140, before: { prompt: "Rename it?" } }],
      [b.id, created("Rename it?")],
    ]);
    for (const askId of [c.id, "abcd9999"])
      expect([askId, history.listEvents("a1", { askId, limit: 50 })]).toEqual([
        askId,
        { items: [], nextBefore: null },
      ]);
  });

  it("pages by its cursor, also for one ask", () => {
    const { history } = open();
    const { store, ask, at } = storeWith(history);
    const a = ask("a1", "u1", "Q0?");
    ask("a1", "u1", "Other?");
    for (let i = 1; i <= 3; i++) {
      at(100 + i);
      store.edit(a.id, `Q${i}?`);
    }
    // a's create, the other's create, a's three edits.
    const all = history.listEvents("a1", { limit: 50 }).items;
    expect(all).toHaveLength(5);

    const first = history.listEvents("a1", { limit: 2 });
    expect(first.items).toEqual(all.slice(0, 2));
    expect(first.nextBefore).toBe(all[1].seq);
    // Exactly `limit` left: the last page says there is no next one.
    const second = history.listEvents("a1", {
      limit: 3,
      before: first.nextBefore!,
    });
    expect(second).toEqual({ items: all.slice(2), nextBefore: null });

    const mine = all.filter((r) => r.askId === a.id);
    const one = history.listEvents("a1", { askId: a.id, limit: 2 });
    expect(one).toEqual({ items: mine.slice(0, 2), nextBefore: mine[1].seq });
    expect(
      history.listEvents("a1", {
        askId: a.id,
        limit: 2,
        before: one.nextBefore!,
      }),
    ).toEqual({ items: mine.slice(2), nextBefore: null });
  });

  it("gets a close only with its history row: a failed write of either throws and leaves neither", () => {
    for (const table of ["ask_history", "ask_events"]) {
      const db = openOfficeDatabase(dbPath());
      dbs.push(db);
      const history = createAskHistory(db);
      const { ask } = storeWith(history);
      const a = ask("a1", "u1", "Fails?");
      db.exec(
        `CREATE TRIGGER refuse BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
      expect(() =>
        history.record(a, { outcome: "withdrawn", at: 200 }),
      ).toThrow();
      db.exec("DROP TRIGGER refuse");
      expect([table, history.get("a1", a.id)]).toEqual([table, null]);
      expect([
        table,
        history.listEvents("a1", { limit: 50 }).items.map((r) => r.event.kind),
      ]).toEqual([table, ["created"]]);
    }
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

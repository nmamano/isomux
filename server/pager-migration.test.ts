// The pager migration (task 74e8fc07, slice 3): each page of the old pager
// store becomes a paged ask with its page id, or a closed ask in the history,
// and a second run changes nothing. A real ask store over memory and a real
// office database in a temp directory; the office around them is faked.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { openOfficeDatabase } from "./audit-store.ts";
import { createAskHistory, type AskHistory } from "./ask-history.ts";
import {
  ASK_PAGES_MAX_OPEN_PER_SOURCE,
  createAskStore,
  type AskPersistence,
} from "./asks.ts";
import type { AskEntry, PagerEntry } from "../shared/types.ts";
import {
  migratePagerAtBoot,
  migratePages,
  type PagerMigrationDeps,
} from "./pager-migration.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 9_000;

// An office with Uma (u1) and Vic (u2), the live agent a1, and the live app
// "uptime" at generation 3 (created at 7), whose message target is a1.
function office(over: Partial<PagerMigrationDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-pager-migration-"));
  dirs.push(dir);
  const db = openOfficeDatabase(join(dir, "office.sqlite"));
  dbs.push(db);
  const history = createAskHistory(db);
  let disk: unknown = undefined;
  const persistence: AskPersistence = {
    load: () =>
      disk === undefined ? { kind: "missing" } : { kind: "data", value: disk },
    save: (entries) => {
      disk = structuredClone(entries);
    },
    quarantine: () => true,
  };
  const open = () => createAskStore({ persistence, history, now: () => NOW });
  const asks = open();
  const names: Record<string, string> = { u1: "Uma", u2: "Vic" };
  const deps: PagerMigrationDeps = {
    asks,
    history,
    now: () => NOW,
    agentLive: (id) => id === "a1",
    isMember: (id) => id in names,
    memberIdByName: (name) =>
      Object.keys(names).find((id) => names[id] === name) ?? null,
    app: (name, gen) =>
      name === "uptime" && gen === 3
        ? { createdAt: 7, targetAgentId: "a1" }
        : null,
    ...over,
  };
  return { deps, asks, history, reopen: open };
}

let n = 0;
// A page from agent a1 ("Bot") to u1, open, raised twice.
function page(over: Partial<PagerEntry> = {}): PagerEntry {
  n++;
  return {
    id: `${String(n).padStart(4, "0")}aaaabbbbcccc`,
    createdAt: 100 + n,
    lastRaisedAt: 200 + n,
    raiseCount: 2,
    source: { kind: "agent", agentId: "a1", name: "Bot", roomId: "room-a" },
    targetUserId: "u1",
    title: "Disk full",
    body: "90%",
    key: "disk",
    state: "open",
    delivery: { state: "delivered", sends: 3, lastAttemptAt: 250 },
    ...over,
  };
}

const resolved = (over: Partial<PagerEntry> & { by: string; at: number }) => {
  const { by, at, ...rest } = over;
  return page({
    state: "resolved",
    resolved: { by, at },
    ...rest,
  });
};

const openOne = (asks: { listAll(): AskEntry[] }, pageId: string) =>
  asks.listAll().find((e) => e.page?.pageId === pageId);

describe("an open or acked page", () => {
  it("becomes a P1 paged ask for its target, with its id, times, count, key, text and send record", () => {
    const { deps, asks, history, reopen } = office();
    const p = page();
    expect(migratePages([p], deps)).toEqual({
      opened: 1,
      closed: 0,
      skipped: 0,
    });
    const ask = openOne(asks, p.id)!;
    expect(ask).toMatchObject({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Disk full\n\n90%",
      priority: "P1",
      createdAt: p.createdAt,
    });
    expect(ask.app).toBeUndefined();
    expect(ask.page).toEqual({
      state: "ringing",
      pageId: p.id,
      key: "disk",
      raiseCount: 2,
      lastRaisedAt: p.lastRaisedAt,
      delivery: { u1: p.delivery },
    });
    expect(history.pageAskId(p.id)).toBe(ask.id);
    // Kept on disk.
    expect(reopen().get(ask.id)?.page?.pageId).toBe(p.id);
    // A page with no body is its title.
    const bare = page({ body: undefined });
    migratePages([bare], deps);
    expect(openOne(asks, bare.id)?.prompt).toBe("Disk full");
  });

  it("an acked page stays acked, by the member with that name, else by nobody", () => {
    const { deps, asks, reopen } = office();
    const byVic = page({ state: "acked", acked: { by: "Vic", at: 300 } });
    // An agent acked it, or a member since renamed or gone.
    const byBot = page({ state: "acked", acked: { by: "Peer", at: 301 } });
    migratePages([byVic, byBot], deps);
    expect(openOne(asks, byVic.id)?.page).toMatchObject({
      state: "acked",
      ackedByUserId: "u2",
      ackedAt: 300,
    });
    const nobody = openOne(asks, byBot.id)!;
    expect(nobody.page).toMatchObject({
      state: "acked",
      ackedByUserId: "",
      ackedAt: 301,
    });
    // The file still loads: the whole of it, not moved aside.
    expect(reopen().listAll()).toHaveLength(2);
  });

  it("an app's page: an app ask for its live registration, from its live target agent or from no agent", () => {
    const appSource = {
      kind: "app" as const,
      appName: "uptime",
      registrationGen: 3,
      name: "uptime",
      roomId: "room-a",
    };
    const withTarget = office();
    const p = page({ source: appSource });
    migratePages([p], withTarget.deps);
    expect(openOne(withTarget.asks, p.id)).toMatchObject({
      agentId: "a1",
      app: { name: "uptime", createdAt: 7 },
      memberUserId: "u1",
    });
    const noTarget = office({
      app: (name, gen) =>
        name === "uptime" && gen === 3
          ? { createdAt: 7, targetAgentId: null }
          : null,
    });
    const q = page({ source: appSource });
    migratePages([q], noTarget.deps);
    expect(openOne(noTarget.asks, q.id)).toMatchObject({
      agentId: "",
      app: { name: "uptime", createdAt: 7 },
      memberUserId: "u1",
    });
  });

  it("an office page: an ask with no agent from that feature, for its member", () => {
    const { deps, asks } = office();
    const p = page({
      source: {
        kind: "office",
        feature: "whatsapp",
        name: "WhatsApp",
        roomId: null,
      },
      targetUserId: "u2",
    });
    migratePages([p], deps);
    expect(openOne(asks, p.id)).toMatchObject({
      agentId: "",
      office: { feature: "whatsapp", name: "WhatsApp" },
      memberUserId: "u2",
      priority: "P1",
    });
  });

  it("no cap applies: every open page of one source migrates", () => {
    const { deps, asks } = office();
    const pages = Array.from(
      { length: ASK_PAGES_MAX_OPEN_PER_SOURCE + 5 },
      (_, i) => page({ key: `k${i}` }),
    );
    expect(migratePages(pages, deps).opened).toBe(pages.length);
    expect(asks.listAll()).toHaveLength(pages.length);
  });
});

describe("a page that cannot be open", () => {
  it("whose agent, app or target is gone becomes a closed ask at the migration, with its page id", () => {
    const { deps, asks, history } = office();
    const agentGone = page({
      source: { kind: "agent", agentId: "a9", name: "Old", roomId: "room-a" },
    });
    const appGone = page({
      source: {
        kind: "app",
        appName: "uptime",
        // Registered again since: generation 3 now.
        registrationGen: 2,
        name: "uptime",
        roomId: null,
      },
    });
    const memberGone = page({ targetUserId: "u9" });
    expect(migratePages([agentGone, appGone, memberGone], deps)).toEqual({
      opened: 0,
      closed: 3,
      skipped: 0,
    });
    expect(asks.listAll()).toEqual([]);
    const closure = (p: PagerEntry) => history.getByPageId(p.id)?.closure;
    expect(closure(agentGone)).toEqual({ outcome: "agent_removed", at: NOW });
    expect(closure(appGone)).toEqual({
      outcome: "withdrawn",
      app: "uptime",
      at: NOW,
    });
    expect(closure(memberGone)).toEqual({ outcome: "dismissed", at: NOW });
    const rec = history.getByPageId(agentGone.id)!;
    expect(rec.entry).toMatchObject({
      agentId: "a9",
      memberUserId: "u1",
      prompt: "Disk full\n\n90%",
      createdAt: agentGone.createdAt,
    });
    expect(rec.entry.page?.pageId).toBe(agentGone.id);
    expect(history.getByPageId(appGone.id)?.entry).toMatchObject({
      agentId: "",
      app: { name: "uptime" },
    });
  });
});

describe("a resolved page", () => {
  it("becomes a closed ask at its resolve time, in resolve order whatever the input order, withdrawn by its source or dismissed by the member", () => {
    const { deps, history } = office();
    const bySource = resolved({ by: "Bot", at: 500 });
    const byVic = resolved({
      by: "Vic",
      at: 400,
      acked: { by: "Uma", at: 350 },
    });
    const byNobody = resolved({ by: "Peer", at: 600 });
    const byApp = resolved({
      by: "uptime",
      at: 450,
      source: {
        kind: "app",
        appName: "uptime",
        registrationGen: 1,
        name: "uptime",
        roomId: null,
      },
    });
    expect(migratePages([bySource, byNobody, byVic, byApp], deps)).toEqual({
      opened: 0,
      closed: 4,
      skipped: 0,
    });
    const closure = (p: PagerEntry) => history.getByPageId(p.id)?.closure;
    expect(closure(bySource)).toEqual({ outcome: "withdrawn", at: 500 });
    expect(closure(byVic)).toEqual({
      outcome: "dismissed",
      byUserId: "u2",
      at: 400,
    });
    expect(closure(byNobody)).toEqual({ outcome: "dismissed", at: 600 });
    expect(closure(byApp)).toEqual({
      outcome: "withdrawn",
      app: "uptime",
      at: 450,
    });
    // Newest close first, by resolve time: the list's order.
    const listed = history.listPaged({ accept: () => true, limit: 10 });
    if (!listed.ok) throw new Error("listPaged refused");
    expect(listed.items.map((r) => r.entry.page?.pageId)).toEqual([
      byNobody.id,
      bySource.id,
      byApp.id,
      byVic.id,
    ]);
    // Its members at the close: the target.
    const vicRec = history.getByPageId(byVic.id)!;
    expect(history.members(vicRec.entry.id)).toContain("u1");
    // Who acked it, kept.
    expect(vicRec.entry.page).toMatchObject({
      state: "acked",
      ackedByUserId: "u1",
      ackedAt: 350,
    });
  });
});

describe("running again", () => {
  it("skips every page it migrated, open or closed, and every page an open ask holds", () => {
    const { deps, asks } = office();
    const pages = [
      page(),
      page({ state: "acked", acked: { by: "Uma", at: 1 } }),
      resolved({ by: "Uma", at: 700 }),
      page({ targetUserId: "u9" }),
    ];
    expect(migratePages(pages, deps)).toEqual({
      opened: 2,
      closed: 2,
      skipped: 0,
    });
    const before = asks.listAll();
    expect(migratePages(pages, deps)).toEqual({
      opened: 0,
      closed: 0,
      skipped: 4,
    });
    expect(asks.listAll()).toEqual(before);
  });

  it("an open ask closed since it migrated stays closed", () => {
    const { deps, asks } = office();
    const p = page();
    migratePages([p], deps);
    const ask = openOne(asks, p.id)!;
    asks.remove(ask.id, { outcome: "dismissed", byUserId: "u1" });
    expect(migratePages([p], deps).skipped).toBe(1);
    expect(asks.listAll()).toEqual([]);
  });

  it("a page that cannot open is left for the next run and stops no other page", () => {
    const { deps, asks, history } = office();
    const before = page();
    const poison = page();
    // Refused without a throw.
    const refused = page();
    const after = page();
    const late = resolved({ by: "Uma", at: 700 });
    let refuse = true;
    const picky: PagerMigrationDeps = {
      ...deps,
      asks: {
        create: (input) => {
          if (refuse && input.migrated?.pageId === poison.id)
            throw new Error("not a valid ask");
          if (refuse && input.migrated?.pageId === refused.id)
            return { ok: false, code: "too_many" };
          return asks.create(input);
        },
      },
    };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        migratePages([before, poison, refused, after, late], picky),
      ).toMatchObject({ opened: 2, closed: 1 });
    } finally {
      errors.mockRestore();
    }
    for (const p of [before, after]) expect(openOne(asks, p.id)).toBeDefined();
    expect(history.getByPageId(late.id)).not.toBeNull();
    expect(history.pageAskId(poison.id)).toBeNull();
    expect(history.pageAskId(refused.id)).toBeNull();
    refuse = false;
    expect(
      migratePages([before, poison, refused, after, late], picky),
    ).toMatchObject({ opened: 2, closed: 0, skipped: 3 });
    expect(openOne(asks, poison.id)).toBeDefined();
    expect(openOne(asks, refused.id)).toBeDefined();
  });

  it("a boot run with a page that cannot open records no complete run", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-pager-boot-"));
    dirs.push(dir);
    const f = {
      pager: join(dir, "pager.json"),
      archive: join(dir, "pager-resolved.jsonl"),
      done: join(dir, "pager-migration.json"),
    };
    const { deps } = office();
    const poison = page();
    writeFileSync(f.pager, JSON.stringify([poison]));
    writeFileSync(
      f.archive,
      JSON.stringify(resolved({ by: "Uma", at: 1 })) + "\n",
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      migratePagerAtBoot(f, {
        ...deps,
        asks: {
          create: () => {
            throw new Error("not a valid ask");
          },
        },
      });
    } finally {
      errors.mockRestore();
    }
    expect(existsSync(f.done)).toBe(false);
  });

  it("a page whose history write failed is not marked done, and the next run migrates it", () => {
    let fail = true;
    const { deps, history } = office();
    const flaky: Pick<AskHistory, "pageAskId" | "record" | "recordPage"> = {
      pageAskId: (id) => history.pageAskId(id),
      recordPage: (p, a) => history.recordPage(p, a),
      record: (entry, closure, members) => {
        if (fail) throw new Error("database locked");
        history.record(entry, closure, members);
      },
    };
    const p = resolved({ by: "Uma", at: 700 });
    try {
      migratePages([p], { ...deps, history: flaky });
    } catch {
      // A throw is the boot wrapper's to log.
    }
    expect(history.pageAskId(p.id)).toBeNull();
    fail = false;
    expect(migratePages([p], { ...deps, history: flaky }).closed).toBe(1);
    expect(history.getByPageId(p.id)?.closure.outcome).toBe("dismissed");
  });
});

describe("the boot run", () => {
  function files() {
    const dir = mkdtempSync(join(tmpdir(), "isomux-pager-boot-"));
    dirs.push(dir);
    return {
      pager: join(dir, "pager.json"),
      archive: join(dir, "pager-resolved.jsonl"),
      done: join(dir, "pager-migration.json"),
    };
  }
  const line = (p: PagerEntry) => JSON.stringify(p) + "\n";

  it("reads the archive again only when it grew since the last complete run; a run that failed records nothing", () => {
    const f = files();
    const { deps, history } = office();
    // Which page ids a run looked up.
    const looked: string[] = [];
    const counting = {
      ...deps,
      history: {
        pageAskId: (id: string) => {
          looked.push(id);
          return history.pageAskId(id);
        },
        record: history.record,
        recordPage: history.recordPage,
      },
    };
    const a = resolved({ by: "Uma", at: 700 });
    writeFileSync(f.pager, JSON.stringify([]));
    writeFileSync(f.archive, line(a));
    migratePagerAtBoot(f, counting);
    expect(history.getByPageId(a.id)).not.toBeNull();
    // Same archive: not read.
    looked.length = 0;
    migratePagerAtBoot(f, counting);
    expect(looked).toEqual([]);
    // It grew: read, and the new page migrates.
    const b = resolved({ by: "Uma", at: 800 });
    appendFileSync(f.archive, line(b));
    migratePagerAtBoot(f, counting);
    expect(history.getByPageId(b.id)).not.toBeNull();
    // A pager.json that cannot be read stops the run: nothing of the grown
    // archive migrates, and no record says it did.
    const c = resolved({ by: "Uma", at: 900 });
    appendFileSync(f.archive, line(c));
    writeFileSync(f.pager, "{ cut");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(migratePagerAtBoot(f, counting)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(history.getByPageId(c.id)).toBeNull();
    writeFileSync(f.pager, JSON.stringify([]));
    migratePagerAtBoot(f, counting);
    expect(history.getByPageId(c.id)).not.toBeNull();
    // The old files as they were written.
    expect(readFileSync(f.archive, "utf-8")).toBe(line(a) + line(b) + line(c));
  });
});

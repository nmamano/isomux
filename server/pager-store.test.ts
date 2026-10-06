// Pager store: state machine, dedupe, bounds and load posture, against an
// in-memory persistence; plus one real-disk round trip.

import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createPagerFilePersistence,
  createPagerStore,
  pagerEntryVisible,
  parseRaiseFields,
  PagerUnavailableError,
  PAGER_BODY_MAX,
  PAGER_KEY_MAX,
  PAGER_MAX_ACTIVE_PER_SOURCE,
  PAGER_RESOLVED_RETENTION_MS,
  PAGER_TITLE_MAX,
  type PagerLoadResult,
  type PagerPersistence,
  type PagerRaiseFields,
} from "./pager-store.ts";
import type { PagerEntry, PagerSource } from "../shared/types.ts";

function memPersistence(initial: PagerLoadResult = { kind: "missing" }) {
  const p = {
    saved: null as PagerEntry[] | null,
    saves: 0,
    failNextSave: false,
    quarantined: 0,
    quarantineOk: true,
    load: () => initial,
    save(entries: PagerEntry[]) {
      if (p.failNextSave) {
        p.failNextSave = false;
        throw new Error("disk full");
      }
      p.saves++;
      p.saved = structuredClone(entries);
    },
    quarantine() {
      p.quarantined++;
      return p.quarantineOk;
    },
  };
  return p satisfies PagerPersistence;
}

const SRC: PagerSource = {
  kind: "agent",
  agentId: "a1",
  name: "Bot",
  roomId: "r1",
};

const APP_SRC: PagerSource = {
  kind: "app",
  appName: "a1",
  registrationGen: 1,
  name: "a1",
  roomId: "r1",
};

function fields(title: string, extra: Partial<PagerRaiseFields> = {}) {
  return { title, ...extra };
}

function raise(
  store: ReturnType<typeof createPagerStore>,
  f: PagerRaiseFields,
  source: PagerSource = SRC,
  targetUserId = "u1",
) {
  return store.raise({ source, targetUserId, fields: f });
}

function created(r: ReturnType<typeof raise>): PagerEntry {
  if (r.outcome !== "created")
    throw new Error(`expected created: ${r.outcome}`);
  return r.entry;
}

describe("pager store: raise and dedupe", () => {
  it("a raise creates an open page with token-given source and target", () => {
    let t = 1000;
    const p = memPersistence();
    const store = createPagerStore({ persistence: p, now: () => t });
    const e = created(raise(store, fields("Disk full", { body: "90%" })));
    expect(e.state).toBe("open");
    expect(e.source).toEqual(SRC);
    expect(e.targetUserId).toBe("u1");
    expect(e.createdAt).toBe(1000);
    expect(e.lastRaisedAt).toBe(1000);
    expect(e.raiseCount).toBe(1);
    expect(e.delivery).toEqual({ state: "not_delivered", sends: 0 });
    expect(e.id).toMatch(/^[0-9a-f]{8}$/);
    expect(p.saved).toEqual([e]);
    t = 2000;
    expect(store.get(e.id)).toEqual(e);
  });

  it("the same key updates the open page; room, name and target stay", () => {
    let t = 1000;
    const store = createPagerStore({
      persistence: memPersistence(),
      now: () => t,
    });
    const first = created(
      raise(store, fields("Disk 90%", { key: "disk", body: "old" })),
    );
    t = 5000;
    const moved: PagerSource = { ...SRC, name: "Renamed", roomId: "r2" };
    const r = raise(store, fields("Disk 95%", { key: "disk" }), moved, "u2");
    expect(r.outcome).toBe("updated");
    if (r.outcome !== "updated") return;
    expect(r.entry.id).toBe(first.id);
    expect(r.entry.title).toBe("Disk 95%");
    expect(r.entry.raiseCount).toBe(2);
    expect(r.entry.lastRaisedAt).toBe(5000);
    expect(r.entry.createdAt).toBe(1000);
    expect(r.entry.source).toEqual(SRC);
    expect(r.entry.targetUserId).toBe("u1");
    // An omitted body clears the old one.
    expect("body" in r.entry).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it("a raise on an acked page updates it and does not re-open it", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    const e = created(raise(store, fields("x", { key: "k" })));
    store.ack(e.id, "Boss");
    const r = raise(store, fields("x again", { key: "k" }));
    expect(r.outcome).toBe("updated");
    if (r.outcome !== "updated") return;
    expect(r.entry.state).toBe("acked");
    expect(r.entry.raiseCount).toBe(2);
  });

  it("a raise after resolve creates a new page", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    const e = created(raise(store, fields("x", { key: "k" })));
    store.resolve(e.id, "Bot");
    const again = created(raise(store, fields("x", { key: "k" })));
    expect(again.id).not.toBe(e.id);
    expect(store.list()).toHaveLength(2);
  });

  it("no key never dedupes; another source's key never matches", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    created(raise(store, fields("x")));
    created(raise(store, fields("x")));
    created(raise(store, fields("x", { key: "k" })));
    created(raise(store, fields("x", { key: "k" }), { ...SRC, agentId: "a2" }));
    expect(store.list()).toHaveLength(4);
  });

  it("an app source never shares pages with an agent of the same id or another registration of its name", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    created(raise(store, fields("x", { key: "k" })));
    const app = created(raise(store, fields("x", { key: "k" }), APP_SRC));
    expect(raise(store, fields("y", { key: "k" }), APP_SRC)).toMatchObject({
      outcome: "updated",
      entry: { id: app.id },
    });
    created(
      raise(store, fields("x", { key: "k" }), {
        ...APP_SRC,
        registrationGen: 2,
      }),
    );
    expect(store.list()).toHaveLength(3);
  });

  it("caps open+acked pages per source; dedupe and resolve do not count", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    const ids: string[] = [];
    for (let i = 0; i < PAGER_MAX_ACTIVE_PER_SOURCE; i++) {
      ids.push(created(raise(store, fields(`p${i}`, { key: `k${i}` }))).id);
    }
    store.ack(ids[0], "Boss"); // acked still counts
    expect(raise(store, fields("over")).outcome).toBe("too_many");
    expect(raise(store, fields("p1", { key: "k1" })).outcome).toBe("updated");
    // Another source is not affected.
    expect(raise(store, fields("x"), { ...SRC, agentId: "a2" }).outcome).toBe(
      "created",
    );
    store.resolve(ids[0], "Bot");
    expect(raise(store, fields("fits now")).outcome).toBe("created");
  });
});

describe("pager store: ack and resolve", () => {
  it("open -> acked -> resolved, recording who and when", () => {
    let t = 1;
    const store = createPagerStore({
      persistence: memPersistence(),
      now: () => t,
    });
    const e = created(raise(store, fields("x")));
    t = 2;
    const a = store.ack(e.id, "Boss");
    expect(a.outcome).toBe("changed");
    if (a.outcome !== "changed") return;
    expect(a.entry.state).toBe("acked");
    expect(a.entry.acked).toEqual({ by: "Boss", at: 2 });
    t = 3;
    const r = store.resolve(e.id, "Bot");
    expect(r.outcome).toBe("changed");
    if (r.outcome !== "changed") return;
    expect(r.entry.state).toBe("resolved");
    expect(r.entry.resolved).toEqual({ by: "Bot", at: 3 });
    expect(r.entry.acked).toEqual({ by: "Boss", at: 2 });
  });

  it("repeats are no-ops; an ack after resolve is refused", () => {
    const p = memPersistence();
    const store = createPagerStore({ persistence: p });
    const e = created(raise(store, fields("x")));
    store.ack(e.id, "Boss");
    const saves = p.saves;
    expect(store.ack(e.id, "Other").outcome).toBe("unchanged");
    expect(store.get(e.id)?.acked?.by).toBe("Boss");
    store.resolve(e.id, "Boss");
    expect(store.resolve(e.id, "Other").outcome).toBe("unchanged");
    expect(store.ack(e.id, "Boss").outcome).toBe("already_resolved");
    expect(store.get(e.id)?.state).toBe("resolved");
    expect(p.saves).toBe(saves + 1);
  });

  it("an open page can be resolved without an ack", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    const e = created(raise(store, fields("x")));
    expect(store.resolve(e.id, "Bot").outcome).toBe("changed");
    expect(store.get(e.id)?.acked).toBeUndefined();
  });

  it("unknown ids are not found", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    expect(store.ack("nope", "x").outcome).toBe("not_found");
    expect(store.resolve("nope", "x").outcome).toBe("not_found");
    expect(store.get("nope")).toBeNull();
  });
});

describe("pager store: commit order and hand-offs", () => {
  it("a failed save throws and leaves memory unchanged", () => {
    const p = memPersistence();
    const changes: PagerEntry[] = [];
    const store = createPagerStore({
      persistence: p,
      onChange: (e) => changes.push(e),
    });
    const e = created(raise(store, fields("x", { key: "k" })));
    p.failNextSave = true;
    expect(() => raise(store, fields("y"))).toThrow("disk full");
    p.failNextSave = true;
    expect(() => raise(store, fields("x2", { key: "k" }))).toThrow();
    p.failNextSave = true;
    expect(() => store.ack(e.id, "Boss")).toThrow();
    expect(store.list()).toEqual([e]);
    expect(changes).toHaveLength(1);
  });

  it("hands new and re-raised pages to delivery, not acks or resolves", () => {
    const handed: Array<[string, string]> = [];
    const store = createPagerStore({
      persistence: memPersistence(),
      onRaised: (e, kind) => {
        handed.push([e.id, kind]);
      },
    });
    const e = created(raise(store, fields("x", { key: "k" })));
    raise(store, fields("x", { key: "k" }));
    store.ack(e.id, "Boss");
    raise(store, fields("x", { key: "k" }));
    store.resolve(e.id, "Boss");
    expect(handed).toEqual([
      [e.id, "created"],
      [e.id, "reraised"],
      [e.id, "reraised"],
    ]);
  });

  it("a throwing or rejecting delivery hand-off never fails the raise", async () => {
    const p = memPersistence();
    let mode: "throw" | "reject" = "throw";
    const store = createPagerStore({
      persistence: p,
      onRaised: () => {
        if (mode === "throw") throw new Error("boom");
        return Promise.reject(new Error("boom"));
      },
    });
    expect(raise(store, fields("a")).outcome).toBe("created");
    mode = "reject";
    expect(raise(store, fields("b")).outcome).toBe("created");
    await Promise.resolve();
    expect(p.saved).toHaveLength(2);
  });

  it("hands each ack and resolve that changed the state to delivery, once", () => {
    const seen: Array<[string, string]> = [];
    const store = createPagerStore({
      persistence: memPersistence(),
      onTransitioned: (e, to) => {
        seen.push([e.state, to]);
        if (to === "resolved") throw new Error("boom");
      },
    });
    const e = created(raise(store, fields("x")));
    store.ack(e.id, "Boss");
    store.ack(e.id, "Boss");
    expect(store.resolve(e.id, "Boss").outcome).toBe("changed");
    store.resolve(e.id, "Boss");
    expect(seen).toEqual([
      ["acked", "acked"],
      ["resolved", "resolved"],
    ]);
  });

  it("a resolve marks the resolved message pending in the same commit", () => {
    const p = memPersistence();
    const store = createPagerStore({ persistence: p });
    const e = created(raise(store, fields("x")));
    store.ack(e.id, "Boss");
    expect(p.saved![0].delivery.resolvedNotice).toBeUndefined();
    store.resolve(e.id, "Boss");
    expect(p.saved![0].delivery.resolvedNotice).toBe("pending");
  });

  it("recordDelivery replaces the delivery block only, saves and notifies", () => {
    const p = memPersistence();
    const changes: PagerEntry[] = [];
    const store = createPagerStore({
      persistence: p,
      onChange: (e) => changes.push(e),
    });
    const e = created(raise(store, fields("x", { body: "b" })));
    const next = store.recordDelivery(e.id, {
      state: "delivered",
      sends: 1,
      lastAttemptAt: 5,
    });
    expect(next).toEqual({
      ...e,
      delivery: { state: "delivered", sends: 1, lastAttemptAt: 5 },
    });
    expect(p.saved![0].delivery.state).toBe("delivered");
    expect(changes.at(-1)!.delivery.sends).toBe(1);
    expect(store.recordDelivery("nope", e.delivery)).toBeNull();
  });

  it("returns copies: a caller cannot change stored pages", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    const e = created(raise(store, fields("x")));
    e.title = "changed";
    store.list()[0].source.roomId = "elsewhere";
    expect(store.get(e.id)?.title).toBe("x");
    expect(store.get(e.id)?.source.roomId).toBe("r1");
  });
});

describe("pager store: load posture", () => {
  const valid: PagerEntry = {
    id: "0a0b0c0d",
    createdAt: 1,
    lastRaisedAt: 2,
    raiseCount: 3,
    source: SRC,
    targetUserId: "u1",
    title: "t",
    key: "k",
    state: "acked",
    acked: { by: "Boss", at: 2 },
    delivery: { state: "not_delivered", sends: 0 },
  };

  it("no file is no pages", () => {
    const store = createPagerStore({ persistence: memPersistence() });
    expect(store.list()).toEqual([]);
  });

  it("an app-source record loads, and its dedupe continues across the load", () => {
    const appEntry: PagerEntry = { ...valid, id: "1a1b1c1d", source: APP_SRC };
    const store = createPagerStore({
      persistence: memPersistence({ kind: "data", value: [valid, appEntry] }),
    });
    expect(store.list()).toEqual([valid, appEntry]);
    const r = raise(store, fields("t2", { key: "k" }), APP_SRC);
    expect(r).toMatchObject({ outcome: "updated", entry: { id: appEntry.id } });
  });

  it("an app-source record with no room loads", () => {
    const appEntry: PagerEntry = {
      ...valid,
      id: "2a2b2c2d",
      source: { ...APP_SRC, roomId: null },
    };
    const store = createPagerStore({
      persistence: memPersistence({ kind: "data", value: [appEntry] }),
    });
    expect(store.list()).toEqual([appEntry]);
  });

  it("valid records load, and dedupe continues across the load", () => {
    const store = createPagerStore({
      persistence: memPersistence({ kind: "data", value: [valid] }),
    });
    expect(store.list()).toEqual([valid]);
    const r = raise(store, fields("t2", { key: "k" }));
    expect(r.outcome).toBe("updated");
  });

  it("a bad record or an unparsable file is moved aside; the store starts empty", () => {
    for (const loaded of [
      { kind: "data", value: [valid, { ...valid, state: "weird" }] },
      // An agent source without a room.
      {
        kind: "data",
        value: [valid, { ...valid, source: { ...SRC, roomId: null } }],
      },
      // An app source without its registration generation.
      {
        kind: "data",
        value: [
          valid,
          { ...valid, source: { ...APP_SRC, registrationGen: undefined } },
        ],
      },
      { kind: "data", value: { not: "an array" } },
      { kind: "corrupt" },
    ] as PagerLoadResult[]) {
      const p = memPersistence(loaded);
      const store = createPagerStore({ persistence: p });
      expect(p.quarantined).toBe(1);
      expect(store.list()).toEqual([]);
      expect(raise(store, fields("x")).outcome).toBe("created");
    }
  });

  it("refuses every operation when the file cannot be moved aside or read", () => {
    const stuck = memPersistence({ kind: "corrupt" });
    stuck.quarantineOk = false;
    const unreadable = memPersistence({ kind: "unreadable" });
    for (const p of [stuck, unreadable]) {
      const store = createPagerStore({ persistence: p });
      expect(() => store.list()).toThrow(PagerUnavailableError);
      expect(() => store.get("x")).toThrow(PagerUnavailableError);
      expect(() => raise(store, fields("x"))).toThrow(PagerUnavailableError);
      expect(() => store.ack("x", "b")).toThrow(PagerUnavailableError);
      expect(() => store.resolve("x", "b")).toThrow(PagerUnavailableError);
      expect(() => store.pruneResolved()).toThrow(PagerUnavailableError);
      expect(p.saves).toBe(0);
    }
  });
});

describe("pager store: retention", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = 100 * DAY;
  const page = (
    id: string,
    state: PagerEntry["state"],
    resolvedAt?: number,
  ): PagerEntry => ({
    id,
    createdAt: 1,
    lastRaisedAt: 1,
    raiseCount: 1,
    source: SRC,
    targetUserId: "u1",
    title: id,
    state,
    ...(resolvedAt !== undefined
      ? { resolved: { by: "Boss", at: resolvedAt } }
      : {}),
    delivery: { state: "delivered", sends: 1 },
  });

  it("is 30 days", () => {
    expect(PAGER_RESOLVED_RETENTION_MS).toBe(30 * DAY);
  });

  it("the load deletes resolved pages past retention and saves; open and acked pages stay", () => {
    const old = page("00000001", "resolved", T0 - PAGER_RESOLVED_RETENTION_MS);
    const recent = page(
      "00000002",
      "resolved",
      T0 - PAGER_RESOLVED_RETENTION_MS + 1,
    );
    const open = page("00000003", "open");
    const acked = page("00000004", "acked");
    const p = memPersistence({
      kind: "data",
      value: [old, recent, open, acked],
    });
    const store = createPagerStore({ persistence: p, now: () => T0 });
    expect(store.list()).toEqual([recent, open, acked]);
    expect(p.saved).toEqual([recent, open, acked]);
    expect(p.saves).toBe(1);
  });

  it("a load with nothing to prune does not save", () => {
    const p = memPersistence({
      kind: "data",
      value: [page("00000001", "resolved", T0), page("00000002", "open")],
    });
    createPagerStore({ persistence: p, now: () => T0 });
    expect(p.saves).toBe(0);
  });

  it("a later prune deletes a page once its retention ends, and returns the count", () => {
    let t = T0;
    const p = memPersistence();
    const store = createPagerStore({ persistence: p, now: () => t });
    const a = created(raise(store, fields("a")));
    const b = created(raise(store, fields("b")));
    store.resolve(a.id, "Boss");
    t = T0 + DAY;
    store.resolve(b.id, "Boss");
    t = T0 + PAGER_RESOLVED_RETENTION_MS - 1;
    expect(store.pruneResolved()).toBe(0);
    t = T0 + PAGER_RESOLVED_RETENTION_MS;
    expect(store.pruneResolved()).toBe(1);
    expect(store.list().map((e) => e.id)).toEqual([b.id]);
    expect(p.saved?.map((e) => e.id)).toEqual([b.id]);
    expect(store.get(a.id)).toBeNull();
  });

  it("an acked or open page never expires, however old", () => {
    const p = memPersistence({
      kind: "data",
      value: [page("00000001", "open"), page("00000002", "acked")],
    });
    const store = createPagerStore({
      persistence: p,
      now: () => T0 + 10 * PAGER_RESOLVED_RETENTION_MS,
    });
    expect(store.pruneResolved()).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  it("a resolved page with no resolved time survives the load and a later prune", () => {
    const untimed = page("00000001", "resolved");
    const p = memPersistence({ kind: "data", value: [untimed] });
    let t = T0;
    const store = createPagerStore({ persistence: p, now: () => t });
    expect(store.list()).toEqual([untimed]);
    t = T0 + 10 * PAGER_RESOLVED_RETENTION_MS;
    expect(store.pruneResolved()).toBe(0);
    expect(store.list()).toEqual([untimed]);
    expect(p.saves).toBe(0);
  });

  it("a failed save throws and keeps the pages; a failed save at load keeps them too", () => {
    const old = page("00000001", "resolved", 0);
    const p = memPersistence({ kind: "data", value: [old] });
    p.failNextSave = true;
    let t = T0;
    const store = createPagerStore({ persistence: p, now: () => t });
    expect(store.list()).toEqual([old]);
    p.failNextSave = true;
    t = T0 + 1;
    expect(() => store.pruneResolved()).toThrow("disk full");
    expect(store.list()).toEqual([old]);
    expect(store.pruneResolved()).toBe(1);
    expect(store.list()).toEqual([]);
  });
});

describe("pager store: file persistence", () => {
  let dir = "";
  afterEach(() => {
    if (dir) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = "";
  });

  it("round-trips through the file", () => {
    dir = mkdtempSync(join(tmpdir(), "pager-store-"));
    const path = join(dir, "pager.json");
    const a = createPagerStore({
      persistence: createPagerFilePersistence(path),
    });
    const e = created(raise(a, fields("x", { key: "k", body: "b" })));
    a.ack(e.id, "Boss");
    const b = createPagerStore({
      persistence: createPagerFilePersistence(path),
    });
    expect(b.list()).toEqual(a.list());
  });

  it("an unreadable file is not an empty store: no write replaces its pages", () => {
    dir = mkdtempSync(join(tmpdir(), "pager-store-"));
    const parent = join(dir, "locked");
    mkdirSync(parent);
    const path = join(parent, "pager.json");
    const original = created(
      raise(
        createPagerStore({ persistence: createPagerFilePersistence(path) }),
        fields("original"),
      ),
    );
    chmodSync(parent, 0o600); // not searchable: the file cannot be read
    try {
      let code: string | undefined;
      try {
        readFileSync(path);
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      expect(code).toBe("EACCES");
      const store = createPagerStore({
        persistence: createPagerFilePersistence(path),
      });
      expect(() => store.list()).toThrow(PagerUnavailableError);
      chmodSync(parent, 0o700); // permissions recover; the store stays closed
      expect(() => raise(store, fields("replacement"))).toThrow(
        PagerUnavailableError,
      );
    } finally {
      chmodSync(parent, 0o700);
    }
    const reloaded = createPagerStore({
      persistence: createPagerFilePersistence(path),
    });
    expect(reloaded.list()).toEqual([original]);
  });

  it("moves an unparsable file aside instead of overwriting it", () => {
    dir = mkdtempSync(join(tmpdir(), "pager-store-"));
    const path = join(dir, "pager.json");
    writeFileSync(path, "{not json");
    const store = createPagerStore({
      persistence: createPagerFilePersistence(path),
    });
    expect(store.list()).toEqual([]);
    const aside = readdirSync(dir).filter((f) =>
      f.startsWith("pager.json.corrupt-"),
    );
    expect(aside).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });
});

describe("pager raise fields", () => {
  const bad = (raw: unknown) => {
    const r = parseRaiseFields(raw);
    expect(r.ok).toBe(false);
  };

  it("accepts the bounds and trims the title", () => {
    const r = parseRaiseFields({
      title: `  ${"t".repeat(PAGER_TITLE_MAX)} `,
      body: "b".repeat(PAGER_BODY_MAX),
      key: "k".repeat(PAGER_KEY_MAX),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.title).toBe("t".repeat(PAGER_TITLE_MAX));
  });

  it("an empty body is the same as no body", () => {
    const r = parseRaiseFields({ title: "t", body: "" });
    expect(r.ok && "body" in r.fields).toBe(false);
  });

  it("ignores fields it does not know, such as a source or a target", () => {
    const r = parseRaiseFields({ title: "t", source: "x", targetUserId: "y" });
    expect(r.ok && r.fields).toEqual({ title: "t" });
  });

  it("rejects bad shapes and lengths", () => {
    bad(undefined);
    bad("title");
    bad([]);
    bad({});
    bad({ title: "   " });
    bad({ title: 7 });
    bad({ title: "a\nb" });
    bad({ title: "a\rb" });
    bad({ title: "a\u2028b" });
    bad({ title: "t".repeat(PAGER_TITLE_MAX + 1) });
    bad({ title: "t", body: 1 });
    bad({ title: "t", body: "b".repeat(PAGER_BODY_MAX + 1) });
    bad({ title: "t", key: "" });
    bad({ title: "t", key: 1 });
    bad({ title: "t", key: "k".repeat(PAGER_KEY_MAX + 1) });
  });
});

describe("pager visibility", () => {
  const base: PagerEntry = {
    id: "0a0b0c0d",
    createdAt: 1,
    lastRaisedAt: 1,
    raiseCount: 1,
    source: SRC,
    targetUserId: "owner",
    title: "t",
    state: "open",
    delivery: { state: "not_delivered", sends: 0 },
  };
  const viewer = (
    rooms: string[],
    userId: string | null,
    isOfficeOwner = false,
  ) => ({ accessibleRoomIds: new Set(rooms), userId, isOfficeOwner });

  it("an agent page: the stored room only, not its manager or an office owner by role", () => {
    expect(pagerEntryVisible(base, viewer(["r1"], "x"))).toBe(true);
    expect(pagerEntryVisible(base, viewer([], "owner"))).toBe(false);
    expect(pagerEntryVisible(base, viewer([], "x", true))).toBe(false);
  });

  it("an app page: the stored room, the app owner and office owners", () => {
    const app: PagerEntry = { ...base, source: APP_SRC };
    expect(pagerEntryVisible(app, viewer(["r1"], "x"))).toBe(true);
    expect(pagerEntryVisible(app, viewer([], "owner"))).toBe(true);
    expect(pagerEntryVisible(app, viewer([], "x", true))).toBe(true);
    expect(pagerEntryVisible(app, viewer(["r2"], "x"))).toBe(false);
    expect(pagerEntryVisible(app, viewer([], null))).toBe(false);
  });

  it("an app page with no room: the app owner and office owners only", () => {
    const app: PagerEntry = { ...base, source: { ...APP_SRC, roomId: null } };
    expect(pagerEntryVisible(app, viewer(["r1"], "x"))).toBe(false);
    expect(pagerEntryVisible(app, viewer([], "owner"))).toBe(true);
    expect(pagerEntryVisible(app, viewer([], "x", true))).toBe(true);
  });
});

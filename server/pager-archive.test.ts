// The resolved-page archive (task af346c0c): resolved pages with nothing owed
// leave memory and pager.json for pager-resolved.jsonl; the move survives a
// crash and failed writes with no page lost and none doubled; the previous
// release's pager.json stays readable; bad archive lines are skipped and
// counted; slices come newest-archived first.

import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createPagerArchiveFile,
  createPagerFilePersistence,
  type PagerLoadResult,
  type PagerPersistence,
  type PagerStore,
} from "./pager-store.ts";
import {
  createMemoryPagerArchive,
  createTestPagerStore,
} from "./test-support/pager-memory-archive.ts";
import {
  comparePagerResolve,
  type PagerEntry,
  type PagerSource,
} from "../shared/types.ts";

// load() reads what the last save left, so a second store over the same
// persistence is a restart.
function memPersistence(initial: PagerEntry[] | null = null) {
  const p = {
    saved: initial,
    saves: 0,
    failNextSave: false,
    load: (): PagerLoadResult =>
      p.saved === null
        ? { kind: "missing" }
        : { kind: "data", value: structuredClone(p.saved) },
    save(entries: PagerEntry[]) {
      if (p.failNextSave) {
        p.failNextSave = false;
        throw new Error("disk full");
      }
      p.saves++;
      p.saved = structuredClone(entries);
    },
    quarantine: () => true,
  };
  return p satisfies PagerPersistence;
}

const SRC: PagerSource = {
  kind: "agent",
  agentId: "a1",
  name: "Bot",
  roomId: "r1",
};

// A saved page, as a release with or without the archive wrote it.
function saved(id: string, patch: Partial<PagerEntry> = {}): PagerEntry {
  return {
    id,
    createdAt: 1,
    lastRaisedAt: 1,
    raiseCount: 1,
    source: SRC,
    targetUserId: "u1",
    title: `t-${id}`,
    state: "open",
    delivery: { state: "delivered", sends: 1 },
    ...patch,
  };
}

// Resolved with its "resolved" message sent: nothing owed.
const done = (id: string, at = 1) =>
  saved(id, {
    state: "resolved",
    resolved: { by: "Morgan", at },
    delivery: { state: "delivered", sends: 1, resolvedNotice: "done" },
  });

const ids = (entries: PagerEntry[] | null) => (entries ?? []).map((e) => e.id);
const archivedIds = (a: { lines: string[] }) =>
  a.lines.map((l) => (JSON.parse(l) as PagerEntry).id);
const all = () => true;

function raiseOne(store: PagerStore, title: string) {
  const r = store.raise({ source: SRC, targetUserId: "u1", fields: { title } });
  if (r.outcome !== "created") throw new Error(r.outcome);
  return r.entry;
}

const errors: string[] = [];
const origError = console.error;
function captureErrors() {
  errors.length = 0;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
}
afterEach(() => {
  console.error = origError;
});

describe("pager archive: the move", () => {
  it("a resolved page stays in memory and pager.json until its resolved message is sent, then moves", () => {
    const p = memPersistence();
    const a = createMemoryPagerArchive();
    const store = createTestPagerStore({ persistence: p, archive: a });
    const e = raiseOne(store, "x");
    store.resolve(e.id, "Morgan");
    // Owed: still here, for delivery to find.
    expect(ids(p.saved)).toEqual([e.id]);
    expect(a.lines).toEqual([]);
    const last = store.get(e.id)!;
    store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" });
    expect(p.saved).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(store.get(e.id)).toBeNull();
    expect(archivedIds(a)).toEqual([e.id]);
    expect((JSON.parse(a.lines[0]) as PagerEntry).delivery.resolvedNotice).toBe(
      "done",
    );
  });

  it("an append that fails keeps the page in pager.json, and the next write moves it", async () => {
    captureErrors();
    const p = memPersistence();
    const a = createMemoryPagerArchive();
    const store = createTestPagerStore({ persistence: p, archive: a });
    const e = raiseOne(store, "x");
    store.resolve(e.id, "Morgan");
    a.failNextAppend = true;
    const last = store.get(e.id)!;
    store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" });
    expect(ids(p.saved)).toEqual([e.id]);
    expect(a.lines).toEqual([]);
    expect(errors.join("\n")).toContain("cannot append");
    raiseOne(store, "y");
    expect(archivedIds(a)).toEqual([e.id]);
    expect(ids(p.saved)).not.toContain(e.id);
    // Listed once, as resolved.
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual([e.id]);
  });

  it("an append that lands with a save that fails, again and again, appends the page once", async () => {
    const p = memPersistence();
    const a = createMemoryPagerArchive();
    const store = createTestPagerStore({ persistence: p, archive: a });
    const e = raiseOne(store, "x");
    store.resolve(e.id, "Morgan");
    const last = store.get(e.id)!;
    p.failNextSave = true;
    expect(() =>
      store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" }),
    ).toThrow("disk full");
    // Enabling condition: the append landed, and the page is still owed.
    expect(archivedIds(a)).toEqual([e.id]);
    expect(store.get(e.id)!.delivery.resolvedNotice).toBe("pending");
    p.failNextSave = true;
    expect(() =>
      store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" }),
    ).toThrow("disk full");
    p.failNextSave = true;
    expect(() => raiseOne(store, "y")).toThrow("disk full");
    store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" });
    expect(archivedIds(a)).toEqual([e.id]);
    expect(ids(p.saved)).not.toContain(e.id);
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual([e.id]);
  });

  it("a resolved page owed its message, done, appended, then a failed save and a restart: archived once", async () => {
    // Reviewer 3's R1: the page is pending in pager.json, the done copy is in
    // the archive, and the process restarts before any save lands.
    const p = memPersistence();
    const a = createMemoryPagerArchive();
    const first = createTestPagerStore({ persistence: p, archive: a });
    const e = raiseOne(first, "x");
    first.resolve(e.id, "Morgan");
    const last = first.get(e.id)!;
    p.failNextSave = true;
    expect(() =>
      first.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" }),
    ).toThrow("disk full");
    // Enabling condition: the done copy reached the archive, pager.json still
    // holds the pending one, and the move record is set.
    expect(archivedIds(a)).toEqual([e.id]);
    expect(p.saved![0].delivery.resolvedNotice).toBe("pending");
    expect(a.intent).not.toBeNull();
    // Restart: the boot cuts the unfinished append; the page is still owed.
    const again = createTestPagerStore({ persistence: p, archive: a });
    expect(a.lines).toEqual([]);
    expect(a.intent).toBeNull();
    expect(again.get(e.id)!.delivery.resolvedNotice).toBe("pending");
    const owed = again.get(e.id)!;
    again.recordDelivery(e.id, { ...owed.delivery, resolvedNotice: "done" });
    expect(archivedIds(a)).toEqual([e.id]);
    const slice = await again.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual([e.id]);
    expect(await again.findArchived(e.id)).not.toBeNull();
  });

  it("an append that writes part of its batch and then throws: the next write cuts it and moves the pages once", async () => {
    captureErrors();
    const a = createMemoryPagerArchive();
    a.lines.push(JSON.stringify(done("old", 1)));
    const p = memPersistence([saved("o1")]);
    // A clock that moves, so e1 resolves before e2.
    let t = 10;
    const store = createTestPagerStore({
      persistence: p,
      archive: a,
      now: () => t++,
    });
    const e1 = raiseOne(store, "x1");
    const e2 = raiseOne(store, "x2");
    store.resolve(e1.id, "Morgan");
    store.resolve(e2.id, "Morgan");
    a.tornNextAppend = true;
    const d1 = store.get(e1.id)!;
    store.recordDelivery(e1.id, { ...d1.delivery, resolvedNotice: "done" });
    const d2 = store.get(e2.id)!;
    // Enabling condition: a torn line sits at the archive's end.
    a.tornNextAppend = true;
    store.recordDelivery(e2.id, { ...d2.delivery, resolvedNotice: "done" });
    expect(a.lines.length).toBeGreaterThan(1);
    expect(() => JSON.parse(a.lines.at(-1)!)).toThrow();
    raiseOne(store, "next write");
    expect(a.lines.map((l) => (JSON.parse(l) as PagerEntry).id)).toEqual([
      "old",
      e1.id,
      e2.id,
    ]);
    expect(a.intent).toBeNull();
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual([e2.id, e1.id, "old"]);
  });

  it("a crash after the save but before the record is cleared: the boot only clears it", () => {
    const a = createMemoryPagerArchive();
    a.lines.push(JSON.stringify(done("p1")));
    a.intent = { size: 0, ids: ["p1"] };
    const p = memPersistence([saved("o1")]);
    createTestPagerStore({ persistence: p, archive: a });
    expect(archivedIds(a)).toEqual(["p1"]);
    expect(a.intent).toBeNull();
  });

  // A record whose pages are only partly in pager.json, or one that cannot be
  // read, is not a state this store writes: moves pause and nothing is cut.
  for (const intent of [{ size: 0, ids: ["p1", "p2"] }, "corrupt" as const]) {
    it(`a ${intent === "corrupt" ? "damaged record" : "record whose pages are only partly in pager.json"} pauses moves and cuts nothing`, () => {
      captureErrors();
      const a = createMemoryPagerArchive();
      a.lines.push(JSON.stringify(done("p1")), JSON.stringify(done("p2")));
      a.intent = structuredClone(intent);
      const p = memPersistence([done("p2"), done("p3")]);
      const store = createTestPagerStore({ persistence: p, archive: a });
      expect(archivedIds(a)).toEqual(["p1", "p2"]);
      expect(ids(store.list())).toEqual(["p2", "p3"]);
      expect(errors.join("\n")).toContain("moves are paused");
    });
  }
});

describe("pager archive: resolve order", () => {
  const owed = (id: string, at: number) =>
    saved(id, {
      state: "resolved",
      resolved: { by: "Morgan", at },
      delivery: { state: "delivered", sends: 1, resolvedNotice: "pending" },
    });

  it("walking one page at a time across interleaved completions returns every page once, in order", async () => {
    const a = createMemoryPagerArchive();
    const p = memPersistence([
      owed("r1", 1),
      owed("r2", 2),
      owed("r3", 3),
      owed("r4", 4),
    ]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    const finish = (id: string) => {
      const e = store.get(id)!;
      store.recordDelivery(id, { ...e.delivery, resolvedNotice: "done" });
    };
    const seen: string[] = [];
    let before: string | undefined;
    const steps = [
      () => finish("r3"),
      () => finish("r1"),
      () => finish("r4"),
      () => finish("r2"),
    ];
    for (let i = 0; i < 4; i++) {
      const s = await store.listResolved({ accept: all, limit: 1, before });
      if (!s.ok) throw new Error("cursor refused");
      seen.push(...ids(s.entries));
      before = seen.at(-1);
      steps[i]();
      // r3 is done first, but it waits behind the older pages still owed.
      if (i === 0) expect(a.lines).toEqual([]);
    }
    expect(seen).toEqual(["r4", "r3", "r2", "r1"]);
    expect(archivedIds(a)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("pages resolved in the same millisecond keep one order, by id, before and after the move", async () => {
    const a = createMemoryPagerArchive();
    const p = memPersistence([owed("b", 5), owed("a", 5), owed("c", 5)]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    const list = async () => {
      const s = await store.listResolved({ accept: all, limit: 10 });
      return s.ok ? ids(s.entries) : [];
    };
    expect(await list()).toEqual(["c", "b", "a"]);
    for (const id of ["c", "a", "b"]) {
      const e = store.get(id)!;
      store.recordDelivery(id, { ...e.delivery, resolvedNotice: "done" });
    }
    expect(archivedIds(a)).toEqual(["a", "b", "c"]);
    expect(await list()).toEqual(["c", "b", "a"]);
  });

  it("resolves in the same millisecond, moved separately and across a restart, keep one order", async () => {
    // Reviewer 3's R2a: z is resolved and archived before a, in the same ms.
    const a = createMemoryPagerArchive();
    const p = memPersistence([saved("z"), saved("a"), saved("m")]);
    const first = createTestPagerStore({
      persistence: p,
      archive: a,
      now: () => 100,
    });
    for (const id of ["z", "a"]) {
      first.resolve(id, "Morgan");
      const e = first.get(id)!;
      first.recordDelivery(id, { ...e.delivery, resolvedNotice: "done" });
    }
    // A restart in the same millisecond, then m.
    const again = createTestPagerStore({
      persistence: p,
      archive: a,
      now: () => 100,
    });
    again.resolve("m", "Morgan");
    const m = again.get("m")!;
    again.recordDelivery("m", { ...m.delivery, resolvedNotice: "done" });
    const pages = a.lines.map((l) => JSON.parse(l) as PagerEntry);
    expect(pages.map((e) => e.id)).toEqual(["z", "a", "m"]);
    // Resolve times rise in archive order, so the comparison agrees with it.
    expect(pages.map((e) => e.resolved!.at)).toEqual([100, 101, 102]);
    expect([...pages].sort(comparePagerResolve).map((e) => e.id)).toEqual([
      "z",
      "a",
      "m",
    ]);
    const all = await again.listResolved({ accept: () => true, limit: 10 });
    expect(all.ok && ids(all.entries)).toEqual(["m", "a", "z"]);
    const afterA = await again.listResolved({
      accept: () => true,
      limit: 10,
      before: "a",
    });
    expect(afterA.ok && ids(afterA.entries)).toEqual(["z"]);
  });
});

describe("pager archive: update and rollback", () => {
  it("the first boot after an update moves every resolved page with nothing owed, in one append, in resolve order", () => {
    const a = createMemoryPagerArchive();
    const owed = saved("owed", {
      state: "resolved",
      resolved: { by: "Morgan", at: 3 },
      delivery: { state: "delivered", sends: 1, resolvedNotice: "pending" },
    });
    // A page resolved before resolvedNotice existed has none.
    const legacy = saved("ab12cd34", {
      state: "resolved",
      resolved: { by: "Morgan", at: 1 },
    });
    // Raise order differs from resolve order: d2 was raised first.
    const p = memPersistence([saved("o1"), done("d2", 2), legacy, owed]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    expect(a.appends).toBe(1);
    expect(archivedIds(a)).toEqual(["ab12cd34", "d2"]);
    expect(ids(p.saved)).toEqual(["o1", "owed"]);
    expect(ids(store.list())).toEqual(["o1", "owed"]);
  });

  it("pages the previous release resolved while rolled back move on the next update, after the archive's own", async () => {
    const a = createMemoryPagerArchive();
    a.lines.push(JSON.stringify(done("a1", 1)), JSON.stringify(done("a2", 2)));
    // The previous release kept its resolved page in pager.json and raised a
    // new 8-character one.
    const p = memPersistence([done("r1", 5), saved("0a0b0c0d")]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    expect(archivedIds(a)).toEqual(["a1", "a2", "r1"]);
    expect(ids(p.saved)).toEqual(["0a0b0c0d"]);
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual(["r1", "a2", "a1"]);
  });
});

describe("pager archive: reads", () => {
  it("lists owed pages first (newest resolve first), then the archive from its end, with the limit and the cursor", async () => {
    const a = createMemoryPagerArchive();
    for (let i = 1; i <= 5; i++) a.lines.push(JSON.stringify(done(`a${i}`, i)));
    const owed = (id: string, at: number) =>
      saved(id, {
        state: "resolved",
        resolved: { by: "Morgan", at },
        delivery: { state: "delivered", sends: 1, resolvedNotice: "pending" },
      });
    const p = memPersistence([owed("o1", 10), saved("open"), owed("o2", 20)]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    const read = async (limit: number, before?: string) => {
      const s = await store.listResolved({ accept: all, limit, before });
      return s.ok ? ids(s.entries) : "bad";
    };
    expect(await read(10)).toEqual(["o2", "o1", "a5", "a4", "a3", "a2", "a1"]);
    expect(await read(3)).toEqual(["o2", "o1", "a5"]);
    expect(await read(3, "a5")).toEqual(["a4", "a3", "a2"]);
    expect(await read(3, "a2")).toEqual(["a1"]);
    expect(await read(3, "a1")).toEqual([]);
    expect(await read(3, "nope")).toBe("bad");
    expect(await read(3, "open")).toBe("bad");
  });

  it("a page archived while a member pages through is neither skipped nor lost", async () => {
    const a = createMemoryPagerArchive();
    a.lines.push(JSON.stringify(done("a1", 1)), JSON.stringify(done("a2", 2)));
    const p = memPersistence();
    const store = createTestPagerStore({ persistence: p, archive: a });
    const e = raiseOne(store, "x");
    store.resolve(e.id, "Morgan");
    const first = await store.listResolved({ accept: all, limit: 2 });
    expect(first.ok && ids(first.entries)).toEqual([e.id, "a2"]);
    // The owed message goes out: the page moves to the archive's end.
    const last = store.get(e.id)!;
    store.recordDelivery(e.id, { ...last.delivery, resolvedNotice: "done" });
    const next = await store.listResolved({
      accept: all,
      limit: 2,
      before: "a2",
    });
    expect(next.ok && ids(next.entries)).toEqual(["a1"]);
  });

  it("skips and counts lines that are not pages, and stays available", async () => {
    captureErrors();
    const a = createMemoryPagerArchive();
    a.lines.push(
      JSON.stringify(done("a1")),
      "not json",
      JSON.stringify({ id: "x" }),
      JSON.stringify(done("a2")),
      JSON.stringify(done("a3")).slice(0, 30),
    );
    const store = createTestPagerStore({
      persistence: memPersistence(),
      archive: a,
    });
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && ids(slice.entries)).toEqual(["a2", "a1"]);
    expect(errors.join("\n")).toMatch(/skipped 3\b/);
    expect((await store.findArchived("a1"))?.id).toBe("a1");
    expect(raiseOne(store, "still works").state).toBe("open");
  });

  it("a page in memory and in the archive is answered from memory, once", async () => {
    const a = createMemoryPagerArchive();
    a.lines.push(JSON.stringify(done("p1")));
    const p = memPersistence([
      saved("p1", {
        state: "resolved",
        resolved: { by: "Morgan", at: 1 },
        delivery: { state: "delivered", sends: 1, resolvedNotice: "pending" },
      }),
    ]);
    const store = createTestPagerStore({ persistence: p, archive: a });
    expect(store.get("p1")?.delivery.resolvedNotice).toBe("pending");
    expect(await store.findArchived("p1")).toBeNull();
    // Listed once, from memory.
    const slice = await store.listResolved({ accept: all, limit: 10 });
    expect(slice.ok && slice.entries).toEqual([store.get("p1")!]);
  });
});

describe("pager archive: the file", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function scanAll(path: string) {
    const out: (string | null)[] = [];
    for await (const line of createPagerArchiveFile(path).scan())
      out.push(line);
    return out;
  }

  it("a missing file is an empty archive", async () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const path = join(dir, "pager-resolved.jsonl");
    const archive = createPagerArchiveFile(path);
    expect(archive.size()).toBe(0);
    expect(archive.readIntent()).toBeNull();
    expect(await scanAll(path)).toEqual([]);
  });

  it("appends whole lines, starting a new line after a partial one, and reads them newest first across chunks", async () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const path = join(dir, "pager-resolved.jsonl");
    const archive = createPagerArchiveFile(path);
    // Pages bigger than a read chunk, so lines straddle chunk edges.
    const big = (id: string) => ({ ...done(id), body: "b".repeat(70_000) });
    archive.append([big("a1"), big("a2")]);
    appendFileSync(path, '{"id":"partial');
    archive.append([big("a3")]);
    const lines = await scanAll(path);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('{"id":"partial');
    const pages = lines
      .filter((l) => l !== lines[1])
      .map((l) => JSON.parse(l!).id);
    expect(pages).toEqual(["a3", "a2", "a1"]);
  });

  it("a short write is finished, a write that makes no progress throws, and truncate cuts back", async () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const path = join(dir, "pager-resolved.jsonl");
    let shortWrites = 0;
    const short = createPagerArchiveFile(path, {
      // At most 100 bytes per call, as a kernel may take.
      writeSync: (fd, buf, offset, length) => {
        const n = writeSync(fd, buf, offset, Math.min(length, 100));
        if (n > 0 && n < length) shortWrites++;
        return n;
      },
      fsyncSync,
    });
    short.append([done("a1"), done("a2")]);
    // Enabling condition: the kernel took less than it was given.
    expect(shortWrites).toBeGreaterThan(0);
    expect((await scanAll(path)).map((l) => JSON.parse(l!).id)).toEqual([
      "a2",
      "a1",
    ]);
    const at = short.size();
    const stuck = createPagerArchiveFile(path, {
      writeSync: (fd, buf, offset) =>
        offset === 0 ? writeSync(fd, buf, 0, 10) : 0,
      fsyncSync,
    });
    expect(() => stuck.append([done("a3")])).toThrow("no progress");
    expect(short.size()).toBe(at + 10);
    short.truncate(at);
    expect((await scanAll(path)).map((l) => JSON.parse(l!).id)).toEqual([
      "a2",
      "a1",
    ]);
  });

  it("the move record round-trips, and a damaged one reads as corrupt", () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const path = join(dir, "pager-resolved.jsonl");
    const archive = createPagerArchiveFile(path);
    archive.writeIntent({ size: 7, ids: ["x"] });
    expect(archive.readIntent()).toEqual({ size: 7, ids: ["x"] });
    writeFileSync(`${path}.move`, "{");
    expect(archive.readIntent()).toBe("corrupt");
    archive.clearIntent();
    expect(archive.readIntent()).toBeNull();
  });

  it("over the files: a short write, a failed fsync and a crash before the save each end with every page archived once", async () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const json = join(dir, "pager.json");
    const jsonl = join(dir, "pager-resolved.jsonl");
    // An update from a release without the archive, with a batch of resolved
    // pages larger than one write call takes.
    const old = Array.from({ length: 20 }, (_, i) => ({
      ...done(`p${String(i).padStart(3, "0")}`, i + 1),
      body: "b".repeat(15_000),
    }));
    writeFileSync(json, JSON.stringify(old));
    // The first boot's fsync fails after the whole batch is written.
    const WRITE_CAP = 100_000;
    let failFsync = true;
    const io = {
      writeSync: (fd: number, buf: Buffer, offset: number, length: number) =>
        writeSync(fd, buf, offset, Math.min(length, WRITE_CAP)),
      fsyncSync: (fd: number) => {
        if (failFsync) throw new Error("EIO");
        fsyncSync(fd);
      },
    };
    captureErrors();
    createTestPagerStore({
      persistence: createPagerFilePersistence(json),
      archive: createPagerArchiveFile(jsonl, io),
    });
    // Enabling condition: the batch, which took several short writes, is on
    // disk, and pager.json still holds it.
    expect(readFileSync(jsonl, "utf-8").length).toBeGreaterThan(2 * WRITE_CAP);
    expect((JSON.parse(readFileSync(json, "utf-8")) as unknown[]).length).toBe(
      20,
    );
    // The next boot: the save fails this time (a crash before it).
    failFsync = false;
    const crashing = createPagerFilePersistence(json);
    createTestPagerStore({
      persistence: {
        ...crashing,
        save: () => {
          throw new Error("crash");
        },
      },
      archive: createPagerArchiveFile(jsonl, io),
    });
    // And the next one lands.
    const store = createTestPagerStore({
      persistence: createPagerFilePersistence(json),
      archive: createPagerArchiveFile(jsonl, io),
    });
    expect(JSON.parse(readFileSync(json, "utf-8"))).toEqual([]);
    const lines = readFileSync(jsonl, "utf-8").split("\n").filter(Boolean);
    expect(lines.map((l) => (JSON.parse(l) as PagerEntry).id)).toEqual(
      old.map((e) => e.id),
    );
    const slice = await store.listResolved({ accept: all, limit: 20 });
    expect(slice.ok && slice.entries.length).toBe(20);
  });

  it("a line too long to be a page reads as one bad line", async () => {
    dir = mkdtempSync(join(tmpdir(), "pager-archive-"));
    const path = join(dir, "pager-resolved.jsonl");
    writeFileSync(
      path,
      // Over the 1 MiB line limit by more than one 64 KiB read chunk: the
      // reader notices at a chunk edge.
      JSON.stringify(done("a1")) +
        "\n" +
        "x".repeat(1024 * 1024 + 2 * 64 * 1024) +
        "\n",
    );
    createPagerArchiveFile(path).append([done("a2")]);
    const lines = await scanAll(path);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).id).toBe("a2");
    expect(lines[1]).toBeNull();
    expect(JSON.parse(lines[2]!).id).toBe("a1");
  });
});

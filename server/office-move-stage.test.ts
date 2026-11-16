// The stage of an office move on the new office (task 78733adf, slice 2b):
// the safe writer and the final check, driven with crafted record events.
// The [R] conditions here: extract only the paths the new box asked for,
// refuse absolute paths and "..", never follow a link in the stage while
// writing; the check comes from the ledger of trailers (a SQLite entry by
// its trailer, never the manifest size), not from the size on disk.
//
// The whole pull against the real old office is in office-move-in.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoveManifestEntry, MoveRecordEvent } from "./office-move-pull.ts";
import {
  createMoveStage,
  isSafeMovePath,
  MoveStageError,
  type MoveStage,
  type MoveStageItem,
} from "./office-move-stage.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    // A read-only folder in the stage must not stop the cleanup.
    try {
      for (const p of [join(dir, "stage", "ro")])
        if (existsSync(p)) chmodSync(p, 0o700);
    } catch {
      // Gone already.
    }
    rmSync(dir, { recursive: true, force: true });
  }
  dir = "";
});

const MTIME = Date.parse("2026-10-01T12:00:00Z");

function fresh(): { stage: MoveStage; root: string } {
  dir = mkdtempSync(join(tmpdir(), "office-move-stage-"));
  const root = join(dir, "stage");
  return { stage: createMoveStage(root), root };
}

const f = (
  p: string,
  s: number,
  extra: Partial<MoveManifestEntry> = {},
): MoveManifestEntry => ({ p, t: "f", s, m: MTIME, mode: 0o644, ...extra });
const d = (p: string, mode = 0o755): MoveManifestEntry => ({
  p,
  t: "d",
  s: 4096,
  m: MTIME,
  mode,
});
const l = (p: string, target: string): MoveManifestEntry => ({
  p,
  t: "l",
  s: target.length,
  m: MTIME,
  mode: 0o777,
  l: target,
});

async function* each<T>(list: T[]): AsyncGenerator<T> {
  for (const x of list) yield x;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The events of one item as the old office sends them. */
function itemEvents(
  entry: MoveManifestEntry,
  content: Buffer,
  opts: { offset?: number; q?: 1 } = {},
): MoveRecordEvent[] {
  return [
    {
      type: "entry",
      path: entry.p,
      t: "f",
      mode: entry.mode,
      mtime: entry.m,
      ...(opts.q ? { q: 1 as const } : {}),
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
    },
    { type: "data", bytes: content },
    { type: "end", bytes: content.length, sha256: sha(content) },
  ];
}

const item = (
  entry: MoveManifestEntry,
  range?: { offset: number; length: number },
): MoveStageItem => ({ path: entry.p, entry, ...(range ?? {}) });

/** Prepares every entry, in manifest order. */
function prepareAll(stage: MoveStage, entries: MoveManifestEntry[]): void {
  for (const e of entries) stage.prepare(e);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

const missingPaths = (c: { missing: { path: string }[] }) =>
  c.missing.map((m) => m.path).sort();

describe("isSafeMovePath", () => {
  it("takes only a relative path with plain segments", () => {
    const good = [
      "a",
      "a/b",
      ".hidden",
      "a/.b",
      "..a",
      "a..",
      "a/b..",
      "a b/c",
    ];
    const bad = [
      "",
      "/a",
      "/",
      "..",
      ".",
      "../a",
      "a/..",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "a\0b",
    ];
    expect({
      good: good.filter((p) => !isSafeMovePath(p)),
      bad: bad.filter((p) => isSafeMovePath(p)),
    }).toEqual({ good: [], bad: [] });
  });
});

describe("pass 1 (prepare)", () => {
  it("refuses an absolute path and a '..' path, and makes nothing outside the stage", () => {
    const { stage } = fresh();
    const outside = join(dir, "escape");
    const errs = [
      { p: "../escape", t: "d" as const },
      { p: outside, t: "d" as const },
      { p: "a/../../escape", t: "d" as const },
    ].map((e) => {
      try {
        stage.prepare({ ...e, s: 0, m: MTIME, mode: 0o755 });
        return null;
      } catch (err) {
        return err instanceof MoveStageError ? err.code : String(err);
      }
    });
    expect(errs).toEqual(["unsafe_path", "unsafe_path", "unsafe_path"]);
    expect(existsSync(outside)).toBe(false);
  });

  it("refuses a duplicate path, and a path under an entry the manifest lists as a link or a file", () => {
    const { stage, root } = fresh();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const code = (e: MoveManifestEntry) => {
      try {
        stage.prepare(e);
        return null;
      } catch (err) {
        return err instanceof MoveStageError ? err.code : String(err);
      }
    };
    expect({
      dir: code(d("x")),
      dup: code(f("x", 3)),
      link: code(l("ln", outside)),
      underLink: code(f("ln/planted", 3)),
      file: code(f("plain", 3)),
      underFile: code(f("plain/child", 3)),
    }).toEqual({
      dir: null,
      dup: "duplicate_path",
      link: null,
      underLink: "parent_not_dir",
      file: null,
      underFile: "parent_not_dir",
    });
    // Links are only listed in pass 1: nothing was written through one.
    expect(existsSync(join(outside, "planted"))).toBe(false);
    expect(existsSync(join(root, "ln"))).toBe(false);
  });

  it("refuses a stage folder that already exists", () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-stage-"));
    const root = join(dir, "stage");
    mkdirSync(root);
    writeFileSync(join(root, "left-over"), "x");
    expect(() => createMoveStage(root)).toThrow();
  });
});

describe("a batch's records", () => {
  it("copies files, folders and links as the manifest says; drops setuid and setgid; a read-only folder gets its mode last", async () => {
    const { stage, root } = fresh();
    const a = Buffer.from("alpha");
    const s = Buffer.from("#!/bin/sh\n");
    const r = Buffer.from("inside");
    const entries = [
      d("docs", 0o750),
      f("docs/a.txt", a.length, { mode: 0o640 }),
      l("docs/ln", "a.txt"),
      f("suid", s.length, { mode: 0o6755 }),
      d("ro", 0o500),
      f("ro/f", r.length),
      f("empty", 0),
    ];
    prepareAll(stage, entries);
    const items = [entries[1], entries[3], entries[5], entries[6]];
    const results = await stage.writeBatch(
      { n: 0, items: items.map((e) => item(e)) },
      each([
        ...itemEvents(entries[1], a),
        ...itemEvents(entries[3], s),
        ...itemEvents(entries[5], r),
        ...itemEvents(entries[6], Buffer.alloc(0)),
      ]),
    );
    expect(results.filter((x) => "error" in x)).toEqual([]);
    await stage.finish(each(entries));
    const check = await stage.check(each(entries));
    expect({ complete: check.complete, missing: check.missing }).toEqual({
      complete: true,
      missing: [],
    });
    const mode = (p: string) => lstatSync(join(root, p)).mode & 0o7777;
    expect({
      a: readFileSync(join(root, "docs/a.txt"), "utf8"),
      aMode: mode("docs/a.txt"),
      aMtime: statSync(join(root, "docs/a.txt")).mtimeMs,
      docsMode: mode("docs"),
      link: readlinkSync(join(root, "docs/ln")),
      suidMode: mode("suid"),
      ro: readFileSync(join(root, "ro/f"), "utf8"),
      roMode: mode("ro"),
      empty: statSync(join(root, "empty")).size,
    }).toEqual({
      a: "alpha",
      aMode: 0o640,
      aMtime: MTIME,
      docsMode: 0o750,
      link: "a.txt",
      suidMode: 0o755,
      ro: "inside",
      roMode: 0o500,
      empty: 0,
    });
  });

  it("writes ranges in any order and a retry rewrites its own bytes without losing the others", async () => {
    const { stage, root } = fresh();
    const content = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 251));
    const big = f("big", content.length);
    prepareAll(stage, [big]);
    const range = (n: number) =>
      stage.writeBatch(
        {
          n,
          items: [item(big, { offset: n * 100, length: 100 })],
        },
        each(
          itemEvents(big, content.subarray(n * 100, n * 100 + 100), {
            offset: n * 100,
          }),
        ),
      );
    // The last range first: the file exists from pass 1.
    await range(2);
    await range(0);
    await range(1);
    // A retry of the first range after the others are in.
    await range(0);
    await stage.finish(each([big]));
    const check = await stage.check(each([big]));
    expect(check.complete).toBe(true);
    expect(readFileSync(join(root, "big")).equals(content)).toBe(true);
  });

  it("the check reads the ledger: a range that never came is missing although the file has its full size", async () => {
    const { stage, root } = fresh();
    const content = Buffer.alloc(300, 7);
    const big = f("big", 300);
    const short = f("short", 10);
    prepareAll(stage, [big, short]);
    for (const n of [0, 2])
      await stage.writeBatch(
        { n, items: [item(big, { offset: n * 100, length: 100 })] },
        each(
          itemEvents(big, content.subarray(n * 100, n * 100 + 100), {
            offset: n * 100,
          }),
        ),
      );
    // An end shorter than asked (the file shrank on the old box).
    await stage.writeBatch(
      { n: 3, items: [item(short)] },
      each(itemEvents(short, Buffer.from("12345"))),
    );
    await stage.finish(each([big, short]));
    // The condition: on disk the hole does not show.
    expect(statSync(join(root, "big")).size).toBe(300);
    const check = await stage.check(each([big, short]));
    expect({ complete: check.complete, missing: missingPaths(check) }).toEqual({
      complete: false,
      missing: ["big", "short"],
    });
  });

  it("checks a SQLite entry against its trailer, never the manifest size", async () => {
    const { stage } = fresh();
    // The live file was 8 KiB; its snapshot is 4 KiB.
    const db = f("data/app.sqlite", 8192, { q: 1 });
    const entries = [d("data"), db];
    prepareAll(stage, entries);
    const snapshot = Buffer.alloc(4096, 1);
    await stage.writeBatch(
      { n: 0, items: [item(db)] },
      each(itemEvents(db, snapshot, { q: 1 })),
    );
    await stage.finish(each(entries));
    const check = await stage.check(each(entries));
    expect({ complete: check.complete, missing: check.missing }).toEqual({
      complete: true,
      missing: [],
    });
  });

  it("an item the old office could not read is missing, with its reason", async () => {
    const { stage } = fresh();
    const a = f("a", 3);
    const b = f("b", 3);
    prepareAll(stage, [a, b]);
    const results = await stage.writeBatch(
      { n: 0, items: [item(a), item(b)] },
      each([
        ...itemEvents(a, Buffer.from("aaa")),
        { type: "error", path: "b", error: "EACCES" } as MoveRecordEvent,
      ]),
    );
    expect(results.map((r) => ("error" in r ? r.path : null))).toEqual([
      null,
      "b",
    ]);
    await stage.finish(each([a, b]));
    const check = await stage.check(each([a, b]));
    expect({ complete: check.complete, missing: missingPaths(check) }).toEqual({
      complete: false,
      missing: ["b"],
    });
    expect(check.missing[0].reason.length).toBeGreaterThan(0);
  });
});

// D3: a record stream that does not match its request fails the whole batch
// (the pull runs it again), and the batch's ledger rows are dropped: the
// first item, written fine before the bad record, is missing afterwards.
describe("a record stream that does not match the request", () => {
  const A = Buffer.from("aaaa");
  const cases: {
    name: string;
    events: (a: MoveManifestEntry, b: MoveManifestEntry) => MoveRecordEvent[];
    items?: (a: MoveManifestEntry, b: MoveManifestEntry) => MoveStageItem[];
  }[] = [
    {
      name: "an entry for a path that was not asked for",
      events: (a) => [...itemEvents(a, A), ...itemEvents(f("../escape", 4), A)],
    },
    {
      name: "the requested paths out of order",
      events: (a, b) => [...itemEvents(b, A), ...itemEvents(a, A)],
    },
    {
      name: "a folder or a link where a file was asked",
      events: (a, b) => [
        ...itemEvents(a, A),
        {
          type: "entry",
          path: b.p,
          t: "l",
          mode: 0o777,
          mtime: MTIME,
          link: "/etc/passwd",
        },
        { type: "end", bytes: 0, sha256: sha(Buffer.alloc(0)) },
      ],
    },
    {
      name: "a SQLite flag the manifest does not have",
      events: (a, b) => [...itemEvents(a, A), ...itemEvents(b, A, { q: 1 })],
    },
    {
      name: "an offset other than the one asked",
      items: (a, b) => [item(a), item(b, { offset: 0, length: 4 })],
      events: (a, b) => [
        ...itemEvents(a, A),
        ...itemEvents(b, A, { offset: 2 }),
      ],
    },
    {
      name: "data before any entry",
      events: (a, b) => [
        { type: "data", bytes: A },
        ...itemEvents(a, A),
        ...itemEvents(b, A),
      ],
    },
    {
      name: "more data than the range asked for",
      items: (a, b) => [item(a), item(b, { offset: 0, length: 2 })],
      events: (a, b) => [
        ...itemEvents(a, A),
        ...itemEvents(b, A, { offset: 0 }),
      ],
    },
    {
      name: "data after an item's end",
      events: (a, b) => [
        ...itemEvents(a, A),
        { type: "data", bytes: A },
        ...itemEvents(b, A),
      ],
    },
  ];

  for (const c of cases)
    it(`refuses ${c.name}: MoveStageError, and the batch leaves no ledger row`, async () => {
      const { stage } = fresh();
      const a = f("a", 4);
      const b = f("b", 4);
      prepareAll(stage, [a, b]);
      const err = await caught(
        stage.writeBatch(
          { n: 0, items: (c.items ?? ((x, y) => [item(x), item(y)]))(a, b) },
          each(c.events(a, b)),
        ),
      );
      expect(err instanceof MoveStageError ? err.code : String(err)).toBe(
        "stream_mismatch",
      );
      expect(existsSync(join(dir, "escape"))).toBe(false);
      await stage.finish(each([a, b]));
      const check = await stage.check(each([a, b]));
      expect({
        complete: check.complete,
        missing: missingPaths(check),
      }).toEqual({
        complete: false,
        missing: ["a", "b"],
      });
    });
});

// [R] never follow a link in the stage while writing: another process of the
// office user can put one there between pass 1 and a batch.
describe("a link put in the stage before a write", () => {
  it("in place of a file: the file outside keeps its bytes, the item is missing", async () => {
    const { stage, root } = fresh();
    const victim = f("victim", 4);
    prepareAll(stage, [victim]);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "keep");
    rmSync(join(root, "victim"));
    symlinkSync(outside, join(root, "victim"));
    await caught(
      stage.writeBatch(
        { n: 0, items: [item(victim)] },
        each(itemEvents(victim, Buffer.from("evil"))),
      ),
    );
    expect(readFileSync(outside, "utf8")).toBe("keep");
    const check = await stage.check(each([victim]));
    expect({ complete: check.complete, missing: missingPaths(check) }).toEqual({
      complete: false,
      missing: ["victim"],
    });
  });

  it("in place of a parent folder: nothing is written through it", async () => {
    const { stage, root } = fresh();
    const sub = d("sub");
    const v = f("sub/v", 4);
    prepareAll(stage, [sub, v]);
    const outsideDir = join(dir, "outdir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "v"), "keep");
    rmSync(join(root, "sub"), { recursive: true });
    symlinkSync(outsideDir, join(root, "sub"));
    await caught(
      stage.writeBatch(
        { n: 0, items: [item(v)] },
        each(itemEvents(v, Buffer.from("evil"))),
      ),
    );
    expect(readFileSync(join(outsideDir, "v"), "utf8")).toBe("keep");
    const check = await stage.check(each([sub, v]));
    expect(check.complete).toBe(false);
  });
});

describe("finish", () => {
  it("makes links without following them: an absolute target outside keeps its mode and mtime", async () => {
    const { stage, root } = fresh();
    const outside = join(dir, "target.txt");
    writeFileSync(outside, "t");
    chmodSync(outside, 0o600);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(outside, old, old);
    const ln = l("ln", outside);
    prepareAll(stage, [ln]);
    await stage.finish(each([ln]));
    const st = statSync(outside);
    expect({
      link: lstatSync(join(root, "ln")).isSymbolicLink(),
      target: readlinkSync(join(root, "ln")),
      mode: st.mode & 0o7777,
      mtime: st.mtimeMs,
    }).toEqual({
      link: true,
      target: outside,
      mode: 0o600,
      mtime: old.getTime(),
    });
    const check = await stage.check(each([ln]));
    expect(check.complete).toBe(true);
  });
});

// [R] skip sockets, fifos and devices: a fifo put in the stage in place of a
// file must not block the office. A blocking open of a fifo stops the whole
// event loop, so the stage runs in a child process the test can give up on.
describe("a fifo put in the stage before a write", () => {
  it("never blocks: the batch and finish return, and the item is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-stage-"));
    const root = join(dir, "stage");
    const script = join(dir, "fifo-probe.ts");
    writeFileSync(
      script,
      `import { createMoveStage } from ${JSON.stringify(join(import.meta.dir, "office-move-stage.ts"))};
import { rmSync } from "node:fs";
const root = process.argv[2];
const stage = createMoveStage(root);
const e = { p: "f", t: "f" as const, s: 4, m: 0, mode: 0o644 };
stage.prepare(e);
rmSync(root + "/f");
if (Bun.spawnSync(["mkfifo", root + "/f"]).exitCode !== 0) throw new Error("no mkfifo");
async function* ev() {
  yield { type: "entry" as const, path: "f", t: "f" as const, mode: 0o644, mtime: 0 };
  yield { type: "data" as const, bytes: new Uint8Array(4) };
  yield { type: "end" as const, bytes: 4, sha256: "" };
}
async function* one() { yield e; }
try { await stage.writeBatch({ n: 0, items: [{ path: "f", entry: e }] }, ev()); } catch {}
await stage.finish(one());
const c = await stage.check(one());
console.log(JSON.stringify({ complete: c.complete, fifo: true }));
`,
    );
    const child = Bun.spawn([process.execPath, script, root], {
      stdout: "pipe",
      stderr: "pipe",
      // A plain bun run must not write the transpiler cache bun test reads.
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    });
    const ended = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(4_000).then(() => false),
    ]);
    if (!ended) child.kill("SIGKILL");
    await child.exited;
    const out = ended ? await new Response(child.stdout).text() : "";
    expect({ ended, out: out.trim() }).toEqual({
      ended: true,
      out: JSON.stringify({ complete: false, fifo: true }),
    });
  }, 15_000);
});

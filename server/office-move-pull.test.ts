// The pull of an office move (task 78733adf, slice 2a): sealing, the batch
// record stream, the manifest walk and its jobs, over a temp home.
//
// The routes that serve these (server/move-locked-office.test.ts) own the
// HTTP answers; this file owns what the bytes say, because the new office
// (slice 2b) trusts nothing else.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMoveManifestJobs,
  MOVE_SEAL_CHUNK_BYTES,
  MoveSealError,
  moveItemsHash,
  openMoveStream,
  readMoveRecords,
  sealMoveStream,
  walkMoveManifest,
  writeMoveBatch,
  type MoveBatchItem,
  type MoveBatchSource,
  type MoveManifestEntry,
  type MoveRecordEvent,
  type MoveSealContext,
} from "./office-move-pull.ts";
import { createMoveScope } from "./office-move-scope.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";

let dir = "";
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  if (dir) {
    // A test may leave a folder at 000.
    for (const p of [join(dir, "home", "locked")])
      if (existsSync(p)) chmodSync(p, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  dir = "";
});

interface Fixture {
  home: string;
  state: string;
  scratch: string;
  outside: string;
}

function fixture(): Fixture {
  dir = mkdtempSync(join(tmpdir(), "office-move-pull-"));
  const home = join(dir, "home");
  const state = join(home, ".isomux");
  const scratch = join(state, "move-pull");
  const outside = join(dir, "outside");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outside);
  return { home, state, scratch, outside };
}

function put(f: Fixture, rel: string, content: string | Uint8Array): string {
  const p = join(f.home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function scopeOf(f: Fixture, home = f.home, codeDir: string | null = null) {
  return createMoveScope({
    home,
    stateRoot: f.state,
    codeDir,
    backupDir: join(dir, "backups"),
  });
}

function source(
  f: Fixture,
  over: Partial<MoveBatchSource> = {},
): MoveBatchSource {
  return {
    scope: scopeOf(f),
    scratchDir: f.scratch,
    snapshot: snapshotOfficeDatabase,
    ...over,
  };
}

// A SQLite database in WAL mode whose last row is only in the WAL: the
// connection stays open and never checkpoints.
function walDatabase(path: string, rows: string[], blobBytes = 0): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  open.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec("CREATE TABLE t(x TEXT, b BLOB)");
  for (const x of rows)
    db.query("INSERT INTO t VALUES (?, ?)").run(
      x,
      blobBytes ? randomBytes(blobBytes) : null,
    );
  return db;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function bytesOf(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

// Feeds bytes in pieces that never line up with the frames, as TCP does.
async function* pieces(
  b: Uint8Array,
  size = 65_537,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

interface Got {
  path: string;
  header: Extract<MoveRecordEvent, { type: "entry" }> | null;
  data: Buffer;
  end: Extract<MoveRecordEvent, { type: "end" }> | null;
  error: string | null;
}

// The record stream as one result per item, in order.
async function records(plain: AsyncIterable<Uint8Array>): Promise<Got[]> {
  const out: Got[] = [];
  let cur: (Got & { parts: Uint8Array[] }) | null = null;
  for await (const ev of readMoveRecords(plain)) {
    if (ev.type === "entry") {
      cur = {
        path: ev.path,
        header: ev,
        data: Buffer.alloc(0),
        end: null,
        error: null,
        parts: [],
      };
    } else if (ev.type === "data") {
      cur!.parts.push(ev.bytes.slice());
    } else if (ev.type === "end") {
      const { parts, ...rest } = cur!;
      out.push({ ...rest, data: Buffer.concat(parts), end: ev });
      cur = null;
    } else {
      out.push({
        path: ev.path,
        header: null,
        data: Buffer.alloc(0),
        end: null,
        error: ev.error,
      });
    }
  }
  return out;
}

const batch = (
  f: Fixture,
  items: MoveBatchItem[],
  over: Partial<MoveBatchSource> = {},
) => records(writeMoveBatch(source(f, over), items));

const KEY = randomBytes(32);
const CTX: MoveSealContext = {
  route: "batch",
  manifestId: "m-1",
  batch: 1,
  itemsHash: "a".repeat(64),
};

const SALT_BYTES = 32;
const TAG_BYTES = 16;

// The sealed wire format: a 32-byte salt, then frames of a big-endian u32
// ciphertext length, the ciphertext and its 16-byte tag.
function splitSealed(b: Buffer): { salt: Buffer; frames: Buffer[] } {
  const salt = b.subarray(0, SALT_BYTES);
  const frames: Buffer[] = [];
  let i = SALT_BYTES;
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const end = i + 4 + len + TAG_BYTES;
    if (end > b.length)
      throw new Error("the sealed stream does not split into frames");
    frames.push(b.subarray(i, end));
    i = end;
  }
  return { salt, frames };
}

async function seal(plain: Uint8Array, ctx = CTX, key = KEY): Promise<Buffer> {
  return bytesOf(sealMoveStream(key, ctx, pieces(plain, 100_000)));
}

async function openAll(
  sealed: Uint8Array,
  ctx = CTX,
  key = KEY,
): Promise<Buffer> {
  return bytesOf(openMoveStream(key, ctx, pieces(sealed)));
}

async function sealError(
  sealed: Uint8Array,
  ctx = CTX,
  key = KEY,
): Promise<string> {
  try {
    await openAll(sealed, ctx, key);
  } catch (err) {
    return err instanceof MoveSealError
      ? "MoveSealError"
      : `other: ${String(err)}`;
  }
  return "opened";
}

describe("sealing", () => {
  it("opens what it sealed, across frames and in pieces that split frames, and an empty stream too", async () => {
    const plain = randomBytes(Math.floor(2.5 * MOVE_SEAL_CHUNK_BYTES));
    const sealed = await seal(plain);
    expect(splitSealed(sealed).frames.length).toBeGreaterThanOrEqual(3);
    expect(sha256(await openAll(sealed))).toBe(sha256(plain));
    const empty = await seal(new Uint8Array(0));
    expect((await openAll(empty)).length).toBe(0);
  });

  it("the same plaintext sealed twice shares no salt and no ciphertext", async () => {
    const plain = randomBytes(300_000);
    const a = splitSealed(await seal(plain));
    const b = splitSealed(await seal(plain));
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.frames[0].subarray(4).equals(b.frames[0].subarray(4))).toBe(false);
  });

  it("never reuses a keystream inside one response: equal chunks seal to different bytes", async () => {
    // GCM with a repeated nonce leaks the XOR of the plaintexts and the
    // authentication key.
    const { frames } = splitSealed(
      await seal(new Uint8Array(2 * MOVE_SEAL_CHUNK_BYTES + 1)),
    );
    expect(frames.length).toBe(3);
    expect(frames[0].length).toBe(frames[1].length);
    const body = (f: Buffer) => f.subarray(4, f.length - TAG_BYTES);
    expect(body(frames[0]).equals(body(frames[1]))).toBe(false);
  });

  it("refuses frames swapped, dropped at the end, cut mid-frame, or taken from another response", async () => {
    const plain = randomBytes(Math.floor(2.5 * MOVE_SEAL_CHUNK_BYTES));
    const sealed = await seal(plain);
    const { salt, frames } = splitSealed(sealed);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const swapped = Buffer.concat([
      salt,
      frames[1],
      frames[0],
      ...frames.slice(2),
    ]);
    const noFinal = Buffer.concat([salt, ...frames.slice(0, -1)]);
    const cut = sealed.subarray(0, sealed.length - 5);
    const other = splitSealed(await seal(plain));
    const spliced = Buffer.concat([salt, other.frames[0], ...frames.slice(1)]);
    expect([
      await sealError(swapped),
      await sealError(noFinal),
      await sealError(cut),
      await sealError(spliced),
    ]).toEqual([
      "MoveSealError",
      "MoveSealError",
      "MoveSealError",
      "MoveSealError",
    ]);
  });

  it("refuses a stream opened for another route, manifest, batch or item list, or with another key", async () => {
    const sealed = await seal(randomBytes(10_000));
    expect(await sealError(sealed)).toBe("opened");
    expect([
      await sealError(sealed, { ...CTX, route: "manifest" }),
      await sealError(sealed, { ...CTX, manifestId: "m-2" }),
      await sealError(sealed, { ...CTX, batch: 2 }),
      await sealError(sealed, { ...CTX, itemsHash: "b".repeat(64) }),
      await sealError(sealed, CTX, randomBytes(32)),
    ]).toEqual(Array(5).fill("MoveSealError"));
  });

  it("hashes an item list by its content, not its key order, and tells lists and orders apart", () => {
    const a = moveItemsHash([
      { path: "a", offset: 1, length: 2 },
      { path: "b" },
    ]);
    expect(
      moveItemsHash([{ length: 2, offset: 1, path: "a" }, { path: "b" }]),
    ).toBe(a);
    expect(
      moveItemsHash([{ path: "b" }, { path: "a", offset: 1, length: 2 }]),
    ).not.toBe(a);
    expect(
      moveItemsHash([{ path: "a", offset: 1, length: 3 }, { path: "b" }]),
    ).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a batch", () => {
  it("sends each file with its header and a trailer that matches what was sent", async () => {
    const f = fixture();
    const a = put(f, "docs/a.txt", "alpha");
    chmodSync(a, 0o640);
    const big = randomBytes(3 * MOVE_SEAL_CHUNK_BYTES + 17);
    put(f, "docs/big.bin", big);
    const got = await batch(f, [
      { path: "docs/a.txt" },
      { path: "docs/big.bin" },
    ]);
    expect(got.map((g) => [g.path, g.error])).toEqual([
      ["docs/a.txt", null],
      ["docs/big.bin", null],
    ]);
    expect(got[0].data.toString()).toBe("alpha");
    expect(got[0].header).toMatchObject({ t: "f" });
    expect(got[0].header!.mode & 0o777).toBe(0o640);
    expect(Math.abs(got[0].header!.mtime - statSync(a).mtimeMs)).toBeLessThan(
      1,
    );
    expect(got[0].end).toMatchObject({
      bytes: 5,
      sha256: sha256(Buffer.from("alpha")),
    });
    expect(got[0].end!.changed).toBeUndefined();
    expect(sha256(got[1].data)).toBe(sha256(big));
    expect(got[1].end!.bytes).toBe(big.length);
  });

  it("the reader refuses content that does not match its trailer", async () => {
    const f = fixture();
    put(f, "docs/a.txt", "MARKER-0123456789-content");
    const plain = await bytesOf(
      writeMoveBatch(source(f), [{ path: "docs/a.txt" }]),
    );
    const at = plain.indexOf("MARKER-0123456789");
    expect(at).toBeGreaterThanOrEqual(0);
    plain[at] ^= 1;
    let error = "";
    try {
      await records(pieces(plain, 7));
    } catch (err) {
      error = String(err);
    }
    expect(error).not.toBe("");
  });

  it("streams a big file: one that grows while it is read ends with changed, and its trailer matches the bytes sent", async () => {
    const f = fixture();
    const p = put(
      f,
      "docs/growing.bin",
      randomBytes(8 * MOVE_SEAL_CHUNK_BYTES),
    );
    const parts: Uint8Array[] = [];
    let end: Extract<MoveRecordEvent, { type: "end" }> | null = null;
    let grown = false;
    for await (const ev of readMoveRecords(
      writeMoveBatch(source(f), [{ path: "docs/growing.bin" }]),
    )) {
      if (ev.type === "data") {
        parts.push(ev.bytes.slice());
        if (!grown) {
          appendFileSync(p, randomBytes(4096));
          grown = true;
        }
      }
      if (ev.type === "end") end = ev;
    }
    expect(grown).toBe(true);
    expect(end?.changed).toBe(true);
    const sent = Buffer.concat(parts);
    expect(end).toMatchObject({ bytes: sent.length, sha256: sha256(sent) });
  });

  it("sends the exact bytes of a range, and refuses a range on a SQLite file or a bad range", async () => {
    const f = fixture();
    const content = randomBytes(300_000);
    put(f, "docs/big.bin", content);
    walDatabase(join(f.home, "data/app.db"), ["r1"]);
    const got = await batch(f, [
      { path: "docs/big.bin", offset: 1000, length: 5000 },
      { path: "data/app.db", offset: 0, length: 100 },
      { path: "docs/big.bin", offset: -1, length: 10 },
      { path: "docs/big.bin", offset: 0.5, length: 10 },
    ]);
    expect(got[0].header?.offset).toBe(1000);
    expect(got[0].data.equals(content.subarray(1000, 6000))).toBe(true);
    expect(got[0].end?.bytes).toBe(5000);
    expect(
      got.slice(1).map((g) => [g.path, g.error !== null, g.data.length]),
    ).toEqual([
      ["data/app.db", true, 0],
      ["docs/big.bin", true, 0],
      ["docs/big.bin", true, 0],
    ]);
  });

  it("sends a SQLite file as a snapshot that holds a row only in its WAL", async () => {
    const f = fixture();
    const path = join(f.home, "data/app.db");
    walDatabase(path, ["in-wal"]);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const got = await batch(f, [{ path: "data/app.db" }]);
    expect(got[0].header).toMatchObject({ q: 1, t: "f" });
    const copy = join(dir, "copy.db");
    writeFileSync(copy, got[0].data);
    const db = new Database(copy, { readonly: true });
    open.push(db);
    expect(db.query("SELECT x FROM t").all()).toEqual([{ x: "in-wal" }]);
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it("the snapshot leaves the member's database as it was (a rollback-journal file stays one)", async () => {
    const f = fixture();
    const path = join(f.home, "data/journal.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('a');",
    );
    db.close();
    const before = sha256(readFileSync(path));
    const got = await batch(f, [{ path: "data/journal.db" }]);
    expect(got[0].error).toBeNull();
    expect(sha256(readFileSync(path))).toBe(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const again = new Database(path, { readonly: true });
    open.push(again);
    expect(again.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
  });

  it("names each snapshot per request in the scratch folder, so two batches of the same file do not collide", async () => {
    const f = fixture();
    const path = join(f.home, "data/app.db");
    walDatabase(path, ["r1"]);
    const dsts: string[] = [];
    const snapshot = async (src: string, dst: string) => {
      dsts.push(dst);
      await Bun.sleep(30);
      await snapshotOfficeDatabase(src, dst);
    };
    const [a, b] = await Promise.all([
      batch(f, [{ path: "data/app.db" }], { snapshot }),
      batch(f, [{ path: "data/app.db" }], { snapshot }),
    ]);
    expect(new Set(dsts).size).toBe(2);
    expect(dsts.map((d) => dirname(d))).toEqual([f.scratch, f.scratch]);
    expect([a[0].error, b[0].error]).toEqual([null, null]);
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it("deletes the snapshot when it fails and when the reader stops mid-file", async () => {
    const f = fixture();
    walDatabase(join(f.home, "data/app.db"), ["r1", "r2", "r3"], 1024 * 1024);
    put(f, "docs/a.txt", "alpha");
    const failed = await batch(
      f,
      [{ path: "data/app.db" }, { path: "docs/a.txt" }],
      {
        snapshot: async (_src, dst) => {
          writeFileSync(dst, "partial");
          throw new Error("disk full");
        },
      },
    );
    expect(failed.map((g) => [g.path, g.error !== null])).toEqual([
      ["data/app.db", true],
      ["docs/a.txt", false],
    ]);
    expect(readdirSync(f.scratch)).toEqual([]);

    let made = false;
    const iter = writeMoveBatch(
      source(f, {
        snapshot: async (src, dst) => {
          await snapshotOfficeDatabase(src, dst);
          made = true;
        },
      }),
      [{ path: "data/app.db" }],
    )[Symbol.asyncIterator]();
    let afterMade = 0;
    while (afterMade < 2) {
      const r = await iter.next();
      expect(r.done).toBe(false);
      if (made) afterMade++;
    }
    expect(readdirSync(f.scratch).length).toBe(1);
    await iter.return?.();
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it("refuses a path out of scope, absolute, with .., or through a symlinked folder, with an error record each, and goes on", async () => {
    const f = fixture();
    // Slice 3: the old box's SSH login keys stay; its id keys move.
    put(f, ".ssh/authorized_keys", "SSH-SECRET");
    put(f, ".isomux/office-move.json", "MOVE-KEY");
    put(f, ".isomux/sessions.json", "SESSION-SECRET");
    put(f, ".cache/x", "CACHE");
    put(f, "real/secret.txt", "VIA-LINK");
    symlinkSync(join(f.home, "real"), join(f.home, "linked"));
    writeFileSync(join(f.outside, "secret.txt"), "OUTSIDE");
    symlinkSync(f.outside, join(f.home, "out"));
    put(f, "docs/a.txt", "alpha");
    const bad = [
      ".ssh/authorized_keys",
      ".isomux/office-move.json",
      ".isomux/sessions.json",
      ".cache/x",
      join(f.home, "docs/a.txt"),
      "docs/../.ssh/authorized_keys",
      "../outside/secret.txt",
      "linked/secret.txt",
      "out/secret.txt",
    ];
    const plain = await bytesOf(
      writeMoveBatch(source(f), [
        ...bad.map((path) => ({ path })),
        { path: "docs/a.txt" },
      ]),
    );
    for (const secret of [
      "SSH-SECRET",
      "MOVE-KEY",
      "SESSION-SECRET",
      "CACHE",
      "VIA-LINK",
      "OUTSIDE",
    ])
      expect([secret, plain.includes(secret)]).toEqual([secret, false]);
    const got = await records(pieces(plain));
    expect(got.map((g) => [g.path, g.error !== null])).toEqual([
      ...bad.map((p) => [p, true]),
      ["docs/a.txt", false],
    ]);
    expect(got.at(-1)!.data.toString()).toBe("alpha");
  });

  it("never follows a symlink at the last step: its target's content is never sent", async () => {
    const f = fixture();
    writeFileSync(join(f.outside, "secret.txt"), "OUTSIDE");
    mkdirSync(join(f.home, "docs"), { recursive: true });
    symlinkSync(join(f.outside, "secret.txt"), join(f.home, "docs/link"));
    const plain = await bytesOf(
      writeMoveBatch(source(f), [{ path: "docs/link" }]),
    );
    expect(plain.includes("OUTSIDE")).toBe(false);
    const [got] = await records(pieces(plain));
    // Either an error record or the link itself.
    if (got.error === null) expect(got.header?.t).toBe("l");
  });

  it("works when the home itself is reached through a symlink", async () => {
    const f = fixture();
    put(f, "docs/a.txt", "alpha");
    const via = join(dir, "home-link");
    symlinkSync(f.home, via);
    const got = await records(
      writeMoveBatch(source(f, { scope: scopeOf(f, via) }), [
        { path: "docs/a.txt" },
      ]),
    );
    expect([got[0].error, got[0].data.toString()]).toEqual([null, "alpha"]);
  });

  it("sends a member's file whose name ends like a SQLite side file", async () => {
    const f = fixture();
    put(f, "notes/travel-journal", "trip");
    put(f, "notes/day", "plain text");
    put(f, "notes/day-journal", "dear diary");
    const got = await batch(f, [
      { path: "notes/travel-journal" },
      { path: "notes/day-journal" },
    ]);
    expect(got.map((g) => [g.path, g.error, g.data.toString()])).toEqual([
      ["notes/travel-journal", null, "trip"],
      ["notes/day-journal", null, "dear diary"],
    ]);
  });
});

function readManifest(path: string): MoveManifestEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as MoveManifestEntry);
}

// A home with one of each thing the walk decides about.
function walkFixture(f: Fixture): { db: string } {
  chmodSync(put(f, "docs/a.txt", "alpha"), 0o640);
  put(f, "docs/sub/b.txt", "beta!");
  const db = join(f.home, "data/app.db");
  walDatabase(db, ["r1"]);
  put(f, "notes/travel-journal", "trip");
  put(f, "notes/day", "plain text");
  put(f, "notes/day-journal", "dear diary");
  writeFileSync(join(f.outside, "secret.txt"), "OUTSIDE");
  symlinkSync(f.outside, join(f.home, "link-out"));
  const fifo = Bun.spawnSync(["mkfifo", join(f.home, "pipe")]);
  if (fifo.exitCode !== 0) throw new Error("mkfifo failed");
  put(f, ".cache/big.bin", randomBytes(1000));
  put(f, ".ssh/id_ed25519", "0123456789");
  put(f, ".ssh/authorized_keys", "abcdefghijk");
  put(f, ".isomux/office-move.json", "{}");
  put(f, ".isomux/secrets/s.json", "1234567");
  put(f, ".isomux/agents.json", "[]");
  put(f, "isomux-code/server/x.ts", "code");
  put(f, "locked/x", "hidden");
  chmodSync(join(f.home, "locked"), 0o000);
  return { db };
}

describe("the manifest walk", () => {
  it("lists what moves, with its type, size, time and mode, flags SQLite, and leaves out the rest", async () => {
    const f = fixture();
    const { db } = walkFixture(f);
    expect(existsSync(`${db}-wal`)).toBe(true);
    expect(existsSync(`${db}-shm`)).toBe(true);
    const out = join(f.scratch, "m1.ndjson");
    const summary = await walkMoveManifest(
      scopeOf(f, f.home, join(f.home, "isomux-code")),
      out,
    );
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const entries = readManifest(out);
    const byPath = new Map(entries.map((e) => [e.p, e]));
    for (const p of [
      "docs",
      "docs/a.txt",
      "docs/sub/b.txt",
      "data/app.db",
      "notes/travel-journal",
      "notes/day",
      "notes/day-journal",
      ".isomux/agents.json",
      // Slice 3: sign-ins and secrets move.
      ".ssh/id_ed25519",
      ".isomux/secrets/s.json",
    ])
      expect([p, byPath.has(p)]).toEqual([p, true]);
    for (const p of entries.map((e) => e.p))
      expect([
        p,
        /^(\.cache|isomux-code|link-out\/|locked\/|pipe$)|authorized_keys|office-move\.json|move-pull|-wal$|-shm$/.test(
          p,
        ),
      ]).toEqual([p, false]);

    expect(byPath.get("docs/a.txt")).toMatchObject({ t: "f", s: 5 });
    expect(byPath.get("docs/a.txt")!.mode & 0o777).toBe(0o640);
    expect(
      Math.abs(
        byPath.get("docs/a.txt")!.m -
          statSync(join(f.home, "docs/a.txt")).mtimeMs,
      ),
    ).toBeLessThan(1);
    expect(byPath.get("docs")?.t).toBe("d");
    expect(byPath.get("link-out")).toMatchObject({ t: "l", l: f.outside });
    expect(byPath.get("data/app.db")?.q).toBe(1);
    expect(byPath.get("docs/a.txt")?.q).toBeUndefined();

    expect(summary.entries).toBe(entries.length);
    expect(summary.totalBytes).toBe(
      entries.filter((e) => e.t === "f").reduce((n, e) => n + e.s, 0),
    );
    expect(summary.skipped).toBe(1);
    expect(summary.unreadable).toContain("locked");
    // Only the bound unit is left out and counted.
    expect(summary.excluded.map((u) => [u.unit, u.entries, u.bytes])).toEqual([
      ["ssh-authorized-keys", 1, 11],
    ]);
  });
});

describe("the manifest jobs", () => {
  async function ready(
    jobs: ReturnType<typeof createMoveManifestJobs>,
    id: string,
    session: string,
  ) {
    const deadline = performance.now() + 10_000;
    for (;;) {
      const s = jobs.status(id, session);
      if (s?.state !== "running" || performance.now() > deadline) return s;
      await Bun.sleep(10);
    }
  }

  it("runs one walk at a time for its session, reports it, and serves its data only to that session", async () => {
    const f = fixture();
    put(f, "docs/a.txt", "alpha");
    const T = new Date("2026-11-15T10:00:00Z");
    const jobs = createMoveManifestJobs({
      scope: scopeOf(f),
      dir: f.scratch,
      units: () => [{ name: "tailscaled.service" }],
      secretCount: () => 3,
      now: () => T,
    });
    const first = jobs.start("s1");
    if (!first.ok) throw new Error(first.message);
    expect(jobs.start("s1").ok).toBe(false);
    expect(jobs.status(first.id, "s2")).toBeNull();
    const s = await ready(jobs, first.id, "s1");
    expect(s).toMatchObject({
      state: "ready",
      id: first.id,
      units: [{ name: "tailscaled.service" }],
      secretCount: 3,
      finishedAt: T.getTime(),
    });
    expect(jobs.dataFile(first.id, "s2")).toBeNull();
    const file = jobs.dataFile(first.id, "s1");
    expect(file && dirname(file)).toBe(f.scratch);
    expect(readManifest(file!).some((e) => e.p === "docs/a.txt")).toBe(true);
    expect(statSync(file!).mode & 0o777).toBe(0o600);

    expect(jobs.served(first.id, "s1")).toBe(false);
    jobs.markServed(first.id);
    expect(jobs.served(first.id, "s1")).toBe(true);
    expect(jobs.served(first.id, "s2")).toBe(false);

    // A finished walk does not block the next one.
    const second = jobs.start("s1");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.id).not.toBe(first.id);
  });
});

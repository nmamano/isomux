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
  compareMoveWalkOrder,
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

// Slice 4 (the live pass): the running office serves the pull before the
// lock. [R] it never takes a SQLite snapshot then (decided by the bytes it
// opens, not by the request), and an ended pairing stops every walk and
// stream in flight and deletes the scratch.
describe("slice 4: the pull while the office still runs", () => {
  it("a batch with snapshots off sends no SQLite file: an error record per database, by its bytes whatever its name, no VACUUM INTO, and the other items go on", async () => {
    const f = fixture();
    walDatabase(join(f.home, "data/app.db"), ["r1"]);
    // A database whose name says nothing about it.
    walDatabase(join(f.home, "data/notes.bin"), ["r2"]);
    put(f, "docs/a.txt", "alpha");
    let snapshots = 0;
    const src = source(f, {
      snapshot: async (a, b) => {
        snapshots++;
        await snapshotOfficeDatabase(a, b);
      },
    });
    const items = [
      { path: "data/app.db" },
      { path: "data/notes.bin" },
      { path: "docs/a.txt" },
    ];
    const got = await records(writeMoveBatch(src, items, { snapshots: false }));
    expect(
      got.map((g) => [g.path, g.error !== null, g.data.toString("utf8")]),
    ).toEqual([
      ["data/app.db", true, ""],
      ["data/notes.bin", true, ""],
      ["docs/a.txt", false, "alpha"],
    ]);
    expect(snapshots).toBe(0);
    expect(readdirSync(f.scratch)).toEqual([]);
    // The condition: by default the same batch takes both snapshots.
    const control = await records(writeMoveBatch(src, items));
    expect(control.map((g) => g.header?.q ?? null)).toEqual([1, 1, null]);
    expect(snapshots).toBe(2);
  });

  it("a batch ends when its signal aborts: no record after the abort, and a snapshot in use is deleted", async () => {
    const f = fixture();
    put(f, "big.bin", randomBytes(5 * 1024 * 1024));
    put(f, "after.txt", "after");
    const ac = new AbortController();
    const iter = writeMoveBatch(
      source(f),
      [{ path: "big.bin" }, { path: "after.txt" }],
      { signal: ac.signal },
    )[Symbol.asyncIterator]();
    // The header and the first data record.
    for (let i = 0; i < 2; i++) expect((await iter.next()).done).toBe(false);
    ac.abort();
    let after = 0;
    try {
      while (!(await iter.next()).done) after++;
    } catch {
      // Ending with an error is an end too.
    }
    expect(after).toBe(0);

    // With a snapshot in the scratch.
    walDatabase(join(f.home, "data/app.db"), ["r1", "r2"], 1024 * 1024);
    const ac2 = new AbortController();
    const it2 = writeMoveBatch(source(f), [{ path: "data/app.db" }], {
      signal: ac2.signal,
    })[Symbol.asyncIterator]();
    for (let i = 0; i < 2; i++) expect((await it2.next()).done).toBe(false);
    expect(readdirSync(f.scratch).length).toBe(1);
    ac2.abort();
    try {
      while (!(await it2.next()).done);
    } catch {
      // Ending with an error is an end too.
    }
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it("clear() stops a walk in flight and deletes every manifest file; a new walk starts after it", async () => {
    const f = fixture();
    for (let i = 0; i < 300; i++) put(f, `many/d${i % 30}/f${i}.txt`, "x");
    // A walk that ends reads the units for its status: a stopped one never.
    let unitReads = 0;
    const jobs = createMoveManifestJobs({
      scope: scopeOf(f),
      dir: f.scratch,
      units: () => {
        unitReads++;
        return [];
      },
      secretCount: () => 0,
      now: () => new Date(),
    });
    // A ready job's file goes.
    const first = jobs.start("s1");
    if (!first.ok) throw new Error(first.message);
    const deadline = performance.now() + 5_000;
    while (
      jobs.status(first.id, "s1")?.state === "running" &&
      performance.now() < deadline
    )
      await Bun.sleep(5);
    expect(jobs.dataFile(first.id, "s1")).not.toBeNull();
    // A walk in flight: start() returns at the walk's first await.
    const second = jobs.start("s1");
    if (!second.ok) throw new Error(second.message);
    expect(jobs.status(second.id, "s1")?.state).toBe("running");
    jobs.clear();
    expect(jobs.dataFile(first.id, "s1")).toBeNull();
    expect(jobs.status(second.id, "s1")?.state ?? null).not.toBe("ready");
    // The stopped walk writes nothing after the clear, and never ends.
    await Bun.sleep(300);
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(unitReads).toBe(1);
    expect(jobs.dataFile(second.id, "s1")).toBeNull();
    expect(jobs.start("s1").ok).toBe(true);
  });
});

// Slice 4: the live pass keeps a file by matching the two manifests in
// walk order (a merge-join), so the order must be one the comparator
// gives. If the two disagree, the join misses matches.
describe("compareMoveWalkOrder", () => {
  it("orders a small tree as the walk does: a folder's names first, then each subfolder's group, depth first", () => {
    const walked = ["A", "a", "a-b", "a.b", "a/b", "a/c", "a/b/x", "a.b/y"];
    const shuffled = [...walked].reverse();
    expect(shuffled.sort(compareMoveWalkOrder)).toEqual(walked);
  });

  it("sorts a real walk: every entry comes after the one before it", async () => {
    const f = fixture();
    const names = [
      "A",
      "a",
      "a-b",
      "a.b",
      "a b",
      "a_b",
      "\u{1D518}",
      "\uFF5A",
      "z",
    ];
    for (const n of names) {
      put(f, `${n}/inner/x.txt`, "1");
      put(f, `${n}/y.txt`, "2");
      put(f, `file-${n}`, "3");
      put(f, `${n}-sib`, "4");
    }
    const out = join(f.scratch, "walk.ndjson");
    await walkMoveManifest(scopeOf(f), out);
    const walked = readManifest(out).map((e) => e.p);
    // The condition: the stress names are in the walk.
    expect(walked).toContain("\u{1D518}/inner/x.txt");
    expect(walked).toContain("a.b/inner");
    const out_of_order = walked.filter(
      (p, i) => i > 0 && compareMoveWalkOrder(walked[i - 1], p) >= 0,
    );
    expect(out_of_order).toEqual([]);
    expect([...walked].reverse().sort(compareMoveWalkOrder)).toEqual(walked);
  });
});

// Slice 5b: folders outside the home. The job walks the home, then each
// folder of the list it read at its start (C4), each with its own manifest;
// the seal binds which folder a response is about, and the home's context is
// the one an office of an earlier release seals with.
describe("slice 5b: folders outside the home", () => {
  // Sealed by this code before slice 5b (key 32 x 0x11, CTX), so an old
  // office of slice 4 still opens for a new office of slice 5b.
  const SLICE4_KEY = Buffer.alloc(32, 0x11);
  const SLICE4_SEALED = Buffer.from(
    "GkqfhdMveQkmHxj9vP8mkBfsd6QT39tMzOGAX4cNVMIAAAAezmv4E18lImuane03TAoiWo7gYpketXQBbYufZUr/fHd31feTsi7a0BS2CA0Yiw==",
    "base64",
  );

  it("the home's context is unchanged, and a response for one folder opens for no other folder and not as the home", async () => {
    expect(
      (await openAll(SLICE4_SEALED, CTX, SLICE4_KEY)).toString("utf8"),
    ).toBe("sealed by an office of slice 4");
    expect(
      await sealError(SLICE4_SEALED, { ...CTX, outside: 0 }, SLICE4_KEY),
    ).toBe("MoveSealError");
    const plain = randomBytes(5_000);
    const zero = await seal(plain, { ...CTX, outside: 0 });
    expect(sha256(await openAll(zero, { ...CTX, outside: 0 }))).toBe(
      sha256(plain),
    );
    expect([
      await sealError(zero, CTX),
      await sealError(zero, { ...CTX, outside: 1 }),
      await sealError(await seal(plain, { ...CTX, outside: 1 }), {
        ...CTX,
        outside: 0,
      }),
    ]).toEqual(Array(3).fill("MoveSealError"));
  });

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

  function outsideFolder(f: Fixture, name: string, mode = 0o750): string {
    const p = join(f.outside, name);
    mkdirSync(join(p, "sub", ".isomux-move-in"), { recursive: true });
    writeFileSync(join(p, "a.txt"), `in ${name}`);
    writeFileSync(join(p, "sub", ".isomux-move-in", "nested.txt"), "moves");
    mkdirSync(join(p, ".cache"));
    writeFileSync(join(p, ".cache", "c.bin"), "moves too");
    // The new office's stage, when this box was once a new office.
    mkdirSync(join(p, ".isomux-move-in", "stage"), { recursive: true });
    writeFileSync(join(p, ".isomux-move-in", "stage", "x.txt"), "stays");
    chmodSync(p, mode);
    return p;
  }

  it("C4: a job walks the folders it read once at its start; its status, data and folders keep that list when the records change", async () => {
    const f = fixture();
    put(f, "docs/a.txt", "alpha");
    const p0 = outsideFolder(f, "p0", 0o750);
    const p1 = outsideFolder(f, "p1", 0o700);
    const late = outsideFolder(f, "late");
    let list = [
      { path: p0, mode: 0o750 },
      { path: p1, mode: 0o700 },
    ];
    let reads = 0;
    const jobs = createMoveManifestJobs({
      scope: scopeOf(f),
      dir: f.scratch,
      units: () => [],
      secretCount: () => 0,
      outside: () => {
        reads++;
        return list;
      },
      now: () => new Date(),
    });
    const job = jobs.start("s1");
    if (!job.ok) throw new Error(job.message);
    // The records change while the job runs.
    list = [{ path: late, mode: 0o755 }];
    const s = await ready(jobs, job.id, "s1");
    expect(reads).toBe(1);
    if (s?.state !== "ready") throw new Error(JSON.stringify(s));
    expect(s.outside.map((o) => [o.path, o.mode & 0o777])).toEqual([
      [p0, 0o750],
      [p1, 0o700],
    ]);
    expect(s.outside[0].mtime).toBe(statSync(p0).mtimeMs);
    expect(jobs.outsideFolder(job.id, "s1", 0)).toBe(p0);
    expect(jobs.outsideFolder(job.id, "s1", 1)).toBe(p1);
    expect(jobs.outsideFolder(job.id, "s1", 2)).toBeNull();
    expect(jobs.outsideFolder(job.id, "s2", 0)).toBeNull();
    // Each folder's manifest is its own, relative to the folder; the home's
    // is unchanged.
    const home = readManifest(jobs.dataFile(job.id, "s1")!).map((e) => e.p);
    expect(home).toContain("docs/a.txt");
    expect(home.some((p) => p.includes("a.txt") && p !== "docs/a.txt")).toBe(
      false,
    );
    const zero = readManifest(jobs.dataFile(job.id, "s1", 0)!).map((e) => e.p);
    expect(zero.sort()).toEqual(
      [
        ".cache",
        ".cache/c.bin",
        "a.txt",
        "sub",
        "sub/.isomux-move-in",
        "sub/.isomux-move-in/nested.txt",
      ].sort(),
    );
    expect(s.outside[0]).toMatchObject({ entries: 6, totalBytes: 19 });
    expect(jobs.dataFile(job.id, "s1", 2)).toBeNull();
    expect(jobs.dataFile(job.id, "s2", 0)).toBeNull();
  });

  it("a folder of the list that is a link when the job walks it fails the job", async () => {
    const f = fixture();
    const real = outsideFolder(f, "real");
    const ln = join(f.outside, "ln");
    symlinkSync(real, ln);
    const jobs = createMoveManifestJobs({
      scope: scopeOf(f),
      dir: f.scratch,
      units: () => [],
      secretCount: () => 0,
      outside: () => [{ path: ln, mode: 0o755 }],
      now: () => new Date(),
    });
    const job = jobs.start("s1");
    if (!job.ok) throw new Error(job.message);
    expect((await ready(jobs, job.id, "s1"))?.state).toBe("failed");
    // The condition: the real folder walks.
    const ok = createMoveManifestJobs({
      scope: scopeOf(f),
      dir: f.scratch,
      units: () => [],
      secretCount: () => 0,
      outside: () => [{ path: real, mode: 0o755 }],
      now: () => new Date(),
    });
    const job2 = ok.start("s1");
    if (!job2.ok) throw new Error(job2.message);
    expect((await ready(ok, job2.id, "s1"))?.state).toBe("ready");
  });
});

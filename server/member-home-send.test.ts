// The member's side of an office move (member-home-send.ts, task 78733adf
// slice 5c-1), run in this process against a real home: the runner runs the
// same code as the member, so "as her" is only the process's uid. The
// properties:
// - the scope: caches, specials and what the office writes again in her
//   agent space stay out; her sign-ins move; her SSH login keys are bound;
// - the listing: the office's walk order, never into a link, a special
//   marked x, a SQLite file flagged and its side files left out, and an end
//   line; a home reached through a link is not walked (C5);
// - the files: only the file at the asked path in her home (no link at the
//   last step or above it), the exact bytes of a range, a SQLite file as a
//   snapshot only when asked, and no snapshot left behind (C7).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listHome,
  MEMBER_HOME_NONCE,
  memberHomeScope,
  sendHomeFiles,
  type HomeFileHeader,
  type HomeFilesInput,
  type HomeListLine,
} from "./member-home-send.ts";
import { compareMoveWalkOrder } from "./office-move-pull.ts";

let dir = "";
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const NONCE = "0123456789abcdef0123456789abcdef";

interface Bed {
  home: string;
  outside: string;
}

function bed(): Bed {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "member-home-send-")));
  const home = join(dir, "home");
  const outside = join(dir, "outside");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(outside);
  writeFileSync(join(outside, "a.txt"), "NOT HER HOME");
  return { home, outside };
}

function put(b: Bed, rel: string, content: string | Uint8Array): string {
  const p = join(b.home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// A SQLite database in WAL mode whose last row is only in the WAL.
function walDatabase(path: string, rows: string[]): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  open.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec("CREATE TABLE t(x TEXT)");
  for (const x of rows) db.query("INSERT INTO t VALUES (?)").run(x);
  return db;
}

async function collect(
  run: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<{ bytes: Buffer; error: string | null }> {
  const parts: Buffer[] = [];
  try {
    await run(async (chunk) => {
      parts.push(Buffer.from(chunk));
    });
    return { bytes: Buffer.concat(parts), error: null };
  } catch (err) {
    return { bytes: Buffer.concat(parts), error: (err as Error).message };
  }
}

async function list(b: Bed, home = b.home, nonce = NONCE) {
  const got = await collect((w) => listHome({ home, nonce }, w));
  const lines = got.bytes
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as HomeListLine | { end: true });
  return { ...got, lines };
}

const entries = (lines: (HomeListLine | { end: true })[]) =>
  lines.filter((l): l is HomeListLine => !("end" in l));

interface Sent {
  i: number;
  header?: HomeFileHeader;
  data?: Buffer;
  trailer?: { i: number; end: true; changed?: true };
  error?: string;
}

// The frames of home-files: u32 BE length, then that many bytes; zero ends.
// Per item a header, then `size` bytes in data frames, then a trailer; or
// one error frame.
function parseFiles(bytes: Buffer): { items: Sent[]; ended: boolean } {
  const frames: Buffer[] = [];
  let at = 0;
  let ended = false;
  while (at + 4 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    at += 4;
    if (len === 0) {
      ended = true;
      break;
    }
    frames.push(bytes.subarray(at, at + len));
    at += len;
  }
  const items: Sent[] = [];
  let k = 0;
  while (k < frames.length) {
    const head = JSON.parse(frames[k++].toString("utf8")) as Record<
      string,
      unknown
    >;
    if (typeof head.error === "string") {
      items.push({ i: head.i as number, error: head.error });
      continue;
    }
    const header = head as unknown as HomeFileHeader;
    const parts: Buffer[] = [];
    let got = 0;
    while (got < header.size) {
      parts.push(frames[k]);
      got += frames[k].length;
      k++;
    }
    const trailer = JSON.parse(frames[k++].toString("utf8")) as Sent["trailer"];
    items.push({ i: header.i, header, data: Buffer.concat(parts), trailer });
  }
  return { items, ended };
}

async function files(
  b: Bed,
  items: HomeFilesInput["items"],
  over: Partial<HomeFilesInput> = {},
) {
  const got = await collect((w) =>
    sendHomeFiles(
      { home: b.home, nonce: NONCE, snapshot: true, items, ...over },
      w,
    ),
  );
  return {
    ...got,
    ...(got.error ? { items: [], ended: false } : parseFiles(got.bytes)),
  };
}

describe("memberHomeScope", () => {
  it("moves her files and sign-ins, leaves out caches, specials and what the office writes again, and binds her SSH login keys", () => {
    const verdict = (p: string, kind: "file" | "dir" | "other" = "file") => {
      const v = memberHomeScope(p, kind);
      return v.in ? "in" : v.why === "bound" ? `bound:${v.unit}` : "out";
    };
    const table: [string, string][] = [
      ["projects/app/main.ts", "in"],
      [".bashrc", "in"],
      [".ssh/id_ed25519", "in"],
      [".config/gh/hosts.yml", "in"],
      // Slice 3's rule: her sign-ins move with her.
      [".isomux-agent/provider-homes/u1/claude/.credentials.json", "in"],
      [".isomux-agent/provider-homes/u1/codex/auth.json", "in"],
      [".isomux-agent/apps/data/app1/db.json", "in"],
      // The home's caches, as for the office user's home.
      [".cache", "out"],
      [".cache/pip/x.whl", "out"],
      [".bun/install/cache/x", "out"],
      [".npm/_cacache/index", "out"],
      ["go/pkg/mod/x", "out"],
      [".cargo/registry/x", "out"],
      // What the office writes again in her agent space (Q2).
      [".isomux-agent/apps/units/app1.service", "out"],
      [".isomux-agent/apps/secrets/app1.env", "out"],
      [".isomux-agent/skill-folders/a/SKILL.md", "out"],
      [".isomux-agent/preview/shot.png", "out"],
      [".isomux-agent/.move-in/x", "out"],
      [".isomux-agent/.move-out/move-x.db", "out"],
    ];
    expect(table.map(([p]) => [p, verdict(p)])).toEqual(table);
    expect(verdict(".ssh/authorized_keys")).toMatch(/^bound:/);
    expect(verdict(".ssh/authorized_keys2")).toMatch(/^bound:/);
    expect(verdict("run/agent.sock", "other")).toBe("out");
    // Only the home's caches: a .cache deeper in a project moves.
    expect(verdict("projects/app/.cache/keep.txt")).toBe("in");
    expect(verdict("projects/app/units/u.service")).toBe("in");
  });
});

describe("home-list", () => {
  it("lists her home in the office's walk order, never enters a link, marks a special x, flags SQLite and leaves out its side files and what the scope leaves out; then an end line", async () => {
    const b = bed();
    chmodSync(put(b, "docs/a.txt", "alpha"), 0o640);
    put(b, "docs/sub/b.txt", "beta!");
    put(b, "docs-b/c.txt", "c");
    put(b, "Zed.txt", "upper case first");
    put(b, "notes-wal", "a file, not a side file");
    walDatabase(join(b.home, "data/app.db"), ["r1"]);
    expect(existsSync(join(b.home, "data/app.db-wal"))).toBe(true);
    put(b, ".cache/big.bin", "cache");
    put(b, ".ssh/id_ed25519", "key");
    put(b, ".ssh/authorized_keys", "login");
    put(b, ".isomux-agent/provider-homes/u1/claude/.credentials.json", "S");
    put(b, ".isomux-agent/apps/units/app1.service", "unit");
    symlinkSync(b.outside, join(b.home, "link-out"));
    expect(Bun.spawnSync(["mkfifo", join(b.home, "pipe")]).exitCode).toBe(0);

    const got = await list(b);
    expect(got.error).toBeNull();
    expect(got.lines.at(-1)).toEqual({ end: true });
    expect(got.lines.filter((l) => "end" in l)).toHaveLength(1);
    const all = entries(got.lines);
    const paths = all.map((e) => e.p);
    // The office's order: each line after the one before it.
    for (let i = 1; i < paths.length; i++)
      expect([
        paths[i - 1],
        paths[i],
        compareMoveWalkOrder(paths[i - 1], paths[i]) < 0,
      ]).toEqual([paths[i - 1], paths[i], true]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of [
      "docs",
      "docs/a.txt",
      "docs/sub",
      "docs/sub/b.txt",
      "docs-b/c.txt",
      "Zed.txt",
      "notes-wal",
      "data/app.db",
      ".ssh/id_ed25519",
      ".isomux-agent/provider-homes/u1/claude/.credentials.json",
      "link-out",
      "pipe",
    ])
      expect([p, paths.includes(p)]).toEqual([p, true]);
    for (const p of paths)
      expect([
        p,
        /^(\.cache|link-out\/|\.isomux-agent\/apps\/units)|authorized_keys|app\.db-(wal|shm)$/.test(
          p,
        ),
      ]).toEqual([p, false]);
    const by = new Map(all.map((e) => [e.p, e]));
    expect(by.get("docs/a.txt")).toMatchObject({ t: "f", s: 5 });
    expect(by.get("docs/a.txt")!.mode & 0o777).toBe(0o640);
    expect(
      Math.abs(
        by.get("docs/a.txt")!.m - lstatSync(join(b.home, "docs/a.txt")).mtimeMs,
      ),
    ).toBeLessThan(1);
    expect(by.get("docs")?.t).toBe("d");
    expect(by.get("link-out")).toMatchObject({ t: "l", l: b.outside });
    expect(by.get("pipe")?.t).toBe("x");
    expect(by.get("data/app.db")?.q).toBe(1);
    expect(by.get("docs/a.txt")?.q).toBeUndefined();
    expect(by.get("notes-wal")?.t).toBe("f");
  });

  it("C5: a home reached through a link is not walked: the call fails and lists nothing", async () => {
    const b = bed();
    put(b, "docs/a.txt", "alpha");
    const ln = join(dir, "home-link");
    symlinkSync(b.home, ln);
    // The condition: the real path walks.
    expect(entries((await list(b)).lines).length).toBeGreaterThan(0);
    const got = await list(b, ln);
    expect(got.error).not.toBeNull();
    expect(entries(got.lines)).toEqual([]);
  });

  it("C7: a nonce that is not 32 hex characters fails the call before it lists anything", async () => {
    const b = bed();
    put(b, "docs/a.txt", "alpha");
    expect(MEMBER_HOME_NONCE.test(NONCE)).toBe(true);
    // The condition: the good nonce lists.
    expect(entries((await list(b)).lines).length).toBeGreaterThan(0);
    for (const nonce of [
      "../../x",
      "ABCDEF0123456789abcdef0123456789",
      NONCE.slice(1),
      "",
    ]) {
      const got = await list(b, b.home, nonce);
      expect([nonce, got.error !== null, entries(got.lines).length]).toEqual([
        nonce,
        true,
        0,
      ]);
    }
  });
});

describe("home-files", () => {
  it("sends each asked file as header, its bytes and a trailer, and the exact bytes of a range; then the end frame", async () => {
    const b = bed();
    chmodSync(put(b, "docs/a.txt", "alpha"), 0o640);
    put(b, "docs/b.txt", "0123456789");
    const got = await files(b, [
      { i: 0, p: "docs/a.txt" },
      { i: 1, p: "docs/b.txt", offset: 2, length: 3 },
    ]);
    expect(got.error).toBeNull();
    expect(got.ended).toBe(true);
    expect(
      got.items.map((s) => [
        s.i,
        s.header?.p,
        s.data?.toString(),
        s.trailer?.i,
        s.header?.offset ?? 0,
      ]),
    ).toEqual([
      [0, "docs/a.txt", "alpha", 0, 0],
      [1, "docs/b.txt", "234", 1, 2],
    ]);
    expect(got.items[0].header!.mode & 0o777).toBe(0o640);
    expect(got.items[0].header!.size).toBe(5);
    expect(got.items[1].header!.size).toBe(3);
  });

  it("never sends what a link at the last step or above it points to: an error frame for that item, and the next item still goes", async () => {
    const b = bed();
    put(b, "docs/a.txt", "alpha");
    put(b, "keep/k.txt", "kept");
    symlinkSync(join(b.outside, "a.txt"), join(b.home, "last-link"));
    // The condition: before the swap the file under docs is sent.
    const before = await files(b, [{ i: 0, p: "docs/a.txt" }]);
    expect(before.items.map((s) => s.data?.toString())).toEqual(["alpha"]);
    // A folder swapped for a link to a folder with the same names.
    renameSync(join(b.home, "docs"), join(dir, "docs-was"));
    symlinkSync(b.outside, join(b.home, "docs"));
    const got = await files(b, [
      { i: 0, p: "last-link" },
      { i: 1, p: "docs/a.txt" },
      { i: 2, p: "keep/k.txt" },
    ]);
    expect(got.bytes.includes(Buffer.from("NOT HER HOME"))).toBe(false);
    expect(
      got.items.map((s) => [
        s.i,
        typeof s.error === "string",
        s.data?.toString() ?? null,
      ]),
    ).toEqual([
      [0, true, null],
      [1, true, null],
      [2, false, "kept"],
    ]);
  });

  it("a path she could not have listed (absolute, with .., not normalised, out of scope) sends no bytes of its target", async () => {
    const b = bed();
    put(b, ".cache/c.bin", "CACHED BYTES");
    put(b, "docs/a.txt", "alpha");
    // The condition: the normalised path sends.
    const good = await files(b, [{ i: 0, p: "docs/a.txt" }]);
    expect(good.items.map((s) => s.data?.toString())).toEqual(["alpha"]);
    for (const p of [
      join(b.outside, "a.txt"),
      "../outside/a.txt",
      "docs/../../outside/a.txt",
      "docs//a.txt",
      ".cache/c.bin",
    ]) {
      const got = await files(b, [{ i: 0, p }]);
      expect([
        p,
        got.bytes.includes(Buffer.from("NOT HER HOME")) ||
          got.bytes.includes(Buffer.from("CACHED BYTES")) ||
          got.bytes.includes(Buffer.from("alpha")),
        got.items.some((s) => s.header !== undefined),
      ]).toEqual([p, false, false]);
    }
  });

  it("sends a SQLite file as a snapshot that holds a row only in its WAL when snapshot is on, an error frame when off, and leaves no snapshot in her home", async () => {
    const b = bed();
    walDatabase(join(b.home, "data/app.db"), ["r1", "only-in-wal"]);
    put(b, "docs/a.txt", "alpha");
    const on = await files(b, [
      { i: 0, p: "data/app.db" },
      { i: 1, p: "docs/a.txt" },
    ]);
    expect(on.error).toBeNull();
    expect(on.items.map((s) => [s.i, s.error === undefined])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(on.items[0].header?.q).toBe(1);
    const copy = join(dir, "copy.db");
    writeFileSync(copy, on.items[0].data!);
    const db = new Database(copy, { readonly: true });
    open.push(db);
    expect(
      (db.query("SELECT x FROM t ORDER BY rowid").all() as { x: string }[]).map(
        (r) => r.x,
      ),
    ).toEqual(["r1", "only-in-wal"]);
    const moveOut = join(b.home, ".isomux-agent/.move-out");
    expect(existsSync(moveOut) ? readdirSync(moveOut) : []).toEqual([]);

    const off = await files(
      b,
      [
        { i: 0, p: "data/app.db" },
        { i: 1, p: "docs/a.txt" },
      ],
      { snapshot: false },
    );
    expect(
      off.items.map((s) => [
        s.i,
        typeof s.error === "string",
        s.data?.toString() ?? null,
      ]),
    ).toEqual([
      [0, true, null],
      [1, false, "alpha"],
    ]);
  });

  // Round 1: the header promised the size, so a file that shrinks while it
  // is read cannot end clean. Padding it would land zeros on the new box as
  // a whole file (the office's own batch reports such a file missing).
  it("a file that shrinks after its header ends the call: no trailer for it, no padding", async () => {
    const b = bed();
    const big = put(b, "docs/big.bin", Buffer.alloc(3 * 1024 * 1024, 0x41));
    const parts: Buffer[] = [];
    let error: string | null = null;
    try {
      await sendHomeFiles(
        {
          home: b.home,
          nonce: NONCE,
          snapshot: true,
          items: [{ i: 0, p: "docs/big.bin" }],
        },
        async (chunk) => {
          const c = Buffer.from(chunk);
          parts.push(c);
          // The header frame: cut the file to 10 bytes before its bytes go.
          if (c.includes(Buffer.from('"p":"docs/big.bin"')))
            truncateSync(big, 10);
        },
      );
    } catch (err) {
      error = (err as Error).message;
    }
    const all = Buffer.concat(parts);
    // The condition: the header went.
    expect(all.includes(Buffer.from('"p":"docs/big.bin"'))).toBe(true);
    expect(error).not.toBeNull();
    expect(all.includes(Buffer.from('"end":true'))).toBe(false);
    expect(all.includes(Buffer.alloc(64, 0))).toBe(false);
  });

  it("C7: removes the snapshots a crashed call left in her .move-out", async () => {
    const b = bed();
    put(b, "docs/a.txt", "alpha");
    const left = put(
      b,
      ".isomux-agent/.move-out/move-ffffffffffffffffffffffffffffffff-0.db",
      "OLD",
    );
    const got = await files(b, [{ i: 0, p: "docs/a.txt" }]);
    expect(got.items.map((s) => s.data?.toString())).toEqual(["alpha"]);
    expect(existsSync(left)).toBe(false);
  });

  it("C7: a nonce that is not 32 hex characters fails the call before it sends anything", async () => {
    const b = bed();
    put(b, "docs/a.txt", "alpha");
    // The condition: the good nonce sends.
    const good = await files(b, [{ i: 0, p: "docs/a.txt" }]);
    expect(good.items.map((s) => s.data?.toString())).toEqual(["alpha"]);
    const got = await files(b, [{ i: 0, p: "docs/a.txt" }], { nonce: "../x" });
    expect(got.error).not.toBeNull();
    expect(got.bytes.includes(Buffer.from("alpha"))).toBe(false);
  });
});

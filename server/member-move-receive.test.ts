// The runner side of the member file move (server/member-move-receive.ts,
// internal-docs/member-os-user-design.md 1.3; slice 1c-ii-a of task
// b94dfd25), run in process as the member's code would run it. The
// properties: a dest outside the member's home or with ".." is refused; a
// short or long body is refused; no byte is written without the free space
// for the whole move; place never replaces a file, and an identical file
// counts as placed but not ours; undo removes only what this move placed and
// still owns, also after a place that succeeded; done and the next files-in
// clear the staging.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  doneFiles,
  placeFiles,
  receiveFiles,
  undoFiles,
} from "./member-move-receive.ts";

let home: string;
let agentRoot: string;
let outside: string;
const NONCE = "0123456789abcdef";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "move-receive-home-"));
  agentRoot = join(home, ".isomux-agent");
  mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
  outside = mkdtempSync(join(tmpdir(), "move-receive-outside-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface Rec {
  dest: string;
  data: Buffer | string;
  mode?: number;
  // A size that differs from the data: a lying header.
  size?: number;
}

// The files-in record stream: u32 big-endian header length, header JSON,
// the bytes; a zero length ends it. Split into small chunks so a record
// crosses chunk boundaries.
async function* body(recs: Rec[], opts: { end?: boolean } = {}) {
  const parts: Buffer[] = [];
  for (const r of recs) {
    const data = Buffer.from(r.data);
    const header = Buffer.from(
      JSON.stringify({
        dest: r.dest,
        size: r.size ?? data.length,
        mode: r.mode ?? 0o600,
      }),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    parts.push(len, header, data);
  }
  if (opts.end !== false) parts.push(Buffer.alloc(4));
  const all = Buffer.concat(parts);
  for (let i = 0; i < all.length; i += 7) yield all.subarray(i, i + 7);
}

const free = (bytes: number) => ({ freeBytes: () => bytes });
const PLENTY = free(2 ** 40);

// "resolved", or the error's code ("refused" for an error without one).
async function codeOf(
  run: Promise<unknown> | (() => unknown),
): Promise<string> {
  try {
    await (typeof run === "function" ? run() : run);
    return "resolved";
  } catch (err) {
    return String((err as NodeJS.ErrnoException).code ?? "refused");
  }
}
const place = () => placeFiles({ nonce: NONCE, agentRoot });

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

const total = (recs: Rec[]) =>
  recs.reduce((n, r) => n + Buffer.from(r.data).length, 0);

async function receive(recs: Rec[], deps = PLENTY) {
  return receiveFiles(
    { nonce: NONCE, total: total(recs), home, agentRoot },
    body(recs),
    deps,
  );
}

describe("files-in", () => {
  it("stages each file and answers the count; place puts them at their dests, 0700-masked", async () => {
    const a = join(home, ".claude", "projects", "p", "s.jsonl");
    const b = join(agentRoot, "provider-homes", "u", "claude", "x");
    const recs = [
      { dest: a, data: "line1\nline2\n", mode: 0o644 },
      { dest: b, data: Buffer.alloc(20000, 7), mode: 0o755 },
    ];
    expect(await receive(recs)).toEqual({ files: 2, bytes: total(recs) });
    expect(existsSync(a)).toBe(false);
    place();
    expect(readFileSync(a, "utf8")).toBe("line1\nline2\n");
    expect(readFileSync(b).equals(Buffer.alloc(20000, 7))).toBe(true);
    expect(lstatSync(a).mode & 0o777).toBe(0o600);
    expect(lstatSync(b).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(a, "..")).mode & 0o777).toBe(0o700);
  });

  for (const [name, dest] of [
    ["relative", "rel/x"],
    ["with ..", "HOME/a/../../escape"],
    ["outside home", "OUTSIDE/x"],
  ] as const) {
    it(`refuses a dest that is ${name}, and writes nothing there`, async () => {
      const path = dest.replace("HOME", home).replace("OUTSIDE", outside);
      const recs = [{ dest: path, data: "secret" }];
      expect(await codeOf(receive(recs))).toBe("refused");
      expect(await codeOf(place)).not.toBe("resolved");
      expect(filesUnder(outside)).toEqual([]);
      expect(existsSync(join(home, "..", "escape"))).toBe(false);
    });
  }

  it("refuses a body shorter or longer than its headers say", async () => {
    const dest = join(home, "f");
    expect(await codeOf(receive([{ dest, data: "abc", size: 10 }]))).toBe(
      "refused",
    );
    expect(await codeOf(receive([{ dest, data: "abcdefghij", size: 3 }]))).toBe(
      "refused",
    );
    expect(
      await codeOf(
        receiveFiles(
          { nonce: NONCE, total: 3, home, agentRoot },
          body([{ dest, data: "abc" }], { end: false }),
          PLENTY,
        ),
      ),
    ).toBe("refused");
  });

  it("refuses ENOSPC before it writes a byte when the free space is short of the total plus the margin", async () => {
    const recs = [
      { dest: join(home, "big"), data: Buffer.alloc(64 * 1024, 1) },
    ];
    // The total fits, the margin (at least 1 GiB) does not.
    expect(await codeOf(receive(recs, free(512 * 1024 * 1024)))).toBe("ENOSPC");
    expect(filesUnder(join(agentRoot, ".move-in"))).toEqual([]);
    // The control: the same move with room passes.
    expect(await receive(recs, free(4 * 1024 * 1024 * 1024))).toEqual({
      files: 1,
      bytes: 64 * 1024,
    });
  });

  it("clears what an earlier failed move left in the staging", async () => {
    const old = join(agentRoot, ".move-in", "old-nonce");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "junk"), "x");
    await receive([{ dest: join(home, "f"), data: "y" }]);
    expect(existsSync(old)).toBe(false);
  });
});

describe("files-place", () => {
  it("never replaces a file that is there with other content, and fails", async () => {
    const dest = join(home, "taken");
    writeFileSync(dest, "hers");
    await receive([{ dest, data: "ours" }]);
    expect(await codeOf(place)).toBe("refused");
    expect(readFileSync(dest, "utf8")).toBe("hers");
  });

  it("takes an identical file as placed but not ours: undo keeps it", async () => {
    const same = join(home, "same");
    const fresh = join(home, "fresh");
    writeFileSync(same, "content");
    const ino = lstatSync(same).ino;
    await receive([
      { dest: same, data: "content" },
      { dest: fresh, data: "new" },
    ]);
    place();
    expect(lstatSync(same).ino).toBe(ino);
    undoFiles({ nonce: NONCE, agentRoot });
    expect(readFileSync(same, "utf8")).toBe("content");
    expect(existsSync(fresh)).toBe(false);
  });
});

describe("files-undo", () => {
  it("after a place that succeeded, removes every file it placed (D2)", async () => {
    const a = join(home, "a", "1");
    const b = join(home, "b", "2");
    await receive([
      { dest: a, data: "1" },
      { dest: b, data: "2" },
    ]);
    place();
    expect([existsSync(a), existsSync(b)]).toEqual([true, true]);
    undoFiles({ nonce: NONCE, agentRoot });
    expect([existsSync(a), existsSync(b)]).toEqual([false, false]);
    expect(existsSync(join(agentRoot, ".move-in", NONCE))).toBe(false);
  });

  it("keeps a placed dest that changed since the place", async () => {
    const a = join(home, "a");
    const b = join(home, "b");
    await receive([
      { dest: a, data: "1" },
      { dest: b, data: "2" },
    ]);
    place();
    // A new file over it, made while the old one exists (so not its inode).
    writeFileSync(`${b}.new`, "hers now");
    renameSync(`${b}.new`, b);
    undoFiles({ nonce: NONCE, agentRoot });
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf8")).toBe("hers now");
  });

  it("after a place that failed halfway, removes the files placed before the failure only", async () => {
    const first = join(home, "first");
    const taken = join(home, "taken");
    writeFileSync(taken, "hers");
    await receive([
      { dest: first, data: "ours" },
      { dest: taken, data: "ours too" },
    ]);
    expect(await codeOf(place)).toBe("refused");
    expect(readFileSync(first, "utf8")).toBe("ours");
    undoFiles({ nonce: NONCE, agentRoot });
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(taken, "utf8")).toBe("hers");
  });
});

// A restore (server/member-restore.ts, slice 3c-ii of task b94dfd25) places
// with keep: what is at a destination stays, and the place goes on.
describe("files-place with keep", () => {
  const placeKeep = (keep: unknown = true) =>
    placeFiles({ nonce: NONCE, agentRoot, keep } as Parameters<
      typeof placeFiles
    >[0]);

  it("keeps a file, a link and a file where a folder goes, names them, and places the rest", async () => {
    const taken = join(home, "taken");
    const link = join(home, "link");
    const target = join(outside, "target");
    const blocked = join(home, "blocked", "x");
    const fresh = join(home, "fresh", "y");
    writeFileSync(taken, "hers");
    writeFileSync(target, "outside");
    symlinkSync(target, link);
    writeFileSync(join(home, "blocked"), "a file");
    await receive([
      { dest: taken, data: "ours" },
      { dest: link, data: "ours" },
      { dest: blocked, data: "ours" },
      { dest: fresh, data: "new" },
    ]);
    const answer = placeKeep();
    expect({
      answer: { ...answer, kept: [...(answer.kept ?? [])].sort() },
      taken: readFileSync(taken, "utf8"),
      target: readFileSync(target, "utf8"),
      link: lstatSync(link).isSymbolicLink(),
      blocked: readFileSync(join(home, "blocked"), "utf8"),
      fresh: readFileSync(fresh, "utf8"),
    }).toEqual({
      answer: { placed: 1, kept: [blocked, link, taken].sort() },
      taken: "hers",
      target: "outside",
      link: true,
      blocked: "a file",
      fresh: "new",
    });
    // An undo removes what it placed, never what it kept.
    undoFiles({ nonce: NONCE, agentRoot });
    expect([existsSync(fresh), readFileSync(taken, "utf8")]).toEqual([
      false,
      "hers",
    ]);
  });

  it("takes keep only as true", async () => {
    const taken = join(home, "taken");
    writeFileSync(taken, "hers");
    await receive([{ dest: taken, data: "ours" }]);
    expect(await codeOf(() => placeKeep("yes"))).toBe("refused");
    expect(readFileSync(taken, "utf8")).toBe("hers");
  });
});

describe("files-done", () => {
  it("removes the staging and keeps the placed files", async () => {
    const a = join(home, "a");
    await receive([{ dest: a, data: "1" }]);
    place();
    doneFiles({ nonce: NONCE, agentRoot });
    expect(existsSync(join(agentRoot, ".move-in", NONCE))).toBe(false);
    expect(readFileSync(a, "utf8")).toBe("1");
  });
});

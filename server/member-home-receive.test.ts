// The member's side of the place of a moved home (task 78733adf, slice
// 5c-2; server/member-home-receive.ts): tree-in and tree-place, run as the
// member by her new runner inside the enable command's go-on. The
// properties: what the office streams lands as the same tree (kinds, bytes,
// modes without setuid or setgid, mtimes, link targets as text); no entry
// lands outside the tree folder, in the runner's own locations, or through
// a link; an entry whose bytes differ from its header fails the call; the
// place takes the old office's data over what the fresh home holds, merges
// folders, never descends into a link of the home, gives read-only folders
// their mode only after their content (D4), and leaves no tree folder
// behind.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  placeTree,
  receiveTree,
  type TreeEntryHeader,
} from "./member-home-receive.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);

let root: string;
let home: string;
let outside: string;

// Tests: give every folder under `dir` u+rwx so rm can take it.
function openUp(dir: string): void {
  if (!existsSync(dir)) return;
  for (const p of [
    "",
    ...(readdirSync(dir, { recursive: true }) as string[]),
  ]) {
    const path = join(dir, p);
    try {
      if (lstatSync(path).isDirectory()) chmodSync(path, 0o700);
    } catch {
      // Gone, or not ours.
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "member-home-receive-"));
  home = join(root, "home");
  outside = join(root, "outside");
  // What a fresh home holds when the place starts: the useradd skeleton and
  // her agent space (the runner makes it at connect).
  mkdirSync(join(home, ".isomux-agent"), { recursive: true, mode: 0o700 });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "outside");
});

afterEach(() => {
  openUp(root);
  rmSync(root, { recursive: true, force: true });
});

// One entry of the stream: its header, and a file's bytes split into the
// given data frames.
interface Item {
  h: TreeEntryHeader;
  data?: (string | Uint8Array)[];
}

function frame(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

const bytesOf = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

// The stream as tree-in reads it, cut into pieces of `chunk` bytes so a
// frame boundary falls anywhere in a read.
function stream(items: Item[], chunk = 7, end = true): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (const item of items) {
    frames.push(frame(new TextEncoder().encode(JSON.stringify(item.h))));
    for (const d of item.data ?? []) frames.push(frame(bytesOf(d)));
  }
  if (end) frames.push(frame(new Uint8Array(0)));
  const all = Buffer.concat(frames);
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += chunk)
    pieces.push(all.subarray(i, i + chunk));
  return pieces;
}

async function* body(pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of pieces) yield p;
}

const dir = (p: string, mode = 0o755, mtime = T0): Item => ({
  h: { p, t: "d", mode, mtime, size: 0 },
});
const file = (
  p: string,
  text: string | string[],
  mode = 0o644,
  mtime = T0,
): Item => {
  const parts = Array.isArray(text) ? text : [text];
  const size = parts.reduce((n, s) => n + Buffer.byteLength(s), 0);
  return {
    h: { p, t: "f", mode, mtime, size },
    data: parts.filter((s) => s.length > 0),
  };
};
const link = (p: string, target: string): Item => ({
  h: { p, t: "l", mode: 0o777, mtime: T0, size: 0, l: target },
});

const totalOf = (items: Item[]) =>
  items.reduce((n, i) => n + (i.h.t === "f" ? i.h.size : 0), 0);

function receive(items: Item[], over: { chunk?: number; total?: number } = {}) {
  return receiveTree(
    { nonce: NONCE, home, total: over.total ?? totalOf(items) },
    body(stream(items, over.chunk)),
  );
}

const treeDir = (nonce = NONCE) =>
  join(home, ".isomux-agent", ".move-in", `tree-${nonce}`);

const modeOf = (p: string) => lstatSync(p).mode & 0o7777;

// Everything under `dir` that is not under its .isomux-agent/.move-in.
function listing(base: string): string[] {
  return (readdirSync(base, { recursive: true }) as string[])
    .filter((p) => !p.startsWith(join(".isomux-agent", ".move-in")))
    .sort();
}

describe("tree-in and tree-place carry the tree", () => {
  it("lands kinds, bytes, file modes, mtimes and link targets as sent, with setuid and setgid dropped", async () => {
    const big = "x".repeat(100_000);
    const items: Item[] = [
      dir("docs", 0o750, T0 + 1000),
      file("docs/a.txt", ["hello ", "world"], 0o640, T0 + 2000),
      file("docs/empty", "", 0o600),
      file("docs/big.bin", [big.slice(0, 40_000), big.slice(40_000)]),
      file("bin-tool", "#!/bin/sh\n", 0o6755),
      // A link is text: never followed, an absolute target too.
      link("docs/to-outside", outside),
      link("rel", "docs/a.txt"),
    ];
    const answer = await receive(items, { chunk: 5 });
    expect(answer).toEqual({ files: 4, bytes: totalOf(items) });
    placeTree({ nonce: NONCE, home });
    expect(readFileSync(join(home, "docs/a.txt"), "utf8")).toBe("hello world");
    expect(readFileSync(join(home, "docs/empty"), "utf8")).toBe("");
    expect(readFileSync(join(home, "docs/big.bin"), "utf8")).toBe(big);
    expect(modeOf(join(home, "docs/a.txt"))).toBe(0o640);
    expect(modeOf(join(home, "docs/empty"))).toBe(0o600);
    expect(modeOf(join(home, "bin-tool"))).toBe(0o755);
    expect(modeOf(join(home, "docs"))).toBe(0o750);
    expect(statSync(join(home, "docs/a.txt")).mtimeMs).toBe(T0 + 2000);
    expect(statSync(join(home, "docs")).mtimeMs).toBe(T0 + 1000);
    expect(lstatSync(join(home, "docs/to-outside")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(home, "docs/to-outside"))).toBe(outside);
    expect(readlinkSync(join(home, "rel"))).toBe("docs/a.txt");
    // Nothing reached the link's target.
    expect(readdirSync(outside)).toEqual(["keep"]);
  });

  it("writes into its own tree folder only, and leaves no tree folder after the place", async () => {
    await receive([dir("d"), file("d/f", "1")]);
    // Before the place, the home itself is as it was.
    expect(listing(home)).toEqual([".isomux-agent"]);
    expect(existsSync(join(treeDir(), "d", "f"))).toBe(true);
    placeTree({ nonce: NONCE, home });
    const moveIn = join(home, ".isomux-agent", ".move-in");
    const left = existsSync(moveIn) ? readdirSync(moveIn) : [];
    expect(left.filter((n) => n.startsWith("tree-"))).toEqual([]);
    expect(readFileSync(join(home, "d", "f"), "utf8")).toBe("1");
  });

  it("removes the tree folders a crashed call left before it writes, read-only folders too", async () => {
    const crashed = treeDir(OTHER_NONCE);
    mkdirSync(join(crashed, "ro"), { recursive: true });
    writeFileSync(join(crashed, "ro", "f"), "old");
    chmodSync(join(crashed, "ro"), 0o555);
    const replaced = `${treeDir(OTHER_NONCE)}-replaced`;
    mkdirSync(replaced);
    await receive([file("f", "new")]);
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(replaced)).toBe(false);
    expect(existsSync(treeDir())).toBe(true);
  });
});

describe("tree-in refuses an entry that would land anywhere else", () => {
  const BAD_PATHS = [
    "/etc/passwd",
    `${"x/".repeat(2)}../../../outside/evil`,
    "../outside/evil",
    "a/../../outside/evil",
    "a//b",
    "",
    ".",
    "a/./b",
    "a/",
    "nul\u0000byte",
    // The runner's own locations in her agent space.
    ".isomux-agent/.move-in/x",
    ".isomux-agent/.move-in",
    ".isomux-agent/.move-out/x",
    ".isomux-agent/apps/units/x",
    ".isomux-agent/apps/secrets",
    ".isomux-agent/skill-folders/x",
    ".isomux-agent/preview/x",
  ];
  for (const bad of BAD_PATHS)
    it(`refuses the path ${JSON.stringify(bad)}`, async () => {
      // The parents a path names exist in the stream, so only the path
      // itself can be the reason.
      const items: Item[] = [
        dir("a"),
        dir("x"),
        dir("x/x"),
        dir(".isomux-agent"),
        dir(".isomux-agent/apps"),
        file(bad, "evil"),
      ];
      await expect(receive(items)).rejects.toThrow();
      expect(readdirSync(outside)).toEqual(["keep"]);
      expect(existsSync(join(root, "evil"))).toBe(false);
    });

  it("takes a plain path in her agent space that is not the runner's (the enabling case of the list above)", async () => {
    await receive([
      dir(".isomux-agent"),
      dir(".isomux-agent/apps"),
      file(".isomux-agent/apps/notes.json", "{}"),
      file(".isomux-agent/settings.json", "{}"),
    ]);
    expect(existsSync(join(treeDir(), ".isomux-agent/apps/notes.json"))).toBe(
      true,
    );
  });

  it("refuses an entry whose folder this call did not make", async () => {
    await expect(receive([file("nofolder/f", "x")])).rejects.toThrow();
  });

  it("refuses an entry under a link it made, and writes nothing through the link", async () => {
    await expect(
      receive([link("l", outside), file("l/evil", "x")]),
    ).rejects.toThrow();
    expect(readdirSync(outside)).toEqual(["keep"]);
  });

  it("refuses an entry that is there already", async () => {
    await expect(
      receive([file("f", "first"), file("f", "second")]),
    ).rejects.toThrow();
    await expect(receive([dir("d"), dir("d")])).rejects.toThrow();
  });

  it("refuses a kind it does not know and a link without a target", async () => {
    await expect(
      receive([
        { h: { p: "s", t: "x" as "f", mode: 0o644, mtime: T0, size: 0 } },
      ]),
    ).rejects.toThrow();
    await expect(
      receive([{ h: { p: "l", t: "l", mode: 0o777, mtime: T0, size: 0 } }]),
    ).rejects.toThrow();
  });

  it("refuses a bad nonce before it writes anything", async () => {
    for (const nonce of [
      "../x",
      "ABCDEF0123456789abcdef0123456789",
      "a".repeat(31),
    ])
      await expect(
        receiveTree({ nonce, home, total: 1 }, body(stream([file("f", "x")]))),
      ).rejects.toThrow();
    expect(existsSync(join(home, ".isomux-agent", ".move-in"))).toBe(false);
  });
});

describe("tree-in takes exactly the bytes a header promises", () => {
  it("fails when the stream ends inside a file", async () => {
    const items: Item[] = [
      {
        h: { p: "f", t: "f", mode: 0o644, mtime: T0, size: 10 },
        data: ["12345"],
      },
    ];
    await expect(receive(items, { total: 10 })).rejects.toThrow();
  });

  it("fails when a file gets more bytes than its header, before the next header", async () => {
    const items: Item[] = [
      {
        h: { p: "f", t: "f", mode: 0o644, mtime: T0, size: 3 },
        data: ["12345"],
      },
      file("g", "x"),
    ];
    await expect(receive(items, { total: 4 })).rejects.toThrow();
  });

  it("fails on data after a folder or a link", async () => {
    await expect(
      receive([{ h: dir("d").h, data: ["x"] }], { total: 1 }),
    ).rejects.toThrow();
    await expect(
      receive([{ h: link("l", "x").h, data: ["x"] }], { total: 1 }),
    ).rejects.toThrow();
  });

  it("fails when the stream has no end frame", async () => {
    await expect(
      receiveTree(
        { nonce: NONCE, home, total: 1 },
        body(stream([file("f", "x")], 7, false)),
      ),
    ).rejects.toThrow();
  });

  it("fails before it writes when her home's file system has no room for the total", async () => {
    await expect(
      receive([file("f", "x")], { total: 2 ** 52 }),
    ).rejects.toThrow();
    const left = existsSync(treeDir()) ? readdirSync(treeDir()) : [];
    expect(left).toEqual([]);
  });
});

describe("tree-place: the old office's data wins over the fresh home", () => {
  it("puts in what the home lacks, replaces what the skeleton holds, merges folders, and keeps what only the home has", async () => {
    // The fresh home: the useradd skeleton, what her user manager made, and
    // her agent space.
    writeFileSync(join(home, ".bashrc"), "skeleton bashrc");
    writeFileSync(join(home, ".profile"), "skeleton profile");
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    writeFileSync(join(home, ".local", "state", "lastlog"), "manager");
    writeFileSync(join(home, ".isomux-agent", "runner-made"), "runner");
    // A file in the home where the tree has a folder, and the reverse.
    writeFileSync(join(home, "notes"), "skeleton file");
    mkdirSync(join(home, "tool"));
    writeFileSync(join(home, "tool", "inside"), "skeleton folder");
    await receive([
      file(".bashrc", "her bashrc"),
      dir(".config", 0o700),
      dir(".config/app"),
      file(".config/app/conf", "her conf"),
      dir(".local"),
      dir(".local/share"),
      file(".local/share/data", "her data"),
      dir(".isomux-agent"),
      file(".isomux-agent/settings.json", "her settings"),
      dir("notes"),
      file("notes/todo", "her todo"),
      file("tool", "her tool file"),
    ]);
    const answer = placeTree({ nonce: NONCE, home });
    expect(answer.replaced).toBe(3);
    const read = (p: string) => readFileSync(join(home, p), "utf8");
    expect(read(".bashrc")).toBe("her bashrc");
    expect(read(".profile")).toBe("skeleton profile");
    expect(read(".config/app/conf")).toBe("her conf");
    expect(existsSync(join(home, ".config/systemd/user"))).toBe(true);
    expect(read(".local/share/data")).toBe("her data");
    expect(read(".local/state/lastlog")).toBe("manager");
    expect(read(".isomux-agent/settings.json")).toBe("her settings");
    expect(read(".isomux-agent/runner-made")).toBe("runner");
    expect(read("notes/todo")).toBe("her todo");
    expect(read("tool")).toBe("her tool file");
    // A merged folder takes the old office's mode.
    expect(modeOf(join(home, ".config"))).toBe(0o700);
    // The replaced entries are gone.
    expect(listing(home)).not.toContain(join("tool", "inside"));
    const moveIn = join(home, ".isomux-agent", ".move-in");
    expect(readdirSync(moveIn).filter((n) => n.startsWith("tree-"))).toEqual(
      [],
    );
  });

  it("never descends into a link of the home: the link is replaced, and its target is untouched", async () => {
    symlinkSync(outside, join(home, ".config"));
    await receive([
      dir(".config"),
      file(".config/keep", "her keep"),
      file(".config/new", "her new"),
    ]);
    placeTree({ nonce: NONCE, home });
    expect(lstatSync(join(home, ".config")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, ".config/keep"), "utf8")).toBe("her keep");
    expect(readdirSync(outside)).toEqual(["keep"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  });

  // D4: a folder without u+w cannot be renamed into another parent, and
  // its content cannot be written once it has its mode.
  it("places read-only folders, at the top and nested, with their content, and gives them their mode and mtime at the end", async () => {
    await receive([
      dir("ro", 0o555, T0 + 10_000),
      file("ro/f", "top"),
      dir("ro/inner", 0o500, T0 + 20_000),
      file("ro/inner/g", "nested"),
      dir("rw"),
      dir("rw/ro", 0o555, T0 + 30_000),
      file("rw/ro/h", "deep"),
    ]);
    placeTree({ nonce: NONCE, home });
    expect(readFileSync(join(home, "ro/f"), "utf8")).toBe("top");
    expect(readFileSync(join(home, "ro/inner/g"), "utf8")).toBe("nested");
    expect(readFileSync(join(home, "rw/ro/h"), "utf8")).toBe("deep");
    expect(modeOf(join(home, "ro"))).toBe(0o555);
    expect(modeOf(join(home, "ro/inner"))).toBe(0o500);
    expect(modeOf(join(home, "rw/ro"))).toBe(0o555);
    expect(statSync(join(home, "ro")).mtimeMs).toBe(T0 + 10_000);
    expect(statSync(join(home, "ro/inner")).mtimeMs).toBe(T0 + 20_000);
    expect(statSync(join(home, "rw/ro")).mtimeMs).toBe(T0 + 30_000);
  });

  it("takes an earlier partial place: the same tree placed twice gives the same home", async () => {
    const items = [dir("d"), file("d/f", "v1"), file("top", "t")];
    await receive(items);
    placeTree({ nonce: NONCE, home });
    // The job ran again from the start (an office restart).
    await receiveTree(
      { nonce: OTHER_NONCE, home, total: totalOf(items) },
      body(stream(items)),
    );
    placeTree({ nonce: OTHER_NONCE, home });
    expect(readFileSync(join(home, "d/f"), "utf8")).toBe("v1");
    expect(readFileSync(join(home, "top"), "utf8")).toBe("t");
    expect(listing(home)).toEqual(
      [".isomux-agent", "d", join("d", "f"), "top"].sort(),
    );
  });

  it("refuses a bad nonce and a tree that is not there, and changes nothing", () => {
    writeFileSync(join(home, "f"), "kept");
    expect(() => placeTree({ nonce: "../../x", home })).toThrow();
    expect(() => placeTree({ nonce: NONCE, home })).toThrow();
    expect(readFileSync(join(home, "f"), "utf8")).toBe("kept");
  });

  it("keeps the mtime of a file the place renames", async () => {
    await receive([file("f", "x", 0o644, T0 + 5000)]);
    // A rename keeps the inode; a copy would not.
    const ino = lstatSync(join(treeDir(), "f")).ino;
    placeTree({ nonce: NONCE, home });
    expect(lstatSync(join(home, "f")).ino).toBe(ino);
    expect(statSync(join(home, "f")).mtimeMs).toBe(T0 + 5000);
  });
});

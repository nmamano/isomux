// Folders outside the home in an office move (task 78733adf, slice 5b): which
// folders the old office moves and why it leaves the others, where each one
// may land on the new office, the scope of a walk inside one, and the new
// office's record of the folders where it staged a copy.
//
// The design round's conditions pinned here:
// - C1: a folder that holds or is inside the home, the state root, the code
//   folder or the backup folder is left (`office`).
// - C2: a folder at or below a temp root is left (`temp`).
// - C3: the order: resolve, drop (home, missing, not a folder), the left
//   reasons, then the fold; a candidate inside a moved folder is listed
//   nowhere.
// - C5: the record names every folder where this box staged a copy; a pass
//   removes the stage of a folder its manifest does not list, and removes
//   only the folders this box made, and only when empty.
// - C6: a part of the path that its group can write, unless the group is
//   gid 0 or the office user's, is unsafe.
//
// collectMoveOutsideFolders and checkMoveInFolder run over a fake disk: the
// tests need folders that another user owns, which a test that is not root
// cannot make.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMoveInFolder,
  clearMoveInOutside,
  collectMoveOutsideFolders,
  createMoveOutsideScope,
  dropMoveInOutside,
  MOVE_IN_OUTSIDE_FILE,
  MOVE_TEMP_ROOTS,
  readMoveInOutside,
  writeMoveInOutside,
  type MoveInFolderFs,
  type MoveOutsideFs,
} from "./office-move-outside.ts";
import { moveAlwaysFetch, moveScope } from "./office-move-scope.ts";
import { MOVE_IN_DIR } from "./office-move-stage.ts";

const ME = 1000;
const MY_GROUP = 1000;
const OTHER = 2000;
const HOME = "/home/u";
const STATE = "/home/u/.isomux";
const CODE = "/opt/isomux";
const BACKUPS = "/var/backups/isomux";

// ---- the old office's fake disk ----

interface OldEntry {
  /** dir: a folder; file; link: a symlink (lstat says not a folder). */
  t: "dir" | "file" | "link";
  uid?: number;
  mode?: number;
  /** For a link: where it resolves. */
  to?: string;
}

/** A fake disk: lstat does not follow the last part; realpath resolves every
 *  link on the path (a prefix match on the table's links). */
function oldFs(table: Record<string, OldEntry>): MoveOutsideFs {
  const resolve = (p: string): string | null => {
    // Resolve the longest link that is a prefix of p, again until none.
    for (let hops = 0; hops < 10; hops++) {
      let hit: string | null = null;
      for (const [k, e] of Object.entries(table))
        if (
          e.t === "link" &&
          (p === k || p.startsWith(`${k}/`)) &&
          (!hit || k.length > hit.length)
        )
          hit = k;
      if (!hit) break;
      p = table[hit].to! + p.slice(hit.length);
    }
    return table[p] && table[p].t !== "link" ? p : null;
  };
  return {
    lstat(p) {
      // The last part is not followed; the parts above it are.
      const slash = p.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : p.slice(0, slash);
      const realParent = parent === "/" ? "/" : resolve(parent);
      if (realParent === null) return null;
      const here = realParent === "/" ? p : `${realParent}${p.slice(slash)}`;
      const e = table[here];
      if (!e) return null;
      return {
        isDirectory: () => e.t === "dir",
        uid: e.uid ?? ME,
        mode:
          (e.t === "dir" ? 0o040000 : e.t === "file" ? 0o100000 : 0o120000) |
          (e.mode ?? 0o755),
      };
    },
    realpath: (p) => resolve(p),
  };
}

function collect(
  paths: string[],
  table: Record<string, OldEntry>,
  over: { codeDir?: string | null; backupDir?: string | null } = {},
) {
  return collectMoveOutsideFolders({
    paths,
    home: HOME,
    stateRoot: STATE,
    codeDir: over.codeDir === undefined ? CODE : over.codeDir,
    backupDir: over.backupDir === undefined ? BACKUPS : over.backupDir,
    uid: ME,
    fs: oldFs(table),
  });
}

const dirs = (...ps: string[]): Record<string, OldEntry> =>
  Object.fromEntries(ps.map((p) => [p, { t: "dir" as const }]));

describe("collectMoveOutsideFolders", () => {
  it("moves the office user's folders outside the home, once each, sorted, with their permission bits", () => {
    const got = collect(
      ["/srv/b", "/srv/a", "/srv/b/", "/srv/a/../a", "/srv/b"],
      {
        ...dirs("/srv"),
        "/srv/a": { t: "dir", mode: 0o750 },
        "/srv/b": { t: "dir", mode: 0o700 },
      },
    );
    expect(got).toEqual({
      move: [
        { path: "/srv/a", mode: 0o750 },
        { path: "/srv/b", mode: 0o700 },
      ],
      left: [],
    });
  });

  it("drops, without listing them, a path that is not absolute, in the home or the home itself, missing, or not a folder", () => {
    const got = collect(
      ["srv/rel", "./x", HOME, `${HOME}/proj`, "/srv/gone", "/srv/file"],
      {
        ...dirs("/srv", "/srv/rel", HOME, `${HOME}/proj`),
        "/srv/file": { t: "file" },
      },
    );
    expect(got).toEqual({ move: [], left: [] });
  });

  it("C2: leaves a folder at or below each temp root (temp), and moves a folder whose name only starts like one", () => {
    expect(MOVE_TEMP_ROOTS).toEqual(["/tmp", "/var/tmp", "/dev/shm", "/run"]);
    const temp = ["/tmp/t-1", "/var/tmp/x", "/dev/shm/y", "/run/user/1000/z"];
    const got = collect(["/tmpx/keep", ...temp], {
      ...dirs("/tmpx", "/tmpx/keep", "/tmp", "/var", "/var/tmp", "/dev"),
      ...dirs("/dev/shm", "/run", "/run/user", "/run/user/1000"),
      ...dirs(...temp),
    });
    expect(got.move.map((m) => m.path)).toEqual(["/tmpx/keep"]);
    expect(got.left).toEqual(
      [...temp].sort().map((path) => ({ path, reason: "temp" })),
    );
  });

  it("leaves a folder with a link on its path (link): the folder itself a link to a folder, or a link above it; the link is never followed into a move", () => {
    const got = collect(["/srv/ln", "/srv/up/sub"], {
      ...dirs("/srv", "/data", "/data/real", "/data/up", "/data/up/sub"),
      "/srv/ln": { t: "link", to: "/data/real" },
      "/srv/up": { t: "link", to: "/data/up" },
    });
    expect(got).toEqual({
      move: [],
      left: [
        { path: "/srv/ln", reason: "link" },
        { path: "/srv/up/sub", reason: "link" },
      ],
    });
  });

  it("C1: leaves a folder that holds or is inside the home, the state root, the code folder or the backup folder (office)", () => {
    const got = collect(
      [
        "/home",
        "/opt",
        "/opt/isomux/ui",
        "/var/backups",
        "/var/backups/isomux/x",
      ],
      {
        ...dirs("/home", HOME, STATE, "/opt", CODE, `${CODE}/ui`),
        ...dirs("/var", "/var/backups", BACKUPS, `${BACKUPS}/x`),
      },
    );
    expect(got).toEqual({
      move: [],
      left: [
        { path: "/home", reason: "office" },
        { path: "/opt", reason: "office" },
        { path: "/opt/isomux/ui", reason: "office" },
        { path: "/var/backups", reason: "office" },
        { path: "/var/backups/isomux/x", reason: "office" },
      ],
    });
    // The condition: with no code or backup folder, the same paths move
    // (except /home, which holds the home).
    const none = collect(
      ["/opt", "/opt/isomux/ui", "/var/backups/isomux/x"],
      {
        ...dirs(
          "/opt",
          CODE,
          `${CODE}/ui`,
          "/var",
          "/var/backups",
          BACKUPS,
          `${BACKUPS}/x`,
        ),
      },
      { codeDir: null, backupDir: null },
    );
    expect(none.move.map((m) => m.path)).toEqual([
      "/opt",
      "/var/backups/isomux/x",
    ]);
  });

  it("leaves a folder another user owns (owner)", () => {
    const got = collect(["/srv/theirs", "/srv/mine"], {
      ...dirs("/srv", "/srv/mine"),
      "/srv/theirs": { t: "dir", uid: OTHER },
    });
    expect(got).toEqual({
      move: [{ path: "/srv/mine", mode: 0o755 }],
      left: [{ path: "/srv/theirs", reason: "owner" }],
    });
  });

  it("C3: folds a folder into a moved ancestor and lists it nowhere, also when it would be left; a left folder is listed only when no ancestor moves", () => {
    const got = collect(
      [
        "/srv/p/sub",
        "/srv/p",
        "/srv/p/theirs",
        "/srv/pp",
        "/srv/q",
        "/srv/q/mine",
        "/srv/q/mine/deep",
        "/srv/a/b",
      ],
      {
        ...dirs("/srv", "/srv/p", "/srv/p/sub", "/srv/pp"),
        "/srv/p/theirs": { t: "dir", uid: OTHER },
        "/srv/q": { t: "dir", uid: OTHER },
        ...dirs("/srv/q/mine", "/srv/q/mine/deep", "/srv/a", "/srv/a/b"),
      },
    );
    expect(got).toEqual({
      // /srv/pp is a sibling of /srv/p, not inside it; /srv/a/b moves alone,
      // never its parent.
      move: [
        { path: "/srv/a/b", mode: 0o755 },
        { path: "/srv/p", mode: 0o755 },
        { path: "/srv/pp", mode: 0o755 },
        { path: "/srv/q/mine", mode: 0o755 },
      ],
      left: [{ path: "/srv/q", reason: "owner" }],
    });
  });
});

// ---- the new office's fake disk ----

interface NewEntry {
  t: "dir" | "file" | "link";
  uid?: number;
  gid?: number;
  mode?: number;
  /** A folder's names. */
  names?: string[];
  writable?: boolean;
}

function newFs(table: Record<string, NewEntry>): MoveInFolderFs {
  return {
    lstat(p) {
      const e = table[p];
      if (!e) return null;
      return {
        isDirectory: () => e.t === "dir",
        isSymbolicLink: () => e.t === "link",
        uid: e.uid ?? 0,
        gid: e.gid ?? 0,
        mode:
          (e.t === "dir" ? 0o040000 : e.t === "file" ? 0o100000 : 0o120000) |
          (e.mode ?? 0o755),
      };
    },
    readdir(p) {
      const e = table[p];
      if (!e || e.t !== "dir") throw new Error(`ENOTDIR: ${p}`);
      return [...(e.names ?? [])];
    },
    writable: (p) => table[p]?.writable === true,
  };
}

const BASE: Record<string, NewEntry> = {
  "/": { t: "dir" },
  "/srv": { t: "dir" },
  "/home": { t: "dir" },
  [HOME]: { t: "dir", uid: ME, gid: MY_GROUP, writable: true },
};

function check(path: string, extra: Record<string, NewEntry>, mode = 0o750) {
  return checkMoveInFolder(path, {
    home: HOME,
    uid: ME,
    gid: MY_GROUP,
    user: "u",
    group: "g",
    mode,
    fs: newFs({ ...BASE, ...extra }),
  });
}

const blocked = (c: ReturnType<typeof check>) =>
  c.ok ? { ok: true } : { reason: c.reason, at: c.at };

/** The words of a command, for checks that do not depend on its spacing. */
const words = (cmd: string | undefined) => (cmd ?? "").trim().split(/\s+/);
const after = (ws: string[], flag: string) => ws[ws.indexOf(flag) + 1];

describe("checkMoveInFolder", () => {
  it("an absent folder under a part the office user can write: ok, with the parts to make, top down", () => {
    const got = check("/srv/a/b/p", {
      "/srv": { t: "dir", uid: ME, gid: MY_GROUP, writable: true },
    });
    expect(got).toEqual({
      path: "/srv/a/b/p",
      ok: true,
      create: ["/srv/a", "/srv/a/b", "/srv/a/b/p"],
    });
  });

  it("an absent folder whose deepest existing part the office user cannot write: no_write there, with a root command that makes the folder for the office user with its mode", () => {
    const got = check("/srv/p", {}, 0o750);
    expect(blocked(got)).toEqual({ reason: "no_write", at: "/srv" });
    const ws = words(!got.ok ? got.command : undefined);
    expect(ws.slice(0, 3)).toEqual(["sudo", "install", "-d"]);
    expect(after(ws, "-o")).toBe("u");
    expect(after(ws, "-g")).toBe("g");
    expect(parseInt(after(ws, "-m"), 8)).toBe(0o750);
    expect(ws[ws.length - 1]).toBe("/srv/p");
  });

  it("an existing folder of the office user that is empty, or holds only the move's stage: ok, nothing to make", () => {
    for (const names of [[], [".isomux-move-in"]])
      expect(
        check("/srv/p", {
          "/srv/p": { t: "dir", uid: ME, gid: MY_GROUP, names },
        }),
      ).toEqual({ path: "/srv/p", ok: true, create: [] });
  });

  it("an existing folder that holds anything else: not_empty", () => {
    const got = check("/srv/p", {
      "/srv/p": { t: "dir", uid: ME, names: [".isomux-move-in", "lost+found"] },
    });
    expect(blocked(got)).toEqual({ reason: "not_empty", at: "/srv/p" });
  });

  it("an existing folder another user owns: owner, with a root command that gives it to the office user", () => {
    const got = check("/srv/p", { "/srv/p": { t: "dir", uid: OTHER } });
    expect(blocked(got)).toEqual({ reason: "owner", at: "/srv/p" });
    const ws = words(!got.ok ? got.command : undefined);
    expect(ws).toContain("chown");
    expect(ws).toContain("u:g");
    expect(ws[ws.length - 1]).toBe("/srv/p");
  });

  it("an existing folder that root owns: owner too (only the office user's own folder takes the copy)", () => {
    const got = check("/srv/p", { "/srv/p": { t: "dir", uid: 0 } });
    expect(blocked(got)).toEqual({ reason: "owner", at: "/srv/p" });
  });

  it("an existing folder that does not read is refused, never thrown (the status calls the check at each request)", () => {
    const fs = newFs({
      ...BASE,
      "/srv/p": { t: "dir", uid: ME, gid: MY_GROUP },
    });
    let got: ReturnType<typeof check> | string;
    try {
      got = checkMoveInFolder("/srv/p", {
        home: HOME,
        uid: ME,
        gid: MY_GROUP,
        user: "u",
        group: "g",
        mode: 0o750,
        fs: {
          ...fs,
          readdir: () => {
            throw Object.assign(new Error("EACCES: permission denied"), {
              code: "EACCES",
            });
          },
        },
      });
    } catch (err) {
      got = `threw: ${String(err)}`;
    }
    expect(typeof got === "string" ? got : got.ok).toBe(false);
  });

  it("a part above the folder that another user owns: owner at that part; root's parts and the office user's pass", () => {
    const got = check("/srv/x/p", {
      "/srv/x": { t: "dir", uid: OTHER, writable: true },
    });
    expect(blocked(got)).toEqual({ reason: "owner", at: "/srv/x" });
    // The condition: the same part owned by the office user passes.
    expect(
      check("/srv/x/p", {
        "/srv/x": { t: "dir", uid: ME, writable: true },
      }).ok,
    ).toBe(true);
  });

  it("a link on the path, above the folder or the folder itself: link at that part", () => {
    expect(blocked(check("/srv/l/p", { "/srv/l": { t: "link" } }))).toEqual({
      reason: "link",
      at: "/srv/l",
    });
    expect(blocked(check("/srv/p", { "/srv/p": { t: "link" } }))).toEqual({
      reason: "link",
      at: "/srv/p",
    });
  });

  it("a part that is not a folder, above the folder or the folder itself: not_dir at that part", () => {
    expect(blocked(check("/srv/f/p", { "/srv/f": { t: "file" } }))).toEqual({
      reason: "not_dir",
      at: "/srv/f",
    });
    expect(
      blocked(check("/srv/p", { "/srv/p": { t: "file", uid: ME } })),
    ).toEqual({
      reason: "not_dir",
      at: "/srv/p",
    });
  });

  it("a part that others can write without the sticky bit: unsafe_parent; with the sticky bit it passes", () => {
    const open = (mode: number) =>
      check("/srv/p", {
        "/srv": { t: "dir", mode, writable: true },
      });
    expect(blocked(open(0o777))).toEqual({
      reason: "unsafe_parent",
      at: "/srv",
    });
    expect(open(0o1777)).toEqual({
      path: "/srv/p",
      ok: true,
      create: ["/srv/p"],
    });
  });

  it("C6: a part that its group can write: unsafe_parent, unless the group is root's or the office user's", () => {
    const group = (gid: number) =>
      check("/srv/p", {
        "/srv": { t: "dir", gid, mode: 0o775, writable: true },
      });
    expect(blocked(group(3000))).toEqual({
      reason: "unsafe_parent",
      at: "/srv",
    });
    expect(group(0).ok).toBe(true);
    expect(group(MY_GROUP).ok).toBe(true);
  });

  it("a folder in the home, the home itself, or a folder that holds the home: in_home", () => {
    for (const p of [`${HOME}/x`, HOME, "/home"])
      expect(
        check(p, {}).ok ? "ok" : (check(p, {}) as { reason: string }).reason,
      ).toBe("in_home");
  });

  it("names the topmost part that fails", () => {
    const got = check("/srv/l/x/p", {
      "/srv": { t: "dir", mode: 0o777 },
      "/srv/l": { t: "link" },
    });
    expect(blocked(got)).toEqual({ reason: "unsafe_parent", at: "/srv" });
  });
});

// ---- the walk's scope inside an outside folder ----

describe("createMoveOutsideScope", () => {
  it("takes everything but specials and the new office's top-level stage; no caches, no bound units, no sign-in rule", () => {
    const scope = createMoveOutsideScope("/srv/p");
    expect(scope.home).toBe("/srv/p");
    const v = (rel: string, kind: "file" | "dir" | "other" = "file") =>
      moveScope(scope, rel, kind).in;
    expect([
      v(".isomux-move-in", "dir"),
      v(".isomux-move-in/stage/a.txt"),
      v("sock", "other"),
    ]).toEqual([false, false, false]);
    expect([
      v("sub/.isomux-move-in", "dir"),
      v(".isomux-move-inx"),
      v(".cache/x"),
      v(".ssh/authorized_keys"),
      v(".isomux/sessions.json"),
      v("a/b.txt"),
    ]).toEqual([true, true, true, true, true, true]);
    // A later pass fetches again only SQLite side files here: no sign-in
    // file lives in an outside folder.
    expect(moveAlwaysFetch(scope, ".ssh/id_ed25519")).toBe(false);
    expect(moveAlwaysFetch(scope, ".config/gh/hosts.yml")).toBe(false);
    expect(moveAlwaysFetch(scope, "data/app.db-wal")).toBe(true);
  });
});

// ---- the new office's record (C5) ----

let base = "";
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

function scratch() {
  base = mkdtempSync(join(tmpdir(), "move-outside-"));
  const home = join(base, "home");
  mkdirSync(join(home, MOVE_IN_DIR), { recursive: true });
  return { home, out: join(base, "out") };
}

/** A folder with a stage holding one file. */
function staged(folder: string): void {
  mkdirSync(join(folder, MOVE_IN_DIR, "stage"), { recursive: true });
  writeFileSync(join(folder, MOVE_IN_DIR, "stage", "f.txt"), "copy");
}

describe("the record of outside folders", () => {
  it("reads empty when absent or unreadable; writes 0600 in the move-in folder and reads back", () => {
    const { home } = scratch();
    expect(readMoveInOutside(home)).toEqual({ staged: [], created: [] });
    const file = join(home, MOVE_IN_DIR, MOVE_IN_OUTSIDE_FILE);
    writeFileSync(file, "{not json");
    expect(readMoveInOutside(home)).toEqual({ staged: [], created: [] });
    const rec = { staged: ["/srv/a", "/srv/b"], created: ["/srv/a"] };
    writeMoveInOutside(home, rec);
    expect(readMoveInOutside(home)).toEqual(rec);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("C5: a pass drops the stage of each folder its manifest does not list, removes the empty folders this box made, and keeps a folder it did not make", () => {
    const { home, out } = scratch();
    const made = join(out, "made"); // made by this box, dropped
    const theirs = join(out, "theirs"); // was there, dropped
    const kept = join(out, "kept"); // still listed
    for (const f of [made, theirs, kept]) staged(f);
    writeMoveInOutside(home, {
      staged: [made, theirs, kept],
      created: [out, made, kept],
    });
    dropMoveInOutside(home, [kept]);
    expect(existsSync(made)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(join(theirs, MOVE_IN_DIR))).toBe(false);
    // The kept folder keeps its stage, and the folder made above it stays.
    expect(
      readFileSync(join(kept, MOVE_IN_DIR, "stage", "f.txt"), "utf8"),
    ).toBe("copy");
    expect(readMoveInOutside(home).staged).toEqual([kept]);
    expect(readMoveInOutside(home).created.sort()).toEqual([kept, out].sort());
  });

  it("removes made folders deepest first, and never a made folder that holds something else", () => {
    const { home, out } = scratch();
    const outer = join(out, "n");
    const inner = join(outer, "m");
    const busy = join(out, "busy");
    staged(inner);
    staged(busy);
    writeFileSync(join(busy, "someone.txt"), "not ours");
    writeMoveInOutside(home, {
      staged: [inner, busy],
      created: [outer, inner, busy],
    });
    dropMoveInOutside(home, []);
    expect(existsSync(outer)).toBe(false);
    expect(readFileSync(join(busy, "someone.txt"), "utf8")).toBe("not ours");
    expect(existsSync(join(busy, MOVE_IN_DIR))).toBe(false);
    expect(readMoveInOutside(home).staged).toEqual([]);
  });

  it("a cancel with no record changes nothing", () => {
    const { home } = scratch();
    dropMoveInOutside(home, []);
    expect(readMoveInOutside(home)).toEqual({ staged: [], created: [] });
  });

  it("the end of the swap removes every stage and the record, and no folder, even an empty one this box made", () => {
    const { home, out } = scratch();
    const a = join(out, "a");
    const b = join(out, "b");
    staged(a);
    staged(b);
    writeFileSync(join(b, "moved.txt"), "the old office's file");
    writeMoveInOutside(home, { staged: [a, b], created: [out, a] });
    clearMoveInOutside(home);
    expect([
      existsSync(join(a, MOVE_IN_DIR)),
      existsSync(join(b, MOVE_IN_DIR)),
    ]).toEqual([false, false]);
    expect(existsSync(a)).toBe(true);
    expect(readFileSync(join(b, "moved.txt"), "utf8")).toBe(
      "the old office's file",
    );
    expect(existsSync(join(home, MOVE_IN_DIR, MOVE_IN_OUTSIDE_FILE))).toBe(
      false,
    );
  });
});

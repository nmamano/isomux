// scripts/worktree-remove.sh removes one task worktree folder under
// isomux-worktrees/, next to the main checkout (task f55f2a03). It removes a
// live worktree through git, deletes a leftover that git no longer tracks and
// that has no .git entry, and refuses everything else, so an agent can clean
// a cut `git worktree remove` without an rm -rf the safety hook blocks. Each
// case runs the script in a scratch repo with the layout worktree-setup.sh
// builds: <parent>/isomux and <parent>/isomux-worktrees/<name>.
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "worktree-remove.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The environment without the caller's GIT_* variables and git config. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

type Fixture = {
  /** The folder that holds the checkout and isomux-worktrees. */
  parent: string;
  /** The main checkout. */
  repo: string;
  /** <parent>/isomux-worktrees. */
  worktrees: string;
};

/** A scratch main checkout with one commit; isomux-worktrees is not made. */
function fixture(): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "worktree-remove-")));
  roots.push(parent);
  const repo = join(parent, "isomux");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "init");
  return { parent, repo, worktrees: join(parent, "isomux-worktrees") };
}

/** A live worktree on its own branch, as worktree-setup.sh adds it. */
function addWorktree(f: Fixture, name: string): string {
  const path = join(f.worktrees, name);
  git(f.repo, "worktree", "add", "-q", path, "-b", name);
  return path;
}

/** A folder with files and no .git entry that git does not list. */
function addLeftover(f: Fixture, name: string): string {
  const path = join(f.worktrees, name);
  mkdirSync(join(path, "ui", "dist"), { recursive: true });
  writeFileSync(join(path, "README"), "x\n");
  writeFileSync(join(path, "ui", "dist", "app.js"), "x\n");
  return path;
}

/** The paths `git worktree list --porcelain` names. */
function listed(f: Fixture): string[] {
  return git(f.repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Every entry under the parent, with its type, without following links. */
function snapshot(f: Fixture): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (path === join(f.repo, ".git")) continue;
      const st = lstatSync(path);
      const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : "f";
      out.push(`${kind} ${path.slice(f.parent.length)}`);
      if (kind === "d") walk(path);
    }
  };
  walk(f.parent);
  return out;
}

function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], { cwd, env: gitEnv() });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

describe("worktree-remove.sh removes", () => {
  it("a clean live worktree through git, and keeps its branch", () => {
    const f = fixture();
    const path = addWorktree(f, "t-live");
    expect(listed(f)).toContain(path);

    const r = run(f.repo, "t-live");
    expect(r).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(listed(f)).toEqual([f.repo]);
    expect(git(f.repo, "branch", "--list", "t-live")).toContain("t-live");
  });

  it("a leftover git no longer lists, and does not follow a link inside it", () => {
    const f = fixture();
    const path = addLeftover(f, "t-left");
    const outside = join(f.parent, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x\n");
    symlinkSync(outside, join(path, "link"));
    expect(listed(f)).not.toContain(path);

    const r = run(f.repo, "t-left");
    expect(r).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(existsSync(f.worktrees)).toBe(true);
  });

  it("a listed worktree whose .git file is gone (a cut remove)", () => {
    const f = fixture();
    const path = addWorktree(f, "t-cut");
    rmSync(join(path, ".git"));
    // git still lists it: only a prune drops the entry.
    expect(listed(f)).toContain(path);

    const r = run(f.repo, "t-cut");
    expect(r).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(listed(f)).toEqual([f.repo]);
  });

  it("a dirty worktree with --force", () => {
    const f = fixture();
    const path = addWorktree(f, "t-dirty");
    writeFileSync(join(path, "README"), "changed\n");
    writeFileSync(join(path, "new-file"), "x\n");

    const r = run(f.repo, "t-dirty", "--force");
    expect(r).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(listed(f)).toEqual([f.repo]);
  });

  it("only the named folder when another worktree's name starts with it", () => {
    const f = fixture();
    const live = addWorktree(f, "t-abc");
    writeFileSync(join(live, "work"), "x\n");
    const path = addLeftover(f, "t-ab");

    const r = run(f.repo, "t-ab");
    expect(r).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(live, "work"))).toBe(true);
    expect(listed(f)).toEqual([f.repo, live]);
  });
});

describe("worktree-remove.sh finishes with nothing to do", () => {
  it("when the folder is missing", () => {
    const f = fixture();
    addWorktree(f, "t-other");
    const before = snapshot(f);

    expect(run(f.repo, "t-gone")).toMatchObject({ code: 0 });
    expect(snapshot(f)).toEqual(before);
  });

  it("when isomux-worktrees is missing", () => {
    const f = fixture();
    const before = snapshot(f);

    expect(run(f.repo, "t-gone")).toMatchObject({ code: 0 });
    expect(snapshot(f)).toEqual(before);
  });
});

describe("worktree-remove.sh refuses and changes nothing", () => {
  /**
   * Runs the script and checks that it exits with one of `codes`, prints a
   * reason, and leaves every entry under the parent and git's worktree list
   * as they were. 128 is git's own failure code: the script passes git's
   * refusal through, and `set -e` passes on a failed name check.
   */
  function refuses(
    f: Fixture,
    cwd: string,
    args: string[],
    codes: number[],
  ): void {
    const before = snapshot(f);
    const beforeListed = listed(f);
    const r = run(cwd, ...args);
    expect(codes).toContain(r.code);
    expect(r.stderr).not.toBe("");
    expect(snapshot(f)).toEqual(before);
    expect(listed(f)).toEqual(beforeListed);
  }

  it("a dirty worktree without --force", () => {
    const f = fixture();
    const path = addWorktree(f, "t-dirty");
    writeFileSync(join(path, "new-file"), "x\n");
    refuses(f, f.repo, ["t-dirty"], [1, 128]);
    expect(existsSync(join(path, "new-file"))).toBe(true);
  });

  it("a locked worktree, with and without --force", () => {
    const f = fixture();
    const path = addWorktree(f, "t-locked");
    git(f.repo, "worktree", "lock", path);
    refuses(f, f.repo, ["t-locked"], [1, 128]);
    refuses(f, f.repo, ["t-locked", "--force"], [1, 128]);
    expect(existsSync(join(path, "README"))).toBe(true);
  });

  it("an unlisted folder with a .git file, .git folder or .git link", () => {
    const f = fixture();
    const makes = [
      (p: string) => writeFileSync(join(p, ".git"), "gitdir: /nowhere\n"),
      (p: string) => mkdirSync(join(p, ".git")),
      (p: string) => symlinkSync("/nowhere", join(p, ".git")),
    ];
    makes.forEach((make, i) => make(addLeftover(f, `t-git${i}`)));
    for (const i of makes.keys()) {
      refuses(f, f.repo, [`t-git${i}`], [1]);
      refuses(f, f.repo, [`t-git${i}`, "--force"], [1]);
    }
  });

  it("a folder that is a link, a dangling link or a file", () => {
    const f = fixture();
    mkdirSync(f.worktrees);
    const target = join(f.parent, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "x\n");
    symlinkSync(target, join(f.worktrees, "t-odd0"));
    symlinkSync("/nowhere", join(f.worktrees, "t-odd1"));
    writeFileSync(join(f.worktrees, "t-odd2"), "x\n");
    for (const i of [0, 1, 2]) {
      refuses(f, f.repo, [`t-odd${i}`], [1]);
      refuses(f, f.repo, [`t-odd${i}`, "--force"], [1]);
    }
  });

  it("when isomux-worktrees is a link", () => {
    const f = fixture();
    const real = join(f.parent, "real-worktrees");
    mkdirSync(real);
    symlinkSync(real, f.worktrees);
    addLeftover(f, "t-left");
    refuses(f, f.repo, ["t-left"], [1]);
    refuses(f, f.repo, ["t-left", "--force"], [1]);
  });

  it("a name that is not one folder under isomux-worktrees", () => {
    const f = fixture();
    // Each name would reach a folder with no .git entry if the script took it.
    mkdirSync(join(f.parent, "isomux-worktrees", "a", "b"), {
      recursive: true,
    });
    for (const name of ["a/b", "..", ".", "", "--force"])
      refuses(f, f.repo, [name], [1, 2, 128]);
    expect(existsSync(f.repo)).toBe(true);
  });

  it("a call that is not <name> or <name> --force", () => {
    const f = fixture();
    addLeftover(f, "t-left");
    refuses(f, f.repo, [], [2]);
    refuses(f, f.repo, ["t-left", "--nope"], [2]);
    refuses(f, f.repo, ["t-left", "--force", "extra"], [2]);
  });

  it("a run outside the main checkout root", () => {
    const f = fixture();
    const live = addWorktree(f, "t-live");
    addLeftover(f, "t-left");
    mkdirSync(join(f.repo, "sub"));
    refuses(f, live, ["t-left"], [1]);
    refuses(f, join(f.repo, "sub"), ["t-left"], [1]);
  });
});

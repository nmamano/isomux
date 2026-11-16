// scripts/worktree-setup.sh makes the worktree <parent>/isomux-worktrees/<name>
// on branch <name> from the main checkout's HEAD. These cases cover a branch
// <name> that is still there when its folder is gone, as after Isomux Main's
// merge cleanup of one slice of a multi-slice task (task ff3641b2): when the
// branch's work is in main the script starts the branch again from main's
// tip, and when it is not the script refuses and changes nothing. Each case
// runs the script in a scratch repo with fake `bun` and `flock` on PATH, so
// the install and build steps are no-ops.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "worktree-setup.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type Fixture = {
  parent: string;
  /** The main checkout. */
  repo: string;
  /** <parent>/isomux-worktrees. */
  worktrees: string;
  /** A folder with the fake bun and flock. */
  bin: string;
};

/** The environment without the caller's GIT_* variables and git config. */
function gitEnv(f?: Fixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    ...(f ? { PATH: `${f.bin}:${env.PATH ?? ""}` } : {}),
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
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string, msg: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

/** A scratch main checkout with one commit, and the fake tools. */
function fixture(): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-")));
  roots.push(parent);
  const repo = join(parent, "isomux");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "README", "one\ntwo\nthree\n", "init");
  const bin = join(parent, "bin");
  mkdirSync(bin);
  for (const tool of ["bun", "flock"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, tool), 0o755);
  }
  return { parent, repo, worktrees: join(parent, "isomux-worktrees"), bin };
}

/**
 * Branch <name> with the commits `work` makes in its worktree, and the
 * worktree then removed, as Isomux Main's cleanup leaves it. Returns the tip.
 */
function staleBranch(
  f: Fixture,
  name: string,
  work: (path: string) => void,
): string {
  const path = join(f.worktrees, name);
  git(f.repo, "worktree", "add", "-q", path, "-b", name);
  work(path);
  const tip = git(path, "rev-parse", "HEAD");
  git(f.repo, "worktree", "remove", path);
  expect(existsSync(path)).toBe(false);
  return tip;
}

/** Squash the branch's changes into main as one commit on main. */
function squashIntoMain(f: Fixture, name: string) {
  git(f.repo, "merge", "--squash", "-q", name);
  git(f.repo, "commit", "-q", "-m", `squash ${name}`);
}

function listed(f: Fixture): string[] {
  return git(f.repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

function run(f: Fixture, name: string) {
  const r = Bun.spawnSync(["bash", SCRIPT, name], {
    cwd: f.repo,
    env: gitEnv(f),
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** The script made <name> on main's tip and printed its path last. */
function expectMadeOnMain(f: Fixture, name: string, r: ReturnType<typeof run>) {
  const path = join(f.worktrees, name);
  const mainTip = git(f.repo, "rev-parse", "main");
  expect(r.code).toBe(0);
  expect(r.stdout.trim().split("\n").at(-1)).toBe(path);
  expect(listed(f)).toContain(path);
  expect(git(path, "symbolic-ref", "--short", "HEAD")).toBe(name);
  expect(git(path, "rev-parse", "HEAD")).toBe(mainTip);
  expect(git(f.repo, "rev-parse", `refs/heads/${name}`)).toBe(mainTip);
  expect(git(path, "status", "--porcelain")).toBe("");
}

/** The script refused: no worktree, branch where it was, the tip named. */
function expectRefused(
  f: Fixture,
  name: string,
  tip: string,
  r: ReturnType<typeof run>,
) {
  const path = join(f.worktrees, name);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(existsSync(path)).toBe(false);
  expect(listed(f)).toEqual([f.repo]);
  expect(git(f.repo, "rev-parse", `refs/heads/${name}`)).toBe(tip);
  expect(r.stderr).toContain(tip.slice(0, 7));
}

describe("worktree-setup.sh starts a stale branch again from main", () => {
  it("when main holds the branch tip (Main squashed in the worktree)", () => {
    const f = fixture();
    const tip = staleBranch(f, "t-anc", (p) => commit(p, "a", "a\n", "a"));
    git(f.repo, "merge", "-q", "--ff-only", "t-anc");
    commit(f.repo, "later", "later\n", "main moves on");
    expect(git(f.repo, "rev-parse", "main")).not.toBe(tip);

    const r = run(f, "t-anc");
    expectMadeOnMain(f, "t-anc", r);
    // The old tip is named, so a wrong reset is easy to undo.
    expect(r.stderr).toContain(tip.slice(0, 7));
  });

  it("when main holds the branch's changes squashed on another branch", () => {
    const f = fixture();
    const tip = staleBranch(f, "t-sq", (p) => {
      commit(p, "README", "one\nTWO\nthree\n", "edit README");
      commit(p, "b", "b\n", "add b");
    });
    commit(f.repo, "other", "other\n", "main moves on before the squash");
    squashIntoMain(f, "t-sq");
    commit(f.repo, "later", "later\n", "main moves on after the squash");
    // The branch tip is not in main's history: only its content is.
    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", tip, "main"], {
        cwd: f.repo,
        env: gitEnv(),
      }).exitCode,
    ).toBe(1);

    const r = run(f, "t-sq");
    expectMadeOnMain(f, "t-sq", r);
    expect(r.stderr).toContain(tip.slice(0, 7));
  });
});

describe("worktree-setup.sh refuses a branch with work that is not in main", () => {
  it("when the branch has a commit main never got", () => {
    const f = fixture();
    const tip = staleBranch(f, "t-new", (p) => commit(p, "c", "c\n", "c"));
    commit(f.repo, "later", "later\n", "main moves on");

    expectRefused(f, "t-new", tip, run(f, "t-new"));
  });

  it("when main got a squash of the branch but not its last commit", () => {
    const f = fixture();
    const name = "t-more";
    const path = join(f.worktrees, name);
    git(f.repo, "worktree", "add", "-q", path, "-b", name);
    commit(path, "d", "d\n", "slice work");
    squashIntoMain(f, name);
    const tip = commit(path, "e", "e\n", "work after the squash");
    git(f.repo, "worktree", "remove", path);
    commit(f.repo, "later", "later\n", "main moves on");

    expectRefused(f, name, tip, run(f, name));
  });

  it("when merging the branch into main conflicts", () => {
    const f = fixture();
    const tip = staleBranch(f, "t-conf", (p) =>
      commit(p, "README", "one\nbranch\nthree\n", "edit line two"),
    );
    squashIntoMain(f, "t-conf");
    // Main later changes the same line, so the branch no longer merges.
    commit(f.repo, "README", "one\nmain\nthree\n", "main edits line two");

    expectRefused(f, "t-conf", tip, run(f, "t-conf"));
  });

  it("when a tag of the same name points into main", () => {
    const f = fixture();
    const tip = staleBranch(f, "t-tag", (p) => commit(p, "g", "g\n", "g"));
    // git resolves a bare name to refs/tags before refs/heads.
    git(f.repo, "tag", "t-tag", "main");
    commit(f.repo, "later", "later\n", "main moves on");

    expectRefused(f, "t-tag", tip, run(f, "t-tag"));
  });

  it("when the branch shares no history with main", () => {
    const f = fixture();
    git(f.repo, "checkout", "-q", "--orphan", "t-orph");
    git(f.repo, "rm", "-q", "-rf", "--cached", ".");
    const tip = commit(f.repo, "z", "z\n", "unrelated");
    git(f.repo, "checkout", "-q", "-f", "main");
    rmSync(join(f.repo, "z"), { force: true });

    expectRefused(f, "t-orph", tip, run(f, "t-orph"));
  });
});

describe("worktree-setup.sh with no branch of that name", () => {
  it("makes the branch and the worktree on main's tip", () => {
    const f = fixture();
    commit(f.repo, "later", "later\n", "main moves on");

    expectMadeOnMain(f, "t-fresh", run(f, "t-fresh"));
  });
});

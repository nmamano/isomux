// Guards against git variables inherited from a hook. `git push` from a
// linked worktree runs .githooks/pre-push with GIT_DIR set to
// <main>/.git/worktrees/<name>; the CI run it starts once let the temp-repo
// tests write core.bare, user.* and tags into the shared repo. Each case sets
// that environment against a throwaway probe repository and checks the probe
// is unchanged: the hook unsets the variables, and the test preload refuses
// to run when they are set anyway. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GIT_REPO_ENV_VARS } from "./git-env.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "git-env.fixture.ts");
const HOOK = join(ROOT, ".githooks", "pre-push");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Probe = { base: string; main: string; wt: string; env: Record<string, string> };

/** A repo with a linked worktree, and the git environment a hook started from that worktree sees. */
function makeProbe(): Probe {
  const base = mkdtempSync(join(tmpdir(), "isomux-git-env-probe-"));
  dirs.push(base);
  const main = join(base, "main");
  const wt = join(base, "wt");
  git(base, "init", "-q", "-b", "main", main);
  git(main, "config", "user.email", "probe@probe");
  git(main, "config", "user.name", "Probe");
  writeFileSync(join(main, "f.txt"), "probe\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "probe");
  git(main, "worktree", "add", "-q", wt, "-b", "lane");
  const gitDir = join(main, ".git", "worktrees", "wt");
  return {
    base,
    main,
    wt,
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: wt,
      GIT_INDEX_FILE: join(gitDir, "index"),
      GIT_COMMON_DIR: join(main, ".git"),
    },
  };
}

/** Everything a leak writes: the shared config, and every ref with its commit. */
function snapshot(p: Probe): string {
  return (
    readFileSync(join(p.main, ".git", "config"), "utf8") +
    git(p.main, "for-each-ref", "--format=%(refname) %(objectname)")
  );
}

/** process.env without the test preload's per-process claims, for a nested bun. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("ISOMUX_TEST_") && k !== "ISOMUX_HOME") env[k] = v;
  }
  return { ...env, ...extra };
}

describe("git variables inherited from a hook", () => {
  it("the list covers every variable the installed git names", () => {
    const listed = git(ROOT, "rev-parse", "--local-env-vars").split("\n");
    expect(listed.length).toBeGreaterThan(0);
    const known: readonly string[] = GIT_REPO_ENV_VARS;
    expect(listed.filter((name) => !known.includes(name))).toEqual([]);
  });

  it("bun test refuses to run tests with the hook's git variables set", () => {
    const probe = makeProbe();
    const before = snapshot(probe);
    // Two files: bun charges a preload failure to one file and can still run
    // the others, so a refusal that stops only one file must fail this case.
    const copies = ["a", "b"].map((n) => join(probe.base, `${n}.fixture.ts`));
    for (const copy of copies) copyFileSync(FIXTURE, copy);
    const runFixture = (env: Record<string, string>) =>
      spawnSync("bun", ["test", ...copies], {
        cwd: ROOT,
        env: childEnv(env),
        encoding: "utf8",
        timeout: 60_000,
      });
    const poisoned = runFixture(probe.env);
    expect(snapshot(probe)).toBe(before);
    expect(poisoned.status).not.toBe(0);
    expect(poisoned.stderr).toContain("GIT_DIR");
    // Control: the fixture passes when nothing is inherited, so the refusal
    // above comes from the environment, not from a broken fixture.
    const clean = runFixture({});
    expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0);
  });

  it("the pre-push hook starts CI without the hook's git variables", () => {
    const probe = makeProbe();
    const bin = join(probe.base, "bin");
    mkdirSync(bin);
    const envOut = join(probe.base, "ci-env.txt");
    // Stands in for `bun run ci`: records the environment CI would get.
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nenv > "$CI_ENV_OUT"\n');
    chmodSync(join(bin, "bun"), 0o755);
    const r = spawnSync("bash", [HOOK], {
      cwd: probe.wt,
      env: {
        ...childEnv(probe.env),
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: probe.base,
        CI_ENV_OUT: envOut,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const names = readFileSync(envOut, "utf8")
      .split("\n")
      .map((line) => line.split("=")[0]);
    expect(names).toContain("CI_ENV_OUT");
    for (const name of GIT_REPO_ENV_VARS) expect(names).not.toContain(name);
  });
});

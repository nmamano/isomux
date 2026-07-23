// server/version.ts — git-derived version identity. Exercises the uncached
// resolveVersionInfo seam against throwaway git repos in the OS temp dir;
// getVersionInfo (the cached production entry) is just resolveVersionInfo over
// the real checkout, so only the null-on-no-git contract is pinned for it via
// a non-repo directory. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveVersionInfo, resolveReachableRelease } from "./version.ts";

let repo: string;
let emptyDir: string;

function sh(cmd: string): string {
  return execSync(cmd, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "isomux-version-test-"));
  emptyDir = mkdtempSync(join(tmpdir(), "isomux-version-empty-"));
  sh("git init -q");
  sh("git config user.email test@test && git config user.name Test");
  writeFileSync(join(repo, "f.txt"), "one\n");
  sh("git add . && git commit -qm one");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("resolveVersionInfo", () => {
  it("untagged commit: short-SHA version, full commit, null release", () => {
    const info = resolveVersionInfo(repo);
    const head = sh("git rev-parse HEAD");
    expect(info.commit).toBe(head);
    expect(info.release).toBeNull();
    // --always falls back to the short SHA when no v* tag matches.
    expect(info.version).toBeTruthy();
    expect(head.startsWith(info.version!)).toBe(true);
  });

  it("HEAD exactly at an annotated v-tag: version === release === tag", () => {
    sh('git tag -a v2026.7.19 -m "isomux v2026.7.19"');
    const info = resolveVersionInfo(repo);
    expect(info.release).toBe("v2026.7.19");
    expect(info.version).toBe("v2026.7.19");
    expect(info.commit).toBe(sh("git rev-parse HEAD"));
  });

  it("commits after the tag: describe-suffixed version, null release", () => {
    writeFileSync(join(repo, "f.txt"), "two\n");
    sh("git add . && git commit -qm two");
    const info = resolveVersionInfo(repo);
    expect(info.release).toBeNull();
    expect(info.version).toMatch(/^v2026\.7\.19-1-g[0-9a-f]+$/);
  });

  it("dirty worktree appends -dirty", () => {
    writeFileSync(join(repo, "f.txt"), "three\n");
    try {
      const info = resolveVersionInfo(repo);
      expect(info.version).toMatch(/-dirty$/);
    } finally {
      sh("git checkout -q -- f.txt");
    }
  });

  it("non-v tags are ignored for version identity", () => {
    sh("git tag not-a-release");
    const info = resolveVersionInfo(repo);
    expect(info.release).toBeNull();
    expect(info.version).toMatch(/^v2026\.7\.19-1-g/);
  });

  it("an exact v-tag that is not CalVer never reports as a release", () => {
    writeFileSync(join(repo, "f.txt"), "four\n");
    sh("git add . && git commit -qm four");
    sh('git tag -a v1.0 -m "not a channel release"');
    const info = resolveVersionInfo(repo);
    expect(info.release).toBeNull();
    // It still shows up as the human-readable describe identity.
    expect(info.version).toBe("v1.0");
  });

  it("a CalVer tag is found even when another v-tag shares the commit", () => {
    // v1.0 (non-CalVer) already sits on HEAD; describe --exact-match could
    // pick either. Enumeration must surface the CalVer one.
    sh('git tag -a v2026.7.20 -m "release"');
    const info = resolveVersionInfo(repo);
    expect(info.release).toBe("v2026.7.20");
  });

  it("two CalVer tags on one commit resolve to the highest, numerically", () => {
    // v2026.7.20 from the previous test is on HEAD; add a same-day .2 and a
    // trap for lexicographic sorting (.10 must beat .2).
    sh("git tag v2026.7.20.2 && git tag v2026.7.20.10");
    const info = resolveVersionInfo(repo);
    expect(info.release).toBe("v2026.7.20.10");
  });

  it("not a git repo: all fields null", () => {
    const info = resolveVersionInfo(emptyDir);
    expect(info).toEqual({ version: null, commit: null, release: null });
  });
});

// The update notice's lineage anchor. Builds on the tag state left by the
// resolveVersionInfo suite above: HEAD carries v1.0 + v2026.7.20 + same-day
// .2/.10 tags, with v2026.7.19 one commit back.
describe("resolveReachableRelease", () => {
  it("newest reachable CalVer tag wins, numerically (same-day .10 beats .2)", () => {
    expect(resolveReachableRelease(repo)).toBe("v2026.7.20.10");
  });

  it("a nearer non-CalVer v-tag does not mask the reachable release (the describe pitfall)", () => {
    // A v-prefixed non-CalVer tag on a NEW commit sits between HEAD and every
    // CalVer tag: `git describe` would report it, hiding the lineage. The
    // dedicated query must still find the CalVer tag behind it.
    writeFileSync(join(repo, "f.txt"), "five\n");
    sh("git add . && git commit -qm five");
    sh('git tag -a v2.0 -m "not a channel release"');
    expect(resolveReachableRelease(repo)).toBe("v2026.7.20.10");
  });

  it("dirty worktree does not affect the answer", () => {
    writeFileSync(join(repo, "f.txt"), "six\n");
    try {
      expect(resolveReachableRelease(repo)).toBe("v2026.7.20.10");
    } finally {
      sh("git checkout -q -- f.txt");
    }
  });

  it("no reachable CalVer tag (only non-CalVer tags / not a repo): null", () => {
    const bare = mkdtempSync(join(tmpdir(), "isomux-reach-test-"));
    try {
      execSync(
        "git init -q && git config user.email t@t && git config user.name T",
        { cwd: bare, stdio: ["ignore", "pipe", "pipe"] },
      );
      writeFileSync(join(bare, "f.txt"), "one\n");
      execSync("git add . && git commit -qm one && git tag v1.0", {
        cwd: bare,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(resolveReachableRelease(bare)).toBeNull();
      expect(resolveReachableRelease(emptyDir)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

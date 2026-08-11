// The copy's own checks, and the guard in front of `rm -rf`.
//
// The transformation and its manifest proof live in `artifact.test.ts`; what is
// tested here is what this program adds on top - that the copy is the tree that
// was measured, and that only the directory this run created can be removed.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REQUIRED_IN_ARTIFACT,
  archiveAllHold,
  judgeArchive,
  removable,
} from "./vercel-archive-deploy.ts";

const WORKSPACE = path.join(import.meta.dir, "..", "..");

describe("what may be removed", () => {
  test("the exact directory this run created, and nothing else", () => {
    const created = fs.mkdtempSync(path.join(os.tmpdir(), "d3-guard-"));
    try {
      expect(removable(created, created, WORKSPACE)).toBe(true);

      const other = fs.mkdtempSync(path.join(os.tmpdir(), "d3-other-"));
      expect(removable(other, created, WORKSPACE)).toBe(false);
      fs.rmSync(other, { recursive: true, force: true });

      // The parent of what we made is not what we made.
      expect(removable(path.dirname(created), created, WORKSPACE)).toBe(false);
    } finally {
      fs.rmSync(created, { recursive: true, force: true });
    }
  });

  test("EMPTY, ROOT, RELATIVE AND WORKSPACE PATHS ARE ALL REFUSED", () => {
    for (const candidate of ["", "/", ".", "relative/path", WORKSPACE]) {
      expect({
        candidate,
        removable: removable(candidate, candidate, WORKSPACE),
      }).toEqual({ candidate, removable: false });
    }
  });

  test("a path inside the workspace is refused even if it looks temporary", () => {
    const inside = path.join(WORKSPACE, "tmp-d3-not-really-temp");
    expect(removable(inside, inside, WORKSPACE)).toBe(false);
  });

  test("a directory that no longer exists is refused rather than assumed", () => {
    const gone = path.join(os.tmpdir(), "d3-guard-never-created-12345");
    expect(removable(gone, gone, WORKSPACE)).toBe(false);
  });
});

describe("what the copy must contain", () => {
  test("an empty copy holds none of the checks that matter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-arch-"));
    try {
      const verdict = judgeArchive(dir);
      expect(verdict.requiredPathsPresent).toBe(false);
      expect(verdict.fileCountInRange).toBe(false);
      expect(archiveAllHold(verdict)).toBe(false);
      // An empty copy still has no link, which is why "no link" alone is
      // never the whole verdict.
      expect(verdict.noVercelLinkAnywhere).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("A .vercel ANYWHERE IN THE COPY FAILS IT, even an empty directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-arch-"));
    try {
      fs.mkdirSync(path.join(dir, "nested", "deep", ".vercel"), {
        recursive: true,
      });
      expect(judgeArchive(dir).noVercelLinkAnywhere).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("THE ROOT vercel.json IS NOT REQUIRED - the artifact removes it", () => {
    // It was required while its exclusion was still a measurement. It is now a
    // transformation, so requiring it here would contradict the artifact.
    expect(REQUIRED_IN_ARTIFACT).not.toContain("vercel.json" as never);
  });

  test("the imports the build must resolve are named explicitly", () => {
    for (const required of [
      "control-plane/store.ts",
      "control-plane/signup.ts",
      "control-plane/web/bun.lock",
    ]) {
      expect(REQUIRED_IN_ARTIFACT).toContain(required as never);
    }
  });
});

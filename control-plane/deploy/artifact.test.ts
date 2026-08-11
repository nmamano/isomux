// The deployment artifact: exactly three transformations, and a manifest that
// cannot drift away from the repository it is cut from.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EXCLUDED_FROM_ARTIFACT,
  INSTALL_COMMAND,
  REPLACED_IN_ARTIFACT,
  hasEntryNamed,
  repositoryDigests,
  repositoryUnchanged,
  safeToTouch,
  transformArtifact,
  transformIsExact,
} from "./artifact.ts";

const WORKSPACE = path.join(import.meta.dir, "..", "..");

function read(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE, rel), "utf8"));
}

/** `bun.lock` is JSONC: it carries trailing commas that strict JSON rejects. */
function readLock(rel: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(WORKSPACE, rel), "utf8");
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
}

/** A copy shaped like the real one: the files the transformation touches. */
function fakeArtifact(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-fake-"));
  fs.writeFileSync(path.join(dir, "vercel.json"), '{"landing":true}');
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"office"}');
  fs.writeFileSync(path.join(dir, "bun.lock"), '{"office":true}');
  fs.mkdirSync(path.join(dir, "control-plane", "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "control-plane", "store.ts"), "");
  return dir;
}

describe("the three transformations, and no others", () => {
  test("one removal, two replacements, zero additions", () => {
    const dir = fakeArtifact();
    try {
      const verdict = transformArtifact(dir, WORKSPACE);
      expect(verdict.removed).toEqual([EXCLUDED_FROM_ARTIFACT]);
      expect(verdict.replaced).toEqual(["bun.lock", "package.json"]);
      expect(verdict.added).toEqual([]);
      expect(verdict.copiesMatchSource).toBe(true);
      expect(verdict.filesAfter).toBe(verdict.filesBefore - 1);
      expect(transformIsExact(verdict)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("THE REPLACEMENTS ARE BYTE-FOR-BYTE THE COMMITTED SOURCES", () => {
    const dir = fakeArtifact();
    try {
      transformArtifact(dir, WORKSPACE);
      for (const { artifact, source } of REPLACED_IN_ARTIFACT) {
        expect(fs.readFileSync(path.join(dir, artifact))).toEqual(
          fs.readFileSync(path.join(WORKSPACE, source)),
        );
      }
      // And the office's own files are gone from the copy, which is the point.
      expect(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      ).not.toContain("office");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("THE REPOSITORY IS NEVER TOUCHED", () => {
    const dir = fakeArtifact();
    const before = repositoryDigests(WORKSPACE);
    try {
      transformArtifact(dir, WORKSPACE);
      expect(repositoryUnchanged(WORKSPACE, before)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a symlink is never written through or unlinked", () => {
    const dir = fakeArtifact();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "d3-out-"));
    try {
      const victim = path.join(outside, "precious");
      fs.writeFileSync(victim, "keep me");
      fs.rmSync(path.join(dir, "vercel.json"));
      fs.symlinkSync(victim, path.join(dir, "vercel.json"));
      expect(safeToTouch(path.join(dir, "vercel.json"), dir)).toBe(false);
      expect(() => transformArtifact(dir, WORKSPACE)).toThrow();
      expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an empty .vercel directory is still found", () => {
    const dir = fakeArtifact();
    try {
      fs.mkdirSync(path.join(dir, "deep", ".vercel"), { recursive: true });
      expect(hasEntryNamed(dir, ".vercel")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the install command", () => {
  test("two frozen installs, root first, and a fail-closed anchor", () => {
    expect((INSTALL_COMMAND.match(/--frozen-lockfile/g) ?? []).length).toBe(2);
    // The anchor must come before the first install, or a wrong starting
    // directory would install something somewhere else before anyone noticed.
    const anchor = INSTALL_COMMAND.indexOf("test -f");
    const firstInstall = INSTALL_COMMAND.indexOf("bun install");
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(anchor).toBeLessThan(firstInstall);
    // Never an unfrozen install, and never the office manifest's postinstall.
    expect(INSTALL_COMMAND).not.toMatch(/bun install(?!\s+--frozen-lockfile)/);
  });
});

describe("the two manifest pairs are distinct contracts", () => {
  const vercel = read("control-plane/deploy/vercel-root/package.json");
  const provisioner = read("control-plane/deploy/package.json");
  const repo = read("package.json");
  const web = read("control-plane/web/package.json");

  const declaredIn = (m: Record<string, unknown>) => ({
    ...((m.dependencies as Record<string, string>) ?? {}),
    ...((m.devDependencies as Record<string, string>) ?? {}),
  });

  test("THE ARTIFACT ROOT PAIR CARRIES THE TYPES; THE PROVISIONER'S DOES NOT", () => {
    // The provisioner's manifest is a RUNTIME contract for an image holding
    // provider credentials. A build-only declaration there would muddy it, and
    // this is the test that keeps the two apart.
    expect(Object.keys(vercel.dependencies as object)).toEqual(["pg"]);
    expect(Object.keys(vercel.devDependencies as object)).toEqual([
      "@types/pg",
    ]);
    expect(Object.keys(provisioner.dependencies as object)).toEqual(["pg"]);
    expect(provisioner.devDependencies).toBeUndefined();
  });

  test("the artifact root manifest is private and runs no script", () => {
    // A script in a manifest installed at the artifact root would execute on
    // Vercel's builder. There is none, and this is what says so.
    expect(vercel.private).toBe(true);
    expect(vercel.scripts).toBeUndefined();
  });

  test("EVERY spec in EITHER pair matches BOTH the repository and the web package", () => {
    const inRepo = declaredIn(repo);
    const inWeb = declaredIn(web);
    for (const [label, manifest] of [
      ["artifact-root", vercel],
      ["provisioner", provisioner],
    ] as const) {
      const declared = declaredIn(manifest);
      expect(Object.keys(declared).length).toBeGreaterThan(0);
      for (const [name, spec] of Object.entries(declared)) {
        expect({ label, name, repo: inRepo[name], web: inWeb[name] }).toEqual({
          label,
          name,
          repo: spec,
          web: spec,
        });
      }
    }
  });

  test("EACH LOCK DESCRIBES ITS OWN MANIFEST AND NOT ANOTHER ONE", () => {
    // The failure this prevents: an artifact whose root lockfile still
    // describes a different manifest, where a frozen install either refuses or
    // stops proving what the artifact actually installs.
    for (const [lockPath, manifest] of [
      ["control-plane/deploy/vercel-root/bun.lock", vercel],
      ["control-plane/deploy/bun.lock", provisioner],
    ] as const) {
      const lock = readLock(lockPath);
      const workspaces = lock.workspaces as Record<
        string,
        {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      >;
      const root = workspaces[""];
      expect(root).toBeDefined();
      expect({ lockPath, declared: declaredIn(root as never) }).toEqual({
        lockPath,
        declared: declaredIn(manifest),
      });
    }
  });
});

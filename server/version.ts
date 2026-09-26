// Version identity for this deployment (see internal-docs/release-design.md).
//
// Direct-host deployments use a Git checkout; containers use a build-generated
// identity record when Git is absent, and a Render build uses the deployed
// commit from Render's environment. Releases are annotated
// CalVer tags, and deriving the version from the checkout means nothing (a
// package.json field, a constant) can drift from what is actually running.
// When git is unavailable the fields are null rather than a guess.

import { execSync } from "child_process";
import { join } from "path";
import { readFileSync, statSync } from "fs";

export interface VersionInfo {
  // Human-readable identity: the exact tag when HEAD is a release
  // ("v2026.7.19"), `git describe` between releases ("v2026.7.19-5-gabc1234"),
  // or a bare short SHA before any release tag exists; "-dirty" appended on
  // uncommitted changes.
  version: string | null;
  // Full HEAD SHA.
  commit: string | null;
  // The tag name when HEAD is EXACTLY at a v* tag, else null - the
  // machine-readable "is this a pinned release" signal the update surfaces
  // key on.
  release: string | null;
}

const PROJECT_ROOT = join(import.meta.dir, "..");

// args is a fixed shell fragment (constants below, never caller input); the
// "v*" match pattern is single-quoted so the shell can't glob it against
// repo-root files (vercel.json would match an unquoted v*).
function git(root: string, args: string): string | null {
  try {
    const out = execSync(`git ${args}`, {
      cwd: root,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// The release-channel tag shape (scripts/release.sh, scripts/update.sh use
// the same rule): vYYYY.M.D with an optional .N for same-day releases. An
// exact v-tag that is NOT CalVer (a stray "v1.0") must not report as a
// release - release consumers treat non-null as "pinned to the channel".
export const CALVER_RELEASE_RE = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;

// Container builds export this record from the selected committed revision.
// Invalid or absent metadata never invents a version.
function imageVersion(root: string): VersionInfo {
  const unknown = { version: null, commit: null, release: null };
  try {
    const path = join(root, "version-info.json");
    if (statSync(path).size > 4096) return unknown;
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).sort().join(",") !== "commit,release,version" ||
      typeof v.commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(v.commit) ||
      !(
        v.release === null ||
        (typeof v.release === "string" &&
          CALVER_RELEASE_RE.test(v.release) &&
          !v.release.includes("\n"))
      ) ||
      v.version !== (v.release ?? v.commit)
    )
      return unknown;
    return { version: v.version, commit: v.commit, release: v.release };
  } catch {
    return unknown;
  }
}

// Where the identity came from. "git" is a source checkout; "image" is a
// container with no checkout: build metadata, or the platform's record of the
// deployed commit. The update checker keys its mode on this.
export type VersionSource = "git" | "image" | null;

// Render builds deploy/container/Dockerfile from the repository without .git
// or context.py, so the image has no version-info.json. Render sets the
// deployed commit in the runtime environment.
function renderVersion(env: Record<string, string | undefined>): VersionInfo {
  const commit = env.RENDER_GIT_COMMIT;
  if (env.RENDER !== "true" || !commit || !/^[a-f0-9]{40}$/.test(commit)) {
    return { version: null, commit: null, release: null };
  }
  return { version: commit, commit, release: null };
}

// Uncached resolution against an explicit checkout - the testable seam.
// Precedence: git, then image metadata, then the Render environment.
export function resolveVersion(
  root: string,
  env: Record<string, string | undefined> = process.env,
): { info: VersionInfo; source: VersionSource } {
  const commit = git(root, "rev-parse HEAD");
  if (!commit) {
    const image = imageVersion(root);
    if (image.commit) return { info: image, source: "image" };
    const render = renderVersion(env);
    return { info: render, source: render.commit ? "image" : null };
  }
  // Enumerate ALL tags at HEAD rather than trusting `describe --exact-match`
  // to pick one: with a release tag and another v-tag on the same commit,
  // describe may return the non-CalVer tag and hide the release. Normally
  // exactly one CalVer tag matches; version-numeric sort makes the freak
  // multi-release-tag case deterministic (highest wins).
  const release =
    git(root, "tag --points-at HEAD")
      ?.split("\n")
      .map((t) => t.trim())
      .filter((t) => CALVER_RELEASE_RE.test(t))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1) ?? null;
  return {
    info: {
      version: git(root, "describe --tags --always --dirty --match 'v*'"),
      commit,
      release,
    },
    source: "git",
  };
}

export function resolveVersionInfo(
  root: string,
  env: Record<string, string | undefined> = process.env,
): VersionInfo {
  return resolveVersion(root, env).info;
}

// The newest CalVer release tag reachable from HEAD - the lineage anchor an
// untagged checkout's update notice compares against the latest release
// ("which release is this commit past?"). A dedicated query rather than
// parsing `git describe`: describe picks the NEAREST v* tag, so a stray
// non-CalVer tag (a local "v1.0") between HEAD and the release would mask
// the reachable release. Same numeric sort as the points-at resolution
// above. Exported for tests.
export function resolveReachableRelease(root: string): string | null {
  return (
    git(root, "tag --merged HEAD --list 'v*'")
      ?.split("\n")
      .map((t) => t.trim())
      .filter((t) => CALVER_RELEASE_RE.test(t))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1) ?? null
  );
}

// The version never changes within a process lifetime (an update always
// restarts the server), so resolve once on first use.
// Identity and source are one cached resolution, so the checker mode can
// never disagree with the identity it reports.
let cached: { info: VersionInfo; source: VersionSource } | null = null;
let cachedReachable: string | null | undefined;

export function getVersionInfo(): VersionInfo {
  cached ??= resolveVersion(PROJECT_ROOT);
  return cached.info;
}

export function getVersionSource(): VersionSource {
  cached ??= resolveVersion(PROJECT_ROOT);
  return cached.source;
}

export function getReachableRelease(): string | null {
  if (cachedReachable === undefined) {
    cachedReachable = resolveReachableRelease(PROJECT_ROOT);
  }
  return cachedReachable;
}

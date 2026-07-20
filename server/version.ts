// Version identity for this deployment (release-channel slice C1, see
// internal-docs/release-design.md).
//
// Every deployment is a git checkout (dev box or installer-managed
// /opt/isomux), so git is the single source of truth: releases are annotated
// CalVer tags, and deriving the version from the checkout means nothing (a
// package.json field, a constant) can drift from what is actually running.
// When git is unavailable the fields are null rather than a guess.

import { execSync } from "child_process";
import { join } from "path";

export interface VersionInfo {
  // Human-readable identity: the exact tag when HEAD is a release
  // ("v2026.7.19"), `git describe` between releases ("v2026.7.19-5-gabc1234"),
  // or a bare short SHA before any release tag exists; "-dirty" appended on
  // uncommitted changes.
  version: string | null;
  // Full HEAD SHA.
  commit: string | null;
  // The tag name when HEAD is EXACTLY at a v* tag, else null — the
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
// release — release consumers treat non-null as "pinned to the channel".
export const CALVER_RELEASE_RE = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;

// Uncached resolution against an explicit checkout — the testable seam.
export function resolveVersionInfo(root: string): VersionInfo {
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
    version: git(root, "describe --tags --always --dirty --match 'v*'"),
    commit: git(root, "rev-parse HEAD"),
    release,
  };
}

// The version never changes within a process lifetime (an update always
// restarts the server), so resolve once on first use.
let cached: VersionInfo | null = null;

export function getVersionInfo(): VersionInfo {
  cached ??= resolveVersionInfo(PROJECT_ROOT);
  return cached;
}

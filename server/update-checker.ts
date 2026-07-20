// Update-available checker feeding the UI banner (update_status events).
// Two modes, decided once at startup (release-channel slice C1,
// internal-docs/release-design.md):
//
// - "commit" (no /etc/isomux/update.conf — dev boxes like Nil's): the original
//   behavior, local HEAD vs. the GitHub main tip. The banner means "you have
//   commit drift; pull and restart".
// - "release" (update.conf present — updater-managed boxes, written by
//   deploy/install.sh): the running release (server/version.ts) vs. the
//   configured repo's latest GitHub release. The banner means "a new release
//   exists; the in-UI trigger / isomux-update applies it". The conf file is
//   the mode signal because it exists exactly on boxes where isomux-update is
//   the sanctioned update path — a VPS bootstrapped from main pre-first-release
//   is still release mode (and stays QUIET, not nagged about commit drift).
//
// Zero-release sanity: releases/latest answering 404 is the legitimate
// "no releases yet" case — quiet status, no error, no retry spam. Only
// transport/HTTP errors keep the previous status (same posture as the commit
// mode fetch). A non-github REPO_URL disables release checks entirely (we can
// only enumerate releases via the GitHub API).

import { execSync } from "child_process";
import { join } from "path";
import type { CommitDriftInfo, UpdateStatusWire } from "../shared/types.ts";
import { getVersionInfo, CALVER_RELEASE_RE } from "./version.ts";
import { readUpdateConf } from "./update-conf.ts";

// Commit-mode drift target. Release mode derives owner/repo from the conf's
// REPO_URL instead, so forks keep a working banner.
const REPO = "nmamano/isomux";
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const PROJECT_ROOT = join(import.meta.dir, "..");

const EMPTY_COMMIT: CommitDriftInfo = { sha: "", message: "", date: "" };

let status: UpdateStatusWire = {
  mode: "commit",
  updateAvailable: false,
  current: { ...EMPTY_COMMIT },
  latest: { ...EMPTY_COMMIT },
};

let onChange: ((s: UpdateStatusWire) => void) | null = null;

// --- Commit mode ------------------------------------------------------------

function getLocalCommit(): CommitDriftInfo | null {
  try {
    // Format: hash\nmessage\nISO date
    const out = execSync('git log -1 --format="%H%n%s%n%aI"', {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    })
      .toString()
      .trim();
    const [sha, message, date] = out.split("\n");
    return { sha, message, date };
  } catch {
    return null;
  }
}

async function fetchLatestCommit(): Promise<CommitDriftInfo | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits/main`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sha: data.sha,
      message: data.commit?.message?.split("\n")[0] ?? "",
      date: data.commit?.committer?.date ?? "",
    };
  } catch {
    return null;
  }
}

async function checkCommit() {
  const current = getLocalCommit();
  if (!current) return;

  const latest = await fetchLatestCommit();
  if (!latest) return;

  publish({
    mode: "commit",
    updateAvailable: current.sha !== latest.sha,
    current,
    latest,
  });
}

// --- Release mode -----------------------------------------------------------

export interface LatestRelease {
  tag: string;
  publishedAt: string | null;
  url: string | null; // GitHub release page (the notes)
}

// "https://github.com/owner/repo[.git]" / "git@github.com:owner/repo[.git]"
// → "owner/repo"; anything else null. The segment charset is restricted to
// GitHub's own (alphanumeric plus ._-) so a hostile REPO_URL cannot smuggle
// query/fragment/path syntax into the api.github.com URL built from the
// result. Exported for tests.
export function githubOwnerRepo(url: string): string | null {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(\.git)?$/.exec(
      url,
    ) ??
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(\.git)?$/.exec(url);
  return m ? m[1] : null;
}

// CalVer order: v2026.7.19 < v2026.7.19.2 < v2026.7.20. Exported for tests.
export function compareCalver(a: string, b: string): number {
  const parse = (t: string) =>
    t
      .slice(1)
      .split(".")
      .map((n) => parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Map a releases/latest response body to the wire shape. A non-CalVer tag (a
// fork publishing its own scheme) counts as "none": the channel only ever
// offers tags scripts/update.sh would accept. Exported for tests.
export function pickRelease(data: unknown): LatestRelease | "none" {
  const d = data as {
    tag_name?: unknown;
    published_at?: unknown;
    html_url?: unknown;
  };
  const tag = typeof d.tag_name === "string" ? d.tag_name : "";
  if (!CALVER_RELEASE_RE.test(tag)) return "none";
  return {
    tag,
    publishedAt: typeof d.published_at === "string" ? d.published_at : null,
    url: typeof d.html_url === "string" ? d.html_url : null,
  };
}

// The release-mode decision, pure for tests. `current.release` null means the
// box is not pinned to a release tag (e.g. bootstrapped from main before the
// first release existed): once a release exists, that box should be offered
// the hop onto the channel, so any release counts as available.
export function computeReleaseStatus(
  current: { release: string | null; version: string | null },
  latest: LatestRelease | null,
): UpdateStatusWire {
  const updateAvailable =
    latest !== null &&
    (current.release === null ||
      compareCalver(latest.tag, current.release) > 0);
  return { mode: "release", updateAvailable, current, latest };
}

async function fetchLatestRelease(
  ownerRepo: string,
): Promise<LatestRelease | "none" | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${ownerRepo}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.status === 404) return "none"; // no releases yet — the quiet case
    if (!res.ok) return null;
    return pickRelease(await res.json());
  } catch {
    return null;
  }
}

async function checkRelease(ownerRepo: string) {
  const latest = await fetchLatestRelease(ownerRepo);
  if (latest === null) return; // transient error: keep the previous status
  const v = getVersionInfo();
  publish(
    computeReleaseStatus(
      { release: v.release, version: v.version },
      latest === "none" ? null : latest,
    ),
  );
}

// --- Shared plumbing --------------------------------------------------------

// Pure change test, exported for tests: notify on any material difference in
// the wire payload — an availability flip, but also a new latest release
// arriving under an already-up banner (true→true with a different tag must
// re-broadcast or clicking "Update now" would target the stale release), and
// available→equal after the box updated. Suppress only an identical payload.
export function statusChanged(
  prev: UpdateStatusWire,
  next: UpdateStatusWire,
): boolean {
  return JSON.stringify(prev) !== JSON.stringify(next);
}

function publish(next: UpdateStatusWire) {
  const changed = statusChanged(status, next);
  status = next;
  if (changed && onChange) {
    onChange(status);
  }
}

export function getUpdateStatus(): UpdateStatusWire {
  return status;
}

export function onUpdateChange(cb: (s: UpdateStatusWire) => void) {
  onChange = cb;
}

export function startUpdateChecker() {
  const conf = readUpdateConf();
  let run = () => void checkCommit();
  // Mode keys on PRESENCE, not parse success: a managed box with a damaged
  // conf stays in (quiet) release mode rather than nagging about main drift.
  if (conf.state !== "absent") {
    const v = getVersionInfo();
    // Quiet release-mode status until the first fetch lands.
    status = computeReleaseStatus(
      { release: v.release, version: v.version },
      null,
    );
    const ownerRepo =
      conf.state === "parsed"
        ? githubOwnerRepo(conf.values.REPO_URL ?? "")
        : null;
    if (!ownerRepo) {
      console.log(
        conf.state === "invalid"
          ? "[update-checker] update.conf is unreadable or malformed; release checks disabled"
          : "[update-checker] REPO_URL in update.conf is not a github.com repo; release checks disabled",
      );
      return;
    }
    run = () => void checkRelease(ownerRepo);
  }
  // Initial check after a short delay to not slow down startup
  setTimeout(run, 5000);
  setInterval(run, CHECK_INTERVAL);
}

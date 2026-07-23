// Update-available checker feeding the UI banner (update_status events).
// Two modes, decided once at startup (release-channel slice C1,
// internal-docs/release-design.md):
//
// - "commit" (no /etc/isomux/update.conf — source checkouts like dev boxes):
//   full context across both dimensions, so pulling is an informed choice —
//   what HEAD runs (exact tag or commit), the repo's latest release and
//   whether it's newer, and how many commits the GitHub main tip has beyond
//   that. Boxes ahead of main (local-only commits) stay QUIET, absolutely:
//   the compare API answering 404 for an unpushed HEAD, or reporting the box
//   has commits main lacks, is the ahead/diverged signal. Copy lives in
//   shared/update-notice.ts.
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
// transport/HTTP errors keep the previous status (both modes). Commit mode
// budgets 2 unauthenticated GitHub calls per hourly cycle (releases/latest,
// then compare). A non-github REPO_URL disables release checks entirely (we
// can only enumerate releases via the GitHub API).

import type { UpdateStatusWire } from "../shared/types.ts";
import {
  getVersionInfo,
  getReachableRelease,
  CALVER_RELEASE_RE,
} from "./version.ts";
import { readUpdateConf } from "./update-conf.ts";

// Commit-mode drift target. Release mode derives owner/repo from the conf's
// REPO_URL instead, so forks keep a working banner.
const REPO = "nmamano/isomux";
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

let status: UpdateStatusWire = {
  mode: "commit",
  updateAvailable: false,
  current: { release: null, sha: "" },
  latest: null,
  releaseStanding: "unknown",
  mainAhead: 0,
};

let onChange: ((s: UpdateStatusWire) => void) | null = null;

// --- Commit mode ------------------------------------------------------------

// What the compare API said about base...main. "unknown" is a 404: the base
// ref doesn't exist on GitHub — for a HEAD-sha base that means local-only
// commits, the definitive ahead-of-main signal.
type CompareResult = { aheadBy: number; behindBy: number } | "unknown";

// The commit-mode drift reference: count main's lead over the newest release
// point the box relates to (Nil's "main has 2 commits beyond that"), not over
// a stale tag; an untagged HEAD counts from itself. Exported for tests.
export function pickCompareBase(
  tagAtHead: string | null,
  latestTag: string | null,
  sha: string,
): string {
  if (!tagAtHead) return sha;
  if (latestTag && compareCalver(latestTag, tagAtHead) > 0) return latestTag;
  return tagAtHead;
}

// The commit-mode decision, pure for tests. `reachable` is the newest CalVer
// release reachable from HEAD (server/version.ts resolveReachableRelease) —
// the lineage anchor that tells an untagged box whether the latest release
// is ahead of it (reachable < latest) or already behind it (reachable ==
// latest means the box is PAST the tag). See the matrix in
// shared/update-notice.test.ts for the state-by-state behavior.
export function computeCommitStatus(
  current: { release: string | null; sha: string },
  reachable: string | null,
  latest: { tag: string; url: string | null } | null,
  cmp: CompareResult,
): UpdateStatusWire {
  let releaseStanding: "current" | "behind" | "ahead" | "unknown" = "unknown";
  if (latest) {
    const anchor = current.release ?? reachable;
    if (current.release && compareCalver(current.release, latest.tag) === 0) {
      releaseStanding = "current";
    } else if (anchor) {
      releaseStanding =
        compareCalver(latest.tag, anchor) > 0 ? "behind" : "ahead";
    }
  }
  // Ahead of main or diverged: quiet, even with a newer release out.
  const quiet = cmp === "unknown" || cmp.behindBy > 0;
  const mainAhead = quiet ? 0 : cmp.aheadBy;
  return {
    mode: "commit",
    updateAvailable:
      !quiet &&
      (mainAhead > 0 || (latest !== null && releaseStanding === "behind")),
    current,
    latest,
    releaseStanding,
    mainAhead,
  };
}

// Map a compare response body to counts. Null on anything but nonnegative
// integers: a malformed 200 is a transient failure (keep the previous
// status), NOT a fresh "no drift" — it must never clear a visible notice.
// Exported for tests.
export function parseCompare(
  data: unknown,
): { aheadBy: number; behindBy: number } | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { ahead_by?: unknown; behind_by?: unknown };
  const count = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!count(d.ahead_by) || !count(d.behind_by)) return null;
  return { aheadBy: d.ahead_by, behindBy: d.behind_by };
}

async function fetchCompare(
  ownerRepo: string,
  base: string,
): Promise<CompareResult | null> {
  try {
    // per_page=1 trims the embedded commit list; ahead_by/behind_by are
    // totals regardless. base is a CalVer tag or a rev-parse sha (both
    // URL-safe by construction); the encode is defense in depth.
    const res = await fetch(
      `https://api.github.com/repos/${ownerRepo}/compare/${encodeURIComponent(base)}...heads/main?per_page=1`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.status === 404) return "unknown";
    if (!res.ok) return null;
    return parseCompare(await res.json());
  } catch {
    return null;
  }
}

async function checkCommit() {
  const v = getVersionInfo();
  if (!v.commit) return; // not a usable git checkout
  const fetched = await fetchLatestRelease(REPO);
  if (fetched === null) return; // transient error: keep the previous status
  const latest =
    fetched === "none" ? null : { tag: fetched.tag, url: fetched.url };
  const base = pickCompareBase(v.release, latest?.tag ?? null, v.commit);
  const cmp = await fetchCompare(REPO, base);
  if (cmp === null) return; // transient error: keep the previous status
  publish(
    computeCommitStatus(
      { release: v.release, sha: v.commit },
      getReachableRelease(),
      latest,
      cmp,
    ),
  );
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

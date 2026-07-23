// server/update-checker.ts — the pure pieces of both modes: CalVer ordering,
// the releases/latest response mapping, the availability decisions, the
// commit-mode compare-base/lineage/status derivations, and the REPO_URL →
// owner/repo derivation. The fetch/timer plumbing is deliberately untested;
// zero network, zero LLM. The commit-mode COPY per state is asserted in
// shared/update-notice.test.ts (the signed-off matrix).

import { describe, it, expect } from "bun:test";
import {
  compareCalver,
  computeCommitStatus,
  computeReleaseStatus,
  githubOwnerRepo,
  parseCompare,
  pickCompareBase,
  pickRelease,
  statusChanged,
} from "./update-checker.ts";

describe("compareCalver", () => {
  it("orders by year, month, day, same-day counter", () => {
    expect(compareCalver("v2026.7.20", "v2026.7.19")).toBeGreaterThan(0);
    expect(compareCalver("v2026.7.19", "v2026.7.19")).toBe(0);
    expect(compareCalver("v2026.7.19.2", "v2026.7.19")).toBeGreaterThan(0);
    expect(compareCalver("v2026.7.19", "v2026.7.19.2")).toBeLessThan(0);
    expect(compareCalver("v2027.1.1", "v2026.12.31")).toBeGreaterThan(0);
    // Numeric, not lexicographic: month 10 > month 9.
    expect(compareCalver("v2026.10.1", "v2026.9.30")).toBeGreaterThan(0);
  });
});

describe("githubOwnerRepo", () => {
  it("accepts https and ssh github URLs, with and without .git", () => {
    expect(githubOwnerRepo("https://github.com/nmamano/isomux.git")).toBe(
      "nmamano/isomux",
    );
    expect(githubOwnerRepo("https://github.com/nmamano/isomux")).toBe(
      "nmamano/isomux",
    );
    expect(githubOwnerRepo("git@github.com:fork/isomux.git")).toBe(
      "fork/isomux",
    );
  });

  it("rejects non-github remotes", () => {
    expect(githubOwnerRepo("https://gitlab.com/x/y")).toBeNull();
    expect(githubOwnerRepo("/srv/git/isomux.git")).toBeNull();
    expect(githubOwnerRepo("")).toBeNull();
  });

  it("rejects URL-syntax smuggling into the derived api.github.com path", () => {
    expect(githubOwnerRepo("https://github.com/a/b?x=1")).toBeNull();
    expect(githubOwnerRepo("https://github.com/a/b#frag")).toBeNull();
    expect(githubOwnerRepo("https://github.com/a/b/c")).toBeNull();
    expect(githubOwnerRepo("https://github.com/a/b/../c")).toBeNull();
  });
});

describe("pickRelease", () => {
  it("maps tag_name/published_at/html_url", () => {
    expect(
      pickRelease({
        tag_name: "v2026.7.19",
        published_at: "2026-07-19T00:00:00Z",
        html_url: "https://github.com/nmamano/isomux/releases/tag/v2026.7.19",
      }),
    ).toEqual({
      tag: "v2026.7.19",
      publishedAt: "2026-07-19T00:00:00Z",
      url: "https://github.com/nmamano/isomux/releases/tag/v2026.7.19",
    });
  });

  it("non-CalVer latest release counts as none (channel offers only update.sh-acceptable tags)", () => {
    expect(pickRelease({ tag_name: "v1.0" })).toBe("none");
    expect(pickRelease({})).toBe("none");
  });
});

describe("computeReleaseStatus", () => {
  const on = { release: "v2026.7.19", version: "v2026.7.19" };
  const rel = (tag: string) => ({ tag, publishedAt: null, url: null });

  it("zero releases -> quiet", () => {
    const s = computeReleaseStatus(on, null);
    expect(s.updateAvailable).toBe(false);
    expect(s.mode).toBe("release");
    if (s.mode === "release") expect(s.latest).toBeNull();
  });

  it("newer release -> available; same or older -> quiet", () => {
    expect(computeReleaseStatus(on, rel("v2026.7.20")).updateAvailable).toBe(
      true,
    );
    expect(computeReleaseStatus(on, rel("v2026.7.19")).updateAvailable).toBe(
      false,
    );
    // Box ahead of the latest published release (e.g. a same-day re-tag was
    // deleted upstream): never nag about a "downgrade".
    expect(computeReleaseStatus(on, rel("v2026.7.18")).updateAvailable).toBe(
      false,
    );
  });

  it("managed box not on a release tag -> any release is available (the hop onto the channel)", () => {
    const offChannel = { release: null, version: "253dd5c" };
    expect(
      computeReleaseStatus(offChannel, rel("v2026.7.19")).updateAvailable,
    ).toBe(true);
    expect(computeReleaseStatus(offChannel, null).updateAvailable).toBe(false);
  });
});

describe("pickCompareBase (commit-mode drift reference)", () => {
  const sha = "abc1234abc1234abc1234abc1234abc1234abc12";

  it("untagged HEAD counts drift from itself", () => {
    expect(pickCompareBase(null, "v2026.7.22", sha)).toBe(sha);
    expect(pickCompareBase(null, null, sha)).toBe(sha);
  });

  it("behind box counts from the RELEASE, not its own stale tag — 'main has N commits beyond that' (matrix row 4) stays truthful", () => {
    // A future "simplify to always-HEAD" change must fail here: the drift
    // number would silently change meaning from beyond-the-release to
    // beyond-the-box.
    expect(pickCompareBase("v2026.7.20", "v2026.7.22", sha)).toBe("v2026.7.22");
    expect(pickCompareBase("v2026.7.22", "v2026.7.22", sha)).toBe("v2026.7.22");
    // Tag newer than the listed release (listing lag): count from the tag.
    expect(pickCompareBase("v2026.7.23", "v2026.7.22", sha)).toBe("v2026.7.23");
    expect(pickCompareBase("v2026.7.20", null, sha)).toBe("v2026.7.20");
  });
});

describe("parseCompare (compare response mapping)", () => {
  it("maps nonnegative integer ahead_by/behind_by", () => {
    expect(parseCompare({ ahead_by: 4, behind_by: 0 })).toEqual({
      aheadBy: 4,
      behindBy: 0,
    });
    // Valid zero-drift (identical to main) is a real result, not an error.
    expect(parseCompare({ ahead_by: 0, behind_by: 0 })).toEqual({
      aheadBy: 0,
      behindBy: 0,
    });
  });

  it("malformed 200 is transient (null), never a fresh 'no drift'", () => {
    expect(parseCompare({})).toBeNull();
    expect(parseCompare({ ahead_by: 4 })).toBeNull();
    expect(parseCompare({ ahead_by: "4", behind_by: "0" })).toBeNull();
    expect(parseCompare({ ahead_by: -1, behind_by: 0 })).toBeNull();
    expect(parseCompare({ ahead_by: 1.5, behind_by: 0 })).toBeNull();
    expect(parseCompare({ ahead_by: NaN, behind_by: 0 })).toBeNull();
    expect(parseCompare(null)).toBeNull();
  });
});

describe("computeCommitStatus (the source-checkout decision)", () => {
  const sha = "abc1234abc1234abc1234abc1234abc1234abc12";
  const rel = (tag: string) => ({ tag, url: null });
  const cmp = (aheadBy: number, behindBy = 0) => ({ aheadBy, behindBy });
  // status(tag at HEAD, newest reachable release, latest release, compare)
  const status = (
    release: string | null,
    reachable: string | null,
    latest: { tag: string; url: string | null } | null,
    c: { aheadBy: number; behindBy: number } | "unknown",
  ) => computeCommitStatus({ release, sha }, reachable, latest, c);

  it("on the latest release: quiet at the main tip, informational when main moved on", () => {
    const quiet = status("v2026.7.22", "v2026.7.22", rel("v2026.7.22"), cmp(0));
    expect(quiet.updateAvailable).toBe(false);
    const drifted = status(
      "v2026.7.22",
      "v2026.7.22",
      rel("v2026.7.22"),
      cmp(4),
    );
    expect(drifted.updateAvailable).toBe(true);
    if (drifted.mode === "commit") {
      expect(drifted.releaseStanding).toBe("current");
      expect(drifted.mainAhead).toBe(4);
    }
  });

  it("behind the latest release: available even with zero main drift", () => {
    const s = status("v2026.7.20", "v2026.7.20", rel("v2026.7.22"), cmp(0));
    expect(s.updateAvailable).toBe(true);
    if (s.mode === "commit") expect(s.releaseStanding).toBe("behind");
  });

  it("tag newer than the listed release: standing ahead, drift-only notice", () => {
    const s = status("v2026.7.23", "v2026.7.23", rel("v2026.7.22"), cmp(3));
    expect(s.updateAvailable).toBe(true);
    if (s.mode === "commit") expect(s.releaseStanding).toBe("ahead");
    expect(
      status("v2026.7.23", "v2026.7.23", rel("v2026.7.22"), cmp(0))
        .updateAvailable,
    ).toBe(false);
  });

  it("untagged HEAD derives its release standing from the reachable release", () => {
    const past = status(null, "v2026.7.22", rel("v2026.7.22"), cmp(5));
    if (past.mode === "commit") expect(past.releaseStanding).toBe("ahead");
    const behind = status(null, "v2026.7.20", rel("v2026.7.22"), cmp(5));
    expect(behind.updateAvailable).toBe(true);
    if (behind.mode === "commit") expect(behind.releaseStanding).toBe("behind");
    const unknown = status(null, null, rel("v2026.7.22"), cmp(5));
    if (unknown.mode === "commit")
      expect(unknown.releaseStanding).toBe("unknown");
  });

  it("untagged at the main tip: quiet unless the lineage is behind a release", () => {
    expect(
      status(null, "v2026.7.22", rel("v2026.7.22"), cmp(0)).updateAvailable,
    ).toBe(false);
    expect(status(null, null, rel("v2026.7.22"), cmp(0)).updateAvailable).toBe(
      false,
    );
    // Exotic off-main release: lineage behind, still offered.
    expect(
      status(null, "v2026.7.20", rel("v2026.7.22"), cmp(0)).updateAvailable,
    ).toBe(true);
  });

  it("ahead of main stays quiet, absolutely — even with a newer release out", () => {
    // Diverged / box has commits main lacks.
    const diverged = status(null, "v2026.7.20", rel("v2026.7.22"), cmp(2, 3));
    expect(diverged.updateAvailable).toBe(false);
    if (diverged.mode === "commit") expect(diverged.mainAhead).toBe(0);
    // HEAD sha unknown to GitHub (unpushed local commits): compare 404.
    expect(
      status(null, "v2026.7.20", rel("v2026.7.22"), "unknown").updateAvailable,
    ).toBe(false);
  });

  it("no releases yet: pure main-drift notice", () => {
    const s = status(null, null, null, cmp(3));
    expect(s.updateAvailable).toBe(true);
    if (s.mode === "commit") {
      expect(s.latest).toBeNull();
      expect(s.mainAhead).toBe(3);
    }
    expect(status(null, null, null, cmp(0)).updateAvailable).toBe(false);
    expect(
      status("v2026.7.20", "v2026.7.20", null, cmp(3)).updateAvailable,
    ).toBe(true);
  });
});

describe("statusChanged (the publish/broadcast decision)", () => {
  const on = { release: "v2026.7.19", version: "v2026.7.19" };
  const rel = (tag: string) => ({ tag, publishedAt: null, url: null });

  it("available A -> available B (true->true, new tag) must notify", () => {
    const a = computeReleaseStatus(on, rel("v2026.7.20"));
    const b = computeReleaseStatus(on, rel("v2026.7.21"));
    expect(a.updateAvailable && b.updateAvailable).toBe(true);
    expect(statusChanged(a, b)).toBe(true);
  });

  it("available -> equal/current (banner clears after the box updated) must notify", () => {
    const before = computeReleaseStatus(on, rel("v2026.7.20"));
    const after = computeReleaseStatus(
      { release: "v2026.7.20", version: "v2026.7.20" },
      rel("v2026.7.20"),
    );
    expect(after.updateAvailable).toBe(false);
    expect(statusChanged(before, after)).toBe(true);
  });

  it("identical payload is suppressed (hourly no-op re-checks stay silent)", () => {
    const a = computeReleaseStatus(on, rel("v2026.7.20"));
    const b = computeReleaseStatus(on, rel("v2026.7.20"));
    expect(statusChanged(a, b)).toBe(false);
  });
});

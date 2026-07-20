// server/update-checker.ts — the pure release-mode pieces: CalVer ordering,
// the releases/latest response mapping, the availability decision, and the
// REPO_URL → owner/repo derivation. The fetch/timer plumbing is deliberately
// untested (same posture as the pre-existing commit mode); zero network,
// zero LLM.

import { describe, it, expect } from "bun:test";
import {
  compareCalver,
  computeReleaseStatus,
  githubOwnerRepo,
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

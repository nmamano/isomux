// server/update-checker.ts - the pure pieces of both modes: CalVer ordering,
// the releases/latest response mapping, the availability decisions, the
// commit-mode compare-base/lineage/status derivations, and the REPO_URL →
// owner/repo derivation. The fetch/timer plumbing is deliberately untested;
// zero network, zero LLM. The commit-mode COPY per state is asserted in
// shared/update-notice.test.ts (the signed-off matrix).

import { describe, it, expect } from "bun:test";
import {
  compareCalver,
  computeCommitStatus,
  computeImageLineageStatus,
  computeSecurityFloor,
  computeReleaseStatus,
  fetchReleaseChannel,
  githubOwnerRepo,
  hasSecurityReleaseMarker,
  imageLineageStatusAfterScan,
  parseCompare,
  parseLineage,
  pickCheckerMode,
  pickCompareBase,
  pickRelease,
  pickReleasePage,
  releaseStatusAfterScan,
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

describe("security release marker and sticky channel", () => {
  const listed = (tag: string, security = false) => ({
    tag,
    publishedAt: null,
    url: null,
    security,
  });

  it("accepts only the exact marker as a complete line", () => {
    expect(
      hasSecurityReleaseMarker("notes\nisomux-severity: security\nmore"),
    ).toBe(true);
    expect(hasSecurityReleaseMarker("isomux-severity: security-fix")).toBe(
      false,
    );
    expect(hasSecurityReleaseMarker("Isomux-Severity: security")).toBe(false);
    expect(hasSecurityReleaseMarker(null)).toBe(false);
  });

  it("maps only published, stable CalVer releases and rejects a malformed page", () => {
    expect(
      pickReleasePage([
        { tag_name: "v2026.8.2", body: "isomux-severity: security" },
        { tag_name: "v2026.8.1", draft: true },
        { tag_name: "v1.0.0" },
      ]),
    ).toEqual([
      {
        tag: "v2026.8.2",
        publishedAt: null,
        url: null,
        security: true,
      },
    ]);
    expect(pickReleasePage({})).toBeNull();
    expect(pickReleasePage([null])).toBeNull();
  });

  it("keeps a security release sticky behind a later ordinary release", () => {
    const floor = computeSecurityFloor("v2026.8.1", [
      listed("v2026.8.4"),
      listed("v2026.8.3", true),
      listed("v2026.8.2"),
      listed("v2026.8.1"),
    ]);
    expect(floor?.tag).toBe("v2026.8.3");
  });

  it("clears the security target only once the running tag includes it", () => {
    const releases = [
      listed("v2026.8.4"),
      listed("v2026.8.3", true),
      listed("v2026.8.2"),
    ];
    expect(computeSecurityFloor("v2026.8.2", releases)?.tag).toBe("v2026.8.3");
    expect(computeSecurityFloor("v2026.8.3", releases)).toBeNull();
    expect(computeSecurityFloor("v2026.8.4", releases)).toBeNull();
  });

  it("cold-scans more than one page until it reaches an old running tag", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      tag_name: `v2026.8.13.${100 - i}`,
      body: i === 50 ? "isomux-severity: security" : "",
    }));
    const pages: unknown[] = [
      { tag_name: "v2026.8.13.100" },
      first,
      [{ tag_name: "v2026.7.1", body: "" }],
    ];
    const calls: string[] = [];
    const fakeFetch = async (input: string | URL | Request) => {
      calls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Response.json(pages.shift());
    };

    const channel = await fetchReleaseChannel(
      "nmamano/isomux",
      "v2026.7.1",
      fakeFetch,
    );
    expect(calls).toHaveLength(3);
    expect(channel?.latest?.tag).toBe("v2026.8.13.100");
    expect(channel?.security?.tag).toBe("v2026.8.13.50");
  });

  it("fails the complete scan when a later pagination call fails", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      tag_name: `v2026.8.13.${100 - i}`,
      body: i === 0 ? "isomux-severity: security" : "",
    }));
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ tag_name: "v2026.8.13.100" });
      return calls === 2
        ? Response.json(full)
        : new Response("unavailable", { status: 503 });
    };

    const channel = await fetchReleaseChannel(
      "nmamano/isomux",
      "v2026.7.1",
      fakeFetch,
    );
    expect(channel).toBeNull();
    expect(
      releaseStatusAfterScan(
        { release: "v2026.7.1", version: "v2026.7.1" },
        channel,
      ),
    ).toBeNull();
    expect(calls).toBe(3);
  });

  it("keeps a zero-release repository quiet through releases/latest 404", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("not found", { status: 404 });
    };
    const channel = await fetchReleaseChannel(
      "nmamano/isomux",
      "v2026.7.1",
      fakeFetch,
    );
    expect(channel).toEqual({ latest: null, security: null });
    expect(calls).toBe(1);
    const next = releaseStatusAfterScan(
      { release: "v2026.7.1", version: "v2026.7.1" },
      channel,
    );
    expect(next?.updateAvailable).toBe(false);
    if (next?.mode === "release") {
      expect(next.latest).toBeNull();
      expect(next.securityUpdate).toBeNull();
    }
  });

  it("scans history when releases/latest is outside the CalVer channel", async () => {
    const responses: unknown[] = [
      { tag_name: "preview" },
      [
        {
          tag_name: "v2026.8.13",
          body: "isomux-severity: security",
        },
      ],
    ];
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return Response.json(responses.shift());
    };
    const channel = await fetchReleaseChannel(
      "fork/isomux",
      "v2026.7.1",
      fakeFetch,
    );
    expect(calls).toBe(2);
    expect(channel?.latest).toBeNull();
    expect(channel?.security?.tag).toBe("v2026.8.13");
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
    if (s.mode === "release") expect(s.securityUpdate).toBeNull();
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

  it("carries the sticky security target separately from the latest target", () => {
    const latest = rel("v2026.8.4");
    const security = rel("v2026.8.3");
    const s = computeReleaseStatus(on, latest, security);
    if (s.mode === "release") {
      expect(s.latest?.tag).toBe("v2026.8.4");
      expect(s.securityUpdate?.tag).toBe("v2026.8.3");
    }
  });
});

describe("pickCompareBase (commit-mode drift reference)", () => {
  const sha = "abc1234abc1234abc1234abc1234abc1234abc12";

  it("untagged HEAD counts drift from itself", () => {
    expect(pickCompareBase(null, "v2026.7.22", sha)).toBe(sha);
    expect(pickCompareBase(null, null, sha)).toBe(sha);
  });

  it("behind box counts from the RELEASE, not its own stale tag - 'main has N commits beyond that' (matrix row 4) stays truthful", () => {
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

  it("ahead of main stays quiet, absolutely - even with a newer release out", () => {
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

describe("pickCheckerMode (which checker runs)", () => {
  const absent = { state: "absent" } as const;
  const parsed = { state: "parsed", values: {} } as const;
  const invalid = { state: "invalid" } as const;
  const k8s = { KUBERNETES_SERVICE_HOST: "10.0.0.1" };

  it("update.conf presence keeps the host updater, even on an image or with a damaged conf", () => {
    for (const conf of [parsed, invalid]) {
      for (const source of ["git", "image", null] as const) {
        expect(
          pickCheckerMode(conf, source, { ...k8s, RENDER: "true" }),
        ).toEqual({ kind: "host" });
      }
    }
  });

  it("without update.conf, a checkout or an unknown identity keeps commit mode", () => {
    expect(pickCheckerMode(absent, "git", { RENDER: "true" })).toEqual({
      kind: "commit",
    });
    expect(pickCheckerMode(absent, null, k8s)).toEqual({ kind: "commit" });
  });

  it("an image picks the guide: Kubernetes, then Render, else the container reference", () => {
    const guide = (env: Record<string, string>) => {
      const mode = pickCheckerMode(absent, "image", env);
      return mode.kind === "image" && mode.apply.kind === "image"
        ? mode.apply.guide
        : mode.kind;
    };
    expect(guide({ ...k8s, RENDER: "true" })).toBe("kubernetes");
    expect(guide(k8s)).toBe("kubernetes");
    expect(guide({ RENDER: "true" })).toBe("render");
    expect(guide({ RENDER: "false" })).toBe("container");
    expect(guide({ KUBERNETES_SERVICE_HOST: "" })).toBe("container");
    expect(guide({})).toBe("container");
  });
});

describe("parseLineage (compare status of a release tag against the running commit)", () => {
  it("maps behind, contained and diverged; anything else is a failed check", () => {
    expect(parseLineage({ status: "behind" })).toBe("behind");
    expect(parseLineage({ status: "identical" })).toBe("contained");
    expect(parseLineage({ status: "ahead" })).toBe("contained");
    expect(parseLineage({ status: "diverged" })).toBe("unrelated");
    for (const bad of [null, [], "behind", {}, { status: "BEHIND" }]) {
      expect(parseLineage(bad)).toBeNull();
    }
  });
});

describe("untagged image lineage (Render main commit)", () => {
  const sha = "c".repeat(40);
  const current = { release: null, version: sha };
  const image = { kind: "image", guide: "render" } as const;
  const ordinary = (tag: string) => ({ tag_name: tag, body: "" });
  const security = (tag: string) => ({
    tag_name: tag,
    body: "isomux-severity: security",
  });

  // Routes each GitHub call by URL: the release scan, then compare calls
  // keyed by release tag. A Response value answers verbatim.
  function github(opts: {
    latest?: unknown;
    list?: unknown[];
    compare?: Record<string, unknown>;
  }) {
    const calls: string[] = [];
    const fakeFetch = async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push(url);
      const answer = (value: unknown) =>
        value instanceof Response ? value : Response.json(value);
      if (url.endsWith("/releases/latest")) return answer(opts.latest);
      if (url.includes("/releases?")) return answer(opts.list ?? []);
      const m = /\/compare\/([^.]+(?:\.[0-9]+)+)\.\.\.([a-f0-9]+)\?/.exec(url);
      if (m && m[2] === sha && opts.compare && m[1] in opts.compare) {
        return answer(opts.compare[m[1]]);
      }
      throw new Error(`unexpected call ${url}`);
    };
    return { calls, fakeFetch };
  }
  const compares = (calls: string[]) =>
    calls.filter((u) => u.includes("/compare/")).length;
  const run = (g: ReturnType<typeof github>) =>
    imageLineageStatusAfterScan(
      "nmamano/isomux",
      current,
      sha,
      image,
      g.fakeFetch,
    );

  it("behind the latest release: available, with the image action", async () => {
    const g = github({
      latest: ordinary("v2026.9.23"),
      list: [ordinary("v2026.9.23")],
      compare: { "v2026.9.23": { status: "behind" } },
    });
    const next = await run(g);
    expect(next?.updateAvailable).toBe(true);
    expect(next?.mode === "release" && next.apply).toEqual(image);
    expect(next?.mode === "release" && next.latest?.tag).toBe("v2026.9.23");
    expect(g.calls[g.calls.length - 1]).toBe(
      `https://api.github.com/repos/nmamano/isomux/compare/v2026.9.23...${sha}?per_page=1`,
    );
  });

  it("identical, ahead, diverged and 404 are definite quiet answers", async () => {
    for (const answer of [
      { status: "identical" },
      { status: "ahead" },
      { status: "diverged" },
      new Response("not found", { status: 404 }),
    ]) {
      const g = github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23")],
        compare: { "v2026.9.23": answer },
      });
      const next = await run(g);
      expect(next).not.toBeNull();
      expect(next?.updateAvailable).toBe(false);
      expect(next?.mode === "release" && next.securityUpdate).toBeNull();
    }
  });

  it("a failed compare publishes nothing: 5xx, rate limit, malformed or network error", async () => {
    for (const answer of [
      new Response("unavailable", { status: 503 }),
      new Response("rate limited", { status: 403 }),
      new Response("rate limited", { status: 429 }),
      { status: "sideways" },
    ]) {
      const g = github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23")],
        compare: { "v2026.9.23": answer },
      });
      expect(await run(g)).toBeNull();
    }
    const g = github({
      latest: ordinary("v2026.9.23"),
      list: [ordinary("v2026.9.23")],
      compare: {},
    });
    expect(await run(g)).toBeNull();
  });

  it("a failed release scan publishes nothing and makes no compare call", async () => {
    const g = github({
      latest: new Response("unavailable", { status: 502 }),
    });
    expect(await run(g)).toBeNull();
    expect(compares(g.calls)).toBe(0);
  });

  it("zero releases: quiet, no compare call", async () => {
    const g = github({ latest: new Response("none", { status: 404 }) });
    const next = await run(g);
    expect(next?.updateAvailable).toBe(false);
    expect(next?.mode === "release" && next.latest).toBeNull();
    expect(compares(g.calls)).toBe(0);
  });

  it("an older security release shows only when the commit is behind it", async () => {
    const list = [ordinary("v2026.9.23"), security("v2026.9.20")];
    const behindBoth = await run(
      github({
        latest: ordinary("v2026.9.23"),
        list,
        compare: {
          "v2026.9.23": { status: "behind" },
          "v2026.9.20": { status: "behind" },
        },
      }),
    );
    expect(behindBoth?.updateAvailable).toBe(true);
    expect(
      behindBoth?.mode === "release" && behindBoth.securityUpdate?.tag,
    ).toBe("v2026.9.20");

    for (const answer of [
      { status: "ahead" },
      { status: "identical" },
      { status: "diverged" },
      new Response("not found", { status: 404 }),
    ]) {
      const next = await run(
        github({
          latest: ordinary("v2026.9.23"),
          list,
          compare: {
            "v2026.9.23": { status: "behind" },
            "v2026.9.20": answer,
          },
        }),
      );
      expect(next?.updateAvailable).toBe(true);
      expect(next?.mode === "release" && next.securityUpdate).toBeNull();
    }
  });

  it("a failed security compare publishes nothing", async () => {
    const next = await run(
      github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23"), security("v2026.9.20")],
        compare: {
          "v2026.9.23": { status: "behind" },
          "v2026.9.20": new Response("unavailable", { status: 500 }),
        },
      }),
    );
    expect(next).toBeNull();
  });

  it("an unrelated latest release quiets the security target without asking", async () => {
    const g = github({
      latest: ordinary("v2026.9.23"),
      list: [ordinary("v2026.9.23"), security("v2026.9.20")],
      compare: { "v2026.9.23": { status: "diverged" } },
    });
    const next = await run(g);
    expect(next?.updateAvailable).toBe(false);
    expect(next?.mode === "release" && next.securityUpdate).toBeNull();
    expect(compares(g.calls)).toBe(1);
  });

  it("the pure decision: an unrelated latest release hides a behind security release", () => {
    const rel = (tag: string) => ({ tag, publishedAt: null, url: null });
    const quiet = computeImageLineageStatus(
      current,
      rel("v2026.9.23"),
      "unrelated",
      rel("v2026.9.20"),
      "behind",
      image,
    );
    expect(quiet.updateAvailable).toBe(false);
    expect(quiet.mode === "release" && quiet.securityUpdate).toBeNull();
    const behind = computeImageLineageStatus(
      current,
      rel("v2026.9.23"),
      "contained",
      rel("v2026.9.24"),
      "behind",
      image,
    );
    expect(behind.updateAvailable).toBe(false);
    expect(behind.mode === "release" && behind.securityUpdate?.tag).toBe(
      "v2026.9.24",
    );
  });

  it("a security release that is the latest release costs one compare", async () => {
    const g = github({
      latest: security("v2026.9.23"),
      list: [security("v2026.9.23")],
      compare: { "v2026.9.23": { status: "behind" } },
    });
    const next = await run(g);
    expect(next?.updateAvailable).toBe(true);
    expect(next?.mode === "release" && next.securityUpdate?.tag).toBe(
      "v2026.9.23",
    );
    expect(compares(g.calls)).toBe(1);
  });

  it("from a visible notice: a definite quiet answer replaces it, a failed check keeps it", async () => {
    const notice = await run(
      github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23"), security("v2026.9.20")],
        compare: {
          "v2026.9.23": { status: "behind" },
          "v2026.9.20": { status: "behind" },
        },
      }),
    );
    expect(notice?.updateAvailable).toBe(true);
    expect(notice?.mode === "release" && notice.securityUpdate).not.toBeNull();

    const quiet = await run(
      github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23"), security("v2026.9.20")],
        compare: { "v2026.9.23": { status: "diverged" } },
      }),
    );
    expect(quiet?.updateAvailable).toBe(false);
    expect(quiet?.mode === "release" && quiet.securityUpdate).toBeNull();
    expect(statusChanged(notice!, quiet!)).toBe(true);

    const failed = await run(
      github({
        latest: ordinary("v2026.9.23"),
        list: [ordinary("v2026.9.23"), security("v2026.9.20")],
        compare: {
          "v2026.9.23": new Response("rate limited", { status: 429 }),
        },
      }),
    );
    expect(failed).toBeNull();
  });
});

describe("apply on release statuses", () => {
  const on = { release: "v2026.9.1", version: "v2026.9.1" };
  const rel = { tag: "v2026.9.8", publishedAt: null, url: null };

  it("the host updater is the default; a tagged image carries the image action", () => {
    const host = computeReleaseStatus(on, rel);
    expect(host.mode === "release" && host.apply).toEqual({ kind: "host" });
    const image = { kind: "image", guide: "kubernetes" } as const;
    const next = releaseStatusAfterScan(
      on,
      { latest: rel, security: null },
      image,
    );
    expect(next?.updateAvailable).toBe(true);
    expect(next?.mode === "release" && next.apply).toEqual(image);
  });
});

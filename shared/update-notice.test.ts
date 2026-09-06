// The commit-mode (source checkout) copy matrix, asserted VERBATIM - this
// file IS the signed-off enumeration of every notice state. Statuses are
// produced by the real server decision (computeCommitStatus) so the matrix
// can't drift from what the checker actually publishes.

import { describe, it, expect } from "bun:test";
import { computeCommitStatus } from "../server/update-checker.ts";
import { buildCommitNotice, type CommitNotice } from "./update-notice.ts";
import { translatorFor } from "./i18n/translate.ts";

const sha = "abc1234abc1234abc1234abc1234abc1234abc12";
const rel = (tag: string) => ({ tag, url: null });
// HEAD exactly at a tag: the tag is also the newest reachable release.
const onTag = (tag: string) => ({ release: tag, reachable: tag });
// Untagged HEAD: standing comes from the newest reachable release, if any.
const onCommit = (reachable: string | null) => ({ release: null, reachable });
const cmp = (aheadBy: number, behindBy = 0) => ({ aheadBy, behindBy });

// The matrix below is the signed-off ENGLISH, so it runs on the English
// translator and every string stays what it was; the language block at the
// bottom proves the same states read in Spanish and Catalan
// (internal-docs/i18n-loop.md, S7).
const en = translatorFor("en");

function notice(
  v: { release: string | null; reachable: string | null },
  latest: { tag: string; url: string | null } | null,
  c: { aheadBy: number; behindBy: number } | "unknown",
  i18n = en,
): CommitNotice | null {
  const s = computeCommitStatus(
    { release: v.release, sha },
    v.reachable,
    latest,
    c,
  );
  if (s.mode !== "commit") throw new Error("expected commit mode");
  return buildCommitNotice(i18n, s);
}

describe("commit-mode copy matrix - release exists (latest v2026.7.22)", () => {
  it("1. on latest release, main tip == release: quiet", () => {
    expect(notice(onTag("v2026.7.22"), rel("v2026.7.22"), cmp(0))).toBeNull();
  });

  it("2. on latest release, main +4", () => {
    expect(notice(onTag("v2026.7.22"), rel("v2026.7.22"), cmp(4))).toEqual({
      pill: "main +4",
      title: "Newer Commits on main",
      notice:
        "You're on v2026.7.22 (latest release). main has 4 newer commits if you want the bleeding edge.",
    });
  });

  it("3. behind latest release, main tip == release", () => {
    expect(notice(onTag("v2026.7.20"), rel("v2026.7.22"), cmp(0))).toEqual({
      pill: "new release",
      title: "New Release Available",
      notice: "You're on v2026.7.20; v2026.7.22 is out.",
    });
  });

  it("4. behind latest release, main 2 beyond the release", () => {
    expect(notice(onTag("v2026.7.20"), rel("v2026.7.22"), cmp(2))).toEqual({
      pill: "new release",
      title: "New Release Available",
      notice:
        "You're on v2026.7.20; v2026.7.22 is out. main has 2 commits beyond that.",
    });
  });

  it("5. on a tag newer than the latest listed release, main +3 (quiet at +0)", () => {
    expect(notice(onTag("v2026.7.23"), rel("v2026.7.22"), cmp(3))).toEqual({
      pill: "main +3",
      title: "Newer Commits on main",
      notice:
        "You're on v2026.7.23 (newer than the latest release, v2026.7.22). main has 3 newer commits if you want the bleeding edge.",
    });
    expect(notice(onTag("v2026.7.23"), rel("v2026.7.22"), cmp(0))).toBeNull();
  });

  it("6. untagged commit past the latest release, main +5", () => {
    expect(notice(onCommit("v2026.7.22"), rel("v2026.7.22"), cmp(5))).toEqual({
      pill: "main +5",
      title: "Newer Commits on main",
      notice:
        "You're on commit abc1234, past the latest release (v2026.7.22). main has 5 newer commits if you want the bleeding edge.",
    });
  });

  it("7. untagged commit, lineage behind the latest release, main +5", () => {
    expect(notice(onCommit("v2026.7.20"), rel("v2026.7.22"), cmp(5))).toEqual({
      pill: "new release",
      title: "New Release Available",
      notice:
        "You're on commit abc1234; v2026.7.22 is out. main has 5 newer commits.",
    });
  });

  it("8. untagged commit, lineage unknown, main +5", () => {
    expect(notice(onCommit(null), rel("v2026.7.22"), cmp(5))).toEqual({
      pill: "main +5",
      title: "Newer Commits on main",
      notice:
        "You're on commit abc1234. The latest release is v2026.7.22; main has 5 newer commits.",
    });
  });

  it("9. untagged at main tip, lineage past-or-unknown: quiet", () => {
    expect(
      notice(onCommit("v2026.7.22"), rel("v2026.7.22"), cmp(0)),
    ).toBeNull();
    expect(notice(onCommit(null), rel("v2026.7.22"), cmp(0))).toBeNull();
  });

  it("10. untagged at main tip, lineage behind (release tagged off-main; exotic)", () => {
    expect(notice(onCommit("v2026.7.20"), rel("v2026.7.22"), cmp(0))).toEqual({
      pill: "new release",
      title: "New Release Available",
      notice: "You're on commit abc1234; v2026.7.22 is out.",
    });
  });

  it("11. ahead of main / diverged / unknown to GitHub: quiet, absolutely", () => {
    expect(
      notice(onCommit("v2026.7.20"), rel("v2026.7.22"), cmp(2, 3)),
    ).toBeNull();
    expect(
      notice(onCommit("v2026.7.20"), rel("v2026.7.22"), "unknown"),
    ).toBeNull();
    expect(
      notice(onTag("v2026.7.20"), rel("v2026.7.22"), "unknown"),
    ).toBeNull();
  });
});

describe("commit-mode copy matrix - no releases yet", () => {
  it("12. untagged at main tip: quiet", () => {
    expect(notice(onCommit(null), null, cmp(0))).toBeNull();
  });

  it("13. untagged, main +3", () => {
    expect(notice(onCommit(null), null, cmp(3))).toEqual({
      pill: "main +3",
      title: "Newer Commits on main",
      notice: "You're on commit abc1234. main has 3 newer commits.",
    });
  });

  it("14. on a tag with no listed release, main +3", () => {
    expect(notice(onTag("v2026.7.20"), null, cmp(3))).toEqual({
      pill: "main +3",
      title: "Newer Commits on main",
      notice: "You're on v2026.7.20. main has 3 newer commits.",
    });
  });

  it("15. on a tag at the main tip: quiet", () => {
    expect(notice(onTag("v2026.7.20"), null, cmp(0))).toBeNull();
  });

  it("16. ahead of main / diverged: quiet", () => {
    expect(notice(onCommit(null), null, cmp(0, 2))).toBeNull();
    expect(notice(onCommit(null), null, "unknown")).toBeNull();
  });
});

describe("commit-mode copy - singular drift", () => {
  it("uses 'commit', not 'commits', at +1", () => {
    expect(notice(onTag("v2026.7.22"), rel("v2026.7.22"), cmp(1))?.notice).toBe(
      "You're on v2026.7.22 (latest release). main has 1 newer commit if you want the bleeding edge.",
    );
    expect(notice(onTag("v2026.7.20"), rel("v2026.7.22"), cmp(1))?.notice).toBe(
      "You're on v2026.7.20; v2026.7.22 is out. main has 1 commit beyond that.",
    );
  });
});

// One state per language, to prove the notice is worded by the client rather
// than by the checker: the same UpdateStatusWire reads differently for two
// readers. Literal strings (ruling 14).
describe("the notice in the reader's language", () => {
  it("words the behind-a-release state in Spanish and Catalan", () => {
    const status = [onTag("v2026.7.1"), rel("v2026.7.22"), cmp(4, 0)] as const;
    expect(
      notice(status[0], status[1], status[2], translatorFor("es")),
    ).toEqual({
      pill: "nueva versión",
      title: "Hay una versión nueva",
      notice:
        "Estás en v2026.7.1; ya está v2026.7.22. main tiene 4 commits más allá de eso.",
    });
    expect(
      notice(status[0], status[1], status[2], translatorFor("ca")),
    ).toEqual({
      pill: "versió nova",
      title: "Hi ha una versió nova",
      notice:
        "Estàs a v2026.7.1; ja hi ha v2026.7.22. main té 4 commits més enllà d'això.",
    });
  });

  it("picks the singular form for one commit", () => {
    expect(
      notice(
        onTag("v2026.7.22"),
        rel("v2026.7.22"),
        cmp(1),
        translatorFor("es"),
      )?.notice,
    ).toBe(
      "Estás en v2026.7.22 (la última versión). main tiene 1 commit más nuevo si quieres lo último de lo último.",
    );
  });
});

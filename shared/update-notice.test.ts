import { describe, expect, it } from "bun:test";
import { computeCommitStatus } from "../server/update-checker.ts";
import { buildCommitNotice, type CommitNotice } from "./update-notice.ts";
import { translatorFor } from "./i18n/translate.ts";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "./languages.ts";

const sha = "abc1234abc1234abc1234abc1234abc1234abc12";
const rel = (tag: string) => ({ tag, url: null });
const onTag = (tag: string) => ({ release: tag, reachable: tag });
const onCommit = (reachable: string | null) => ({ release: null, reachable });
const cmp = (aheadBy: number, behindBy = 0) => ({ aheadBy, behindBy });

function notice(
  version: { release: string | null; reachable: string | null },
  latest: { tag: string; url: string | null } | null,
  comparison: { aheadBy: number; behindBy: number } | "unknown",
  language: SupportedLanguageCode = "en",
): CommitNotice | null {
  const status = computeCommitStatus(
    { release: version.release, sha },
    version.reachable,
    latest,
    comparison,
  );
  if (status.mode !== "commit") throw new Error("expected commit mode");
  return buildCommitNotice(translatorFor(language), status);
}

function expectComplete(
  value: CommitNotice | null,
  language: SupportedLanguageCode,
  decision: "newRelease" | "mainAhead",
  count: number,
): void {
  expect(value).not.toBeNull();
  expect(Object.keys(value!).sort()).toEqual(["notice", "pill", "title"]);
  expect(Object.values(value!).every((part) => part.length > 0)).toBe(true);
  const { t } = translatorFor(language);
  expect(value!.pill).toBe(
    decision === "newRelease"
      ? t("updateNotice.pill.newRelease")
      : t("updateNotice.pill.mainAhead", { count }),
  );
  expect(value!.title).toBe(
    decision === "newRelease"
      ? t("updateNotice.title.newRelease")
      : t("updateNotice.title.mainAhead"),
  );
}

describe("commit-mode notice decisions", () => {
  const latest = rel("v2026.7.22");
  const visible = [
    [onTag("v2026.7.22"), latest, cmp(4), "mainAhead", 4],
    [onTag("v2026.7.20"), latest, cmp(0), "newRelease", 0],
    [onTag("v2026.7.20"), latest, cmp(2), "newRelease", 2],
    [onTag("v2026.7.23"), latest, cmp(3), "mainAhead", 3],
    [onCommit("v2026.7.22"), latest, cmp(5), "mainAhead", 5],
    [onCommit("v2026.7.20"), latest, cmp(5), "newRelease", 5],
    [onCommit(null), latest, cmp(5), "mainAhead", 5],
    [onCommit("v2026.7.20"), latest, cmp(0), "newRelease", 0],
    [onCommit(null), null, cmp(3), "mainAhead", 3],
    [onTag("v2026.7.20"), null, cmp(3), "mainAhead", 3],
  ] as const;

  it("returns a complete notice with the status data for every visible state", () => {
    for (const [version, release, comparison, decision, count] of visible)
      expectComplete(
        notice(version, release, comparison),
        "en",
        decision,
        count,
      );
  });

  it("stays quiet for states that do not require an update notice", () => {
    const quiet = [
      notice(onTag("v2026.7.22"), latest, cmp(0)),
      notice(onTag("v2026.7.23"), latest, cmp(0)),
      notice(onCommit("v2026.7.22"), latest, cmp(0)),
      notice(onCommit(null), latest, cmp(0)),
      notice(onCommit("v2026.7.20"), latest, cmp(2, 3)),
      notice(onCommit("v2026.7.20"), latest, "unknown"),
      notice(onTag("v2026.7.20"), latest, "unknown"),
      notice(onCommit(null), null, cmp(0)),
      notice(onTag("v2026.7.20"), null, cmp(0)),
      notice(onCommit(null), null, cmp(0, 2)),
      notice(onCommit(null), null, "unknown"),
    ];
    expect(quiet.every((value) => value === null)).toBe(true);
  });

  it("resolves the same state into each reader's language without losing data", () => {
    const localized = SUPPORTED_LANGUAGES.map(({ code }) =>
      notice(onTag("v2026.7.1"), latest, cmp(4), code),
    );
    expect(new Set(localized.map((value) => JSON.stringify(value))).size).toBe(
      localized.length,
    );
    for (const [index, value] of localized.entries())
      expectComplete(value, SUPPORTED_LANGUAGES[index].code, "newRelease", 4);
  });

  it("uses the singular drift form when main is one commit ahead", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      const value = notice(onTag("v2026.7.22"), latest, cmp(1), code);
      expectComplete(value, code, "mainAhead", 1);
      expect(value!.notice).toContain(
        translatorFor(code).tn("updateNotice.drift.bleedingEdge", 1),
      );
    }
  });
});

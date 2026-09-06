// The commit-mode (source checkout) update-notice copy, composed in one place
// so the UI (header pill, modal title/body, clipboard text) and the tests
// share the exact strings. The copy matrix in update-notice.test.ts is the
// signed-off enumeration of every state; change copy there and here together.
//
// Shape of the notice: one compact paragraph giving (a) what the
// box runs - the exact tag, or the commit; (b) the latest release and whether
// it's newer; (c) how many commits ahead the GitHub main tip is, so pulling
// is an informed choice.
//
// CLIENT-SIDE, and deliberately so (internal-docs/i18n-loop.md, S7). The
// server sends only the status DATA (UpdateStatusWire, from
// server/update-checker.ts, which words nothing); whichever client renders the
// notice words it, so each reader gets their own language from one wire
// message. The translator arrives first (ruling 18); nothing here reads a
// global.

import type { UpdateStatusWire } from "./types.ts";
import type { Translator } from "./i18n/translate.ts";

type CommitStatus = Extract<UpdateStatusWire, { mode: "commit" }>;

export interface CommitNotice {
  // Short header-pill label ("new release" / "main +4").
  pill: string;
  // Modal heading.
  title: string;
  // The compact notice paragraph.
  notice: string;
}

// Null when the status carries no notice (quiet states).
export function buildCommitNotice(
  i18n: Translator,
  s: CommitStatus,
): CommitNotice | null {
  if (!s.updateAvailable) return null;
  const { t, tn } = i18n;
  const short = s.current.sha.slice(0, 7);
  const running =
    s.current.release ?? t("updateNotice.running", { sha: short });
  const latest = s.latest;

  let identity: string;
  if (!latest) {
    identity = t("updateNotice.identity.noLatest", { running });
  } else {
    switch (s.releaseStanding) {
      case "current":
        identity = t("updateNotice.identity.current", { running });
        break;
      case "behind":
        identity = t("updateNotice.identity.behind", {
          running,
          latest: latest.tag,
        });
        break;
      case "ahead":
        identity = s.current.release
          ? t("updateNotice.identity.aheadTagged", {
              running,
              latest: latest.tag,
            })
          : t("updateNotice.identity.aheadUntagged", {
              running,
              latest: latest.tag,
            });
        break;
      case "unknown":
        identity = t("updateNotice.identity.unknown", {
          running,
          latest: latest.tag,
        });
        break;
    }
  }

  let drift = "";
  if (s.mainAhead > 0) {
    const n = s.mainAhead;
    if (latest && s.releaseStanding === "behind" && s.current.release) {
      // Counted from the latest release (the compare base for a tagged,
      // behind box): main's lead beyond the release it just offered.
      drift = tn("updateNotice.drift.beyond", n);
    } else if (latest && s.releaseStanding === "unknown") {
      drift = tn("updateNotice.drift.newer", n);
    } else if (
      latest &&
      (s.releaseStanding === "current" || s.releaseStanding === "ahead")
    ) {
      drift = tn("updateNotice.drift.bleedingEdge", n);
    } else {
      drift = tn("updateNotice.drift.newer", n);
    }
  }

  const releaseNewer = latest !== null && s.releaseStanding === "behind";
  return {
    pill: releaseNewer
      ? t("updateNotice.pill.newRelease")
      : t("updateNotice.pill.mainAhead", { count: s.mainAhead }),
    title: releaseNewer
      ? t("updateNotice.title.newRelease")
      : t("updateNotice.title.mainAhead"),
    notice: [identity, drift].filter(Boolean).join(" "),
  };
}

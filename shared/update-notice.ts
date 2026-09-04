// The commit-mode (source checkout) update-notice copy, composed in one place
// so the UI (header pill, modal title/body, clipboard text) and the tests
// share the exact strings. The copy matrix in update-notice.test.ts is the
// signed-off enumeration of every state; change copy there and here together.
//
// Shape of the notice: one compact paragraph giving (a) what the
// box runs - the exact tag, or the commit; (b) the latest release and whether
// it's newer; (c) how many commits ahead the GitHub main tip is, so pulling
// is an informed choice.

import type { UpdateStatusWire } from "./types.ts";

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
export function buildCommitNotice(s: CommitStatus): CommitNotice | null {
  if (!s.updateAvailable) return null;
  const short = s.current.sha.slice(0, 7);
  const running = s.current.release ?? `commit ${short}`;
  const latest = s.latest;

  let identity: string;
  if (!latest) {
    identity = `You're on ${running}.`;
  } else {
    switch (s.releaseStanding) {
      case "current":
        identity = `You're on ${running} (latest release).`;
        break;
      case "behind":
        identity = `You're on ${running}; ${latest.tag} is out.`;
        break;
      case "ahead":
        identity = s.current.release
          ? `You're on ${running} (newer than the latest release, ${latest.tag}).`
          : `You're on ${running}, past the latest release (${latest.tag}).`;
        break;
      case "unknown":
        identity = `You're on ${running}. The latest release is ${latest.tag};`;
        break;
    }
  }

  let drift = "";
  if (s.mainAhead > 0) {
    const n = s.mainAhead;
    const commits = n === 1 ? "commit" : "commits";
    if (latest && s.releaseStanding === "behind" && s.current.release) {
      // Counted from the latest release (the compare base for a tagged,
      // behind box): main's lead beyond the release it just offered.
      drift = `main has ${n} ${commits} beyond that.`;
    } else if (latest && s.releaseStanding === "unknown") {
      drift = `main has ${n} newer ${commits}.`;
    } else if (
      latest &&
      (s.releaseStanding === "current" || s.releaseStanding === "ahead")
    ) {
      drift = `main has ${n} newer ${commits} if you want the bleeding edge.`;
    } else {
      drift = `main has ${n} newer ${commits}.`;
    }
  }

  const releaseNewer = latest !== null && s.releaseStanding === "behind";
  return {
    pill: releaseNewer ? "new release" : `main +${s.mainAhead}`,
    title: releaseNewer ? "New Release Available" : "Newer Commits on main",
    notice: [identity, drift].filter(Boolean).join(" "),
  };
}

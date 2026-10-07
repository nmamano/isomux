// What the update screen (components/UpdateOverlay.tsx) shows, as pure state
// transitions over the update_status events this tab receives and its
// connection state. The server's `progress` field (server/update-progress.ts)
// is the evidence: nothing here reads a clock.
//
// A tab WATCHES one attempt at a time. It adopts a requested or running
// attempt from any member's launch, and any attempt that first appears while
// the tab is open, finished or not (an updater can fail before the tab sees it
// run). An attempt already on record when the page loads is never adopted, so
// a page loaded after an update never reopens its outcome. Until the updater
// names its attempt, the tab watches "requested"; the first attempt the server
// then reports is that launch. A new attempt resets everything, including
// which tab launched it.

import type {
  UpdateOutcomeWire,
  UpdateProgressWire,
  UpdateStatusWire,
} from "../shared/types.ts";

export const REQUESTED = "requested";

export interface UpdateWatch {
  // The watched attempt id, REQUESTED, or null when not watching.
  key: string | null;
  // The watched attempt's last progress, kept while the server reports none.
  last: UpdateProgressWire | null;
  // The last attempt id any status named (undefined before the first status).
  seen: string | null | undefined;
  // This tab launched the watched attempt: it reloads by itself when done.
  clicked: boolean;
  // This tab's launch was accepted before any attempt reached it.
  clickPending: boolean;
  // `seen` when this tab started its last launch.
  launchFrom: string | null | undefined;
  // Hide on the running/requested screen, and on the outcome screen.
  hidden: boolean;
  outcomeHidden: boolean;
  // The version this page was loaded with (undefined until the first status).
  loadedVersion: string | null | undefined;
}

export const initialUpdateWatch: UpdateWatch = {
  key: null,
  last: null,
  seen: undefined,
  clicked: false,
  clickPending: false,
  launchFrom: undefined,
  hidden: false,
  outcomeHidden: false,
  loadedVersion: undefined,
};

export type UpdateStep = "prepare" | "install" | "restart";

export type UpdateScreen =
  | { kind: "none" }
  | { kind: "requested" }
  | { kind: "running"; step: UpdateStep }
  | {
      kind: "done";
      version: string | null;
      clicked: boolean;
      outcome: UpdateOutcomeWire | null;
    }
  | { kind: "failed"; version: string | null };

// The version a status names: what the server runs.
export function statusVersion(s: UpdateStatusWire): string | null {
  return s.mode === "release"
    ? (s.current.release ?? s.current.version)
    : (s.current.release ?? s.current.sha);
}

function progressOf(s: UpdateStatusWire | null): UpdateProgressWire | null {
  return s?.mode === "release" ? (s.progress ?? null) : null;
}

const STEPS: Record<string, UpdateStep> = {
  init: "prepare",
  validate: "prepare",
  fetch: "prepare",
  deps: "prepare",
  image: "prepare",
  assets: "prepare",
  checkout: "install",
  install: "install",
  build: "install",
};

export function stepOf(phase: string | null): UpdateStep {
  return (phase && STEPS[phase]) || "restart";
}

function adopt(
  w: UpdateWatch,
  key: string,
  last: UpdateProgressWire | null,
): UpdateWatch {
  return {
    ...w,
    key,
    last,
    clicked: w.clickPending,
    clickPending: false,
    hidden: false,
    outcomeHidden: false,
  };
}

export function watchOnStatus(
  w: UpdateWatch,
  s: UpdateStatusWire,
): UpdateWatch {
  let next =
    w.loadedVersion === undefined
      ? { ...w, loadedVersion: statusVersion(s) }
      : w;
  const p = progressOf(s);
  // The first status names what was on record before this page.
  const first = next.seen === undefined;
  if (first) next = { ...next, seen: p?.attempt ?? null };
  if (!p) return next;
  if (p.result === "requested") {
    return next.key === REQUESTED ? next : adopt(next, REQUESTED, null);
  }
  const attempt = p.attempt;
  if (!attempt) return next;
  const seen = { ...next, seen: attempt };
  if (attempt === next.key) return { ...seen, last: p };
  // The first attempt after a launch is that launch.
  if (next.key === REQUESTED) return { ...seen, key: attempt, last: p };
  const isNew = !first && attempt !== next.seen;
  return p.result === "running" || isNew ? adopt(seen, attempt, p) : seen;
}

// This tab is about to launch an update.
export function watchOnLaunching(w: UpdateWatch): UpdateWatch {
  return { ...w, launchFrom: w.seen };
}

// This tab's launch was accepted. The server marks it requested before it
// answers, so the tab usually watches it already; a fast updater may already
// have named its attempt, which differs from the one before the launch.
export function watchOnClicked(w: UpdateWatch): UpdateWatch {
  const active =
    w.key === REQUESTED || (w.key !== null && w.key !== w.launchFrom);
  return active
    ? { ...w, clicked: true, clickPending: false }
    : { ...w, clickPending: true };
}

export function watchOnHide(w: UpdateWatch, screen: UpdateScreen): UpdateWatch {
  return screen.kind === "done" || screen.kind === "failed"
    ? { ...w, outcomeHidden: true }
    : { ...w, hidden: true };
}

function known(v: string | null | undefined): v is string {
  return typeof v === "string" && v !== "";
}

// The screen before Hide is applied (the clicker's reload ignores Hide).
// While the tab is disconnected the status it holds is the last one the
// server sent, so it keeps the last phase the updater reported.
export function updateScreen(
  w: UpdateWatch,
  s: UpdateStatusWire | null,
  connected: boolean,
): UpdateScreen {
  if (w.key === null || s === null) return { kind: "none" };
  const p = progressOf(s);
  const version = statusVersion(s);
  const versionsKnown = known(version) && known(w.loadedVersion);
  // Only a known version change may reload the launching tab.
  const done = (): UpdateScreen => ({
    kind: "done",
    version,
    clicked: w.clicked && versionsKnown,
    outcome: s.mode === "release" ? (s.outcome ?? null) : null,
  });
  if (p?.result === "requested") return { kind: "requested" };
  if (w.key === REQUESTED) {
    // The tab watches a request and a connected server reports no progress
    // at all: the server restarted, which ends its in-memory "requested", and
    // no updater progress reaches it. That is a container office (its
    // updater runs on the host) or an updater that publishes no progress. A
    // known new version is done, the same version is a failed update, and an
    // unknown one proves nothing.
    if (p === null && connected && versionsKnown) {
      return version !== w.loadedVersion ? done() : { kind: "failed", version };
    }
    return { kind: "requested" };
  }
  // A missing record keeps the last one seen.
  const rec = p === null ? w.last : p.attempt === w.key ? p : null;
  if (!rec) return { kind: "none" };
  if (rec.result === "failed") return { kind: "failed", version };
  if (rec.result === "ok") {
    // Finished with nothing new to load (already on the target).
    return versionsKnown && version === w.loadedVersion
      ? { kind: "none" }
      : done();
  }
  return { kind: "running", step: stepOf(rec.phase) };
}

export function visibleScreen(
  w: UpdateWatch,
  screen: UpdateScreen,
): UpdateScreen {
  if (screen.kind === "none") return screen;
  const outcome = screen.kind === "done" || screen.kind === "failed";
  return (outcome ? w.outcomeHidden : w.hidden) ? { kind: "none" } : screen;
}

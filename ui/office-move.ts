// The Settings "Move office" section's logic (task 78733adf, slice 2c-2):
// what each move status shows and when the pane polls again. Pure, so the
// tests read it without a DOM. ui/components/OfficeMovePane.tsx renders it.
// internal-docs/office-move-design.md describes the flow.

import type {
  MoveInLive,
  MoveInLivePhase,
  MoveInProgress,
  MoveInReport,
  MoveInStartBlocker,
  MoveInStatus,
  MoveStageCheck,
  OfficeMoveRes,
} from "../shared/office-move.ts";

/** The new office polls this often while a job runs. */
export const MOVE_IN_POLL_MS = 2_000;
/** The old office polls this often while a code waits or a pairing runs. */
export const MOVE_OUT_POLL_MS = 5_000;
/** After this long in finishing/swapping with no answer, the pane says the
 *  office has not come back and offers a reload. */
export const MOVE_IN_RESTART_CAP_MS = 5 * 60_000;
/** The most missing paths and aside entries the pane lists. */
export const MOVE_LIST_MAX = 50;

/** A part of the old office's preflight that this release could not read. */
export type Unknown = { kind: "unknown" };

/** The old office's preflight, read through a guard: it comes from the old
 *  office's release, so each part is its known shape or unknown. */
export interface PreflightView {
  /** Epoch ms the old office finished the check. */
  finishedAt: number | null;
  turnsInFlight:
    | {
        kind: "list";
        agents: { agentId: string; name: string; roomName: string | null }[];
      }
    | Unknown;
  units:
    | {
        kind: "list";
        units: {
          name: string;
          unitFileState: string;
          activeState: string;
          transient: boolean;
        }[];
      }
    | { kind: "timedOut" }
    | { kind: "error"; error: string }
    | Unknown;
  /** null: the old office runs under no service manager the move knows. */
  restart:
    | {
        kind: "set";
        unit: string;
        manager: "user" | "system";
        restart: string;
      }
    | { kind: "none" }
    | Unknown;
  hostRefs:
    | {
        kind: "list";
        apps: {
          app: string;
          paths: string[];
          truncated: boolean;
          timedOut: boolean;
        }[];
      }
    | Unknown;
  /** `partial`: an entry timed out or has no size, so the total is a lower
   *  bound ("at least"). */
  sizes: { kind: "total"; bytes: number; partial: boolean } | Unknown;
  /** Members with their own OS user on the old office (slice 3): the lock
   *  waits until none has one. Unknown: an old office of a release without
   *  this part. */
  memberOsUsers:
    | { kind: "none" }
    | { kind: "list"; names: string[] }
    | { kind: "broken" }
    | Unknown;
  sudoPackages: { kind: "list"; packages: string[] } | Unknown;
}

type Obj = Record<string, unknown>;

const UNKNOWN: Unknown = { kind: "unknown" };

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Every item read, or null when one does not read: a list is known whole
 *  or not at all, so nothing is dropped silently. */
function readList<T>(v: unknown, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = item(x);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

const readStrings = (v: unknown): string[] | null =>
  readList(v, (x) => (isStr(x) ? x : null));

function readTurns(v: unknown): PreflightView["turnsInFlight"] {
  const agents = readList(v, (x) =>
    isObj(x) &&
    isStr(x.agentId) &&
    isStr(x.name) &&
    (x.roomName === null || isStr(x.roomName))
      ? { agentId: x.agentId, name: x.name, roomName: x.roomName }
      : null,
  );
  return agents ? { kind: "list", agents } : UNKNOWN;
}

function readUnits(v: unknown): PreflightView["units"] {
  if (isObj(v)) {
    if (v.timedOut === true) return { kind: "timedOut" };
    if (isStr(v.error)) return { kind: "error", error: v.error };
    return UNKNOWN;
  }
  const units = readList(v, (x) =>
    isObj(x) &&
    isStr(x.name) &&
    isStr(x.unitFileState) &&
    isStr(x.activeState) &&
    isBool(x.transient)
      ? {
          name: x.name,
          unitFileState: x.unitFileState,
          activeState: x.activeState,
          transient: x.transient,
        }
      : null,
  );
  return units ? { kind: "list", units } : UNKNOWN;
}

function readRestart(v: unknown): PreflightView["restart"] {
  if (v === null) return { kind: "none" };
  if (
    isObj(v) &&
    isStr(v.unit) &&
    (v.manager === "user" || v.manager === "system") &&
    isStr(v.restart)
  )
    return {
      kind: "set",
      unit: v.unit,
      manager: v.manager,
      restart: v.restart,
    };
  return UNKNOWN;
}

function readHostRefs(v: unknown): PreflightView["hostRefs"] {
  const apps = readList(v, (x) => {
    if (!isObj(x) || !isStr(x.app)) return null;
    const paths = readStrings(x.paths);
    return paths && isBool(x.truncated) && isBool(x.timedOut)
      ? { app: x.app, paths, truncated: x.truncated, timedOut: x.timedOut }
      : null;
  });
  return apps ? { kind: "list", apps } : UNKNOWN;
}

function readSizes(v: unknown): PreflightView["sizes"] {
  if (!isObj(v) || !isNum(v.total)) return UNKNOWN;
  const partial = readList(v.entries, (x) =>
    isObj(x) && isStr(x.name) && (x.bytes === null || isNum(x.bytes))
      ? x.bytes === null || x.timedOut === true
      : null,
  );
  return partial
    ? { kind: "total", bytes: v.total, partial: partial.some(Boolean) }
    : UNKNOWN;
}

function readSudo(v: unknown): PreflightView["sudoPackages"] {
  const packages = isObj(v) ? readStrings(v.packages) : null;
  return packages ? { kind: "list", packages } : UNKNOWN;
}

function readMemberOsUsers(v: unknown): PreflightView["memberOsUsers"] {
  if (!isObj(v)) return UNKNOWN;
  if (v.broken === true) return { kind: "broken" };
  const names = readStrings(v.names);
  if (!names) return UNKNOWN;
  return names.length === 0 ? { kind: "none" } : { kind: "list", names };
}

/** Never throws: each part that does not have its known shape is unknown. */
export function preflightView(raw: unknown): PreflightView {
  const r: Obj = isObj(raw) ? raw : {};
  return {
    finishedAt: isNum(r.finishedAt) ? r.finishedAt : null,
    turnsInFlight: isObj(raw) ? readTurns(r.turnsInFlight) : UNKNOWN,
    units: isObj(raw) ? readUnits(r.units) : UNKNOWN,
    restart: isObj(raw) && "restart" in r ? readRestart(r.restart) : UNKNOWN,
    hostRefs: isObj(raw) ? readHostRefs(r.hostRefs) : UNKNOWN,
    sizes: isObj(raw) ? readSizes(r.sizes) : UNKNOWN,
    sudoPackages: isObj(raw) ? readSudo(r.sudoPackages) : UNKNOWN,
    memberOsUsers: readMemberOsUsers(isObj(raw) ? r.memberOsUsers : undefined),
  };
}

/** The old office locks only when its unit has Restart=always and no
 *  member has their own OS user. An old office that does not report those
 *  members (unknown) does not refuse them either. */
export function lockAllowed(preflight: PreflightView): boolean {
  const members = preflight.memberOsUsers.kind;
  return (
    preflight.restart.kind === "set" &&
    preflight.restart.restart === "always" &&
    (members === "none" || members === "unknown")
  );
}

/** The copy while the old office still runs (slice 4), as the confirm
 *  card shows it. */
export interface LiveView {
  phase: MoveInLivePhase;
  finishedAt: number | null;
  error: { code: string; message: string } | null;
  progress: MoveInProgress | null;
  /** 0..1 by bytes (copyFraction); null when the total is not known. */
  fraction: number | null;
  /** Copy again: only after a pass that ended (ready, stopped, failed). */
  copyAgain: boolean;
}

/** Bytes in the stage: fetched in this pass plus kept from the last one. */
export function copiedBytes(progress: MoveInProgress): number {
  return progress.bytesDone + (progress.bytesKept ?? 0);
}

/** copiedBytes over the manifest total, at most 1; null when the total is
 *  not known (0). */
export function copyFraction(progress: MoveInProgress): number | null {
  return progress.totalBytes > 0
    ? Math.min(1, copiedBytes(progress) / progress.totalBytes)
    : null;
}

/** The live passes that ended: the owner may run one again. */
const LIVE_ENDED = new Set<MoveInLivePhase>(["ready", "stopped", "failed"]);

function liveView(live: MoveInLive | undefined): LiveView | null {
  if (!live) return null;
  const progress = live.progress ?? null;
  return {
    phase: live.phase,
    finishedAt: live.finishedAt ?? null,
    error: live.error ?? null,
    progress,
    fraction: progress ? copyFraction(progress) : null,
    copyAgain: LIVE_ENDED.has(live.phase),
  };
}

/** What the move-in card shows. */
export type MoveInView =
  | { kind: "start"; blocker: MoveInStartBlocker | null }
  | {
      kind: "working";
      step: "pairing" | "preflight" | "locking" | "waiting" | "manifest";
      oldOrigin: string;
      oldOfficeLocked: boolean;
    }
  | {
      kind: "confirm";
      oldOrigin: string;
      preflightId: string;
      preflight: PreflightView;
      lockAllowed: boolean;
      oldOfficeLocked: boolean;
      /** Slice 4: null when the status has no live pass. */
      live: LiveView | null;
    }
  | {
      kind: "copying";
      checking: boolean;
      oldOrigin: string;
      progress: MoveInProgress | null;
      /** 0..1 by bytes; null when the total is not known yet. */
      fraction: number | null;
      oldOfficeLocked: boolean;
    }
  | {
      kind: "staged" | "incomplete";
      oldOrigin: string;
      result: MoveStageCheck;
      error: { code: string; message: string } | null;
      oldOfficeLocked: boolean;
    }
  | {
      kind: "failed";
      oldOrigin: string;
      error: { code: string; message: string };
      retryable: boolean;
      oldOfficeLocked: boolean;
    }
  | { kind: "restarting"; oldOrigin: string }
  | {
      kind: "report";
      oldOrigin: string;
      report: MoveInReport;
      asidePath: string;
    };

export function phaseView(status: MoveInStatus): MoveInView {
  switch (status.phase) {
    case "none":
      return { kind: "start", blocker: status.blocker };
    case "pairing":
      return {
        kind: "working",
        step: "pairing",
        oldOrigin: status.oldOrigin,
        oldOfficeLocked: false,
      };
    case "moved":
      return {
        kind: "report",
        oldOrigin: status.oldOrigin,
        report: status.report,
        asidePath: status.asidePath,
      };
  }
  const { oldOrigin, oldOfficeLocked } = status;
  switch (status.phase) {
    case "preflight":
    case "locking":
    case "waiting":
    case "manifest":
      return {
        kind: "working",
        step: status.phase,
        oldOrigin,
        oldOfficeLocked,
      };
    case "confirm": {
      const preflight = preflightView(status.preflight);
      return {
        kind: "confirm",
        oldOrigin,
        preflightId: status.preflightId ?? "",
        preflight,
        lockAllowed: lockAllowed(preflight),
        oldOfficeLocked,
        live: liveView(status.live),
      };
    }
    case "pulling":
    case "checking": {
      const progress = status.progress ?? null;
      return {
        kind: "copying",
        checking: status.phase === "checking",
        oldOrigin,
        progress,
        fraction: progress ? copyFraction(progress) : null,
        oldOfficeLocked,
      };
    }
    case "staged":
    case "incomplete":
      return {
        kind: status.phase,
        oldOrigin,
        result: status.result ?? {
          complete: false,
          files: 0,
          bytes: 0,
          missing: [],
          changed: [],
        },
        error: status.error ?? null,
        oldOfficeLocked,
      };
    case "failed":
      return {
        kind: "failed",
        oldOrigin,
        error: status.error ?? { code: "unknown", message: "" },
        retryable: status.retryable === true,
        oldOfficeLocked,
      };
    case "finishing":
    case "swapping":
      return { kind: "restarting", oldOrigin };
  }
}

/** Finish runs on a staged copy, or on an incomplete one when the owner
 *  ticked "finish without these files". */
export function finishAllowed(
  view: MoveInView,
  acceptMissing: boolean,
): boolean {
  return (
    view.kind === "staged" || (view.kind === "incomplete" && acceptMissing)
  );
}

/** The phases in which a job runs: the move-in card polls. */
const MOVE_IN_JOB_PHASES = new Set<MoveInStatus["phase"]>([
  "pairing",
  "preflight",
  "locking",
  "waiting",
  "manifest",
  "pulling",
  "checking",
  "finishing",
  "swapping",
]);

/** In confirm, the live pass still lists or copies (slice 4): the card
 *  polls for its progress and for the check after it. */
const liveRuns = (status: MoveInStatus): boolean =>
  status.phase === "confirm" &&
  (status.live?.phase === "manifest" || status.live?.phase === "copying");

/** What one poll got. `locked`: the answer carried LOCKED_HEADER. */
export type PollOutcome<S> =
  | { kind: "status"; status: S }
  | { kind: "locked" }
  | { kind: "error"; error: unknown };

export type PollDecision =
  | { kind: "wait"; ms: number }
  | { kind: "stop" }
  /** A locked server answered: reload, so the owner sees its page. */
  | { kind: "reload" }
  /** finishing/swapping with no answer for MOVE_IN_RESTART_CAP_MS. */
  | { kind: "lost" };

/** The move-in card's next poll. `restartingSince`: when the pane first saw
 *  finishing or swapping (null otherwise); fetch errors after it are the
 *  restart, not a failure. */
export function moveInPollDecision(
  outcome: PollOutcome<MoveInStatus>,
  ctx: { restartingSince: number | null; now: number },
): PollDecision {
  switch (outcome.kind) {
    case "locked":
      return { kind: "reload" };
    case "error":
      return ctx.restartingSince !== null &&
        ctx.now - ctx.restartingSince >= MOVE_IN_RESTART_CAP_MS
        ? { kind: "lost" }
        : { kind: "wait", ms: MOVE_IN_POLL_MS };
    case "status":
      return MOVE_IN_JOB_PHASES.has(outcome.status.phase) ||
        liveRuns(outcome.status)
        ? { kind: "wait", ms: MOVE_IN_POLL_MS }
        : { kind: "stop" };
  }
}

/** The move-out card's next poll. */
export function moveOutPollDecision(
  outcome: PollOutcome<OfficeMoveRes>,
): PollDecision {
  switch (outcome.kind) {
    case "locked":
      return { kind: "reload" };
    case "error":
      // The lock restarts the old office into the MOVE server: keep asking,
      // the next answer is locked.
      return { kind: "wait", ms: MOVE_OUT_POLL_MS };
    case "status":
      return outcome.status.state === "none"
        ? { kind: "stop" }
        : { kind: "wait", ms: MOVE_OUT_POLL_MS };
  }
}

/** The first MOVE_LIST_MAX items and how many more there are. */
export function listHead<T>(items: T[]): { shown: T[]; more: number } {
  return {
    shown: items.slice(0, MOVE_LIST_MAX),
    more: Math.max(0, items.length - MOVE_LIST_MAX),
  };
}

/** One line of the after-move report's "left behind" list (slice 3). */
export type LeftBehindLine =
  | { kind: "signIn" }
  | { kind: "invites" }
  | { kind: "extension" }
  | { kind: "push" }
  | { kind: "sshKeys" }
  /** A unit this release does not name (an old office of an older release). */
  | { kind: "unit"; unit: string; entries: number }
  | { kind: "secrets"; count: number };

/** The units the report names, in the order it shows them. A unit with a
 *  null kind gives no line (apps sign in again through the office). The
 *  units it does not name come after these, then the secrets line. */
export const LEFT_BEHIND_ORDER: readonly {
  unit: string;
  kind: "signIn" | "invites" | "extension" | "push" | "sshKeys" | null;
}[] = [
  { unit: "browser-sessions", kind: "signIn" },
  { unit: "invites", kind: "invites" },
  { unit: "extension-pairings", kind: "extension" },
  { unit: "web-push", kind: "push" },
  { unit: "ssh-authorized-keys", kind: "sshKeys" },
  { unit: "app-sessions", kind: null },
];

/** The secret store's unit: an older old office leaves it out, and the
 *  report then counts the secrets to set again. */
const SECRET_STORE_UNIT = "secret-store";

/** What the report lists as left behind: one line per excluded unit with
 *  entries, and the secrets to set again when the old office left the
 *  secret store out. */
export function leftBehindLines(
  report: Pick<MoveInReport, "excluded" | "secretCount">,
): LeftBehindLine[] {
  const present = report.excluded.filter((u) => u.entries > 0);
  const has = (unit: string) => present.some((u) => u.unit === unit);
  const lines: LeftBehindLine[] = [];
  for (const o of LEFT_BEHIND_ORDER)
    if (o.kind !== null && has(o.unit)) lines.push({ kind: o.kind });
  const named = new Set(LEFT_BEHIND_ORDER.map((o) => o.unit));
  for (const u of present)
    if (!named.has(u.unit) && u.unit !== SECRET_STORE_UNIT)
      lines.push({ kind: "unit", unit: u.unit, entries: u.entries });
  if (has(SECRET_STORE_UNIT) && report.secretCount > 0)
    lines.push({ kind: "secrets", count: report.secretCount });
  return lines;
}

// The wire types of an office move (task 78733adf): what the old office's
// owner routes (/api/office/move*) and the new office's owner routes
// (/api/office/move-in*) answer, shared by the server and the Settings pane.
// internal-docs/office-move-design.md describes the flow.

import type { AuditActor } from "./audit.ts";

/** An office's own systemd user unit. */
export interface MoveOfficeUnit {
  name: string;
  /** The unit file, absolute, or null when systemd does not name one. */
  fragmentPath: string | null;
}

/** What each box tells the other about itself at the redeem. */
export interface MoveBoxInfo {
  /** The CalVer release tag when the checkout is at one, else null. */
  release: string | null;
  commit: string | null;
  /** The office user's home directory. */
  homePath: string;
  /** The office's state root, absolute (slice 2b). Both boxes refuse a move
   *  when it is not inside the home, not its own realpath, or differs. */
  stateRoot: string;
  /** The office's own user unit (slice 2c-1), null for a system unit or
   *  none. The new office refuses a redeem answer without the key ("update
   *  the old office"): its swap sets the old unit aside. */
  officeUnit?: MoveOfficeUnit | null;
}

export interface TransientExec {
  /** argv of ExecStart. */
  argv: string[];
  workingDirectory: string | null;
  /** KEY=VALUE entries of Environment. */
  environment: string[];
}

export interface AgentUnit {
  name: string;
  fragmentPath: string;
  /** UnitFileState as systemctl reports it ("enabled", "static", ...). */
  unitFileState: string;
  /** ActiveState as systemctl reports it ("active", "inactive", ...). */
  activeState: string;
  transient: boolean;
  /** For an active transient unit: how to start it again. null when it could
   *  not be read. */
  exec?: TransientExec | null;
}

export interface MoveExcludedUnit {
  unit: string;
  entries: number;
  /** Regular file bytes only. */
  bytes: number;
}

export interface MoveStageCheck {
  /** Every manifest entry is in the stage and every requested item has its
   *  end with the requested length. */
  complete: boolean;
  files: number;
  bytes: number;
  /** Items with no end, a short end or an error record; directories and
   *  links not in the stage. */
  missing: { path: string; reason: string }[];
  /** Files whose size or mtime moved while the old office read them. */
  changed: string[];
}

export interface MoveInProgress {
  entries: number;
  totalBytes: number;
  filesDone: number;
  bytesDone: number;
  batchesDone: number;
  batchesTotal: number;
  retries: number;
}

/** What the report starts with (the rest is filled at the swap and at the
 *  first normal boot). */
export interface MoveInReportInput {
  oldOrigin: string;
  office: MoveBoxInfo;
  finishedAt: number;
  by: AuditActor;
  /** The units the move left out, bound to the old box or its origin (the
   *  manifest's `excluded`; an older old office also lists its sign-ins). */
  excluded: MoveExcludedUnit[];
  /** The old office's secret count (the manifest's); secrets to set again
   *  only when the old office left the secret store out. */
  secretCount: number;
  /** The paths the owner accepted as missing (finish {acceptMissing}). */
  missing: { path: string; reason: string }[];
}

/** The after-move report (GET /api/office/move-in in phase `moved`). */
export interface MoveInReport extends MoveInReportInput {
  swappedAt: number;
  /** The fresh office's owner, renamed on a name clash (null: not renamed). */
  ownerRenamedTo: string | null;
  /** The old office's own unit, set aside (null: none in the stage). */
  oldOfficeUnitSetAside: string | null;
  /** The top-level entries of the aside folder and its size. */
  aside: { entries: string[]; bytes: number };
  /** The agent-made units put back at the first normal boot (null: not
   *  yet). */
  units: {
    restored: string[];
    failed: { name: string; reason: string }[];
  } | null;
  /** Whether the first normal boot wrote office.moveInSwapped. */
  audited: boolean;
}

/** The old office's preflight result, as it answered. Not typed here: it
 *  comes from the old office's release, so the new office shows it through a
 *  guard (ui/office-move.ts preflightView). */
export type MoveInPreflight = Record<string, unknown>;

/** Why this office cannot take a move in now: the same answer the start
 *  refuses with before the redeem (office_not_fresh with `extra.reasons`,
 *  restart_policy, state_root_outside_home). */
export interface MoveInStartBlocker {
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export type MoveInPhase =
  | "preflight"
  | "confirm"
  | "locking"
  | "waiting"
  | "manifest"
  | "pulling"
  | "checking"
  | "staged"
  | "incomplete"
  | "finishing"
  | "swapping"
  | "failed";

/** GET /api/office/move-in: what an owner sees, never the session, the key or
 *  the code. */
export type MoveInStatus =
  | {
      phase: "none";
      /** null: this office can take a move in. */
      blocker: MoveInStartBlocker | null;
    }
  /** The redeem is in flight (in memory only). */
  | { phase: "pairing"; oldOrigin: string }
  | {
      phase: MoveInPhase;
      oldOrigin: string;
      office: MoveBoxInfo;
      /** Whether the lock may have reached the old office: a cancel leaves
       *  it locked until its owner enters the move code there. */
      oldOfficeLocked: boolean;
      preflightId?: string;
      preflight?: MoveInPreflight;
      lockedAt?: number | null;
      progress?: MoveInProgress;
      result?: MoveStageCheck;
      error?: { code: string; message: string };
      retryable?: boolean;
    }
  | {
      phase: "moved";
      oldOrigin: string;
      office: MoveBoxInfo;
      report: MoveInReport;
      /** The folder that holds the fresh office set aside, absolute. */
      asidePath: string;
    };

/** DELETE /api/office/move-in. */
export interface MoveInCancelRes {
  cancelled: boolean;
  oldOfficeLocked: boolean;
  message?: string;
}

/** POST /api/office/move/code. */
export interface MintMoveCodeRes {
  code: string;
  origin: string;
  expiresAt: number;
  loopbackOrigin: boolean;
}

/** GET /api/office/move. */
export interface OfficeMoveRes {
  state: "none" | "code" | "paired" | "move";
  expiresAt?: number | null;
  pairedAt?: number;
  newBox?: {
    release: string | null;
    commit: string | null;
    homePath: string;
    stateRoot: string;
  };
}

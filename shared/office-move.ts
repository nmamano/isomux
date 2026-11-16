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
  /** Slice 4: files and bytes an earlier pass already copied, kept without
   *  a fetch. */
  filesKept?: number;
  bytesKept?: number;
}

/** Slice 4: the copy while the old office still runs (the live pass). */
export type MoveInLivePhase =
  | "manifest"
  | "copying"
  /** Done: the lock's pass fetches only what changed since. */
  | "ready"
  /** The lock stopped it; what it copied whole is kept. */
  | "stopped"
  | "failed"
  /** The old office's release cannot serve it: the lock's pass copies
   *  everything. */
  | "unsupported";

export interface MoveInLive {
  phase: MoveInLivePhase;
  startedAt: number;
  finishedAt?: number;
  manifestId?: string;
  error?: { code: string; message: string };
  /** In the status only, while it copies. */
  progress?: MoveInProgress;
}

/** Slice 5b: why the old office leaves a folder outside its home (C1-C3):
 *  `temp`, at or below /tmp, /var/tmp, /dev/shm or /run; `link`, a link on
 *  its path; `office`, it holds or is inside the home, the state root, the
 *  code folder or the backup folder; `owner`, another user owns it. */
export type MoveOutsideLeftReason = "temp" | "link" | "office" | "owner";

export interface MoveOutsideLeft {
  path: string;
  reason: MoveOutsideLeftReason;
}

export interface MoveOutsideFolder {
  path: string;
  /** The folder's mode (permission bits). */
  mode: number;
}

/** Slice 5b: the old office's folders outside its home. */
export interface MoveOutsideFolders {
  move: MoveOutsideFolder[];
  left: MoveOutsideLeft[];
}

/** Slice 5c-1: why the old office cannot carry the home of a member with
 *  their own OS user. `broken`, her record is malformed; `unfinished`, her
 *  enable did not finish; `busy`, an enable, a disable or an agent host move runs for her;
 *  `moved_in`, she came with a move and the enable command has not run on
 *  this machine; `bad_home`, passwd gives no safe home for her; `runner_down`,
 *  her runner does not answer; `wrong_runner`, the answer names another user,
 *  uid or home; `old_runtime`, her runner runs another runtime than this
 *  office's. */
export type MoveMemberBlock =
  | "broken"
  | "unfinished"
  | "busy"
  | "moved_in"
  | "bad_home"
  | "runner_down"
  | "wrong_runner"
  | "old_runtime";

/** Slice 5c-1: a member with their own OS user, as the preflight and the
 *  lock see her. */
export interface MoveMemberInfo {
  userId: string;
  /** Her name, or the id when no user has it. */
  name: string;
  /** The OS user, or null when her record is malformed. */
  osUser: string | null;
  /** Her home from passwd, or null. */
  home: string | null;
  /** Ready to move, or why not. */
  block: MoveMemberBlock | null;
  /** The detail of a block, for the owner (a path, the two hashes...). */
  detail?: string;
  /** Her agent-made user units (slice 5c-1, Q5): the lock stops and
   *  disables them. Absent when her runner cannot be asked. */
  units?: AgentUnit[];
}

/** Slice 5b: why a folder cannot land on the new office. */
export type MoveInFolderBlock =
  | "in_home"
  | "link"
  | "not_dir"
  | "owner"
  | "unsafe_parent"
  | "not_empty"
  | "no_write";

export type MoveInFolderCheck =
  | {
      path: string;
      ok: true;
      /** The folders to make, top down (empty: the folder exists). */
      create: string[];
    }
  | {
      path: string;
      ok: false;
      reason: MoveInFolderBlock;
      /** The part of the path the reason is about. */
      at: string;
      /** A command for root on this box that clears it (owner on the folder
       *  itself, no_write), or absent. */
      command?: string;
    };

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
  /** Slice 5b: the folders outside the home that moved (absent in a report
   *  of an earlier release). */
  outsideMoved?: string[];
  /** Slice 5b: the folders outside the home the old office left, from the
   *  preflight the owner agreed to. */
  outsideLeft?: MoveOutsideLeft[];
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
      /** Slice 4, phases `preflight` and `confirm`. */
      live?: MoveInLive;
      /** Slice 5b: where each folder outside the home lands on this box,
       *  checked at this request. Phase `confirm`: the preflight's folders;
       *  phase `failed` with error code outside_folders_blocked: the
       *  folders the lock kept. */
      outsideChecks?: MoveInFolderCheck[];
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
  /** Slice 4: when the new office first copied a part of this office (in
   *  `paired`, while it still runs, or in `move`). */
  servedAt?: number;
  newBox?: {
    release: string | null;
    commit: string | null;
    homePath: string;
    stateRoot: string;
  };
}

// The new office's side of an office move (task 78733adf, slice 2b; design:
// internal-docs/office-move-design.md "The new office"). An owner pastes the
// move code here; this office pairs with the old office, shows its
// preflight, locks it after the owner's yes, then pulls its home into the
// stage (office-move-stage.ts) and checks the copy. Slice 2b ends at
// `staged`: it does not send `done` (2c sends it, with the swap at boot).
//
// The state file `<state>/office-move-in.json` (0600, one union by phase)
// keeps the old office's origin, the move session and the key. Nothing of
// them goes in a status answer. The pull job lives in this process only: a
// boot that finds a phase from `locking` on sets `failed` (interrupted).

import {
  checkMoveInFolder,
  createMoveOutsideScope,
  dropMoveInOutside,
  readMoveInOutside,
  writeMoveInOutside,
  type MoveInFolderFs,
} from "./office-move-outside.ts";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import { errMessage } from "../shared/errors.ts";
import type {
  MoveInFolderCheck,
  MoveInLive,
  MoveOutsideFolder,
  MoveOutsideLeft,
  MoveInPreflight,
  MoveInProgress,
  MoveInStartBlocker,
  MoveInStatus,
} from "../shared/office-move.ts";
import {
  MOVE_IN_DIR,
  MOVE_IN_STATE_FILE,
  moveStateRootRefusal,
  parseMoveCode,
  type MoveBoxInfo,
  type MoveOfficeUnit,
} from "./office-move.ts";
import {
  checkMoveInSwap,
  MOVE_IN_ASIDE,
  writeMoveInSwapFile,
  type MoveInReport,
  type MoveInSwapInputs,
  type MoveInSwapRefusal,
} from "./office-move-swap.ts";
import type { AgentUnit } from "./office-move-units.ts";
import {
  compareMoveWalkOrder,
  moveItemsHash,
  openMoveStream,
  readMoveRecords,
  type MoveExcludedUnit,
  type MoveManifestEntry,
  type MoveSealContext,
} from "./office-move-pull.ts";
import {
  createMoveScope,
  moveAlwaysFetch,
  type MoveScope,
} from "./office-move-scope.ts";
import {
  createMoveStage,
  removeMoveTree,
  MOVE_IN_LEDGER,
  MOVE_IN_STAGE,
  MoveStageError,
  readMoveLedger,
  type MoveLedgerRow,
  type MoveStage,
  type MoveStageBatch,
  type MoveStageCheck,
  type MoveStageItem,
} from "./office-move-stage.ts";

export { MOVE_IN_STATE_FILE };

// ---- freshness ----

/** What the freshness check reads of this office. */
export interface MoveInFreshInput {
  /** users.json, removed members included. */
  users: { role: string }[];
  /** Agents, killed ones included. */
  agents: { name: string; roomId: string | null }[];
  /** The agents the office seeds (welcome agents, the lobby Receptionist). */
  seededAgents: { name: string; roomId: string }[];
  apps: number;
  /** Tasks of any status. */
  tasks: number;
}

export type MoveInFreshness =
  | { fresh: true }
  | {
      fresh: false;
      /** One per rule that fails, with a count; never names. */
      reasons: { kind: "users" | "agents" | "apps" | "tasks"; count: number }[];
    };

/** A fresh office: one user, an owner; only seeded agents; no apps; no
 *  tasks. */
export function checkMoveInFresh(input: MoveInFreshInput): MoveInFreshness {
  const reasons: {
    kind: "users" | "agents" | "apps" | "tasks";
    count: number;
  }[] = [];
  const owners = input.users.filter((u) => u.role === "owner").length;
  if (input.users.length !== 1 || owners !== 1)
    reasons.push({
      kind: "users",
      count: Math.max(1, input.users.length - (owners > 0 ? 1 : 0)),
    });
  // Each seed matches at most one agent, by its name and its room.
  const seeds = new Map<string, number>();
  const seedKey = (name: string, roomId: string | null) =>
    JSON.stringify([name, roomId]);
  for (const a of input.seededAgents) {
    const k = seedKey(a.name, a.roomId);
    seeds.set(k, (seeds.get(k) ?? 0) + 1);
  }
  let made = 0;
  for (const a of input.agents) {
    const k = seedKey(a.name, a.roomId);
    const left = seeds.get(k) ?? 0;
    if (left > 0) seeds.set(k, left - 1);
    else made++;
  }
  if (made > 0) reasons.push({ kind: "agents", count: made });
  if (input.apps > 0) reasons.push({ kind: "apps", count: input.apps });
  if (input.tasks > 0) reasons.push({ kind: "tasks", count: input.tasks });
  return reasons.length === 0 ? { fresh: true } : { fresh: false, reasons };
}

// ---- state ----

/** What a pairing gives (kept in the state file from `preflight` on). */
export interface MoveInPairing {
  /** The old office's origin, from the code. */
  oldOrigin: string;
  /** The move session (bearer), base64url. */
  session: string;
  sessionExpiresAt: number;
  /** The code's AEAD key, base64url. */
  key: string;
  pairedAt: number;
  /** The owner who started it. */
  by: AuditActor;
  /** The old office, as its redeem answered. */
  office: MoveBoxInfo;
  /** Slice 5b: the old office's folders outside its home, from the
   *  preflight the owner agreed to (set at the lock). The final pass refuses
   *  a manifest that lists others (C4). */
  outside?: { move: MoveOutsideFolder[]; left: MoveOutsideLeft[] };
}

export type { MoveInLive, MoveInPreflight, MoveInProgress, MoveInStatus };

export type MoveInState =
  | ({
      phase: "preflight";
      preflightId: string;
      /** Slice 4: the live pass (written only by writeLive). */
      live?: MoveInLive;
    } & MoveInPairing)
  | ({
      phase: "confirm";
      preflightId: string;
      preflight: MoveInPreflight;
      live?: MoveInLive;
    } & MoveInPairing)
  | ({ phase: "locking"; preflightId: string } & MoveInPairing)
  /** Waiting for the old office to answer as locked: after the lock's
   *  202 (lockedAt set), or a pull again that asks whether a lost lock
   *  arrived (lockedAt null). */
  | ({ phase: "waiting"; lockedAt: number | null } & MoveInPairing)
  | ({
      phase: "manifest";
      lockedAt: number;
      manifestId: string;
    } & MoveInPairing)
  | ({
      phase: "pulling";
      lockedAt: number;
      manifestId: string;
      progress: MoveInProgress;
    } & MoveInPairing)
  | ({
      phase: "checking";
      lockedAt: number;
      manifestId: string;
      progress: MoveInProgress;
    } & MoveInPairing)
  | ({
      phase: "staged";
      lockedAt: number;
      manifestId: string;
      stagedAt: number;
      result: MoveStageCheck;
      /** Slice 2c-1: what the swap and the report need of the manifest. */
      manifest: MoveInManifestFacts;
      /** A finish that did not reach the old office. */
      error?: { code: string; message: string };
    } & MoveInPairing)
  | ({
      phase: "incomplete";
      lockedAt: number;
      manifestId: string;
      result: MoveStageCheck;
      manifest: MoveInManifestFacts;
      error?: { code: string; message: string };
    } & MoveInPairing)
  /** Slice 2c-1: finish runs (the dry run, then `done`). A boot that finds it
   *  goes back to `staged` or `incomplete` (`from`). */
  | ({
      phase: "finishing";
      from: "staged" | "incomplete";
      lockedAt: number;
      manifestId: string;
      stagedAt: number | null;
      result: MoveStageCheck;
      manifest: MoveInManifestFacts;
      acceptMissing: boolean;
    } & MoveInPairing)
  /** `done` answered and swap.json is written: the process restarts and the
   *  boot swaps. */
  | ({
      phase: "swapping";
      lockedAt: number;
      manifestId: string;
      finishedAt: number;
    } & MoveInPairing)
  | ({
      phase: "failed";
      /** Set when the old office was locked before the failure. */
      lockedAt: number | null;
      error: { code: string; message: string };
      /** Whether `retryPull` may run (after the lock only). */
      retryable: boolean;
      failedAt: number;
    } & MoveInPairing);

/** Terminal, in the same state file: the swap boot wrote it. No session or
 *  key any more. Not a MoveInState: nothing pairs from it. */
export interface MoveInMovedState {
  phase: "moved";
  oldOrigin: string;
  office: MoveBoxInfo;
  report: MoveInReport;
}

/** What the swap and the report keep of the old office's manifest answer. */
export interface MoveInManifestFacts {
  excluded: MoveExcludedUnit[];
  secretCount: number;
  /** The old office's units record. */
  units: AgentUnit[];
  /** Slice 5b: the folders outside the home, as the manifest lists them
   *  (each one's own mode and mtime go on it at the swap). Absent: none. */
  outside?: { path: string; mode: number; mtime: number }[];
}

// ---- the job ----

export interface MoveInTiming {
  /** One request to the old office (headers and a JSON body). */
  requestMs: number;
  /** A sealed stream with no bytes for this long fails (the batch runs
   *  again). */
  idleMs: number;
  /** Between two status polls. */
  pollMs: number;
  /** The old office's restart into the MOVE-locked server. */
  restartWaitMs: number;
  /** The old office's preflight job. */
  preflightWaitMs: number;
  /** The old office's manifest walk. */
  manifestWaitMs: number;
}

export interface MoveInLimits {
  /** The most content one batch asks for. */
  batchBytes: number;
  /** The most JSON of a batch's item list (the old office reads 1 MB). */
  batchItemsJsonBytes: number;
  /** Batches at the same time. */
  concurrency: number;
  /** Runs of one batch, the first included. */
  batchAttempts: number;
  /** The most bytes of a JSON answer of the old office. */
  jsonMaxBytes: number;
}

export const MOVE_IN_TIMING: MoveInTiming = {
  requestMs: 30_000,
  idleMs: 120_000,
  pollMs: 2_000,
  restartWaitMs: 5 * 60_000,
  preflightWaitMs: 10 * 60_000,
  manifestWaitMs: 60 * 60_000,
};

export const MOVE_IN_LIMITS: MoveInLimits = {
  batchBytes: 64 * 1024 * 1024,
  batchItemsJsonBytes: 800 * 1024,
  concurrency: 3,
  batchAttempts: 3,
  jsonMaxBytes: 1024 * 1024,
};

export interface MoveInStatfs {
  bavail: number;
  bsize: number;
  ffree: number;
}

/** This box, as finish needs it. */
export interface MoveInBox {
  codeDir: string | null;
  backupDir: string | null;
  /** The office's own user unit, or null. */
  officeUnit: MoveOfficeUnit | null;
  /** The office unit's Restart= value, or null when it runs under no unit. */
  restartPolicy: string | null;
  /** The public origin, or null (finish then sends the request's origin). */
  publicOrigin: string | null;
  /** Whether the office listens on loopback only (absent: yes). */
  loopbackOnly?: boolean;
  /** Slice 5b: the office OS user, for checkMoveInFolder (gid: the primary
   *  group). Absent: the process's own (userInfo, getgid, the group's name
   *  from /etc/group). */
  osUser?: { uid: number; gid: number; user: string; group: string };
}

/** The job's own audit row (the routes audit start, lock, retry and
 *  cancel through the executor). */
export type MoveInAuditOperation = "office.moveInStaged";

export interface MoveInDeps {
  stateRoot: string;
  /** The office user's home (the stage is under it). */
  home: string;
  /** Every request to the old office. Production: globalThis.fetch. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** This box, as the redeem sends it. */
  ours(): MoveBoxInfo;
  freshness(): MoveInFreshInput;
  statfs(path: string): MoveInStatfs;
  audit(operation: MoveInAuditOperation, actor: AuditActor): void;
  /** Slice 2c-1: this box, for the swap's inputs and finish's checks. */
  box(): MoveInBox;
  /** Restarts the office process (the office's own self-restart path). */
  requestRestart(): void;
  /** Slice 5b, a test seam: put in front of every outside folder's path on
   *  this office (the check, the stage, outside.json, the swap inputs). The
   *  status and the report keep the old office's paths. Production omits
   *  it. */
  outsideRoot?: string;
  /** Slice 5b: checkMoveInFolder's reads. Default: node:fs. */
  folderFs?: MoveInFolderFs;
  /** Slice 5b: the device of a path, for the free-space check by device
   *  (statfs runs once per device, on its first path; the home first). For
   *  a folder not made yet, its deepest existing ancestor. Default:
   *  lstat(path).dev. */
  deviceOf?(path: string): number;
  now(): Date;
  timing: MoveInTiming;
  limits: MoveInLimits;
}

/** A route's answer. */
export type MoveInAnswer =
  | { ok: true; status: 200 | 202; body: unknown }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      extra?: Record<string, unknown>;
    };

export interface MoveIn {
  /** POST /api/office/move-in {code}: freshness, the redeem, the preflight.
   *  One move-in at a time (a synchronous guard). */
  start(input: { code: string; by: AuditActor }): Promise<MoveInAnswer>;
  /** GET /api/office/move-in. */
  status(): MoveInStatus;
  /** POST /api/office/move-in/preflight: phase `confirm` only. */
  rerunPreflight(input: { by: AuditActor }): Promise<MoveInAnswer>;
  /** POST /api/office/move-in/lock {preflightId}: the owner's yes. */
  lock(input: { preflightId: string; by: AuditActor }): Promise<MoveInAnswer>;
  /** POST /api/office/move-in/live (slice 4): the live pass again, in
   *  `confirm` with no live pass running. It keeps what the last pass
   *  copied whole. */
  copyLive(input: { by: AuditActor }): Promise<MoveInAnswer>;
  /** POST /api/office/move-in/pull: a retryable `failed` only. */
  retryPull(input: { by: AuditActor }): Promise<MoveInAnswer>;
  /** POST /api/office/move-in/finish {acceptMissing?} (owner browser
   *  session), slice 2c-1: `staged`, or `incomplete` with acceptMissing.
   *  The dry run, then `done`, then swap.json, then a restart. 202. */
  finish(input: {
    acceptMissing: boolean;
    by: AuditActor;
    /** The origin of the owner's request. */
    requestOrigin: string;
  }): Promise<MoveInAnswer>;
  /** DELETE /api/office/move-in: the state file and the stage. In `moved`:
   *  the report and the move-in folder (the fresh office set aside). */
  cancel(input: { by: AuditActor }): Promise<MoveInAnswer>;
  /** At boot: a phase from `locking` on with no job -> `failed`
   *  (interrupted, retryable). */
  recoverAtBoot(): void;
  /** Resolves when no job runs (tests). */
  settled(): Promise<void>;
}

// ---- the client of the old office ----

/** A failure of the move-in with what the owner sees. */
class MoveInFail extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Overrides the default (retryable once the lock may have arrived). */
    readonly retryable?: boolean,
    readonly status = 502,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MoveInFail";
  }
}

const unreachable = (err: unknown) =>
  err instanceof MoveInFail
    ? err
    : new MoveInFail(
        "old_office_unreachable",
        `The old office did not answer: ${errMessage(err)}`,
      );

const STATE_ROOT_REFUSAL_MESSAGE =
  "This office's data folder is not a real folder inside the office user's home.";

/** Phases after which the lock may have reached the old office. */
const LOCKED_PHASES = new Set<MoveInState["phase"]>([
  "locking",
  "waiting",
  "manifest",
  "pulling",
  "checking",
  "staged",
  "incomplete",
]);

/** The phases a job runs in; a boot that finds one has no job. */
const JOB_PHASES = new Set<MoveInState["phase"]>([
  "preflight",
  "locking",
  "waiting",
  "manifest",
  "pulling",
  "checking",
]);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted)
      return reject(new MoveInFail("cancelled", "Cancelled."));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new MoveInFail("cancelled", "Cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Rejects after `ms` unless `p` settles first. */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      onTimeout?.();
      reject(
        new MoveInFail(
          "old_office_timeout",
          `The old office took too long: ${what}.`,
        ),
      );
    }, ms);
  });
  p.catch(() => {});
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** A body read in full, at most `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  const tooLarge = () =>
    new MoveInFail(
      "answer_too_large",
      `An answer of the old office is larger than ${max} bytes.`,
    );
  if (Number.isFinite(declared) && declared > max) {
    res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}

/** A body's chunks; a pause longer than `idleMs` fails it. */
async function* idleLimited(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) throw new MoveInFail("cancelled", "Cancelled.");
      const read = reader.read();
      read.catch(() => {});
      let t: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        t = setTimeout(
          () =>
            reject(
              new MoveInFail(
                "stream_idle",
                `The old office sent nothing for ${idleMs} ms.`,
              ),
            ),
          idleMs,
        );
      });
      const r = await Promise.race([read, idle]).finally(() => clearTimeout(t));
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // Never awaited: a stalled source may never settle its cancel.
    reader.cancel().catch(() => {});
  }
}

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** An error answer of the old office as a failure the owner sees. */
function answerFail(status: number, body: unknown): MoveInFail {
  const b = isObject(body) ? body : {};
  const e = isObject(b.error) ? b.error : {};
  const code = typeof e.code === "string" ? e.code : `old_office_${status}`;
  const message =
    typeof e.message === "string"
      ? e.message
      : `The old office answered ${status}.`;
  const extra = Object.fromEntries(
    Object.entries(b).filter(([k]) => k !== "error"),
  );
  return new MoveInFail(
    code,
    message,
    undefined,
    status,
    Object.keys(extra).length > 0 ? extra : undefined,
  );
}

/** A service unit's file name. */
const UNIT_NAME_RE = /^[A-Za-z0-9:_.@\\-]+\.service$/;

function asBox(v: unknown): MoveBoxInfo | null {
  if (!isObject(v)) return null;
  const nullable = (x: unknown) => x === null || typeof x === "string";
  if (
    !nullable(v.release) ||
    !nullable(v.commit) ||
    typeof v.homePath !== "string" ||
    typeof v.stateRoot !== "string"
  )
    return null;
  // Slice 2c-1: the old office's own unit (null: a system unit or none). An
  // answer without the key comes from an older release.
  const u = v.officeUnit;
  let officeUnit: MoveOfficeUnit | null;
  if (u === null) officeUnit = null;
  // The swap renames by these: a unit file name, and an absolute path with
  // no "." or ".." in it, never a path that leaves the stage.
  else if (
    isObject(u) &&
    typeof u.name === "string" &&
    UNIT_NAME_RE.test(u.name) &&
    (u.fragmentPath === null ||
      (typeof u.fragmentPath === "string" &&
        isAbsolute(u.fragmentPath) &&
        normalize(u.fragmentPath) === u.fragmentPath))
  )
    officeUnit = { name: u.name, fragmentPath: u.fragmentPath };
  else return null;
  return {
    release: v.release,
    commit: v.commit,
    homePath: v.homePath,
    stateRoot: v.stateRoot,
    officeUnit,
  };
}

function asManifestEntry(v: unknown): MoveManifestEntry | null {
  if (!isObject(v)) return null;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (
    typeof v.p !== "string" ||
    (v.t !== "f" && v.t !== "d" && v.t !== "l") ||
    !num(v.s) ||
    (v.s as number) < 0 ||
    !num(v.m) ||
    !num(v.mode) ||
    (v.t === "l" && typeof v.l !== "string") ||
    (v.q !== undefined && v.q !== 1)
  )
    return null;
  return {
    p: v.p,
    t: v.t,
    s: v.s as number,
    m: v.m as number,
    mode: v.mode as number,
    ...(v.t === "l" ? { l: v.l as string } : {}),
    ...(v.q === 1 ? { q: 1 as const } : {}),
  };
}

/** The entries of a manifest file, line by line. */
async function* manifestEntries(
  file: string,
): AsyncGenerator<MoveManifestEntry> {
  const decoder = new TextDecoder();
  let rest = "";
  const parse = (line: string) => {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      v = null;
    }
    const e = asManifestEntry(v);
    if (!e)
      throw new MoveInFail(
        "manifest_malformed",
        "The old office's manifest has an entry that does not parse.",
        true,
      );
    return e;
  };
  for await (const chunk of Bun.file(file).stream()) {
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line) yield parse(line);
    }
  }
  rest += decoder.decode();
  if (rest) yield parse(rest);
}

const GIB = 1024 ** 3;
// ---- the move-in ----

/** Slice 5b: one stage of a pass: the home, or a folder outside it. */
interface PassTarget {
  /** The index in the manifest's outside list; null for the home. */
  outside: number | null;
  /** The old office's path of the folder; null for the home. */
  oldPath: string | null;
  /** Where it lands here (the home, or the folder). */
  local: string;
  dir: string;
  stageDir: string;
  manifestFile: string;
  ledgerFile: string;
  prevStageDir: string;
  prevLedgerFile: string;
  fetchScope: MoveScope;
}

/** Slice 5b: a folder of a ready manifest answer. */
interface OutsideListed {
  path: string;
  mode: number;
  mtime: number;
  totalBytes?: number;
  unreadable?: unknown;
}

/** The office OS user of this process, for the folder checks. */
function processOsUser(): {
  uid: number;
  gid: number;
  user: string;
  group: string;
} {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const user = userInfo().username;
  let group = String(gid);
  try {
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const [name, , id] = line.split(":");
      if (id !== undefined && Number(id) === gid && name) {
        group = name;
        break;
      }
    }
  } catch {
    // No group file: the command names the group by its number.
  }
  return { uid, gid, user, group };
}

/** Slice 5b: the old office's folders outside its home, as its preflight
 *  answered (an older release sends none). */
function preflightOutside(pf: MoveInPreflight | undefined): {
  move: MoveOutsideFolder[];
  left: MoveOutsideLeft[];
} {
  const o = pf?.outsideFolders;
  if (!isObject(o)) return { move: [], left: [] };
  const move = Array.isArray(o.move)
    ? o.move
        .filter(
          (f): f is MoveOutsideFolder =>
            isObject(f) &&
            typeof f.path === "string" &&
            typeof f.mode === "number",
        )
        .map((f) => ({ path: f.path, mode: f.mode }))
    : [];
  const left = Array.isArray(o.left)
    ? o.left
        .filter(
          (f): f is MoveOutsideLeft =>
            isObject(f) &&
            typeof f.path === "string" &&
            typeof f.reason === "string",
        )
        .map((f) => ({ path: f.path, reason: f.reason }))
    : [];
  return { move, left };
}

/** Slice 5b: why a folder cannot land here, in plain words. */
function blockedWhy(c: MoveInFolderCheck): string {
  if (c.ok) return "";
  switch (c.reason) {
    case "in_home":
      return "it would be inside this office's home";
    case "link":
      return `${c.at} is a link`;
    case "not_dir":
      return `${c.at} is not a folder`;
    case "owner":
      return `another user owns ${c.at}`;
    case "unsafe_parent":
      return `other users can write to ${c.at}`;
    case "not_empty":
      return `${c.at} is not empty`;
    case "no_write":
      return `this office cannot make folders in ${c.at}`;
  }
}

function blockedMessage(blocked: MoveInFolderCheck[]): string {
  return `These folders of the old office cannot be copied to this machine: ${blocked
    .map((c) => `${c.path} (${blockedWhy(c)})`)
    .join("; ")}. Fix them, then try again.`;
}

export function createMoveIn(deps: MoveInDeps): MoveIn {
  const stateFile = join(deps.stateRoot, MOVE_IN_STATE_FILE);
  const moveInDir = join(deps.home, MOVE_IN_DIR);
  // Slice 5b: the old office's folder outside its home, at its place here.
  const localOf = (p: string) =>
    deps.outsideRoot === undefined ? p : join(deps.outsideRoot, p);
  // Slice 4: every pass builds on the last one. Its ledger lists what came
  // whole and clean; a new pass moves the last stage and ledger aside, keeps
  // what still matches, and removes the rest.
  const targetOf = (
    local: string,
    outside: number | null,
    oldPath: string | null,
    fetchScope: MoveScope,
  ): PassTarget => {
    const dir = join(local, MOVE_IN_DIR);
    return {
      outside,
      oldPath,
      local,
      dir,
      stageDir: join(dir, MOVE_IN_STAGE),
      manifestFile: join(dir, "manifest.ndjson"),
      ledgerFile: join(dir, MOVE_IN_LEDGER),
      prevStageDir: join(dir, `${MOVE_IN_STAGE}.prev`),
      prevLedgerFile: join(dir, "ledger.prev.ndjson"),
      fetchScope,
    };
  };
  // Only the state root's place matters to moveAlwaysFetch; it is the same
  // path on both boxes (the redeem refuses otherwise).
  const homeTarget = targetOf(
    deps.home,
    null,
    null,
    createMoveScope({
      home: deps.home,
      stateRoot: deps.stateRoot,
      codeDir: null,
      backupDir: null,
    }),
  );
  const outsideTarget = (f: OutsideListed, i: number): PassTarget => {
    const local = localOf(f.path);
    return targetOf(local, i, f.path, createMoveOutsideScope(local));
  };
  const deviceOf = (path: string): number => {
    if (deps.deviceOf) return deps.deviceOf(path);
    for (let p = path; ; p = dirname(p)) {
      try {
        return lstatSync(p).dev;
      } catch {
        if (p === dirname(p)) return 0;
      }
    }
  };
  /** Slice 5b: where the old office's folder `path` lands here, checked. The
   *  answer names the old office's path; `at`, `create` and `command` name
   *  this box's. */
  const checkFolder = (path: string, mode: number): MoveInFolderCheck => {
    const own = deps.box().osUser ?? processOsUser();
    return {
      ...checkMoveInFolder(localOf(path), {
        home: deps.home,
        uid: own.uid,
        gid: own.gid,
        user: own.user,
        group: own.group,
        mode,
        ...(deps.folderFs ? { fs: deps.folderFs } : {}),
      }),
      path,
    };
  };

  const readState = (): MoveInState | null => {
    let text: string;
    try {
      text = readFileSync(stateFile, "utf8");
    } catch {
      return null;
    }
    try {
      const v = JSON.parse(text) as MoveInState;
      return isObject(v) && typeof v.phase === "string" ? v : null;
    } catch {
      console.error("[move-in] the state file does not parse; ignored");
      return null;
    }
  };

  /** A finish runs (from its first line): a cancel waits for its end. */
  let finishRunning = false;
  /** Phase `moved` (slice 2c-1): terminal, in the same state file. */
  let moved: MoveInMovedState | null = null;
  let state: MoveInState | null = null;
  const loadState = () => {
    const s = readState();
    if (s && (s as { phase: string }).phase === "moved") {
      moved = s as unknown as MoveInMovedState;
      state = null;
    } else {
      moved = null;
      state = s;
    }
  };
  loadState();
  /** The redeem in flight (in memory only). */
  let pairing: { oldOrigin: string } | null = null;
  /** Set before the first await of a start or a lock (D9). */
  let busy = false;
  let progress: MoveInProgress | null = null;
  let job: Promise<void> | null = null;
  let jobAbort: AbortController | null = null;
  /** Slice 4: the live pass, in its own slot (a preflight again may run
   *  next to it). */
  let liveJob: Promise<void> | null = null;
  let liveAbort: AbortController | null = null;
  /** The lock stops the live pass: it ends `stopped`, not `failed`. */
  let liveStopping = false;
  let liveProgress: MoveInProgress | null = null;
  /** A cancel bumps it; a job of an older generation writes nothing. */
  let generation = 0;

  const writeState = (next: MoveInState | null) => {
    state = next;
    if (!next) {
      rmSync(stateFile, { force: true });
      return;
    }
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, stateFile);
  };

  /** The live pass of the state now (phases preflight and confirm only). */
  const currentLive = (): MoveInLive | undefined =>
    state && (state.phase === "preflight" || state.phase === "confirm")
      ? state.live
      : undefined;

  /** C6: the one writer of `preflight` and `confirm`: `live` comes from the
   *  state now, never from a snapshot taken before an await. */
  const writePre = (
    next:
      | Extract<MoveInState, { phase: "preflight" }>
      | Extract<MoveInState, { phase: "confirm" }>,
  ) => {
    const { live: _ignored, ...rest } = next;
    const live = currentLive();
    writeState(live ? { ...rest, live } : rest);
  };

  /** C6: the one writer of `live`. Written only in preflight and confirm,
   *  and only for the current generation. */
  const writeLive = (gen: number, live: MoveInLive) => {
    if (gen !== generation || !state) return;
    if (state.phase !== "preflight" && state.phase !== "confirm") return;
    writeState({ ...state, live });
  };

  const pairingOf = (s: MoveInState): MoveInPairing => ({
    oldOrigin: s.oldOrigin,
    session: s.session,
    sessionExpiresAt: s.sessionExpiresAt,
    key: s.key,
    pairedAt: s.pairedAt,
    by: s.by,
    office: s.office,
    ...(s.outside ? { outside: s.outside } : {}),
  });

  const lockedAtOf = (s: MoveInState): number | null =>
    "lockedAt" in s && typeof s.lockedAt === "number" ? s.lockedAt : null;
  /** Whether the lock may have reached the old office: a cancel then leaves
   *  it locked until its owner enters the move code there. */
  const oldOfficeLocked = (s: MoveInState): boolean =>
    lockedAtOf(s) !== null || LOCKED_PHASES.has(s.phase);

  // ---- requests ----

  const signalFor = (job: AbortSignal | null, ms: number) => {
    const t = AbortSignal.timeout(ms);
    return job ? AbortSignal.any([job, t]) : t;
  };

  /** One JSON request to the old office. */
  const requestJson = async (
    origin: string,
    method: "GET" | "POST",
    path: string,
    opts: { session?: string; body?: unknown; signal?: AbortSignal | null },
  ): Promise<{ status: number; body: unknown }> => {
    const signal = signalFor(opts.signal ?? null, deps.timing.requestMs);
    const headers: Record<string, string> = {};
    if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const run = async () => {
      let res: Response;
      try {
        res = await deps.fetch(`${origin}${path}`, {
          method,
          headers,
          ...(opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
          redirect: "error",
          signal,
        });
      } catch (err) {
        throw unreachable(err);
      }
      const text = await readCapped(res, deps.limits.jsonMaxBytes);
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    };
    return withTimeout(run(), deps.timing.requestMs, `${method} ${path}`);
  };

  /** A sealed stream of the old office, opened and idle-limited. */
  const requestSealed = async (
    s: MoveInPairing,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    ctx: MoveSealContext,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<Uint8Array>> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${s.session}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Aborted when the headers do not come in time; after them the body's
    // idle limit takes over (a time limit would cut a long batch).
    const request = new AbortController();
    const requestSignal = AbortSignal.any([signal, request.signal]);
    const run = async () => {
      try {
        return await deps.fetch(`${s.oldOrigin}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: requestSignal,
        });
      } catch (err) {
        throw unreachable(err);
      }
    };
    const res = await withTimeout(
      run(),
      deps.timing.requestMs,
      `${method} ${path}`,
      () => request.abort(),
    );
    if (res.status !== 200) {
      const text = await readCapped(res, deps.limits.jsonMaxBytes).catch(
        () => "",
      );
      let b: unknown = null;
      try {
        b = JSON.parse(text);
      } catch {
        b = null;
      }
      throw answerFail(res.status, b);
    }
    if (!res.body)
      throw new MoveInFail("old_office_empty", "The old office sent no body.");
    return openMoveStream(
      Buffer.from(s.key, "base64url"),
      ctx,
      idleLimited(res.body, deps.timing.idleMs, requestSignal),
    );
  };

  /** Polls a job route of the old office until `done` gives a value. */
  const poll = async <T>(
    s: MoveInPairing,
    path: string,
    waitMs: number,
    what: string,
    signal: AbortSignal,
    done: (body: JsonObject) => T | null,
  ): Promise<T> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await requestJson(s.oldOrigin, "GET", path, {
        session: s.session,
        signal,
      });
      if (r.status !== 200) throw answerFail(r.status, r.body);
      if (!isObject(r.body))
        throw new MoveInFail(
          "old_office_answer",
          "The old office's answer does not parse.",
        );
      if (r.body.state === "failed")
        throw new MoveInFail(
          `${what}_failed`,
          typeof r.body.error === "string"
            ? r.body.error
            : `The old office's ${what} failed.`,
        );
      const v = done(r.body);
      if (v !== null) return v;
      if (Date.now() > deadline)
        throw new MoveInFail(
          `${what}_timeout`,
          `The old office's ${what} took too long.`,
        );
      await sleep(deps.timing.pollMs, signal);
    }
  };

  // ---- jobs ----

  const runJob = (
    fn: (signal: AbortSignal, gen: number) => Promise<void>,
  ): void => {
    const ctl = new AbortController();
    const gen = generation;
    jobAbort = ctl;
    const p = (async () => {
      try {
        await fn(ctl.signal, gen);
      } catch (err) {
        if (gen === generation) fail(err);
        else if (!(err instanceof MoveInFail && err.code === "cancelled"))
          console.error(
            "[move-in] a cancelled job ended with:",
            errMessage(err),
          );
      }
    })()
      .catch((err) => {
        console.error("[move-in] the job failed:", errMessage(err));
      })
      .finally(() => {
        if (job === p) {
          job = null;
          jobAbort = null;
          progress = null;
        }
      });
    job = p;
  };

  /** The current state as `failed`. */
  const fail = (err: unknown) => {
    if (!state) return;
    const f =
      err instanceof MoveInFail
        ? err
        : new MoveInFail("move_in_failed", errMessage(err));
    console.error(
      `[move-in] failed in ${state.phase}: ${f.code}: ${f.message}`,
    );
    const lockedAt = lockedAtOf(state);
    const mayBeLocked = oldOfficeLocked(state);
    // The live pass stops with the move-in it belongs to.
    liveAbort?.abort();
    try {
      writeState({
        phase: "failed",
        ...pairingOf(state),
        lockedAt,
        error: { code: f.code, message: f.message },
        retryable: f.retryable ?? mayBeLocked,
        failedAt: deps.now().getTime(),
      });
    } catch (writeErr) {
      console.error(
        "[move-in] could not record the failure:",
        errMessage(writeErr),
      );
    }
  };

  /** Writes `next` only for a job of the current generation. */
  const setFor = (gen: number, next: MoveInState) => {
    if (gen !== generation)
      throw new MoveInFail("cancelled", "The move-in was cancelled.");
    if (next.phase === "preflight" || next.phase === "confirm") writePre(next);
    else writeState(next);
  };

  /** The old office's preflight: start it, then poll it to `confirm`. */
  const preflightJob = (pair: MoveInPairing, preflightId: string) =>
    runJob(async (signal, gen) => {
      const result = await poll(
        pair,
        `/api/move/preflight/${encodeURIComponent(preflightId)}`,
        deps.timing.preflightWaitMs,
        "preflight",
        signal,
        (b) => (b.state === "ready" && isObject(b.result) ? b.result : null),
      );
      setFor(gen, {
        phase: "confirm",
        ...pair,
        preflightId,
        preflight: result,
      });
      // Slice 4: the live pass starts at the first confirm of a pairing.
      if (!currentLive() && !liveJob) startLive(pair);
    });

  /** Slice 4: the live pass, while the old office still runs. Ends
   *  `ready` (then the preflight again, N3, so the Lock works at once with a
   *  fresh preflight), `stopped` (the lock), `unsupported` (an old office of
   *  an older release) or `failed`. */
  const startLive = (pair: MoveInPairing) => {
    const ctl = new AbortController();
    const gen = generation;
    liveAbort = ctl;
    liveStopping = false;
    const startedAt = deps.now().getTime();
    let manifestId: string | undefined;
    // Slice 5b: the folders of the preflight the owner sees now.
    const startChecked =
      state?.phase === "confirm" ? preflightOutside(state.preflight).move : [];
    const liveChecked = () =>
      state?.phase === "confirm"
        ? preflightOutside(state.preflight).move
        : startChecked;
    const set = (live: Omit<MoveInLive, "startedAt">) =>
      writeLive(gen, {
        ...live,
        startedAt,
        ...(manifestId ? { manifestId } : {}),
      });
    const p = (async () => {
      set({ phase: "manifest" });
      try {
        const started = await requestJson(
          pair.oldOrigin,
          "POST",
          "/api/move/manifest",
          { session: pair.session, signal: ctl.signal },
        );
        if (started.status === 404) {
          set({ phase: "unsupported", finishedAt: deps.now().getTime() });
          return;
        }
        if (
          started.status !== 202 ||
          !isObject(started.body) ||
          typeof started.body.id !== "string"
        )
          throw answerFail(started.status, started.body);
        manifestId = started.body.id;
        set({ phase: "manifest" });
        const summary = await poll(
          pair,
          `/api/move/manifest/${encodeURIComponent(manifestId)}`,
          deps.timing.manifestWaitMs,
          "manifest",
          ctl.signal,
          (b) => (b.state === "ready" ? b : null),
        );
        await runPass(pair, manifestId, summary, {
          live: true,
          checked: liveChecked(),
          signal: ctl.signal,
          gen,
          started: (prog) => {
            liveProgress = prog;
            set({ phase: "copying" });
          },
        });
        const ready = {
          phase: "ready" as const,
          finishedAt: deps.now().getTime(),
        };
        // N3: a fresh preflight, unless one runs or the owner already acts.
        if (gen === generation && !job && !busy && state?.phase === "confirm") {
          try {
            const preflightId = await startPreflight(pair, ctl.signal);
            if (
              gen === generation &&
              !job &&
              !busy &&
              state?.phase === "confirm"
            ) {
              set(ready);
              setFor(gen, { phase: "preflight", ...pair, preflightId });
              preflightJob(pair, preflightId);
              return;
            }
          } catch (err) {
            console.warn(
              "[move-in] the preflight after the live pass failed:",
              errMessage(err),
            );
          }
        }
        set(ready);
      } catch (err) {
        if (gen !== generation) return;
        const finishedAt = deps.now().getTime();
        if (liveStopping) set({ phase: "stopped", finishedAt });
        else {
          const f = unreachable(err);
          console.error(
            `[move-in] the live pass failed: ${f.code}: ${f.message}`,
          );
          set({
            phase: "failed",
            finishedAt,
            error: { code: f.code, message: f.message },
          });
        }
      }
    })()
      .catch((err) => {
        console.error("[move-in] the live pass failed:", errMessage(err));
      })
      .finally(() => {
        if (liveJob === p) {
          liveJob = null;
          liveAbort = null;
          liveProgress = null;
        }
      });
    liveJob = p;
  };

  const startPreflight = async (
    pair: MoveInPairing,
    signal: AbortSignal | null,
  ): Promise<string> => {
    const r = await requestJson(pair.oldOrigin, "POST", "/api/move/preflight", {
      session: pair.session,
      signal,
    });
    if (r.status !== 202 || !isObject(r.body) || typeof r.body.id !== "string")
      throw answerFail(r.status, r.body);
    return r.body.id;
  };

  /** From the lock's answer to `staged` (or `incomplete`). */
  const pullJob = (pair: MoveInPairing, lockedAt: number) =>
    runJob((signal, gen) => pull(pair, lockedAt, signal, gen));

  const pull = async (
    pair: MoveInPairing,
    lockedAt: number,
    signal: AbortSignal,
    gen: number,
  ): Promise<void> => {
    // The old office restarts into the MOVE-locked server.
    setFor(gen, { phase: "waiting", ...pair, lockedAt });
    const back = Date.now() + deps.timing.restartWaitMs;
    for (;;) {
      let st: string | null = null;
      try {
        const r = await requestJson(pair.oldOrigin, "GET", "/api/move/status", {
          session: pair.session,
          signal,
        });
        if (
          r.status === 200 &&
          isObject(r.body) &&
          typeof r.body.state === "string"
        )
          st = r.body.state;
        else if (r.status === 401) throw answerFail(r.status, r.body);
      } catch (err) {
        if (err instanceof MoveInFail && err.status === 401) throw err;
        if (signal.aborted) throw err;
        // Down while it restarts.
      }
      if (st === "move") break;
      if (st !== null && st !== "paired")
        throw new MoveInFail(
          "old_office_state",
          `The old office is in the state "${st}", not locked for the move.`,
          false,
        );
      if (Date.now() > back)
        throw new MoveInFail(
          "old_office_not_back",
          "The old office did not come back locked for the move.",
        );
      await sleep(deps.timing.pollMs, signal);
    }

    // The manifest.
    const started = await requestJson(
      pair.oldOrigin,
      "POST",
      "/api/move/manifest",
      {
        session: pair.session,
        signal,
      },
    );
    if (
      started.status !== 202 ||
      !isObject(started.body) ||
      typeof started.body.id !== "string"
    )
      throw answerFail(started.status, started.body);
    const manifestId = started.body.id;
    setFor(gen, { phase: "manifest", ...pair, lockedAt, manifestId });
    const summary = await poll(
      pair,
      `/api/move/manifest/${encodeURIComponent(manifestId)}`,
      deps.timing.manifestWaitMs,
      "manifest",
      signal,
      (b) => (b.state === "ready" ? b : null),
    );
    // Slice 2c-1: the swap and the report keep these.
    const manifestFacts: MoveInManifestFacts = {
      excluded: Array.isArray(summary.excluded)
        ? summary.excluded.filter(
            (u): u is MoveExcludedUnit =>
              isObject(u) &&
              typeof u.unit === "string" &&
              typeof u.entries === "number" &&
              typeof u.bytes === "number",
          )
        : [],
      secretCount:
        typeof summary.secretCount === "number" ? summary.secretCount : 0,
      units: Array.isArray(summary.units)
        ? summary.units.filter(
            (u): u is AgentUnit => isObject(u) && typeof u.name === "string",
          )
        : [],
      // Slice 5b: at this box's path, for the swap.
      outside: outsideOfSummary(summary).map((f) => ({
        path: localOf(f.path),
        mode: f.mode,
        mtime: f.mtime,
      })),
    };
    const unreadable = Array.isArray(summary.unreadable)
      ? summary.unreadable.filter((p): p is string => typeof p === "string")
      : [];

    const { stages, prog } = await runPass(pair, manifestId, summary, {
      live: false,
      checked: pair.outside?.move ?? [],
      signal,
      gen,
      started: (prog) => {
        progress = prog;
        setFor(gen, {
          phase: "pulling",
          ...pair,
          lockedAt,
          manifestId,
          progress: { ...prog },
        });
      },
    });

    setFor(gen, {
      phase: "checking",
      ...pair,
      lockedAt,
      manifestId,
      progress: { ...prog },
    });
    const result: MoveStageCheck = {
      complete: true,
      files: 0,
      bytes: 0,
      missing: [],
      changed: [],
    };
    // Slice 5b: a folder outside the home names its paths absolute, as on
    // the old office.
    const shown = (t: PassTarget, p: string) =>
      t.oldPath === null ? p : join(t.oldPath, p);
    for (const { target, stage } of stages) {
      await stage.finish(manifestEntries(target.manifestFile));
      const r = await stage.check(manifestEntries(target.manifestFile));
      result.files += r.files;
      result.bytes += r.bytes;
      for (const m of r.missing)
        result.missing.push({ ...m, path: shown(target, m.path) });
      for (const c of r.changed) result.changed.push(shown(target, c));
    }
    for (const p of unreadable)
      result.missing.push({
        path: p,
        reason: "The old office could not read it.",
      });
    outsideOfSummary(summary).forEach((f, i) => {
      const t = outsideTarget(f, i);
      const list = Array.isArray(f.unreadable) ? f.unreadable : [];
      for (const p of list)
        if (typeof p === "string")
          result.missing.push({
            path: shown(t, p),
            reason: "The old office could not read it.",
          });
    });
    result.complete = result.missing.length === 0;
    if (result.complete) {
      setFor(gen, {
        phase: "staged",
        ...pair,
        lockedAt,
        manifestId,
        stagedAt: deps.now().getTime(),
        result,
        manifest: manifestFacts,
      });
      try {
        deps.audit("office.moveInStaged", pair.by);
      } catch (err) {
        console.error(
          "[move-in] could not write the audit row:",
          errMessage(err),
        );
      }
    } else {
      setFor(gen, {
        phase: "incomplete",
        ...pair,
        lockedAt,
        manifestId,
        result,
        manifest: manifestFacts,
      });
    }
  };

  /** A ledger read in step with a manifest (both in walk order): the row of
   *  a path, or null. Flat memory: one row at a time. */
  const ledgerJoin = (file: string) => {
    const it = readMoveLedger(file)[Symbol.asyncIterator]();
    let cur: MoveLedgerRow | null | undefined;
    return async (path: string): Promise<MoveLedgerRow | null> => {
      for (;;) {
        if (cur === undefined) {
          const r = await it.next();
          cur = r.done ? null : r.value;
        }
        if (cur === null) return null;
        const c = compareMoveWalkOrder(cur.p, path);
        if (c > 0) return null;
        const row = cur;
        cur = undefined;
        if (c === 0) return row;
      }
    };
  };

  /** Whether an earlier pass's copy of a file may stay ([R]: the manifest
   *  values that pass recorded against this manifest's, never a stat). */
  const keepable = (
    t: PassTarget,
    e: MoveManifestEntry,
    row: MoveLedgerRow | null,
  ) =>
    row !== null &&
    e.t === "f" &&
    e.q !== 1 &&
    row.s === e.s &&
    row.m === e.m &&
    !moveAlwaysFetch(t.fetchScope, e.p);

  /** Slice 5b: the outside folders of a ready manifest answer, as listed. */
  const outsideOfSummary = (summary: JsonObject): OutsideListed[] =>
    Array.isArray(summary.outside)
      ? summary.outside.filter(
          (f): f is OutsideListed =>
            isObject(f) &&
            typeof f.path === "string" &&
            typeof f.mode === "number" &&
            typeof f.mtime === "number",
        )
      : [];

  /** Slice 5b: before a pass writes anything: the manifest's folders are the
   *  checked ones (C4), each one can land here, the stage of a folder this
   *  pass does not list goes (C5), and the folders to make are recorded,
   *  then made. */
  const prepareOutside = (
    listed: OutsideListed[],
    checked: { path: string; mode: number }[],
  ): void => {
    const a = listed.map((f) => f.path).sort();
    const b = checked.map((f) => f.path).sort();
    if (a.length !== b.length || a.some((p, i) => p !== b[i]))
      throw new MoveInFail(
        "outside_folders_changed",
        "The old office lists other folders outside its home than the ones checked. Try again.",
        true,
      );
    const checks = listed.map((f) => checkFolder(f.path, f.mode));
    const blocked = checks.filter((c) => !c.ok);
    if (blocked.length > 0)
      throw new MoveInFail(
        "outside_folders_blocked",
        blockedMessage(blocked),
        true,
        502,
        { checks },
      );
    dropMoveInOutside(
      deps.home,
      listed.map((f) => localOf(f.path)),
    );
    const rec = readMoveInOutside(deps.home);
    const created = new Set(rec.created);
    const staged = new Set(rec.staged);
    const toMake: string[] = [];
    for (const c of checks)
      if (c.ok) {
        // `create` names this box's paths already.
        for (const part of c.create) {
          created.add(part);
          toMake.push(part);
        }
      }
    for (const f of listed) staged.add(localOf(f.path));
    // The record first: a cancel then removes what a crash left.
    writeMoveInOutside(deps.home, {
      staged: [...staged],
      created: [...created],
    });
    // Two folders can share the parts to make; each is made once, top down.
    for (const part of new Set(toMake)) mkdirSync(part, { mode: 0o755 });
  };

  /** One pass (slice 4: the live pass, or the final pass after the lock):
   *  the manifest data, the free space, then pass 1 and the batches on a
   *  new stage that keeps what the last pass copied whole and still
   *  matches. Writes the ledger whatever the end, unless cancelled. Slice
   *  5b: the home, then each folder outside it, each with its own stage. */
  const runPass = async (
    pair: MoveInPairing,
    manifestId: string,
    summary: JsonObject,
    opts: {
      live: boolean;
      /** The folders the owner's check covered (C4). */
      checked: { path: string; mode: number }[];
      signal: AbortSignal;
      gen: number;
      started(prog: MoveInProgress): void;
    },
  ): Promise<{
    stages: { target: PassTarget; stage: MoveStage }[];
    prog: MoveInProgress;
  }> => {
    const { signal, gen } = opts;
    if (gen !== generation) throw new MoveInFail("cancelled", "Cancelled.");
    const listed = outsideOfSummary(summary);
    prepareOutside(listed, opts.checked);
    const targets: PassTarget[] = [
      homeTarget,
      ...listed.map((f, i) => outsideTarget(f, i)),
    ];
    for (const t of targets) {
      mkdirSync(t.dir, { recursive: true, mode: 0o700 });
      // A pass a crash cut left these.
      removeMoveTree(t.prevStageDir);
      rmSync(t.prevLedgerFile, { force: true });
      const fd = openSync(t.manifestFile, "w", 0o600);
      const q = t.outside === null ? "" : `?outside=${t.outside}`;
      try {
        for await (const chunk of await requestSealed(
          pair,
          "GET",
          `/api/move/manifest/${encodeURIComponent(manifestId)}/data${q}`,
          undefined,
          {
            route: "manifest",
            manifestId,
            batch: 0,
            itemsHash: "",
            ...(t.outside === null ? {} : { outside: t.outside }),
          },
          signal,
        )) {
          let off = 0;
          while (off < chunk.byteLength)
            off += writeSync(fd, chunk, off, chunk.byteLength - off);
        }
      } finally {
        closeSync(fd);
      }
      if (gen !== generation) throw new MoveInFail("cancelled", "Cancelled.");
    }

    // D5: whole blocks and inodes, before the first batch, per device (the
    // home's first); a file the last pass copied and that stays needs
    // neither.
    const devices = new Map<
      number,
      { fs: MoveInStatfs; blocks: number; entries: number }
    >();
    const reuse = new Map<PassTarget, boolean>();
    let entries = 0;
    for (const t of targets) {
      const dev = deviceOf(t.local);
      let d = devices.get(dev);
      if (!d) {
        d = { fs: deps.statfs(t.local), blocks: 0, entries: 0 };
        devices.set(dev, d);
      }
      const bsize = Math.max(1, d.fs.bsize);
      // The last pass's stage and ledger, when both are there.
      const again = existsSync(t.ledgerFile) && existsSync(t.stageDir);
      reuse.set(t, again);
      const spaceJoin = again ? ledgerJoin(t.ledgerFile) : null;
      for await (const e of manifestEntries(t.manifestFile)) {
        entries++;
        if (e.t === "f") {
          if (spaceJoin && keepable(t, e, await spaceJoin(e.p))) continue;
          d.blocks += Math.ceil(e.s / bsize) * bsize;
        } else if (e.t === "d") d.blocks += bsize;
        d.entries++;
      }
    }
    for (const d of devices.values()) {
      const bsize = Math.max(1, d.fs.bsize);
      const needBytes = d.blocks + Math.max(d.blocks * 0.1, GIB);
      const haveBytes = d.fs.bavail * bsize;
      const needInodes = d.entries + Math.ceil(d.entries * 0.1);
      if (haveBytes < needBytes)
        throw new MoveInFail(
          "no_space",
          `Not enough disk space: the copy needs ${Math.ceil(needBytes)} bytes, and ${haveBytes} are free. Free some space, then pull again.`,
          true,
        );
      if (d.fs.ffree < needInodes)
        throw new MoveInFail(
          "no_space",
          `The disk can hold ${d.fs.ffree} more files, and the copy needs ${needInodes}. Free some, then pull again.`,
          true,
        );
    }
    if (gen !== generation) throw new MoveInFail("cancelled", "Cancelled.");

    const totalBytes =
      (typeof summary.totalBytes === "number" ? summary.totalBytes : 0) +
      listed.reduce(
        (n, f) => n + (typeof f.totalBytes === "number" ? f.totalBytes : 0),
        0,
      );
    const prog: MoveInProgress = {
      entries,
      totalBytes,
      filesDone: 0,
      bytesDone: 0,
      batchesDone: 0,
      batchesTotal: 0,
      retries: 0,
      filesKept: 0,
      bytesKept: 0,
    };
    const stages: { target: PassTarget; stage: MoveStage }[] = [];
    opts.started(prog);
    for (const t of targets) {
      const again = reuse.get(t) === true;
      if (again) {
        renameSync(t.stageDir, t.prevStageDir);
        renameSync(t.ledgerFile, t.prevLedgerFile);
      } else {
        rmSync(t.ledgerFile, { force: true });
        removeMoveTree(t.stageDir);
      }
      const stage = createMoveStage(t.stageDir);
      stages.push({ target: t, stage });
      try {
        await pullBatches(pair, manifestId, t, stage, signal, gen, {
          live: opts.live,
          prev: again
            ? { root: t.prevStageDir, ledger: t.prevLedgerFile }
            : null,
          prog,
        });
      } finally {
        // What the batches wrote stays usable for the next pass, also after
        // a failure or a stop; never after a cancel (its folder is gone).
        if (gen === generation)
          try {
            await stage.writeLedger(
              manifestEntries(t.manifestFile),
              t.ledgerFile,
            );
          } catch (err) {
            console.error(
              "[move-in] could not write the ledger:",
              errMessage(err),
            );
            rmSync(t.ledgerFile, { force: true });
          }
        removeMoveTree(t.prevStageDir);
        rmSync(t.prevLedgerFile, { force: true });
      }
    }
    return { stages, prog };
  };

  /** Pass 1 over the manifest, and the batches it plans. */
  const pullBatches = async (
    pair: MoveInPairing,
    manifestId: string,
    t: PassTarget,
    stage: MoveStage,
    signal: AbortSignal,
    gen: number,
    opts: {
      /** The live pass asks for no SQLite file. */
      live: boolean;
      prev: { root: string; ledger: string } | null;
      prog: MoveInProgress;
    },
  ): Promise<void> => {
    const { batchBytes, batchItemsJsonBytes, concurrency } = deps.limits;
    let n = 0;
    let active = 0;
    let firstError: unknown = null;
    const slots: (() => void)[] = [];
    const running = new Set<Promise<void>>();

    const launch = async (batch: MoveStageBatch) => {
      while (active >= concurrency && firstError === null)
        await new Promise<void>((r) => slots.push(r));
      if (firstError !== null) return;
      active++;
      const p = runBatch(pair, manifestId, t, stage, batch, signal, opts.prog)
        .catch((err) => {
          if (firstError === null) firstError = err;
        })
        .finally(() => {
          active--;
          running.delete(p);
          slots.shift()?.();
        });
      running.add(p);
    };

    let items: MoveStageItem[] = [];
    let bytes = 0;
    let json = 2;
    const flush = async () => {
      if (items.length === 0) return;
      const batch = { n: n++, items };
      items = [];
      bytes = 0;
      json = 2;
      opts.prog.batchesTotal++;
      await launch(batch);
    };
    const itemJson = (i: { path: string; offset?: number; length?: number }) =>
      JSON.stringify(i).length + 1;

    const prevJoin = opts.prev ? ledgerJoin(opts.prev.ledger) : null;
    try {
      for await (const e of manifestEntries(t.manifestFile)) {
        if (firstError !== null || gen !== generation || signal.aborted) break;
        if (e.t === "f" && prevJoin && opts.prev) {
          const row = await prevJoin(e.p);
          if (
            row &&
            keepable(t, e, row) &&
            stage.keep(e, opts.prev.root, row)
          ) {
            opts.prog.filesKept = (opts.prog.filesKept ?? 0) + 1;
            opts.prog.bytesKept = (opts.prog.bytesKept ?? 0) + e.s;
            continue;
          }
        }
        stage.prepare(e);
        if (e.t !== "f") continue;
        // The running office takes no snapshot: the final pass fetches every
        // SQLite file.
        if (opts.live && e.q === 1) continue;
        if (e.q !== 1 && e.s > batchBytes) {
          // A big file: one range per batch.
          await flush();
          for (let offset = 0; offset < e.s; offset += batchBytes) {
            items = [
              {
                path: e.p,
                offset,
                length: Math.min(batchBytes, e.s - offset),
                entry: e,
              },
            ];
            await flush();
            if (firstError !== null) break;
          }
          continue;
        }
        const size = itemJson({ path: e.p });
        if (
          items.length > 0 &&
          (bytes + e.s > batchBytes || json + size > batchItemsJsonBytes)
        )
          await flush();
        items.push({ path: e.p, entry: e });
        bytes += e.s;
        json += size;
      }
      if (firstError === null) await flush();
    } catch (err) {
      // A manifest the stage refuses: the batches in flight end first.
      if (firstError === null) firstError = err;
    }
    while (running.size > 0) await Promise.all([...running]);
    if (gen !== generation || (signal.aborted && firstError === null))
      throw new MoveInFail("cancelled", "Cancelled.");
    if (firstError instanceof MoveStageError)
      throw new MoveInFail("manifest_refused", firstError.message, true);
    if (firstError !== null) throw unreachable(firstError);
  };

  /** One batch, run again on a failure up to batchAttempts. */
  const runBatch = async (
    pair: MoveInPairing,
    manifestId: string,
    t: PassTarget,
    stage: MoveStage,
    batch: MoveStageBatch,
    signal: AbortSignal,
    progress: MoveInProgress,
  ): Promise<void> => {
    const items = batch.items.map((i) => ({
      path: i.path,
      ...(i.offset !== undefined ? { offset: i.offset } : {}),
      ...(i.length !== undefined ? { length: i.length } : {}),
    }));
    const ctx: MoveSealContext = {
      route: "batch",
      manifestId,
      batch: batch.n,
      itemsHash: moveItemsHash(items),
      ...(t.outside === null ? {} : { outside: t.outside }),
    };
    let last: unknown = null;
    for (let attempt = 1; attempt <= deps.limits.batchAttempts; attempt++) {
      if (signal.aborted) throw new MoveInFail("cancelled", "Cancelled.");
      try {
        const plain = await requestSealed(
          pair,
          "POST",
          "/api/move/batch",
          {
            manifestId,
            batch: batch.n,
            items,
            ...(t.outside === null ? {} : { outside: t.outside }),
          },
          ctx,
          signal,
        );
        const results = await stage.writeBatch(batch, readMoveRecords(plain));
        progress.batchesDone++;
        for (const r of results)
          if (!("error" in r)) {
            progress.bytesDone += r.bytes;
            if ((r.offset ?? 0) === 0) progress.filesDone++;
          }
        return;
      } catch (err) {
        last = err;
        // A refusal of the session or the state does not get better.
        if (
          err instanceof MoveInFail &&
          (err.status === 401 || err.status === 409)
        )
          throw err;
        if (signal.aborted) throw err;
        progress.retries++;
        console.warn(
          `[move-in] batch ${batch.n} attempt ${attempt} failed:`,
          errMessage(err),
        );
      }
    }
    throw new MoveInFail(
      "batch_failed",
      `A part of the copy failed ${deps.limits.batchAttempts} times: ${errMessage(last)}`,
      true,
    );
  };

  // ---- answers ----

  const okStatus = (status: 200 | 202): MoveInAnswer => ({
    ok: true,
    status,
    body: api.status(),
  });

  const refuse = (
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): MoveInAnswer => ({
    ok: false,
    status,
    code,
    message,
    ...(extra ? { extra } : {}),
  });

  const fromFail = (err: unknown): MoveInAnswer => {
    const f = unreachable(err);
    return refuse(f.status, f.code, f.message, f.extra);
  };

  const notFresh = (): MoveInAnswer | null => {
    const fresh = checkMoveInFresh(deps.freshness());
    return fresh.fresh
      ? null
      : refuse(
          409,
          "office_not_fresh",
          "This office already has members, agents, apps or tasks of its own. A move goes only into a new office.",
          { reasons: fresh.reasons },
        );
  };

  const movedRefusal = () =>
    refuse(409, "move_in_done", "The move into this office is done.");

  const restartRefusal = (): MoveInAnswer | null => {
    const policy = deps.box().restartPolicy;
    return policy === "always"
      ? null
      : refuse(
          409,
          "restart_policy",
          "This office's service does not restart by itself (it needs Restart=always), so it cannot take a move.",
          { restart: policy },
        );
  };

  /** Why this office cannot take a move in now: the start's refusals before
   *  the redeem, in its order. The status in phase none shows the same answer
   *  (slice 2c-2), so the owner learns it before minting a code. */
  const startBlocker = (): MoveInStartBlocker | null => {
    const answer = notFresh() ?? restartRefusal();
    if (answer && !answer.ok)
      return {
        code: answer.code,
        message: answer.message,
        ...(answer.extra ? { extra: answer.extra } : {}),
      };
    const ours = deps.ours();
    const rootRefusal = moveStateRootRefusal(ours);
    return rootRefusal
      ? {
          code: rootRefusal,
          message: STATE_ROOT_REFUSAL_MESSAGE,
          extra: { ours },
        }
      : null;
  };

  const swapRefusalMessage = (r: MoveInSwapRefusal): string => {
    switch (r.code) {
      case "home_too_big":
        return `This office's home has more than ${r.entries} entries. A move goes only into a new office.`;
      case "home_has_mounts":
        return `These folders are on another disk than the home, so the move cannot replace them: ${r.paths.join(", ")}.`;
      case "account_clash":
        return "A member of the old office has the same id as this office's owner.";
      case "swap_unreadable":
        return `The move cannot read this machine's files: ${r.message}`;
      case "outside_folder_not_empty":
        return `${r.path} holds files that are not the move's copy. Move them away, then finish again.`;
    }
  };

  /** The old office's state after a `done` that did not answer 200: its
   *  state, "gone" (it no longer knows the session), or null (no answer). */
  const oldStateAfterDone = async (
    pair: MoveInPairing,
  ): Promise<string | null> => {
    try {
      const r = await requestJson(pair.oldOrigin, "GET", "/api/move/status", {
        session: pair.session,
      });
      if (r.status === 401) return "gone";
      if (
        r.status === 200 &&
        isObject(r.body) &&
        typeof r.body.state === "string"
      )
        return r.body.state;
      return null;
    } catch {
      return null;
    }
  };

  const api: MoveIn = {
    async start({ code, by }) {
      if (moved) return movedRefusal();
      if (busy || job || liveJob || pairing)
        return refuse(
          409,
          "move_in_running",
          "A move into this office is already running.",
        );
      if (state && !(state.phase === "failed" && !state.retryable))
        return refuse(
          409,
          "move_in_running",
          "A move into this office is already running.",
        );
      busy = true;
      try {
        const parsed = parseMoveCode(code);
        let origin: string | null = null;
        try {
          const u = parsed ? new URL(parsed.origin) : null;
          if (u && (u.protocol === "https:" || u.protocol === "http:"))
            origin = u.origin;
        } catch {
          origin = null;
        }
        if (!parsed || !origin)
          return refuse(400, "move_code_malformed", "This is not a move code.");
        // Freshness, the restart policy (the swap needs a restart) and the
        // state root, before the old office is asked anything.
        const blocker = startBlocker();
        if (blocker)
          return refuse(409, blocker.code, blocker.message, blocker.extra);
        const ours = deps.ours();
        pairing = { oldOrigin: origin };
        // A cancel while a request is in flight wins: nothing is written.
        const gen = generation;
        const cancelled = () =>
          refuse(409, "cancelled", "The move-in was cancelled.");
        const r = await requestJson(origin, "POST", "/api/move/redeem", {
          body: { token: parsed.token, newBox: ours },
        });
        if (generation !== gen) return cancelled();
        if (r.status !== 200) return fromFail(answerFail(r.status, r.body));
        const b = isObject(r.body) ? r.body : {};
        const office = asBox(b.office);
        if (
          typeof b.session !== "string" ||
          typeof b.sessionExpiresAt !== "number"
        )
          return refuse(
            502,
            "old_office_answer",
            "The old office's answer does not parse.",
          );
        if (!office)
          return refuse(
            409,
            "old_office_outdated",
            "The old office runs an older Isomux. Update the old office, then make a new move code.",
          );
        if (office.stateRoot !== ours.stateRoot)
          return refuse(
            409,
            "state_root_differs",
            "The office's data folder is in another place on the two machines.",
            // As in the old office's own refusal: ours is the old office.
            { ours: office, theirs: ours },
          );
        const pair: MoveInPairing = {
          oldOrigin: origin,
          session: b.session,
          sessionExpiresAt: b.sessionExpiresAt,
          key: parsed.key,
          pairedAt: deps.now().getTime(),
          by,
          office,
        };
        let preflightId: string;
        try {
          preflightId = await startPreflight(pair, null);
        } catch (err) {
          if (generation !== gen) return cancelled();
          writeState({
            phase: "failed",
            ...pair,
            lockedAt: null,
            error: {
              code: unreachable(err).code,
              message: unreachable(err).message,
            },
            retryable: true,
            failedAt: deps.now().getTime(),
          });
          return fromFail(err);
        }
        if (generation !== gen) return cancelled();
        writePre({ phase: "preflight", ...pair, preflightId });
        preflightJob(pair, preflightId);
        return okStatus(202);
      } catch (err) {
        return fromFail(err);
      } finally {
        pairing = null;
        busy = false;
      }
    },

    status() {
      if (moved)
        return {
          phase: "moved",
          oldOrigin: moved.oldOrigin,
          office: moved.office,
          report: moved.report,
          // The folder the delete removes, so the owner can look first.
          asidePath: join(moveInDir, MOVE_IN_ASIDE),
        };
      if (pairing) return { phase: "pairing", oldOrigin: pairing.oldOrigin };
      const s = state;
      if (!s) return { phase: "none", blocker: startBlocker() };
      const out: MoveInStatus = {
        phase: s.phase,
        oldOrigin: s.oldOrigin,
        office: s.office,
        oldOfficeLocked: oldOfficeLocked(s),
      };
      if ("preflightId" in s) out.preflightId = s.preflightId;
      if (s.phase === "confirm") {
        out.preflight = s.preflight;
        // Slice 5b: checked at each request (a few reads).
        const folders = preflightOutside(s.preflight).move;
        if (folders.length > 0)
          out.outsideChecks = folders.map((f) => checkFolder(f.path, f.mode));
      }
      if ((s.phase === "preflight" || s.phase === "confirm") && s.live)
        out.live =
          s.live.phase === "copying" && liveProgress
            ? { ...s.live, progress: { ...liveProgress } }
            : s.live;
      if ("lockedAt" in s) out.lockedAt = s.lockedAt;
      if (s.phase === "pulling" || s.phase === "checking")
        out.progress = progress ? { ...progress } : s.progress;
      if (s.phase === "staged" || s.phase === "incomplete") {
        out.result = s.result;
        if (s.error) out.error = s.error;
      }
      if (s.phase === "failed") {
        out.error = s.error;
        out.retryable = s.retryable;
      }
      return out;
    },

    async rerunPreflight() {
      if (busy || job || !state || state.phase !== "confirm")
        return refuse(
          409,
          "not_confirming",
          "The move is not waiting for the owner's yes.",
        );
      busy = true;
      try {
        const pair = pairingOf(state);
        const gen = generation;
        const preflightId = await startPreflight(pair, null);
        // A cancel while the request was in flight wins.
        if (generation !== gen)
          return refuse(409, "cancelled", "The move-in was cancelled.");
        writePre({ phase: "preflight", ...pair, preflightId });
        preflightJob(pair, preflightId);
        return okStatus(202);
      } catch (err) {
        return fromFail(err);
      } finally {
        busy = false;
      }
    },

    async lock({ preflightId }) {
      if (busy || job || !state || state.phase !== "confirm")
        return refuse(
          409,
          "not_confirming",
          "The move is not waiting for the owner's yes.",
        );
      const notFreshAnswer = notFresh();
      if (notFreshAnswer) return notFreshAnswer;
      // C4: set before the first await; every other verb sees it.
      busy = true;
      const gen = generation;
      try {
        // Slice 4: the live pass stops first; what it copied whole stays.
        const running = liveJob;
        if (running) {
          liveStopping = true;
          liveAbort?.abort();
          await running;
          if (gen !== generation)
            return refuse(409, "cancelled", "The move-in was cancelled.");
        }
        // Read after the live pass ended: `live` is final, and no writer of
        // it runs until the refusal below writes it back.
        const before = state;
        if (!before || before.phase !== "confirm")
          return refuse(
            409,
            "not_confirming",
            "The move is not waiting for the owner's yes.",
          );
        // Slice 5b: every folder outside the home must land here.
        const agreed = preflightOutside(before.preflight);
        const checks = agreed.move.map((f) => checkFolder(f.path, f.mode));
        const blocked = checks.filter((c) => !c.ok);
        if (blocked.length > 0) {
          writeState(before);
          return refuse(
            409,
            "outside_folders_blocked",
            blockedMessage(blocked),
            {
              checks,
            },
          );
        }
        const pair = { ...pairingOf(before), outside: agreed };
        writeState({ phase: "locking", ...pair, preflightId });
        let r: { status: number; body: unknown };
        try {
          r = await requestJson(pair.oldOrigin, "POST", "/api/move/lock", {
            session: pair.session,
            body: { preflightId },
          });
        } catch (err) {
          // The lock may have arrived: the pull again asks the old office.
          if (gen === generation)
            fail(
              new MoveInFail(
                "lock_unknown",
                `The old office did not answer the lock: ${errMessage(err)}`,
                true,
              ),
            );
          return fromFail(err);
        }
        if (gen !== generation)
          return refuse(409, "cancelled", "The move-in was cancelled.");
        if (r.status !== 202) {
          // Refused: nothing locked; the owner sees why and may say yes again.
          writeState(before);
          return fromFail(answerFail(r.status, r.body));
        }
        pullJob(pair, deps.now().getTime());
        return okStatus(202);
      } finally {
        busy = false;
      }
    },

    async finish({ acceptMissing, by, requestOrigin }) {
      if (moved) return movedRefusal();
      if (busy || job || liveJob || pairing)
        return refuse(
          409,
          "move_in_running",
          "A move into this office is already running.",
        );
      const s = state;
      if (!s || (s.phase !== "staged" && s.phase !== "incomplete"))
        return refuse(409, "not_staged", "The copy is not ready.");
      if (s.phase === "incomplete" && !acceptMissing)
        return refuse(
          409,
          "copy_incomplete",
          "Some files of the old office are not in the copy. Finish with acceptMissing: true to move without them.",
          { missing: s.result.missing.length },
        );
      busy = true;
      finishRunning = true;
      try {
        // Every refusal comes before `done`: after it, only writes fail.
        const restartAnswer = restartRefusal();
        if (restartAnswer) return restartAnswer;
        const notFreshAnswer = notFresh();
        if (notFreshAnswer) return notFreshAnswer;
        const box = deps.box();
        const pair = pairingOf(s);
        const finishedAt = deps.now().getTime();
        const inputs: MoveInSwapInputs = {
          version: 1,
          home: deps.home,
          stateRoot: deps.stateRoot,
          codeDir: box.codeDir,
          backupDir: box.backupDir,
          newOfficeUnit: box.officeUnit,
          oldOfficeUnit: s.office.officeUnit ?? null,
          ownerId: by.id,
          units: s.manifest.units,
          loopbackOnly: box.loopbackOnly !== false,
          report: {
            oldOrigin: pair.oldOrigin,
            office: pair.office,
            finishedAt,
            by,
            excluded: s.manifest.excluded,
            secretCount: s.manifest.secretCount,
            missing: s.phase === "incomplete" ? s.result.missing : [],
            outsideMoved: (pair.outside?.move ?? []).map((f) => f.path),
            outsideLeft: pair.outside?.left ?? [],
          },
          ...(s.manifest.outside && s.manifest.outside.length > 0
            ? { outside: s.manifest.outside }
            : {}),
        };
        const refusals = await checkMoveInSwap(inputs);
        if (refusals.length > 0)
          return refuse(
            409,
            refusals[0].code,
            swapRefusalMessage(refusals[0]),
            { refusals },
          );
        const { error: _lastError, ...back } = s;
        writeState({
          phase: "finishing",
          from: s.phase,
          ...pair,
          lockedAt: s.lockedAt,
          manifestId: s.manifestId,
          stagedAt: s.phase === "staged" ? s.stagedAt : null,
          result: s.result,
          manifest: s.manifest,
          acceptMissing,
        });
        let done = false;
        try {
          const r = await requestJson(
            pair.oldOrigin,
            "POST",
            "/api/move/done",
            {
              session: pair.session,
              body: {
                manifestId: s.manifestId,
                newOrigin: box.publicOrigin ?? requestOrigin,
              },
            },
          );
          done = r.status === 200;
        } catch {
          // No answer: the old office's state says whether it got it.
        }
        if (!done) {
          const st = await oldStateAfterDone(pair);
          if (st === "moved") done = true;
          else if (st === "move" || st === null) {
            const error = {
              code: "done_failed",
              message:
                "The old office did not confirm the end of the move. Finish again.",
            };
            writeState({ ...back, error });
            return refuse(502, error.code, error.message);
          } else {
            const error = {
              code: "old_office_state",
              message:
                st === "gone"
                  ? "The old office no longer knows this move. Cancel here and start again with a new code."
                  : `The old office is in the state "${st}". The move cannot end.`,
            };
            writeState({
              phase: "failed",
              ...pair,
              lockedAt: s.lockedAt,
              error,
              retryable: false,
              failedAt: deps.now().getTime(),
            });
            return refuse(409, error.code, error.message);
          }
        }
        // The old office is MOVED: from here, only writes.
        writeMoveInSwapFile(deps.home, { inputs, ops: null });
        writeState({
          phase: "swapping",
          ...pair,
          lockedAt: s.lockedAt,
          manifestId: s.manifestId,
          finishedAt,
        });
        deps.requestRestart();
        return okStatus(202);
      } catch (err) {
        return fromFail(err);
      } finally {
        busy = false;
        finishRunning = false;
      }
    },

    async copyLive() {
      if (busy || job || liveJob || !state || state.phase !== "confirm")
        return refuse(
          409,
          "not_confirming",
          "The move is not waiting for the owner's yes, or a copy runs.",
        );
      startLive(pairingOf(state));
      return okStatus(202);
    },

    async retryPull() {
      if (
        busy ||
        job ||
        liveJob ||
        !state ||
        state.phase !== "failed" ||
        !state.retryable
      )
        return refuse(
          409,
          "not_retryable",
          "There is no failed copy to run again.",
        );
      const pair = pairingOf(state);
      const lockedAt = state.lockedAt;
      busy = true;
      try {
        // Out of `failed` before the answer: the job asks the old office.
        writeState({ phase: "waiting", ...pair, lockedAt });
        runJob(async (signal, gen) => {
          const r = await requestJson(
            pair.oldOrigin,
            "GET",
            "/api/move/status",
            {
              session: pair.session,
              signal,
            },
          );
          const st =
            r.status === 200 &&
            isObject(r.body) &&
            typeof r.body.state === "string"
              ? r.body.state
              : null;
          if (r.status !== 200 || st === null) {
            throw new MoveInFail(
              r.status === 401 ? "move_session_invalid" : "old_office_state",
              r.status === 401
                ? "The old office no longer knows this move. Cancel it here and start again with a new code."
                : `The old office answered ${r.status}.`,
              r.status !== 401,
            );
          }
          if (st === "paired") {
            // The lock never arrived: the owner says yes again.
            const preflightId = await startPreflight(pair, signal);
            setFor(gen, { phase: "preflight", ...pair, preflightId });
            const result = await poll(
              pair,
              `/api/move/preflight/${encodeURIComponent(preflightId)}`,
              deps.timing.preflightWaitMs,
              "preflight",
              signal,
              (b) =>
                b.state === "ready" && isObject(b.result) ? b.result : null,
            );
            setFor(gen, {
              phase: "confirm",
              ...pair,
              preflightId,
              preflight: result,
            });
            if (!currentLive() && !liveJob) startLive(pair);
            return;
          }
          if (st !== "move")
            throw new MoveInFail(
              "old_office_state",
              `The old office is in the state "${st}". The move cannot go on.`,
              false,
            );
          // Locked: the pull from the start.
          await pull(pair, lockedAt ?? deps.now().getTime(), signal, gen);
        });
        return okStatus(202);
      } finally {
        busy = false;
      }
    },

    async cancel() {
      if (moved) {
        moved = null;
        writeState(null);
        removeMoveTree(moveInDir);
        return {
          ok: true,
          status: 200,
          body: { cancelled: true, oldOfficeLocked: false },
        };
      }
      if (
        finishRunning ||
        state?.phase === "finishing" ||
        state?.phase === "swapping"
      )
        return refuse(
          409,
          "move_in_finishing",
          "The move is ending. Wait for the office to restart.",
        );
      const s = state;
      generation++;
      jobAbort?.abort();
      liveAbort?.abort();
      for (const running of [job, liveJob])
        if (running)
          await withTimeout(running, deps.timing.requestMs, "the cancel").catch(
            () => {},
          );
      writeState(null);
      // Slice 5b (C5): every folder outside the home where this box staged.
      try {
        dropMoveInOutside(deps.home, []);
      } catch (err) {
        console.error(
          "[move-in] could not remove the copies outside the home:",
          errMessage(err),
        );
      }
      removeMoveTree(moveInDir);
      const locked = s ? oldOfficeLocked(s) : false;
      return {
        ok: true,
        status: 200,
        body: {
          cancelled: s !== null,
          oldOfficeLocked: locked,
          ...(locked
            ? {
                message:
                  "The old office stays locked for the move. Its owner cancels the move there with the move code.",
              }
            : {}),
        },
      };
    },

    recoverAtBoot() {
      if (busy || job || pairing) return;
      // The disk as the boot left it (the swap boot writes `moved`).
      loadState();
      // Slice 2c-1: a finish the restart cut goes back to the copy it had;
      // finish again asks the old office. Never the pull again (it wipes the
      // stage).
      if (state?.phase === "finishing" && !busy) {
        const f = state;
        const common = {
          ...pairingOf(f),
          lockedAt: f.lockedAt,
          manifestId: f.manifestId,
          result: f.result,
          manifest: f.manifest,
        };
        writeState(
          f.from === "staged"
            ? {
                phase: "staged",
                ...common,
                stagedAt: f.stagedAt ?? deps.now().getTime(),
              }
            : { phase: "incomplete", ...common },
        );
        return;
      }
      // Slice 4: a live pass the restart cut.
      if (
        state?.phase === "confirm" &&
        !liveJob &&
        (state.live?.phase === "manifest" || state.live?.phase === "copying")
      ) {
        writeState({
          ...state,
          live: {
            ...state.live,
            phase: "failed",
            finishedAt: deps.now().getTime(),
            error: {
              code: "interrupted",
              message: "The office restarted during the copy.",
            },
          },
        });
        return;
      }
      if (!state || !JOB_PHASES.has(state.phase) || job) return;
      writeState({
        phase: "failed",
        ...pairingOf(state),
        lockedAt: lockedAtOf(state),
        error: {
          code: "interrupted",
          message:
            "The office restarted during the move-in. Pull again to go on.",
        },
        retryable: true,
        failedAt: deps.now().getTime(),
      });
    },

    async settled() {
      while (job || liveJob) await (job ?? liveJob)!.catch(() => {});
    },
  };
  return api;
}

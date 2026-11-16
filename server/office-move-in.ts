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
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import { errMessage } from "../shared/errors.ts";
import type {
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
  moveItemsHash,
  openMoveStream,
  readMoveRecords,
  type MoveExcludedUnit,
  type MoveManifestEntry,
  type MoveSealContext,
} from "./office-move-pull.ts";
import {
  createMoveStage,
  MOVE_IN_STAGE,
  MoveStageError,
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
}

export type { MoveInPreflight, MoveInProgress, MoveInStatus };

export type MoveInState =
  | ({ phase: "preflight"; preflightId: string } & MoveInPairing)
  | ({
      phase: "confirm";
      preflightId: string;
      preflight: MoveInPreflight;
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
const DIR_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_DIRECTORY |
  fsConstants.O_NONBLOCK;

/** Removes a move-in folder: a staged copy can hold read-only folders, so
 *  each folder gets u+rwx first (by fd, never through a link). */
function removeTree(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    let fd: number;
    try {
      fd = openSync(p, DIR_FLAGS);
    } catch {
      continue; // Not a folder (or a link, or gone): rm takes it.
    }
    try {
      fchmodSync(fd, 0o700);
    } catch {
      // rm reports what it cannot remove.
    } finally {
      closeSync(fd);
    }
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      names = [];
    }
    for (const n of names) stack.push(join(p, n));
  }
  rmSync(root, { recursive: true, force: true });
}

// ---- the move-in ----

export function createMoveIn(deps: MoveInDeps): MoveIn {
  const stateFile = join(deps.stateRoot, MOVE_IN_STATE_FILE);
  const moveInDir = join(deps.home, MOVE_IN_DIR);
  const stageDir = join(moveInDir, MOVE_IN_STAGE);
  const manifestFile = join(moveInDir, "manifest.ndjson");

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

  const pairingOf = (s: MoveInState): MoveInPairing => ({
    oldOrigin: s.oldOrigin,
    session: s.session,
    sessionExpiresAt: s.sessionExpiresAt,
    key: s.key,
    pairedAt: s.pairedAt,
    by: s.by,
    office: s.office,
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
    writeState(next);
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
    });

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
    const totalBytes =
      typeof summary.totalBytes === "number" ? summary.totalBytes : 0;
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
    };
    const unreadable = Array.isArray(summary.unreadable)
      ? summary.unreadable.filter((p): p is string => typeof p === "string")
      : [];

    // A fresh move-in folder: an earlier pull's stage goes (rm does not
    // follow links).
    removeTree(moveInDir);
    mkdirSync(moveInDir, { mode: 0o700 });
    const fd = openSync(manifestFile, "w", 0o600);
    try {
      for await (const chunk of await requestSealed(
        pair,
        "GET",
        `/api/move/manifest/${encodeURIComponent(manifestId)}/data`,
        undefined,
        { route: "manifest", manifestId, batch: 0, itemsHash: "" },
        signal,
      )) {
        let off = 0;
        while (off < chunk.byteLength)
          off += writeSync(fd, chunk, off, chunk.byteLength - off);
      }
    } finally {
      closeSync(fd);
    }

    // D5: whole blocks and inodes, before the first batch.
    const fs = deps.statfs(deps.home);
    const bsize = Math.max(1, fs.bsize);
    let blocks = 0;
    let entries = 0;
    for await (const e of manifestEntries(manifestFile)) {
      entries++;
      if (e.t === "f") blocks += Math.ceil(e.s / bsize) * bsize;
      else if (e.t === "d") blocks += bsize;
    }
    const needBytes = blocks + Math.max(blocks * 0.1, GIB);
    const haveBytes = fs.bavail * bsize;
    const needInodes = entries + Math.ceil(entries * 0.1);
    if (haveBytes < needBytes)
      throw new MoveInFail(
        "no_space",
        `Not enough disk space: the copy needs ${Math.ceil(needBytes)} bytes, and ${haveBytes} are free. Free some space, then pull again.`,
        true,
      );
    if (fs.ffree < needInodes)
      throw new MoveInFail(
        "no_space",
        `The disk can hold ${fs.ffree} more files, and the copy needs ${needInodes}. Free some, then pull again.`,
        true,
      );

    progress = {
      entries,
      totalBytes,
      filesDone: 0,
      bytesDone: 0,
      batchesDone: 0,
      batchesTotal: 0,
      retries: 0,
    };
    setFor(gen, {
      phase: "pulling",
      ...pair,
      lockedAt,
      manifestId,
      progress: { ...progress },
    });
    const stage = createMoveStage(stageDir);
    await pullBatches(pair, manifestId, stage, signal, gen);

    setFor(gen, {
      phase: "checking",
      ...pair,
      lockedAt,
      manifestId,
      progress: { ...progress },
    });
    await stage.finish(manifestEntries(manifestFile));
    const result = await stage.check(manifestEntries(manifestFile));
    for (const p of unreadable)
      result.missing.push({
        path: p,
        reason: "The old office could not read it.",
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

  /** Pass 1 over the manifest, and the batches it plans. */
  const pullBatches = async (
    pair: MoveInPairing,
    manifestId: string,
    stage: MoveStage,
    signal: AbortSignal,
    gen: number,
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
      const p = runBatch(pair, manifestId, stage, batch, signal)
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
      if (progress) progress.batchesTotal++;
      await launch(batch);
    };
    const itemJson = (i: { path: string; offset?: number; length?: number }) =>
      JSON.stringify(i).length + 1;

    try {
      for await (const e of manifestEntries(manifestFile)) {
        if (firstError !== null || gen !== generation) break;
        stage.prepare(e);
        if (e.t !== "f") continue;
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
    if (gen !== generation) throw new MoveInFail("cancelled", "Cancelled.");
    if (firstError instanceof MoveStageError)
      throw new MoveInFail("manifest_refused", firstError.message, true);
    if (firstError !== null) throw unreachable(firstError);
  };

  /** One batch, run again on a failure up to batchAttempts. */
  const runBatch = async (
    pair: MoveInPairing,
    manifestId: string,
    stage: MoveStage,
    batch: MoveStageBatch,
    signal: AbortSignal,
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
    };
    let last: unknown = null;
    for (let attempt = 1; attempt <= deps.limits.batchAttempts; attempt++) {
      if (signal.aborted) throw new MoveInFail("cancelled", "Cancelled.");
      try {
        const plain = await requestSealed(
          pair,
          "POST",
          "/api/move/batch",
          { manifestId, batch: batch.n, items },
          ctx,
          signal,
        );
        const results = await stage.writeBatch(batch, readMoveRecords(plain));
        if (progress) {
          progress.batchesDone++;
          for (const r of results)
            if (!("error" in r)) {
              progress.bytesDone += r.bytes;
              if ((r.offset ?? 0) === 0) progress.filesDone++;
            }
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
        if (progress) progress.retries++;
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
      if (busy || job || pairing)
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
        writeState({ phase: "preflight", ...pair, preflightId });
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
      if (s.phase === "confirm") out.preflight = s.preflight;
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
        writeState({ phase: "preflight", ...pair, preflightId });
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
      busy = true;
      const before = state;
      const pair = pairingOf(before);
      const gen = generation;
      try {
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
      if (busy || job || pairing)
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
          },
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

    async retryPull() {
      if (busy || job || !state || state.phase !== "failed" || !state.retryable)
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
        removeTree(moveInDir);
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
      const running = job;
      if (running)
        await withTimeout(running, deps.timing.requestMs, "the cancel").catch(
          () => {},
        );
      writeState(null);
      removeTree(moveInDir);
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
      while (job) await job.catch(() => {});
    },
  };
  return api;
}

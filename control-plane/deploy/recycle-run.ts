#!/usr/bin/env bun
// G5: the test box, rebuilt ONCE, with the fresh key the customer pass adopts.
//
//   bun control-plane/deploy/recycle-run.ts --plan                 contacts nothing
//   bun control-plane/deploy/recycle-run.ts --state                reads only
//   bun control-plane/deploy/recycle-run.ts --execute              rebuilds, once
//   bun control-plane/deploy/recycle-run.ts --verify --run <id>    reads only
//   bun control-plane/deploy/recycle-run.ts --connect --run <id>   waits, re-pins
//
// WHY A PROGRAM AND NOT A flyctl LINE. A shell `flyctl` either uses the ambient
// ~/.fly identity - which on this box belongs to another project - or needs
// FLY_API_TOKEN expanded by a shell, which ruling 8 forbids. The same argument
// `activate.ts` makes for the arming deploy: the token is read in-process, the
// remote commands are constants in this file, and nothing about the target comes
// from outside the repository.
//
// WHY THERE IS NO ON-BOX HALF. Every remote command here is one the DEPLOYED
// image already carries (`cli.ts recycle`, `cli.ts connect`,
// `deploy/provider-account.ts --on-box`) or a shell-free read (`ls -1`,
// `grep -c`). D3.5's G4 trap was the deployed-artifact lag - shipping code and
// then relying on behaviour the running image did not have - and a step that
// adds no on-box code cannot walk into it. G5 therefore needs no deploy.
//
// ABSENCE MUST BE PROVED, NEVER INFERRED (reviewer blocker, 2026-08-12). The
// guard that matters most here is "no run record is already mid-rebuild",
// because a second rebuild of a box that is already rebuilding is the one thing
// README's recovery story says must never happen. `grep -c` exits 1 for a count
// of zero and 2 for a file it could not read, and `ls -1` exits non-zero for a
// directory that is not there. Mapping non-zero to "nothing pending" would let a
// missing directory, a renamed file or a truncated read license the rebuild. So
// every absence is established by a file that was READ and found to lack the
// value, in two calls; anything else stops the ladder. The runs DIRECTORY gets
// the same treatment one level up: a listing that refuses is not "no records",
// and the only way that becomes a reading is the parent listing carrying the
// boot marker and not carrying `runs` - a positive control, because a clean
// EMPTY answer is what both a virgin volume and a broken transport look like.
//
// THE CHILD IS CORROBORATED, NOT BELIEVED (reviewer must-fix, 2026-08-12). The
// run id comes out of the child's transcript, and the post-state read would be
// vacuous if that id were stale or wrong: it would prove "reachable" about a
// record this run did not create. So the runs directory is listed BEFORE and
// AFTER, and the delta must be exactly one new id equal to the extracted one.
//
// REPORT-ONLY FACTS. The reinstall-to-SSH seconds and the login-user label are
// printed and nothing else: no acceptance decision reads either, so nobody can
// later gate on a number the child chose. Acceptance reads the world - the
// listing delta, the record's state, and the provider's own account listing.
//
// THIS PROGRAM PRINTS booleans, small integers, fixed labels, the provider's
// cancel DAY, and the run id (which the operator needs for --verify and
// --connect). No path, no host, no address, no key material, no token, and no
// line of any child's transcript crosses to the output.

import {
  APP,
  FLYCTL,
  FLY_TOKEN_FILE,
  type BoundedResult,
  readSecretFile,
  realBoundedSpawn,
} from "./fly-cli.ts";
import {
  EXPECTED_INSTANCE_ID,
  REMOTE_DEADLINE_MS,
  type AccountReading,
  judgeRemote,
  parseRemote,
  readProviderHealth,
  remoteRunUsable,
} from "./provider-account.ts";
import { NOTHING_OBSERVED, mayRun } from "./landing.ts";
import { MARKER_NAME } from "../state-marker.ts";

/** The host the run record carries. cp1 is Let's Encrypt rate-limited until
 * ~2026-08-16; cp2 has certificate budget. Whether the name RESOLVES to this box
 * is a G7 question - `recycle` records the host and waits on the instance's own
 * address. */
export const HOST = "cp2.test.isomux.app";

/** HOME=/data in the image (Dockerfile) and the volume mounts there (fly.toml),
 * so this is where config.ts's STATE_ROOT lands on the persistent volume. */
export const STATE_ROOT_REMOTE = "/data/.isomux-control-plane";
export const RUNS_DIR_REMOTE = `${STATE_ROOT_REMOTE}/runs`;

/**
 * How long the rebuild gets.
 *
 * The child's own SSH wait is capped at 15 minutes (config.ts
 * SSH_WAIT_TIMEOUT_MS), and this deadline must sit ABOVE it so the child reports
 * its own timeout and this side's deadline fires only on a hung transport. 18
 * minutes preserved that ordering with under 3 minutes of margin for the
 * adapter read, the key generation, the secret creation and the reinstall
 * request; 20 preserves it with room and costs nothing when the run is clean
 * (reviewer note N2, 2026-08-12).
 */
export const RECYCLE_DEADLINE_MS = 20 * 60_000;
/** The same shape of wait, for the recovery that only waits. */
export const CONNECT_DEADLINE_MS = 20 * 60_000;
/** A directory listing or a grep. Generous for a transport, short for a read. */
export const READ_DEADLINE_MS = 60_000;

/**
 * How many run records this program will walk.
 *
 * Every record on the volume is read twice at the post-state rung, so an
 * unexpectedly full directory would become a spawn storm. More than this is a
 * world-fact for a manager rather than a number this program raises on its own.
 */
export const MAX_RUN_RECORDS = 20;

/** `newId` in cli.ts produces run-<14 digits>-<base36>; a recovered id may only
 * ever be one of those. Validated before it can reach a command line. */
const RUN_ID = /^run-[a-z0-9-]{1,40}$/;
const RUN_FILE = /^(run-[a-z0-9-]{1,40})\.json$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/**
 * A remote command's tokens, checked for shell-inertness before it is sent.
 *
 * `ssh` joins its command arguments into a string the remote side re-splits, so
 * a token carrying a space or a quote arrives as several - which is how an
 * earlier slice silently wrote a corrupt authorized_keys line (README's
 * "Remote arguments must be shell-inert"). Every pattern this program greps for
 * is therefore a single inert word: `state`, `reinstall_requested`, `reachable`.
 * The check is here rather than in a comment because a future edit that adds a
 * quoted pattern must fail loudly instead of matching something else remotely.
 */
const INERT_TOKEN = /^[A-Za-z0-9_.,:=@%+/-]+$/;

export function shellInert(command: string): boolean {
  const tokens = command.split(" ");
  return tokens.length > 0 && tokens.every((t) => INERT_TOKEN.test(t));
}

/**
 * The home directory every command we exec must resolve, and why it is carried
 * explicitly on ALL of them.
 *
 * MEASURED 2026-08-12: a `fly ssh console -C` exec does NOT carry the image's
 * ENV. HOME is `/root` there while the process fly's init starts sees `/data`,
 * and `config.ts` derives the state root from `os.homedir()` - so every command
 * this loop had exec'd was writing the run records, the private keys and the
 * audit log to the machine's EPHEMERAL filesystem, beside a volume holding only
 * the boot marker. Also measured locally the same day: with HOME set to a
 * directory, bun's `os.homedir()` returns exactly that directory, so the prefix
 * is sufficient as well as necessary.
 *
 * UNIFORM, INCLUDING THE READS (reviewer ruling, 2026-08-12). Sorting commands
 * into writers and readers is what produced two audit logs: `audit.record` is
 * called from nearly every cli.ts verb, so `list_instances` became a state write
 * without anybody classifying it as one. A prefix that costs nothing on a read
 * removes a judgement somebody would otherwise have to repeat correctly forever.
 *
 * This is enforcement rather than attestation: it is a committed argv inside a
 * reviewed program, not a flag an operator remembers. The remembering risk lives
 * in runbook lines a human types, which is what the machine-level environment
 * change addresses - and that one has to wait, because applying it replaces the
 * machine.
 */
export const PINNED_HOME = "/data";

/** The one console form, with the command as its own argv element. */
export function consoleArgv(command: string): string[] {
  const pinned = `env HOME=${PINNED_HOME} ${command}`;
  if (!shellInert(pinned)) {
    throw new Error("refusing a remote command that is not shell-inert");
  }
  return [FLYCTL, "ssh", "console", "-a", APP, "-C", pinned];
}

export const LIST_RUNS_COMMAND = `ls -1 ${RUNS_DIR_REMOTE}`;
/**
 * The state root, listed WITH dotfiles, as the positive control for absence.
 *
 * `-a` is load-bearing (reviewer sharpening, 2026-08-12). On a volume where no
 * run has ever happened, every visible entry - runs, keys, the intent journal,
 * the audit log - is created on first use, so a plain listing can legitimately
 * come back clean and EMPTY. That answer is byte-identical to a transport that
 * returns success with no output, so reading it as "runs is absent" would rest
 * absence on an empty answer again. The boot marker is a dotfile and is written
 * on every boot, so requiring it in the listing is what makes an empty answer
 * distinguishable from a real one.
 */
export const PARENT_LIST_COMMAND = `ls -1a ${STATE_ROOT_REMOTE}`;

/**
 * The pre-check: does the env prefix reach the child at all?
 *
 * Reviewer substitution (2026-08-12) for the marker read I first proposed, and a
 * better one: reading the marker at an absolute volume path proves the marker
 * exists, which is already known, and proves nothing about what the CHILD will
 * resolve. This tests the link that can actually fail. `consoleArgv` adds the
 * prefix, so the command here is just the reader.
 */
export const ENV_PIN_COMMAND = "printenv HOME";

/**
 * The state root the old, unpinned commands wrote to - read ONLY as a negative
 * control, never written and never cleaned up by this program.
 *
 * A rebuilt box makes the key under it inert, and a hand `rm` of key material is
 * one more unreviewed mutation; it goes away with the machine replacement that
 * the environment fix will need anyway (reviewer ruling, 2026-08-12).
 */
export const LEGACY_RUNS_COMMAND = "ls -1 /root/.isomux-control-plane/runs";
export const ACCOUNT_COMMAND =
  "bun control-plane/deploy/provider-account.ts --on-box";
export const RECYCLE_COMMAND =
  `bun control-plane/cli.ts recycle --instance ${EXPECTED_INSTANCE_ID} ` +
  `--host ${HOST}`;

export function connectCommand(runId: string): string {
  return `bun control-plane/cli.ts connect --run ${requireRunId(runId)}`;
}

/** The three inert words, each in its own call. `state` establishes that the
 * file was READ and holds exactly one state field; the other two ask what that
 * field says. */
export function stateFieldCommand(runId: string): string {
  return `grep -c state ${recordPath(runId)}`;
}
export function pendingCommand(runId: string): string {
  return `grep -c reinstall_requested ${recordPath(runId)}`;
}
export function reachableCommand(runId: string): string {
  return `grep -c reachable ${recordPath(runId)}`;
}

function recordPath(runId: string): string {
  return `${RUNS_DIR_REMOTE}/${requireRunId(runId)}.json`;
}

function requireRunId(runId: string): string {
  if (!isRunId(runId)) throw new Error("refusing a run id of an unruled shape");
  return runId;
}

// ------------------------------------------------------------------ readings

/** A bounded run that ended cleanly, whatever its exit code says. */
export function endedCleanly(result: BoundedResult): boolean {
  return !result.timedOut && !result.groupSurvived && result.groupEmpty;
}

export type GrepOutcome =
  | { kind: "count"; count: number }
  | { kind: "unreadable" }
  | { kind: "unusable" };

/**
 * `grep -c`, with its exit codes meaning what they actually mean.
 *
 *   0  matched: the count is on stdout and must be at least 1.
 *   1  read, nothing matched: the count must be exactly 0. THE ONLY "absent".
 *   2  could not read the file - missing, a directory, a permission. NOT zero.
 *
 * The count and the code have to agree. A code that says "matched" with a count
 * of 0 on stdout, or a count that is not digits, is a grep this program does not
 * recognise, and an unrecognised reader is not evidence.
 */
export function classifyGrep(result: BoundedResult): GrepOutcome {
  if (!endedCleanly(result) || result.code === null)
    return { kind: "unusable" };
  const count = parseCount(result.stdout);
  if (result.code === 0) {
    return count !== null && count >= 1
      ? { kind: "count", count }
      : { kind: "unusable" };
  }
  if (result.code === 1) {
    return count === 0 ? { kind: "count", count: 0 } : { kind: "unusable" };
  }
  return { kind: "unreadable" };
}

export function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

export type ListOutcome =
  | { kind: "ids"; ids: string[] }
  | { kind: "malformed" }
  | { kind: "over_cap" }
  | { kind: "unreadable" }
  | { kind: "unusable" };

/**
 * The runs directory, as a set of ids or as a refusal.
 *
 * An EMPTY directory is a reading: exit 0 with no lines is zero records. A
 * directory that is not there exits non-zero and is UNREADABLE - never "zero
 * records" (reviewer blocker, 2026-08-12). If this volume has genuinely never
 * held a run, that is a fact for the manager to authorise past explicitly, not
 * one this program passes on its own.
 *
 * Every line must be exactly a record file. A leftover `.tmp` from an
 * interrupted write, a directory, or anything else is MALFORMED and stops the
 * ladder: a runs directory holding something nobody wrote deliberately is not a
 * place to start a rebuild from.
 */
export function classifyList(
  result: BoundedResult,
  cap: number = MAX_RUN_RECORDS,
): ListOutcome {
  if (!endedCleanly(result) || result.code === null)
    return { kind: "unusable" };
  if (result.code !== 0) return { kind: "unreadable" };
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > cap) return { kind: "over_cap" };
  const ids: string[] = [];
  for (const line of lines) {
    const match = RUN_FILE.exec(line);
    if (!match) return { kind: "malformed" };
    ids.push(match[1]);
  }
  if (new Set(ids).size !== ids.length) return { kind: "malformed" };
  return { kind: "ids", ids: [...ids].sort() };
}

export type ParentOutcome =
  /** The marker is there and `runs` is not: the directory is PROVED absent. */
  | { kind: "runs_absent" }
  /** `runs` is there, so the earlier refusal was a read that failed. */
  | { kind: "runs_present" }
  /** No marker: either not the directory we think, or an answer that came back
   * with nothing in it. Either way nothing is established. */
  | { kind: "no_marker" }
  | { kind: "unreadable" }
  | { kind: "unusable" };

/**
 * The state root, judged against the one entry that must be there.
 *
 * This is the ONLY path by which "no run record exists" becomes a reading rather
 * than a refusal, and it is deliberately the narrowest one: a listing that ended
 * cleanly, exited 0, carries the boot marker, and does not carry `runs`.
 */
export function classifyParent(result: BoundedResult): ParentOutcome {
  if (!endedCleanly(result) || result.code === null)
    return { kind: "unusable" };
  if (result.code !== 0) return { kind: "unreadable" };
  const entries = parentEntries(result.stdout);
  if (!entries.includes(MARKER_NAME)) return { kind: "no_marker" };
  return entries.includes("runs")
    ? { kind: "runs_present" }
    : { kind: "runs_absent" };
}

function parentEntries(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * What the volume's state root actually holds, as booleans.
 *
 * AUDIT UNITY IS AN ACCEPTANCE PROPERTY, NOT AN OBSERVATION (reviewer ruling,
 * 2026-08-12). `AUDIT_FILE` sits directly in the derived root, so the unpinned
 * commands put the account of what happened to the box on the ephemeral
 * filesystem - and a design whose checkable property is its audit surface cannot
 * have two of them. `audit` false before and true after is what proves the
 * pinned run wrote its rows where they survive.
 *
 * Null for every reading that established nothing, which refuses like any other
 * unmet precondition.
 */
export interface VolumeEntries {
  marker: boolean;
  runs: boolean;
  keys: boolean;
  audit: boolean;
}

export function volumeEntries(result: BoundedResult): VolumeEntries | null {
  if (!endedCleanly(result) || result.code === null || result.code !== 0) {
    return null;
  }
  const entries = parentEntries(result.stdout);
  // The marker is the same positive control the absence proof uses: without it,
  // this is not established to be the directory we think it is.
  if (!entries.includes(MARKER_NAME)) return null;
  return {
    marker: true,
    runs: entries.includes("runs"),
    keys: entries.includes("keys"),
    audit: entries.includes("audit.jsonl"),
  };
}

/**
 * Did the env prefix reach the child?
 *
 * Exactly the pinned path and nothing else. A trailing newline is the shell's,
 * anything else is an answer this side does not accept.
 */
export function envPinProved(result: BoundedResult): boolean {
  if (!endedCleanly(result) || result.code !== 0) return false;
  return result.stdout.trim() === PINNED_HOME;
}

/** What a record's state field says, once the file is known to be readable. */
export type RecordState = "reachable" | "reinstall_requested" | "other";

export interface ChildFacts {
  /** Null when the line is missing or occurs more than once - an id nobody can
   * point at is worse than no id. */
  runId: string | null;
  /** Report only. No acceptance decision reads it. */
  seconds: number | null;
  /** Report only. */
  loginUser: string | null;
}

const RECORDED =
  /^run (run-[a-z0-9-]{1,40}) recorded; login user is ([a-z][a-z0-9_-]{0,31})$/;
const MEASURED =
  /^MEASUREMENT reinstall-to-SSH: (\d{1,6})s \(ssh wait \d{1,6}s\)$/;

/**
 * The child's transcript, reduced to three whitelisted facts.
 *
 * Nothing else crosses. The transcript can carry the box's address, a driver
 * error or a path, and a program that prints "the interesting lines" is a
 * program that prints whatever a failure put in them.
 */
export function extractChildFacts(text: string): ChildFacts {
  let runId: string | null = null;
  let loginUser: string | null = null;
  let seconds: number | null = null;
  let recordedSeen = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const recorded = RECORDED.exec(line);
    if (recorded) {
      recordedSeen += 1;
      runId = recorded[1];
      loginUser = recorded[2];
      continue;
    }
    const measured = MEASURED.exec(line);
    if (measured) seconds = parseCount(measured[1]);
  }
  if (recordedSeen !== 1) return { runId: null, seconds, loginUser: null };
  return { runId, seconds, loginUser };
}

export interface DeltaVerdict {
  ok: boolean;
  added: number;
  removed: number;
  matchesChild: boolean;
  because: string;
}

/**
 * The listing before and after, against what the child claimed.
 *
 * Exactly one new record, none gone, and the new one is the id the child
 * printed. A delta of zero means the rebuild wrote nothing; a delta above one
 * means something else wrote too; a record that disappeared is a change to the
 * key master's own state that nothing in this ladder should produce.
 */
export function judgeDelta(
  before: string[],
  after: string[],
  extracted: string | null,
): DeltaVerdict {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  const matchesChild =
    added.length === 1 && extracted !== null && added[0] === extracted;
  if (added.length !== 1) {
    return {
      ok: false,
      added: added.length,
      removed: removed.length,
      matchesChild: false,
      because:
        added.length === 0
          ? "the rebuild left no new run record"
          : "more than one run record appeared",
    };
  }
  if (removed.length !== 0) {
    return {
      ok: false,
      added: 1,
      removed: removed.length,
      matchesChild,
      because: "a run record that existed before the rebuild is gone",
    };
  }
  if (!matchesChild) {
    return {
      ok: false,
      added: 1,
      removed: 0,
      matchesChild: false,
      because: "the new run record is not the one the child said it wrote",
    };
  }
  return {
    ok: true,
    added: 1,
    removed: 0,
    matchesChild: true,
    because: "one new run record, and it is the child's",
  };
}

// -------------------------------------------------------------------- ladder

export type Say = (line: string) => void;

export interface Seams {
  /** True, false, or null for "not established" - which refuses. */
  health: () => Promise<boolean | null>;
  /** One console command. A throw is an outcome the caller classifies. */
  run: (command: string, deadlineMs: number) => Promise<BoundedResult>;
  say: Say;
}

/** Exit codes, as meanings rather than numbers at the call site. */
export const ACCEPTED = 0;
export const REFUSED = 1;
export const USAGE = 2;
/** The rebuild may have taken effect and its outcome is not established.
 * `--verify` follows, and only a manager may authorise `--connect`. */
export const AMBIGUOUS = 3;

async function attempt(
  seams: Seams,
  command: string,
  deadlineMs: number,
): Promise<BoundedResult | null> {
  try {
    return await seams.run(command, deadlineMs);
  } catch {
    // DISCARDED: a CLI error can carry a path, a host or a fragment of what it
    // was given. Null is the outcome the caller acts on.
    return null;
  }
}

const UNUSABLE: BoundedResult = {
  code: null,
  timedOut: false,
  groupSurvived: false,
  groupEmpty: false,
  stdout: "",
  stderr: "",
};

async function grep(seams: Seams, command: string): Promise<GrepOutcome> {
  const result = await attempt(seams, command, READ_DEADLINE_MS);
  return classifyGrep(result ?? UNUSABLE);
}

/**
 * One record's state, in the two-call form.
 *
 * Call one proves the file was read and holds exactly one state field. Only then
 * does call two's "no match" mean the state is not that value, rather than
 * meaning the read failed.
 */
export async function readRecordState(
  seams: Seams,
  runId: string,
): Promise<RecordState | "unreadable"> {
  const field = await grep(seams, stateFieldCommand(runId));
  if (field.kind !== "count" || field.count !== 1) return "unreadable";
  const pending = await grep(seams, pendingCommand(runId));
  if (pending.kind !== "count") return "unreadable";
  if (pending.count === 1) return "reinstall_requested";
  if (pending.count !== 0) return "unreadable";
  const reachable = await grep(seams, reachableCommand(runId));
  if (reachable.kind !== "count") return "unreadable";
  if (reachable.count === 1) return "reachable";
  return reachable.count === 0 ? "other" : "unreadable";
}

export async function readRunIds(seams: Seams): Promise<ListOutcome> {
  const result = await attempt(seams, LIST_RUNS_COMMAND, READ_DEADLINE_MS);
  return classifyList(result ?? UNUSABLE);
}

export interface RunsReading {
  /** The resolved record ids, or null for every stop. */
  ids: string[] | null;
  /** Null when nothing was established. Printed at both rungs so a transcript
   * shows a virgin volume going from false to true across the rebuild. */
  dirPresent: boolean | null;
  listing: ListOutcome["kind"];
  /** Only read when the listing refused, so null on the ordinary path. */
  parent: ParentOutcome["kind"] | null;
  markerPresent: boolean | null;
}

/**
 * The runs directory, and the one case where its ABSENCE is an answer.
 *
 * A listing that refuses is not the end of the question: it is either a
 * directory nobody could read, or a directory that has never existed because no
 * run has ever been written on this volume - and those are different worlds. The
 * second one is a TRUE reading of rung 3's predicate, not a gap in it: where no
 * record exists, no rebuild can be in flight. Establishing it needs the parent
 * listing plus the marker; short of that, the refusal stands.
 */
export async function resolveRuns(seams: Seams): Promise<RunsReading> {
  const listing = await readRunIds(seams);
  if (listing.kind === "ids") {
    return {
      ids: listing.ids,
      dirPresent: true,
      listing: "ids",
      parent: null,
      markerPresent: null,
    };
  }
  if (listing.kind !== "unreadable") {
    // Malformed or over the cap: the directory answered - `classifyList` only
    // reaches either after an exit 0 - so it EXISTS, and its contents are what
    // refuses. An unusable run answered nothing, so presence stays unknown. The
    // parent read has nothing to add to either, and is not taken.
    return {
      ids: null,
      dirPresent: listing.kind === "unusable" ? null : true,
      listing: listing.kind,
      parent: null,
      markerPresent: null,
    };
  }
  const result = await attempt(seams, PARENT_LIST_COMMAND, READ_DEADLINE_MS);
  const parent = classifyParent(result ?? UNUSABLE);
  const markerPresent =
    parent.kind === "runs_absent" || parent.kind === "runs_present"
      ? true
      : parent.kind === "no_marker"
        ? false
        : null;
  if (parent.kind === "runs_absent") {
    return {
      ids: [],
      dirPresent: false,
      listing: "unreadable",
      parent: parent.kind,
      markerPresent,
    };
  }
  return {
    ids: null,
    dirPresent: parent.kind === "runs_present" ? true : null,
    listing: "unreadable",
    parent: parent.kind,
    markerPresent,
  };
}

/** The volume's state root, as booleans, or null for a reading that established
 * nothing. */
export async function readVolume(seams: Seams): Promise<VolumeEntries | null> {
  const result = await attempt(seams, PARENT_LIST_COMMAND, READ_DEADLINE_MS);
  return result === null ? null : volumeEntries(result);
}

/**
 * The OLD root's records, as ids, or null for a reading that established
 * nothing. Read-only: this program never writes to or deletes anything there.
 */
export async function readLegacyRuns(seams: Seams): Promise<string[] | null> {
  const result = await attempt(seams, LEGACY_RUNS_COMMAND, READ_DEADLINE_MS);
  const listing = classifyList(result ?? UNUSABLE);
  return listing.kind === "ids" ? listing.ids : null;
}

export interface AccountOutcome {
  reading: AccountReading | null;
  ok: boolean;
  cancelScheduled: boolean;
  because: string;
}

/**
 * The provider account, read ON the machine and re-judged HERE.
 *
 * The machine ran the same checks; that is not a reason to skip them. Every
 * predicate - completeness, the expected id exactly once, the row/total
 * agreement, the stranger count, the >1 full stop, the closed state list, the
 * date's whole shape - is `judgeRemote`'s, reused rather than restated.
 */
export async function readAccount(seams: Seams): Promise<AccountOutcome> {
  const result = await attempt(seams, ACCOUNT_COMMAND, REMOTE_DEADLINE_MS);
  if (!result) {
    return {
      reading: null,
      ok: false,
      cancelScheduled: false,
      because: "the account read did not run",
    };
  }
  const reading = remoteRunUsable(result) ? parseRemote(result.stdout) : null;
  const verdict = judgeRemote(reading);
  return { reading, ...verdict };
}

function sayAccount(say: Say, outcome: AccountOutcome, suffix: string): void {
  const r = outcome.reading;
  say(`provider_rows${suffix}: ${r ? r.rows : "unknown"}`);
  say(`provider_total_elements${suffix}: ${r ? r.totalElements : "unknown"}`);
  say(`listing_complete${suffix}: ${r ? r.complete : "unknown"}`);
  say(`expected_id_present${suffix}: ${r ? r.expectedIdPresent : "unknown"}`);
  say(`other_instances${suffix}: ${r ? r.otherInstances : "unknown"}`);
  say(`asset_state${suffix}: ${r ? r.assetState : "unknown"}`);
  say(`power_state${suffix}: ${r ? r.powerState : "unknown"}`);
  say(`cancel_date${suffix}: ${r ? r.cancelDate : "unknown"}`);
  say(`account_as_ruling_7_requires${suffix}: ${outcome.ok}`);
  say(`cancel_scheduled${suffix}: ${outcome.cancelScheduled}`);
  say(`because${suffix}: ${outcome.because}`);
}

/**
 * Every record's state, and how many of them are mid-rebuild.
 *
 * Null for "a record could not be read", which refuses: a directory where one
 * file cannot be read is not a directory anybody can say has no pending rebuild
 * in it.
 */
export async function countPending(
  seams: Seams,
  ids: string[],
): Promise<number | null> {
  let pending = 0;
  for (const id of ids) {
    const state = await readRecordState(seams, id);
    if (state === "unreadable") return null;
    if (state === "reinstall_requested") pending += 1;
  }
  return pending;
}

function sayVolume(
  say: Say,
  entries: VolumeEntries | null,
  suffix: string,
): void {
  say(`volume_readable${suffix}: ${entries !== null}`);
  say(`volume_marker${suffix}: ${entries ? entries.marker : "unknown"}`);
  say(`volume_runs${suffix}: ${entries ? entries.runs : "unknown"}`);
  say(`volume_keys${suffix}: ${entries ? entries.keys : "unknown"}`);
  say(`volume_audit${suffix}: ${entries ? entries.audit : "unknown"}`);
}

/** The listing rung's own labels, shared by every mode that takes it. */
function sayRuns(say: Say, reading: RunsReading, suffix: string): void {
  say(`runs_listing${suffix}: ${reading.listing}`);
  if (reading.parent !== null) {
    say(`runs_parent${suffix}: ${reading.parent}`);
    say(
      `runs_parent_marker_present${suffix}: ${reading.markerPresent ?? "unknown"}`,
    );
  }
  say(`runs_dir_present${suffix}: ${reading.dirPresent ?? "unknown"}`);
  if (reading.ids !== null) say(`runs${suffix}: ${reading.ids.length}`);
}

// ---------------------------------------------------------------------- modes

export async function state(seams: Seams): Promise<number> {
  const health = await seams.health();
  seams.say(`health_readable: ${health !== null}`);
  seams.say(`provider_configured: ${health ?? "unknown"}`);
  const pinResult = await attempt(seams, ENV_PIN_COMMAND, READ_DEADLINE_MS);
  seams.say(`env_pin_proved: ${pinResult !== null && envPinProved(pinResult)}`);
  sayVolume(seams.say, await readVolume(seams), "");
  const legacy = await readLegacyRuns(seams);
  seams.say(`legacy_runs: ${legacy === null ? "unknown" : legacy.length}`);
  const runs = await resolveRuns(seams);
  sayRuns(seams.say, runs, "");
  if (runs.ids === null) {
    seams.say("next_action: stop_and_report");
    return REFUSED;
  }
  for (const id of runs.ids) {
    seams.say(`run_state ${id}: ${await readRecordState(seams, id)}`);
  }
  const account = await readAccount(seams);
  sayAccount(seams.say, account, "");
  seams.say("next_action: none");
  return ACCEPTED;
}

/**
 * The rebuild, once.
 *
 * Every rung is an observation taken at the moment it is needed - there is no
 * ledger file and no memory of an earlier rung (landing.ts's doctrine). The
 * order is the only order these may run in: a rebuild before the health reading
 * would act on a machine in an unknown state, and a rebuild before the account
 * listing would act on a box nobody proved is the one this loop may touch.
 */
export async function execute(seams: Seams): Promise<number> {
  const say = seams.say;

  // 1. The machine's own reading of itself. A degraded machine licenses nothing.
  const health = await seams.health();
  say(`health_readable: ${health !== null}`);
  say(`provider_configured: ${health ?? "unknown"}`);
  const permission = mayRun("list", {
    ...NOTHING_OBSERVED,
    providerConfigured: health,
  });
  say(`may_list: ${permission.ok}`);
  say(`because: ${permission.because}`);
  if (!permission.ok) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  // 2. The account, from the provider, complete or not at all.
  const before = await readAccount(seams);
  sayAccount(say, before, "");
  // `!before.ok` is the same belt: `judgeRemote` never reports a scheduled
  // cancel for a reading it refused, so the second clause alone decides today.
  // The invariant that makes that safe is pinned in the test file rather than
  // assumed here.
  if (!before.ok || !before.cancelScheduled) {
    // R-2026-08-12-D4-1 point 3: a box that is no longer cancel-scheduled is a
    // finding for the manager, and nothing touches it.
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  // 3. No rebuild already in flight, proved by files that were read.
  // 2a. The link everything after this depends on: does the env prefix reach the
  // child? Measured here rather than assumed, because the whole defect was a
  // path nobody checked.
  const pinResult = await attempt(seams, ENV_PIN_COMMAND, READ_DEADLINE_MS);
  const pinned = pinResult !== null && envPinProved(pinResult);
  say(`env_pin_proved: ${pinned}`);
  if (!pinned) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  const volumeBefore = await readVolume(seams);
  sayVolume(say, volumeBefore, "_before");
  if (volumeBefore === null) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  const runsBefore = await resolveRuns(seams);
  sayRuns(say, runsBefore, "_before");
  if (runsBefore.ids === null) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  // The negative control's baseline: what the OLD root holds before the run.
  const legacyBefore = await readLegacyRuns(seams);
  say(
    `legacy_runs_before: ${legacyBefore === null ? "unknown" : legacyBefore.length}`,
  );
  if (legacyBefore === null) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }
  const pendingBefore = await countPending(seams, runsBefore.ids);
  say(`pending_rebuilds_before: ${pendingBefore ?? "unknown"}`);
  if (pendingBefore !== 0) {
    say("recycle_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }

  // 4. One spawn. No retry, ever, and no second rebuild on any path.
  say("recycle_spawned: true");
  const result = await attempt(seams, RECYCLE_COMMAND, RECYCLE_DEADLINE_MS);
  if (!result) {
    // A throw AT the spawn is ambiguous, not a refusal: the child may have run.
    say("recycle_threw: true");
    say("recycle_clean: false");
    say("next_action: verify");
    return AMBIGUOUS;
  }
  say(`recycle_exit: ${result.code}`);
  say(`recycle_timed_out: ${result.timedOut}`);
  say(`recycle_group_survived: ${result.groupSurvived}`);
  say(`recycle_group_empty: ${result.groupEmpty}`);
  const clean = remoteRunUsable(result);
  say(`recycle_clean: ${clean}`);

  // 5. Three whitelisted facts, two of them report-only.
  const facts = clean
    ? extractChildFacts(result.stdout)
    : { runId: null, seconds: null, loginUser: null };
  say(`run_id: ${facts.runId ?? "unknown"}`);
  say(`reinstall_to_ssh_seconds: ${facts.seconds ?? "unknown"} (report only)`);
  say(`login_user: ${facts.loginUser ?? "unknown"} (report only)`);

  // 6. The world, not the child: the delta, the states, and the account again.
  const runsAfter = await resolveRuns(seams);
  sayRuns(say, runsAfter, "_after");
  if (runsAfter.ids === null) {
    say("next_action: verify");
    return AMBIGUOUS;
  }
  const delta = judgeDelta(runsBefore.ids, runsAfter.ids, facts.runId);
  say(`runs_added: ${delta.added}`);
  say(`runs_removed: ${delta.removed}`);
  say(`delta_matches_child: ${delta.matchesChild}`);
  say(`delta_because: ${delta.because}`);
  const pendingAfter = await countPending(seams, runsAfter.ids);
  say(`pending_rebuilds_after: ${pendingAfter ?? "unknown"}`);
  const recordState = delta.ok
    ? await readRecordState(seams, facts.runId as string)
    : "unreadable";
  say(`run_state_reachable: ${recordState === "reachable"}`);
  // The negative control: proving the record landed in the right place is not
  // the same as proving nothing landed in the wrong one (reviewer addition).
  const legacyAfter = await readLegacyRuns(seams);
  const legacyAdded =
    legacyAfter === null
      ? null
      : legacyAfter.filter((id) => !legacyBefore.includes(id)).length;
  say(
    `legacy_runs_after: ${legacyAfter === null ? "unknown" : legacyAfter.length}`,
  );
  say(`legacy_runs_added: ${legacyAdded ?? "unknown"}`);

  const volumeAfter = await readVolume(seams);
  sayVolume(say, volumeAfter, "_after");

  const accountAfter = await readAccount(seams);
  sayAccount(say, accountAfter, "_after");
  const dayUnchanged =
    before.reading !== null &&
    accountAfter.reading !== null &&
    before.reading.cancelDate === accountAfter.reading.cancelDate;
  say(`cancel_date_unchanged: ${dayUnchanged}`);

  // THE ACCEPTANCE STATES EVERY PROPERTY IT REQUIRES, including two that a
  // second guard already enforces: `clean` (the child's facts are only extracted
  // from a clean run, so an unclean one has no id and fails the delta) and
  // `delta.ok` (the record state is only read when the delta identified a
  // record). Both are deliberate belts - a mutation that removes either is
  // survivable today and is recorded as such in the G5 report rather than
  // covered by a test that would have to defeat the first guard to reach the
  // second. Written down because an undocumented redundancy is indistinguishable
  // from an untested one (2026-08-12).
  const accepted =
    clean &&
    delta.ok &&
    pendingAfter === 0 &&
    recordState === "reachable" &&
    accountAfter.ok &&
    dayUnchanged &&
    // Audit unity and durability: the pinned run's rows are on the volume.
    volumeAfter !== null &&
    volumeAfter.audit &&
    volumeAfter.runs &&
    volumeAfter.keys &&
    // And nothing landed in the old place.
    legacyAdded === 0;
  say(`recycle_accepted: ${accepted}`);
  if (accepted) {
    say("next_action: none");
    return ACCEPTED;
  }
  say("next_action: verify");
  return AMBIGUOUS;
}

/**
 * What happened, without changing anything.
 *
 * The first thing run after any ambiguity, and the one mode that is allowed to
 * report `reinstall_requested` as an ANSWER rather than as a refusal: a rebuild
 * whose wait was interrupted leaves exactly that, and `--connect` is its
 * recovery.
 */
export async function verify(seams: Seams, runId: string): Promise<number> {
  const say = seams.say;
  const runs = await resolveRuns(seams);
  sayRuns(say, runs, "");
  if (runs.ids === null) {
    say("next_action: stop_and_report");
    return REFUSED;
  }
  say(`run_present: ${runs.ids.includes(runId)}`);
  const recordState = runs.ids.includes(runId)
    ? await readRecordState(seams, runId)
    : "unreadable";
  say(`run_state: ${recordState}`);
  const pending = await countPending(seams, runs.ids);
  say(`pending_rebuilds: ${pending ?? "unknown"}`);
  const account = await readAccount(seams);
  sayAccount(say, account, "");
  if (recordState === "reachable" && pending === 0 && account.ok) {
    say("next_action: none");
    return ACCEPTED;
  }
  if (recordState === "reinstall_requested" && account.ok) {
    // The rebuild was requested and the wait was interrupted. `cli.ts connect`
    // waits and re-pins; it never rebuilds.
    say("next_action: connect");
    return AMBIGUOUS;
  }
  say("next_action: stop_and_report");
  return REFUSED;
}

/**
 * The only sanctioned recovery: wait for the box a provider was asked to
 * rebuild, rather than rebuild it again.
 *
 * Gated on the record actually being mid-rebuild, read the two-call way. A
 * record in any other state is not this command's business.
 */
export async function connect(seams: Seams, runId: string): Promise<number> {
  const say = seams.say;
  const state = await readRecordState(seams, runId);
  say(`run_state: ${state}`);
  if (state !== "reinstall_requested") {
    say("connect_spawned: false");
    say("next_action: stop_and_report");
    return REFUSED;
  }
  say("connect_spawned: true");
  const result = await attempt(
    seams,
    connectCommand(runId),
    CONNECT_DEADLINE_MS,
  );
  if (!result) {
    say("connect_threw: true");
    say("next_action: verify");
    return AMBIGUOUS;
  }
  say(`connect_exit: ${result.code}`);
  say(`connect_timed_out: ${result.timedOut}`);
  say(`connect_group_survived: ${result.groupSurvived}`);
  say(`connect_group_empty: ${result.groupEmpty}`);
  say(`connect_clean: ${remoteRunUsable(result)}`);
  const after = await readRecordState(seams, runId);
  say(`run_state_after: ${after}`);
  if (after === "reachable") {
    say("next_action: none");
    return ACCEPTED;
  }
  say("next_action: verify");
  return AMBIGUOUS;
}

export const PLAN = [
  "G5 recycle, one rebuild of the one box this loop may touch:",
  `  instance: ${EXPECTED_INSTANCE_ID}`,
  `  host: ${HOST}`,
  `  every command carries: env HOME=${PINNED_HOME}`,
  "  1. health: the machine reports provider handlers registered",
  "  2. account: complete listing, expected id present exactly once,",
  "     strangers counted only, cancel date scheduled (R-2026-08-12-D4-1)",
  "  3. runs: every record read, zero mid-rebuild (absence proved, not",
  "     inferred - a refused listing needs the parent's marker to become",
  "     'no record has ever been written here')",
  `  4. one spawn: ${RECYCLE_COMMAND}`,
  "  5. child facts: run id (corroborated), seconds and user (report only)",
  "  6. world: one new record equal to the child's, no record gone, zero",
  "     mid-rebuild, that record reachable, account unchanged and still ours,",
  "     the volume now holding runs, keys AND the audit log, and the old",
  "     ephemeral root having gained nothing",
  "  no retry, no second rebuild, no rollback; ambiguity goes to --verify",
] as const;

// ------------------------------------------------------------------ real seams

const realSeams: Seams = {
  health: readProviderHealth,
  run: (command, deadlineMs) =>
    realBoundedSpawn(
      consoleArgv(command),
      { FLY_API_TOKEN: readSecretFile(FLY_TOKEN_FILE) },
      "",
      deadlineMs,
    ),
  say: (line) => console.log(line),
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  const runArg = args[1] === "--run" ? args[2] : undefined;

  if (args.length === 1 && mode === "--plan") {
    for (const line of PLAN) console.log(line);
    return;
  }
  if (args.length === 1 && mode === "--state") {
    process.exitCode = await state(realSeams);
    return;
  }
  if (args.length === 1 && mode === "--execute") {
    process.exitCode = await execute(realSeams);
    return;
  }
  if (
    args.length === 3 &&
    (mode === "--verify" || mode === "--connect") &&
    runArg !== undefined &&
    isRunId(runArg)
  ) {
    process.exitCode =
      mode === "--verify"
        ? await verify(realSeams, runArg)
        : await connect(realSeams, runArg);
    return;
  }
  console.log(
    "usage: recycle-run.ts <--plan|--state|--execute|" +
      "--verify --run <id>|--connect --run <id>>",
  );
  process.exitCode = USAGE;
}

if (import.meta.main) {
  await main();
}

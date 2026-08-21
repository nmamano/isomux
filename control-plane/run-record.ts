// The recovery record for one box, and when it has to exist.
//
// It is written and fsynced BEFORE the provider action that rebuilds the box,
// for the same reason the create intent is: a crash after Contabo accepts the
// reinstall and before we could write would leave a rebuilt machine carrying a
// key whose paths, blob and runId we no longer know. That is an unexpiring key
// we cannot even connect to in order to put a ceiling on it - the exact state
// the whole design exists to avoid.
//
// `state` is what a restart reads. A `reinstall_requested` run RESUMES the wait
// and then first contact; it never reinstalls again and never mints a second
// key, because the box may already be rebuilding against the key we hold.

import * as fs from "node:fs";
import * as path from "node:path";

export type RunState =
  | "reinstall_requested"
  | "reachable"
  | "first_contact_done"
  | "revoked";

export interface TimerEvidenceRecord {
  enabled: boolean;
  active: boolean;
  persistent: boolean;
  nextElapseUtc: string;
  onCalendar: string;
}

export interface RunRecord {
  runId: string;
  state: RunState;
  host: string;
  instanceId: string;
  ipv4: string;
  loginUser: string;
  privateKeyPath: string;
  publicKeyPath: string;
  algorithm: string;
  blob: string;
  knownHostsFile: string;
  secretId?: number;
  expiry?: string;
  boxClockUtc?: string;
  timerArmed?: TimerEvidenceRecord;
}

/** The durable identity that exists before a paid create is armed. Key material
 * is complete; provider facts stay null until their own remote steps prove them. */
export interface PreparedRunRecord {
  runId: string;
  state: "prepared";
  host: string;
  instanceId: string | null;
  ipv4: null;
  loginUser: string;
  privateKeyPath: string;
  publicKeyPath: string;
  algorithm: string;
  blob: string;
  knownHostsFile: string;
  secretId?: number;
}

export type AnyRunRecord = RunRecord | PreparedRunRecord;

export function runFile(dir: string, runId: string): string {
  return path.join(dir, `${runId}.json`);
}

/** Atomic and fsynced: a half-written recovery record is the same problem as no
 * record at all. */
export function saveRun(dir: string, rec: AnyRunRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = runFile(dir, rec.runId);
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(rec, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  const dirFd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

export function loadRun(dir: string, runId: string): RunRecord | null {
  const rec = loadAnyRun(dir, runId);
  if (rec?.state === "prepared") {
    throw new Error(`run ${runId} is prepared but has no provider address yet`);
  }
  return rec;
}

export function loadAnyRun(dir: string, runId: string): AnyRunRecord | null {
  try {
    return JSON.parse(
      fs.readFileSync(runFile(dir, runId), "utf8"),
    ) as AnyRunRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export type ResumeAction =
  | "wait_for_ssh"
  | "first_contact"
  | "provision"
  | "done";

/**
 * What a restart may do with a run it finds on disk.
 *
 * There is deliberately no arm that rebuilds. A box we asked a provider to
 * reinstall and then lost track of is a human's problem: rebuilding it again
 * would wipe a machine that may already be carrying the key we hold, and
 * minting a second key would strand the first one on it with no ceiling.
 */
export function resumeAction(rec: RunRecord): ResumeAction {
  switch (rec.state) {
    case "reinstall_requested":
      return "wait_for_ssh";
    case "reachable":
      return "first_contact";
    case "first_contact_done":
      return "provision";
    case "revoked":
      return "done";
  }
}

/** The steps a resume is allowed to take. Injected so a test can prove which
 * ones a given state reaches - and that none of them rebuild a box. */
export interface ResumeSteps {
  waitForSsh(rec: RunRecord): Promise<void>;
  firstContact(rec: RunRecord): Promise<void>;
  provision(rec: RunRecord): Promise<void>;
  report(message: string): void;
}

/**
 * Continue an interrupted run from whatever the disk says happened.
 *
 * The operator should never have to hand-drive a half-finished flow, and the
 * state model should never be a thing that exists only in tests. Each state
 * dispatches exactly one safe step and then advances; the provider is not
 * reachable from any of them.
 */
export async function resumeRun(
  dir: string,
  rec: RunRecord,
  steps: ResumeSteps,
): Promise<ResumeAction> {
  const action = resumeAction(rec);
  switch (action) {
    case "wait_for_ssh":
      steps.report(
        `run ${rec.runId} was interrupted after the rebuild was requested; ` +
          `waiting for the box rather than rebuilding it again`,
      );
      await steps.waitForSsh(rec);
      rec.state = "reachable";
      saveRun(dir, rec);
      steps.report(`run ${rec.runId} is reachable; continue with provision`);
      break;
    case "first_contact":
      steps.report(`run ${rec.runId} is reachable but has no ceiling yet`);
      await steps.firstContact(rec);
      break;
    case "provision":
      steps.report(`run ${rec.runId} has a confirmed ceiling; continuing`);
      await steps.provision(rec);
      break;
    case "done":
      steps.report(`run ${rec.runId} is already revoked; nothing to resume`);
      break;
  }
  return action;
}

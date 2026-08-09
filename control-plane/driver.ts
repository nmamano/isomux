// The box side of provisioning: first contact, the install run, and revocation.
//
// Ordering here is not stylistic. On first contact the injected key is a BARE
// key with no ceiling, so rewriting it to carry `expiry-time` and reading that
// back is the first thing that happens on the box - before the wrapper, before
// the installer, before anything. Until the read-back succeeds the box holds an
// unexpiring key, so the step is not complete and provisioning may not proceed.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthOutcome, Exec, SshClient, SshTarget } from "./ssh.ts";
import {
  SshClient as SshClientCtor,
  classifyAuth,
  resolveTimeout,
  sshBaseArgs,
} from "./ssh.ts";
import type { TimeoutSource } from "./ssh.ts";

export const WRAPPER_REMOTE_PATH = "/usr/local/sbin/isomux-cp-run";
export const CLEANUP_REMOTE_PATH = "/usr/local/sbin/isomux-cp-cleanup";
export const CLEANUP_UNIT_NAME = "isomux-cp-cleanup";

/** sshd's authorized_keys option format: an absolute UTC instant. */
export function formatExpiry(when: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(when.getUTCFullYear(), 4)}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}` +
    `${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}Z`
  );
}

/** systemd OnCalendar wants a different rendering of the same instant. */
export function formatOnCalendar(when: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(when.getUTCFullYear(), 4)}-${p(when.getUTCMonth() + 1)}-${p(when.getUTCDate())} ` +
    `${p(when.getUTCHours())}:${p(when.getUTCMinutes())}:${p(when.getUTCSeconds())} UTC`
  );
}

export function authorizedKeysPathFor(user: string): string {
  return user === "root"
    ? "/root/.ssh/authorized_keys"
    : `/home/${user}/.ssh/authorized_keys`;
}

/** Everything the driver needs to know about who it is on the box. */
export interface BoxIdentity {
  /** Which account our key actually landed on, carried as evidence from the
   * adapter. Typed as a plain string because the account a Contabo create
   * produces (`ubuntu`) is not one of the values its API accepts. */
  loginUser: string;
  /** Carried as run evidence from the adapter, never guessed on connect. */
  authorizedKeysPath: string;
}

export function identityFor(loginUser: string): BoxIdentity {
  return {
    loginUser,
    authorizedKeysPath: authorizedKeysPathFor(loginUser),
  };
}

/**
 * Privilege prefix for a remote command. root needs none; anyone else needs
 * `sudo -n`, and a box where that fails is a box we cannot provision.
 *
 * Contabo's API only accepts root/admin/administrator as the login user, but a
 * create that omits it produces `ubuntu` - so which account we land on is
 * carried as evidence from the adapter rather than assumed here.
 */
function privilegeArgv(identity: BoxIdentity): string[] {
  return identity.loginUser === "root" ? [] : ["sudo", "-n"];
}

/**
 * Run one of our shell files on the box as root, with its inputs as positional
 * arguments.
 *
 * The script travels on stdin, so nothing in it is ever quoted or interpolated.
 * The remote command is built only from our own constants, and the arguments
 * are values we generated (a path we computed, an algorithm name, a base64
 * blob, a formatted instant) - never provider output and never customer input.
 */
/**
 * Build a remote script from repo files, helpers first.
 *
 * The authorized_keys surgery lives in ONE file (remote/authorized-keys.sh) and
 * is prepended to whichever script needs it, rather than being copied into
 * three. Shebangs after the first are dropped so the result is still a single
 * valid script.
 */
export function composeRemoteScript(names: string[]): string {
  return names
    .map((name, i) => {
      const body = fs.readFileSync(repoFile(name), "utf8");
      return i === 0 ? body : body.replace(/^#!.*\n/, "");
    })
    .join("\n");
}

async function privilegedScript(
  ssh: SshClient,
  identity: BoxIdentity,
  scriptFile: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const body = composeRemoteScript(["remote/authorized-keys.sh", scriptFile]);
  const remoteArgv = [...privilegeArgv(identity), "bash", "-s", "--", ...args];
  return ssh.pipe(remoteArgv, body);
}

export interface FirstContactResult {
  expiry: string;
  readbackLine: string;
  /** The box's own clock at first contact, for skew and boundary maths. */
  boxClockUtc: string;
}

/**
 * Rewrite our authorized_keys line to carry an absolute expiry and prove it
 * took.
 *
 * MANAGER RULING (2026-08-09, slice 1, clause 1): "The driver itself refuses to
 * rewrite an authorized_keys line without an absolute expiry instant - a
 * missing ceiling stops the run at every layer: argument parsing rejects it AND
 * the driver treats a missing instant as a precondition failure." The check
 * below is that second layer. It is deliberately not delegated to the CLI: the
 * guarantee is a property of the driver, so slice 2 inherits it whatever front
 * end calls in.
 */
export async function rewriteKeyWithExpiry(
  ssh: SshClient,
  identity: BoxIdentity,
  key: { algorithm: string; blob: string },
  expiresAt: Date | undefined,
): Promise<FirstContactResult> {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      "refusing to rewrite an authorized_keys line without an absolute expiry instant",
    );
  }
  const expiry = formatExpiry(expiresAt);
  // The rewrite is the FIRST thing that runs on this box. Nothing - not even a
  // clock read - goes before it: until the read-back succeeds the box holds a
  // key with no ceiling, and every command issued in that window is a command
  // issued under an unbounded key. The clock is read afterwards, below.
  const res = await privilegedScript(ssh, identity, "remote/rewrite-key.sh", [
    identity.authorizedKeysPath,
    key.algorithm,
    key.blob,
    expiry,
  ]);
  if (res.code !== 0 || !res.stdout.includes("RESULT: ok")) {
    throw new Error(
      `expiry rewrite failed (exit ${res.code}): ${firstLineOf(res.stdout, res.stderr)}`,
    );
  }
  const readback = res.stdout
    .split("\n")
    .filter((l) => l.startsWith("READBACK: "))
    .map((l) => l.slice("READBACK: ".length));
  // Exact field match, mirroring the remote script: a line containing our blob
  // as a substring is not our line, and certifying it would certify nothing.
  const line = readback.find((l) => blobOf(l) === key.blob);
  if (!line) {
    throw new Error("expiry rewrite produced no readable line for our key");
  }
  if (!line.includes(`expiry-time="${expiry}"`)) {
    throw new Error(
      "read-back shows our key without the expiry option; the box holds an unexpiring key",
    );
  }
  // Only now, with the ceiling durable and proven, does anything else run.
  const clock = await ssh.script("date -u +%Y-%m-%dT%H:%M:%SZ\n");
  if (clock.code !== 0) {
    throw new Error(`could not read the box clock (exit ${clock.code})`);
  }
  return {
    expiry,
    readbackLine: line,
    boxClockUtc: clock.stdout.trim(),
  };
}

/**
 * Ship a local file to the box, root-owned, at an absolute path.
 *
 * The payload travels on stdin so it is never quoted or interpolated; the
 * remote command is built only from our own constants. `install` writes to a
 * temporary and renames, so a reader never sees a half-written script.
 */
export async function installFile(
  ssh: SshClient,
  identity: BoxIdentity,
  localPath: string,
  remotePath: string,
  mode: string,
): Promise<void> {
  await installText(
    ssh,
    identity,
    fs.readFileSync(localPath, "utf8"),
    remotePath,
    mode,
  );
}

/**
 * Write text to the box, root-owned, at an absolute path.
 *
 * The payload travels on stdin so it is never quoted or interpolated, and the
 * remote command is built only from our own constants. `install` writes to a
 * temporary and renames, so nothing ever reads a half-written script.
 */
export async function installText(
  ssh: SshClient,
  identity: BoxIdentity,
  body: string,
  remotePath: string,
  mode: string,
): Promise<void> {
  const remoteArgv = [
    ...privilegeArgv(identity),
    "install",
    "-m",
    mode,
    "-o",
    "root",
    "-g",
    "root",
    "/dev/stdin",
    remotePath,
  ];
  const res = await ssh.pipe(remoteArgv, body);
  if (res.code !== 0) {
    throw new Error(
      `installing ${remotePath} failed (exit ${res.code}): ${firstLineOf(res.stdout, res.stderr)}`,
    );
  }
}

/**
 * Arm the box-local cleanup at the same instant as the key's expiry.
 *
 * `Persistent=true` so an overdue timer still fires after a boot. The unit
 * removes the script and itself with ExecStartPost rather than having the
 * script delete its own path while bash may still be reading it.
 */
export function renderCleanupUnits(
  authorizedKeysPath: string,
  blob: string,
  expiresAt: Date,
): { service: string; timer: string; onCalendar: string } {
  const onCalendar = formatOnCalendar(expiresAt);
  const service = [
    "[Unit]",
    "Description=Remove isomux setup access from this box",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${CLEANUP_REMOTE_PATH} ${authorizedKeysPath} ${blob}`,
    `ExecStartPost=-/bin/rm -f ${CLEANUP_REMOTE_PATH}`,
    `ExecStartPost=-/bin/rm -f /etc/systemd/system/${CLEANUP_UNIT_NAME}.service /etc/systemd/system/${CLEANUP_UNIT_NAME}.timer`,
    "ExecStartPost=-/bin/systemctl --no-block daemon-reload",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Deadline for isomux setup access",
    "",
    "[Timer]",
    `OnCalendar=${onCalendar}`,
    "Persistent=true",
    "AccuracySec=1s",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer, onCalendar };
}

export interface WaitForSshOptions {
  /** `knownHostsFile` is where the pin LANDS, not where probing happens. */
  target: SshTarget;
  exec: Exec;
  /** A fresh throwaway path per probe, in the same directory as the target's. */
  tempKnownHosts: () => string;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for the box to authenticate our key, and pin its host key from THAT
 * connection.
 *
 * The naive version - probe with `accept-new` straight into the run's
 * known_hosts - is wrong, and live testing is what showed it: `accept-new`
 * records a host key when the connection is made, BEFORE authentication is
 * decided. During a recycle the old system is still answering for several
 * minutes after the provider accepts the reinstall, so the first probe pins the
 * host key of the machine we are in the middle of destroying. Every connection
 * after the rebuild then fails as a host-key mismatch - which is supposed to be
 * a hard stop meaning "something is wrong", and here it would mean "we pinned
 * too early".
 *
 * So each probe pins into a THROWAWAY file, and only the probe that actually
 * authenticates with our key has its file promoted to the run's known_hosts.
 * The pinned key is then, by construction, the key of the box that holds the
 * key we just installed.
 */
export async function probeAndPinOnce(opts: {
  target: SshTarget;
  exec: Exec;
  /** A throwaway path in the same directory as the target's known_hosts. */
  tempKnownHosts: string;
  timeoutMs?: TimeoutSource;
}): Promise<AuthOutcome> {
  const probe = new SshClientCtor(
    { ...opts.target, knownHostsFile: opts.tempKnownHosts },
    opts.exec,
    "accept-new",
    opts.timeoutMs,
  );
  let outcome: AuthOutcome;
  try {
    outcome = await probe.probeAuth();
  } catch (err) {
    fs.rmSync(opts.tempKnownHosts, { force: true });
    throw err;
  }
  if (outcome.kind === "authenticated") {
    fs.renameSync(opts.tempKnownHosts, opts.target.knownHostsFile);
    return outcome;
  }
  // A probe that did not authenticate leaves NO pin behind. Both this and the
  // throwaway path are load-bearing: dropping either one lets the host key of a
  // box we are destroying survive into the run's known_hosts.
  fs.rmSync(opts.tempKnownHosts, { force: true });
  return outcome;
}

/**
 * Drop any pin from a previous life. Separate from the probe because a
 * tick-driven caller must do it ONCE at the start of the operation and then
 * poll, and because the ordering matters at a crash: remove first, record that
 * it was removed second. Recording first would let a crash skip the removal and
 * leave a stale pin in place.
 */
export function resetHostKeyPin(knownHostsFile: string): void {
  fs.rmSync(knownHostsFile, { force: true });
}

export async function waitForAuthenticatedSsh(
  opts: WaitForSshOptions,
): Promise<{ elapsedMs: number }> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 5000;
  const started = now();
  // Nothing from a previous life may survive into this run's pin.
  resetHostKeyPin(opts.target.knownHostsFile);
  for (;;) {
    const outcome = await probeAndPinOnce({
      target: opts.target,
      exec: opts.exec,
      tempKnownHosts: opts.tempKnownHosts(),
    });
    if (outcome.kind === "authenticated") {
      return { elapsedMs: now() - started };
    }
    if (now() - started >= opts.timeoutMs) {
      throw new Error(
        `box never authenticated our key within ${Math.round(opts.timeoutMs / 1000)}s ` +
          `(last outcome: ${outcome.kind})`,
      );
    }
    await sleep(pollMs);
  }
}

export interface TimerEvidence {
  enabled: boolean;
  active: boolean;
  persistent: boolean;
  /** systemd's own rendering of the instant it will next fire. Rendered in the
   * BOX's timezone, so it is evidence that scheduling exists, not evidence of
   * which instant - see onCalendar for that. */
  nextElapseUtc: string;
  /** The OnCalendar spec as systemd loaded it. Echoed verbatim (measured
   * 2026-08-09), so it can be compared exactly against what we asked for. */
  onCalendar: string;
}

/**
 * Read back what systemd actually believes about the cleanup timer.
 *
 * `systemctl enable --now` exiting 0 is not evidence: it says the command was
 * accepted, not that a timer is loaded, active, persistent, and pointed at the
 * instant we meant. The expiry tests are gated on this, so it has to be parsed
 * rather than assumed.
 */
export function parseTimerEvidence(showOutput: string): TimerEvidence {
  const f = new Map<string, string>();
  for (const line of showOutput.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) f.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  // TimersCalendar={ OnCalendar=<spec> ; next_elapse=<timestamp> }
  const cal = /OnCalendar=(.*?)\s*;/.exec(f.get("TimersCalendar") ?? "");
  return {
    enabled: f.get("UnitFileState") === "enabled",
    active: f.get("ActiveState") === "active",
    persistent: f.get("Persistent") === "yes",
    nextElapseUtc: f.get("NextElapseUSecRealtime") ?? "",
    onCalendar: cal?.[1] ?? "",
  };
}

/**
 * Does the evidence show a timer that will enforce OUR ceiling?
 *
 * `expectedOnCalendar` is not optional in spirit. A box can carry an enabled,
 * active, persistent timer left over from an earlier run with a completely
 * different deadline - it would satisfy every other check while enforcing the
 * wrong instant, and the expiry tests would unlock on it. systemd echoes the
 * OnCalendar spec verbatim, so the intended instant is comparable exactly.
 */
export function timerIsArmed(
  ev: TimerEvidence,
  expectedOnCalendar: string,
): boolean {
  return (
    ev.enabled &&
    ev.active &&
    ev.persistent &&
    ev.nextElapseUtc !== "" &&
    expectedOnCalendar !== "" &&
    ev.onCalendar === expectedOnCalendar
  );
}

/**
 * Render the OnCalendar form of an expiry we already recorded, so a later
 * command can re-check the timer against the same instant without trusting a
 * second copy of the value.
 */
export function onCalendarFromExpiry(expiry: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(expiry);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
}

export type LaunchOutcome =
  | { kind: "confirmed"; runId: string }
  | { kind: "failed"; reason: string }
  /**
   * The box already has this generation, so the launch we were unsure about did
   * reach it. The BOX is the arbiter of that ambiguity, which is why re-issuing
   * a launch with the SAME runId is safe: the wrapper refuses to reuse a
   * generation directory, so a second installer cannot start.
   */
  | { kind: "already-exists"; reason: string }
  /** Resolved by the next tick. NEVER by launching again. */
  | { kind: "unconfirmed"; reason: string };

export function parseLaunch(result: {
  code: number;
  stdout: string;
  stderr: string;
}): LaunchOutcome {
  const out = result.stdout.trim();
  if (out.startsWith("CONFIRMED")) {
    return { kind: "confirmed", runId: out.split(/\s+/)[1] ?? "" };
  }
  if (out.startsWith("FAILED") && /already exists/.test(out)) {
    return { kind: "already-exists", reason: out };
  }
  if (out.startsWith("UNCONFIRMED")) {
    return { kind: "unconfirmed", reason: out };
  }
  if (out.startsWith("LOCKED")) {
    return { kind: "unconfirmed", reason: out };
  }
  return {
    kind: "failed",
    reason: out || result.stderr.trim() || `exit ${result.code}`,
  };
}

export type TickState =
  | { state: "none" }
  | { state: "running"; runId: string; pid: string; step: string }
  | { state: "finished"; runId: string; exit: number; step: string }
  | { state: "crashed"; runId: string; step: string };

export function parseTick(stdout: string): TickState {
  const fields = new Map<string, string>();
  for (const part of stdout.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const state = fields.get("state");
  const runId = fields.get("runId") ?? "";
  const step = fields.get("step") ?? "";
  switch (state) {
    case "running":
      return { state: "running", runId, pid: fields.get("pid") ?? "", step };
    case "finished":
      return {
        state: "finished",
        runId,
        exit: Number(fields.get("exit") ?? "-1"),
        step,
      };
    case "crashed":
      return { state: "crashed", runId, step };
    default:
      return { state: "none" };
  }
}

/**
 * Remove our key and our artifacts, and confirm from disk that the line is
 * gone.
 *
 * The cleanup timer is deliberately LEFT ARMED. It is the backstop that must
 * still be in place while the proof runs, and with no customer key there is no
 * post-proof SSH path to remove it - so it is self-removing at its deadline
 * instead. That the timer units outlive revocation until then is a real
 * deviation from "nothing we installed outlives the access window", recorded
 * rather than hidden.
 */
export async function revokeAccess(
  ssh: SshClient,
  identity: BoxIdentity,
  blob: string,
): Promise<void> {
  const res = await privilegedScript(ssh, identity, "remote/revoke-key.sh", [
    identity.authorizedKeysPath,
    blob,
  ]);
  if (!res.stdout.includes("RESULT: removed")) {
    throw new Error(
      `revocation did not confirm removal (exit ${res.code}): ${firstLineOf(res.stdout, res.stderr)}`,
    );
  }
}

export type RemovalProof = { proven: true } | { proven: false; reason: string };

/**
 * Prove the removal the only way that means anything: reconnect AUTHENTICATING
 * WITH THE KEY WE JUST REMOVED, and require sshd to refuse it.
 *
 * Only a classified public-key rejection counts. A timeout, a refused
 * connection, an unresolvable name or a changed host key prove nothing about
 * our key, and accepting any of them would let a network blip certify the
 * guarantee. Those are inconclusive, which is an attention case rather than a
 * pass - and emphatically not a failure to report as success.
 */
export async function proveRemoval(
  target: SshTarget,
  exec: Exec,
  /** Bounded like every other remote call. Unbounded, this one could outlive
   * its holder's lease while the proof that matters most was in flight. */
  timeoutMs?: TimeoutSource,
): Promise<RemovalProof> {
  const argv = [...sshBaseArgs(target, "yes"), "true"];
  const outcome: AuthOutcome = classifyAuth(
    await exec.run(argv, { timeoutMs: resolveTimeout(timeoutMs) }),
  );
  if (outcome.kind === "rejected") return { proven: true };
  if (outcome.kind === "authenticated") {
    return {
      proven: false,
      reason: "the removed key still authenticates; access was NOT revoked",
    };
  }
  return { proven: false, reason: `inconclusive: ${outcome.reason}` };
}

/**
 * The exact base64 blob field of an authorized_keys line, or null.
 *
 * Mirrors ak_blob_of in remote/authorized-keys.sh. Options may contain spaces
 * inside quotes, so the blob is located relative to the algorithm field rather
 * than by counting from the left.
 */
export function blobOf(line: string): string | null {
  const f = line.trim().split(/\s+/);
  for (let i = 0; i < f.length - 1; i++) {
    if (
      /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-\S+)$/.test(f[i]) &&
      /^AAAA[A-Za-z0-9+/=]+$/.test(f[i + 1])
    ) {
      return f[i + 1];
    }
  }
  return null;
}

export function repoFile(name: string): string {
  return path.join(import.meta.dir, name);
}

function firstLineOf(stdout: string, stderr: string): string {
  const text = (stdout || stderr).trim();
  return text.split("\n")[0] ?? "";
}

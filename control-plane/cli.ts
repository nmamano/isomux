#!/usr/bin/env bun
// The one command, and the pieces it is built from.
//
//   list      read the provider account. ALWAYS the first thing done, and the
//             only safe way to answer "do we already have a box?"
//   recycle   rebuild an adopted box with a fresh per-run key
//   provision first contact -> installer -> HTTPS -> invite, and with
//             --handoff-now, revocation and its proof
//   status    one tick against the current generation
//   revoke    revoke, prove, destroy - for the held case and after a failure
//   expiry-test  the ruling-9 verification, both variants
//
// There is deliberately NO create command here. The adapter can create a box
// and the stub tier exercises that path, but no flag in this file reaches it:
// creating one is latched durably by intents.ts and, in this slice, is a thing
// a human does on purpose rather than something a mistyped argument can do.

import * as fs from "node:fs";
import * as path from "node:path";
import { AuditLog } from "./audit.ts";
import {
  AUDIT_FILE,
  DEFAULT_LOGIN_USER,
  KEYS_DIR,
  RUNS_DIR,
  SSH_WAIT_TIMEOUT_MS,
  STATE_ROOT,
  UBUNTU_2404_IMAGE_ID,
} from "./config.ts";
import { ContaboAdapter } from "./contabo/adapter.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "./contabo/auth.ts";
import { ContaboHttp } from "./contabo/http.ts";
import {
  CLEANUP_REMOTE_PATH,
  CLEANUP_UNIT_NAME,
  WRAPPER_REMOTE_PATH,
  identityFor,
  composeRemoteScript,
  installFile,
  installText,
  parseLaunch,
  parseTick,
  proveRemoval,
  onCalendarFromExpiry,
  parseTimerEvidence,
  renderCleanupUnits,
  repoFile,
  timerIsArmed,
  revokeAccess,
  rewriteKeyWithExpiry,
  waitForAuthenticatedSsh,
} from "./driver.ts";
import { destroyPrivateKey, generateKeyPair, type KeyPair } from "./keys.ts";
import { probeLiveness } from "./liveness.ts";
import { Reporter } from "./report.ts";
import { SpawnExec, SshClient, type SshTarget } from "./ssh.ts";

const reporter = new Reporter();
const audit = new AuditLog(AUDIT_FILE, "control-plane-cli");
const exec = new SpawnExec();

// ---------------------------------------------------------------- arguments

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      out.set(arg.slice(2), next && !next.startsWith("--") ? next : "true");
      if (next && !next.startsWith("--")) i++;
    }
  }
  return out;
}

function required(args: Map<string, string>, name: string): string {
  const v = args.get(name);
  if (!v || v === "true") die(`--${name} is required`);
  return v;
}

function die(message: string): never {
  reporter.problem(`error: ${message}`);
  process.exit(2);
}

/**
 * Parse the access window into an absolute instant.
 *
 * MANAGER RULING (2026-08-09, slice 1): slice 1 takes the access window as a
 * REQUIRED parameter with NO DEFAULT, and does not invent a product default -
 * that choice is parked for Nil. This is the argument-parsing layer of clause
 * 1; the driver enforces the same precondition independently, so no front end
 * can talk it out of a ceiling.
 */
function accessWindowInstant(
  args: Map<string, string>,
  now = new Date(),
): Date {
  const raw = args.get("access-window");
  if (!raw || raw === "true") {
    die(
      "--access-window is required and has no default (e.g. 2h, 45m, 3d). " +
        "The product's ceiling is an open question for Nil; slice 1 will not pick one.",
    );
  }
  const m = /^(\d+)([mhd])$/.exec(raw);
  if (!m) die(`--access-window must look like 90m, 2h or 3d (got ${raw})`);
  const n = Number(m[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  if (!unitMs) die(`unknown access-window unit in ${raw}`);
  return new Date(now.getTime() + n * unitMs);
}

// ------------------------------------------------------------------ adapter

function makeAdapter(): ContaboAdapter {
  const creds = credentialsFromEnv();
  const fetchImpl = fetch as unknown as FetchLike;
  return new ContaboAdapter({
    http: new ContaboHttp({
      fetchImpl,
      tokens: new TokenProvider(creds, fetchImpl),
    }),
    imageId: UBUNTU_2404_IMAGE_ID,
    loginUser: DEFAULT_LOGIN_USER,
  });
}

// --------------------------------------------------------------- run record

import type { RunRecord } from "./run-record.ts";
import {
  loadRun as loadRunFrom,
  resumeRun,
  saveRun as saveRunTo,
} from "./run-record.ts";

function saveRun(rec: RunRecord): void {
  saveRunTo(RUNS_DIR, rec);
}

function loadRun(runId: string): RunRecord {
  const rec = loadRunFrom(RUNS_DIR, runId);
  if (!rec) return die(`no run record for ${runId} under ${RUNS_DIR}`);
  return rec;
}

function targetFor(rec: RunRecord): SshTarget {
  return {
    host: rec.ipv4,
    user: rec.loginUser,
    identityFile: rec.privateKeyPath,
    knownHostsFile: rec.knownHostsFile,
  };
}

// ------------------------------------------------------------------ helpers

async function waitForSsh(
  rec: RunRecord,
  timeoutMs = SSH_WAIT_TIMEOUT_MS,
): Promise<number> {
  let n = 0;
  const { elapsedMs } = await waitForAuthenticatedSsh({
    target: targetFor(rec),
    exec,
    tempKnownHosts: () =>
      path.join(KEYS_DIR, `${rec.runId}.known_hosts.probe${n++}`),
    timeoutMs,
  });
  return elapsedMs;
}

function newId(prefix: string): string {
  return `${prefix}-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
}

// ----------------------------------------------------------------- commands

async function cmdList(): Promise<void> {
  const creds = credentialsFromEnv();
  const fetchImpl = fetch as unknown as FetchLike;
  const http = new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(creds, fetchImpl),
  });
  const body = (await http.okOrThrow(
    "GET",
    "/v1/compute/instances?size=100",
  )) as {
    data?: {
      instanceId: number;
      displayName?: string;
      productId?: string;
      region?: string;
      status?: string;
      cancelDate?: string | null;
      ipConfig?: { v4?: { ip?: string } };
    }[];
  } | null;
  const rows = body?.data ?? [];
  reporter.line(`${rows.length} instance(s) on the account:`);
  for (const r of rows) {
    reporter.line(
      `  ${r.instanceId}  ${r.ipConfig?.v4?.ip ?? "-"}  ${r.productId ?? "-"}  ` +
        `${r.region ?? "-"}  ${r.status ?? "-"}  cancelDate=${r.cancelDate ?? "none"}  ` +
        `name=${r.displayName || "-"}`,
    );
  }
  audit.record("list_instances", "contabo", "succeeded");
}

async function cmdRecycle(args: Map<string, string>): Promise<void> {
  const instanceId = required(args, "instance");
  const host = required(args, "host");
  const adapter = makeAdapter();
  const runId = args.get("run-id") ?? newId("run");

  const before = await adapter.get(instanceId);
  reporter.line(
    `adopting instance ${instanceId} (${before.assetState}, ${before.powerState}, ${before.ipv4 ?? "no ip"})`,
  );

  const pair = await generateKeyPair(KEYS_DIR, runId, exec);
  const secretId = await adapter.createSshSecret(
    `isomux-cp-${runId}`,
    pair.publicKeyLine,
  );
  audit.record("create_key_secret", instanceId, "succeeded");

  // The recovery record is written and fsynced BEFORE the reinstall, for the
  // same reason the create intent is: a crash after Contabo accepts the request
  // and before we could write would leave a rebuilt box carrying a key whose
  // paths, blob and runId we no longer know - an unexpiring key we cannot even
  // connect to in order to put a ceiling on. `state` is what a restart reads:
  // a reinstall_requested run RESUMES the wait, and never reinstalls again.
  const rec: RunRecord = {
    runId,
    host,
    instanceId,
    ipv4: before.ipv4 ?? die("adopted instance has no ipv4"),
    loginUser: DEFAULT_LOGIN_USER,
    privateKeyPath: pair.privateKeyPath,
    publicKeyPath: pair.publicKeyPath,
    algorithm: pair.algorithm,
    blob: pair.blob,
    knownHostsFile: path.join(KEYS_DIR, `${runId}.known_hosts`),
    secretId,
    state: "reinstall_requested",
  };
  saveRun(rec);

  reporter.step(
    "recycle",
    `reinstalling ${instanceId} with defaultUser=${DEFAULT_LOGIN_USER}`,
  );
  const startedAt = Date.now();
  await adapter.reinstall(instanceId, {
    imageId: UBUNTU_2404_IMAGE_ID,
    publicKeys: [secretId],
    loginUser: DEFAULT_LOGIN_USER,
  });
  audit.record("reinstall", instanceId, "succeeded");

  const waitedMs = await waitForSsh(rec);
  rec.state = "reachable";
  saveRun(rec);
  reporter.line(
    `MEASUREMENT reinstall-to-SSH: ${Math.round((Date.now() - startedAt) / 1000)}s ` +
      `(ssh wait ${Math.round(waitedMs / 1000)}s)`,
  );
  reporter.line(`run ${runId} recorded; login user is ${rec.loginUser}`);
}

async function cmdProvision(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const expiresAt = accessWindowInstant(args);
  const ownerName = args.get("owner-name") ?? "Owner";
  const ssh = new SshClient(targetFor(rec), exec);
  const identity = identityFor(rec.loginUser);

  // 1. FIRST CONTACT. Nothing else happens on this box until the key carries a
  // ceiling and we have read it back.
  reporter.step("first-contact", "rewriting our key with an absolute expiry");
  const contact = await rewriteKeyWithExpiry(
    ssh,
    identity,
    { algorithm: rec.algorithm, blob: rec.blob },
    expiresAt,
  );
  rec.expiry = contact.expiry;
  rec.boxClockUtc = contact.boxClockUtc;
  saveRun(rec);
  audit.record("arm_expiry", rec.instanceId, "succeeded");
  reporter.line(`expiry confirmed on the box: ${contact.expiry}`);
  reporter.line(
    `MEASUREMENT box clock at first contact: ${contact.boxClockUtc} (ours: ${new Date().toISOString()})`,
  );

  // 2. ARM THE BOX-LOCAL BACKSTOP before anything long-running starts.
  reporter.step("arm-revocation", "installing the cleanup timer");
  await installText(
    ssh,
    identity,
    composeRemoteScript(["remote/authorized-keys.sh", "cleanup.sh"]),
    CLEANUP_REMOTE_PATH,
    "0755",
  );
  const units = renderCleanupUnits(
    identity.authorizedKeysPath,
    rec.blob,
    expiresAt,
  );
  await installText(
    ssh,
    identity,
    units.service,
    `/etc/systemd/system/${CLEANUP_UNIT_NAME}.service`,
    "0644",
  );
  await installText(
    ssh,
    identity,
    units.timer,
    `/etc/systemd/system/${CLEANUP_UNIT_NAME}.timer`,
    "0644",
  );
  const enable = await ssh.script(
    `set -euo pipefail\nsystemctl daemon-reload\nsystemctl enable --now ${CLEANUP_UNIT_NAME}.timer\n`,
  );
  if (enable.code !== 0)
    die(`arming the cleanup timer failed: ${enable.stderr.trim()}`);
  // Exit 0 says the command was accepted, not that a timer is loaded, active,
  // persistent and pointed at our instant. Read systemd's own answer back and
  // parse it; the expiry tests are gated on this evidence.
  const shown = await ssh.script(
    `systemctl show ${CLEANUP_UNIT_NAME}.timer ` +
      `-p UnitFileState -p ActiveState -p Persistent -p NextElapseUSecRealtime ` +
      `-p TimersCalendar\n`,
  );
  const evidence = parseTimerEvidence(shown.stdout);
  if (!timerIsArmed(evidence, units.onCalendar)) {
    die(
      `the cleanup timer is not armed for OUR instant (wanted OnCalendar=` +
        `${units.onCalendar}): ${JSON.stringify(evidence)}. ` +
        `The box would hold a key whose only ceiling is sshd's own expiry.`,
    );
  }
  rec.timerArmed = evidence;
  rec.state = "first_contact_done";
  saveRun(rec);
  audit.record("arm_revocation", rec.instanceId, "succeeded");
  reporter.line(
    `cleanup timer armed: enabled+active+Persistent, next elapse ${evidence.nextElapseUtc}`,
  );

  // Reviewer2's R7: the expiry tests may only run once the PROVISIONING key's
  // rewrite has passed read-back and this timer is armed, so the box is never
  // in a state where a key exists without a ceiling. --stop-after first-contact
  // is how that prerequisite is reached on its own.
  if (args.get("stop-after") === "first-contact") {
    reporter.line(
      "stopping after first contact: the key carries a confirmed ceiling and " +
        "the cleanup timer is armed.",
    );
    return;
  }

  // 3. THE INSTALL, driven through the wrapper.
  //
  // First wait out the box's OWN boot-time package work. SSH answering is not
  // the same claim as ready-to-provision: measured 2026-08-09, apt still held
  // the dpkg lock at T+2min on a box that authenticated at T+88s, and the
  // installer died on it immediately.
  reporter.step(
    "wait-for-package-manager",
    "letting the box finish its own apt work",
  );
  const settleStarted = Date.now();
  const settled = await ssh.pipe(
    [...privilegeArgvFor(identity.loginUser), "bash", "-s", "--", "600"],
    fs.readFileSync(repoFile("remote/wait-apt.sh"), "utf8"),
  );
  if (!settled.stdout.includes("RESULT: ready")) {
    die(
      `the box never finished its own package work: ${settled.stdout.trim()}`,
    );
  }
  reporter.line(
    `MEASUREMENT wait-for-package-manager: ${Math.round((Date.now() - settleStarted) / 1000)}s ` +
      `(${settled.stdout.trim()})`,
  );

  reporter.step("run-installer", "installing the wrapper and launching");
  await installFile(
    ssh,
    identity,
    repoFile("wrapper.sh"),
    WRAPPER_REMOTE_PATH,
    "0755",
  );
  const installerRunId = newId("install");
  // Upload the installer from THIS tree rather than curling it from GitHub.
  // The point of driving it is to test the installer we have, and a fix that
  // has not been pushed yet is invisible to a fetch from main. (Production will
  // drive a release's installer; that choice belongs to the deployed
  // provisioner, not to the driver.)
  await installText(
    ssh,
    identity,
    fs.readFileSync(
      path.join(import.meta.dir, "..", "deploy", "install.sh"),
      "utf8",
    ),
    "/tmp/isomux-install.sh",
    "0755",
  );

  const launch = parseLaunch(
    await ssh.script(
      `${identity.loginUser === "root" ? "" : "sudo -n "}${WRAPPER_REMOTE_PATH} launch "$1" env DOMAIN="$2" OWNER_NAME="$3" bash /tmp/isomux-install.sh\n`,
      [installerRunId, rec.host, ownerName],
    ),
  );
  if (launch.kind === "failed") die(`launch failed: ${launch.reason}`);
  if (launch.kind === "unconfirmed") {
    reporter.problem(
      `launch unconfirmed (${launch.reason}); resolving by tick, NOT relaunching`,
    );
  }
  audit.record("run_installer", installerRunId, "started");

  // 4. TICK until the generation is terminal.
  const installStarted = Date.now();
  let lastStep = "";
  for (;;) {
    const tick = parseTick(
      (await ssh.script(`${WRAPPER_REMOTE_PATH} tick\n`)).stdout,
    );
    if (tick.state === "running" && tick.step !== lastStep) {
      lastStep = tick.step;
      reporter.line(
        `  step: ${tick.step} (+${Math.round((Date.now() - installStarted) / 1000)}s)`,
      );
    }
    if (tick.state === "finished") {
      reporter.line(
        `MEASUREMENT install duration: ${Math.round((Date.now() - installStarted) / 1000)}s, exit=${tick.exit}`,
      );
      if (tick.exit !== 0) {
        audit.record("run_installer", installerRunId, "failed");
        die(`installer exited ${tick.exit} at step ${tick.step}`);
      }
      audit.record("run_installer", installerRunId, "succeeded");
      break;
    }
    if (tick.state === "crashed") {
      audit.record("run_installer", installerRunId, "failed", "crashed");
      die(`installer crashed at step ${tick.step}`);
    }
    await Bun.sleep(5000);
  }

  if (args.get("stop-after") === "install") {
    reporter.line(
      "stopping after the install. HTTPS and the invite need the A record; " +
        `finish with: finish --run ${rec.runId}`,
    );
    return;
  }

  await finishHandoff(rec, args);
}

/**
 * The tail of provisioning: wait for HTTPS, mint the invite, and - only when
 * asked - hand off.
 *
 * Separate from the install because it is the one part that depends on DNS.
 * Caddy retries HTTP-01 until the name resolves, so an install can complete
 * long before the record exists, and only a SUCCESSFUL issuance counts against
 * Let's Encrypt's duplicate-certificate limit.
 */
async function finishHandoff(
  rec: RunRecord,
  args: Map<string, string>,
): Promise<void> {
  const httpsStarted = Date.now();
  reporter.step("verify-https", `waiting for https://${rec.host}/readyz`);
  for (;;) {
    const live = await probeLiveness(rec.host, {}, rec.ipv4);
    if (live.rung === "ok") {
      reporter.line(
        `MEASUREMENT install-exit to HTTPS 200: ${Math.round((Date.now() - httpsStarted) / 1000)}s`,
      );
      break;
    }
    reporter.line(`  liveness rung ${live.rung}: ${live.detail}`);
    if (Date.now() - httpsStarted > 20 * 60_000) {
      audit.record("verify_https", rec.host, "failed", live.rung);
      die(`HTTPS never came up (stuck at rung ${live.rung})`);
    }
    await Bun.sleep(15_000);
  }
  audit.record("verify_https", rec.host, "succeeded");

  await mintInvite(rec);

  if (args.get("handoff-now") === "true") {
    await revokeAndProve(rec);
  } else {
    reporter.line(
      "access window is OPEN (default). Run `revoke --run " +
        rec.runId +
        "` to hand off, or pass --handoff-now next time.",
    );
  }
}

/**
 * Mint an owner invite and show it to the operator once.
 *
 * Available while the access window is open, which is what makes "resend" work
 * without us ever storing a credential. The URL reaches the terminal and
 * nothing else: the audit log records that a mint happened, and the transcript
 * carries a redaction in its place.
 */
async function mintInvite(rec: RunRecord): Promise<void> {
  const identity = identityFor(rec.loginUser);
  const ssh = new SshClient(targetFor(rec), exec);
  reporter.step("mint-invite", "minting a fresh owner invite");
  const minted = await ssh.pipe(
    [...privilegeArgvFor(identity.loginUser), "bash", "-s"],
    fs.readFileSync(repoFile("remote/mint-invite.sh"), "utf8"),
  );
  if (minted.code !== 0)
    die(`minting the invite failed: ${minted.stderr.trim()}`);
  audit.record("mint_invite", rec.host, "succeeded");
  reporter.invite(minted.stdout.trim());
}

function privilegeArgvFor(loginUser: string): string[] {
  return loginUser === "root" ? [] : ["sudo", "-n"];
}

/**
 * Revoke, then prove it, then destroy our half.
 *
 * The order is the guarantee: remove and confirm from disk while the session is
 * alive, close it, reconnect with the REMOVED key and require sshd to refuse
 * it, and only then destroy the private half. The cleanup timer stays armed
 * throughout - it is the backstop that must still be in place if the proof
 * comes back saying the removal did not take.
 */
async function revokeAndProve(rec: RunRecord): Promise<void> {
  const identity = identityFor(rec.loginUser);
  reporter.step("revoke-access", "removing our key and our artifacts");
  const ssh = new SshClient(targetFor(rec), exec);
  await revokeAccess(ssh, identity, rec.blob);
  audit.record("revoke_access", rec.instanceId, "succeeded");

  reporter.step("prove-removal", "reconnecting with the key we just removed");
  const proof = await proveRemoval(targetFor(rec), exec);
  if (!proof.proven) {
    audit.record("verify_revocation", rec.instanceId, "failed", proof.reason);
    die(
      `REVOCATION NOT PROVEN: ${proof.reason}. The cleanup timer is still armed and ` +
        `the key still carries expiry-time=${rec.expiry ?? "unknown"}. This needs a human.`,
    );
  }
  audit.record("verify_revocation", rec.instanceId, "succeeded");
  reporter.line(
    "proof: sshd refused the removed key (publickey). Access is gone.",
  );

  destroyPrivateKey({
    privateKeyPath: rec.privateKeyPath,
    publicKeyPath: rec.publicKeyPath,
  } as KeyPair);
  audit.record("destroy_key", rec.instanceId, "succeeded");
  reporter.line("our private half is destroyed.");
}

/**
 * Re-establish contact with a recorded box: wait for our key to authenticate
 * and pin the host key from that same connection.
 *
 * Separate from `recycle` because a box can go away and come back for reasons
 * other than a rebuild - a power cycle across an expiry test, most obviously -
 * and re-pinning has to be a deliberate act rather than a side effect.
 */
async function cmdConnect(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const waited = await waitForSsh(rec);
  // Advance the state, so a run that was interrupted after its rebuild does not
  // sit at reinstall_requested forever and invite someone to rebuild it again.
  if (rec.state === "reinstall_requested") {
    rec.state = "reachable";
    saveRun(rec);
  }
  reporter.line(
    `authenticated as ${rec.loginUser}@${rec.ipv4} after ${Math.round(waited / 1000)}s; ` +
      `host key pinned in ${rec.knownHostsFile}`,
  );
  audit.record("connect", rec.instanceId, "succeeded");
}

/**
 * Continue an interrupted run from what the disk says happened.
 *
 * This is the command that makes the state model real. Without it the operator
 * has to work out by hand which half of a one-command flow already ran, and the
 * safest step is the one nobody thinks of under pressure: WAIT for the box we
 * asked a provider to rebuild, rather than rebuild it again.
 */
async function cmdResume(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const action = await resumeRun(RUNS_DIR, rec, {
    waitForSsh: async (r) => {
      const waited = await waitForSsh(r);
      reporter.line(`reachable after ${Math.round(waited / 1000)}s`);
    },
    firstContact: (r) => {
      reporter.line(
        `next: provision --run ${r.runId} --access-window <window> --stop-after first-contact`,
      );
      return Promise.resolve();
    },
    provision: (r) => {
      reporter.line(
        `next: provision --run ${r.runId} --access-window <window>`,
      );
      return Promise.resolve();
    },
    report: (m) => reporter.line(m),
  });
  audit.record("resume", rec.instanceId, "succeeded", action);
}

async function cmdStatus(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const ssh = new SshClient(targetFor(rec), exec);
  const tick = parseTick(
    (await ssh.script(`${WRAPPER_REMOTE_PATH} tick\n`)).stdout,
  );
  reporter.line(JSON.stringify(tick));
}

async function cmdRevoke(args: Map<string, string>): Promise<void> {
  await revokeAndProve(loadRun(required(args, "run")));
}

/**
 * Ruling 9: prove Ubuntu 24.04's OpenSSH honours `expiry-time`, rather than
 * assuming it because the version is new enough.
 *
 * Runs on a SCRATCH key, never the provisioning key, so a surprise here cannot
 * lock us out of the box. Prerequisite (Reviewer2): the provisioning key's
 * rewrite must already have passed read-back and the cleanup timer must be
 * armed, so the box is never in a state where a key exists without a ceiling.
 */
async function cmdExpiryTest(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  // R7, enforced on EVIDENCE rather than on a field that provision happened to
  // set early: the provisioning key's ceiling must be confirmed AND the
  // box-local backstop must be armed before any scratch key exists, so the box
  // is never in a state where a key exists without a ceiling.
  if (!rec.expiry) {
    die(
      "run this only after provision has confirmed the provisioning key's expiry",
    );
  }
  if (
    !rec.timerArmed ||
    !timerIsArmed(rec.timerArmed, onCalendarFromExpiry(rec.expiry))
  ) {
    die(
      "the cleanup timer is not proven armed for THIS run's instant; refusing " +
        "to add a scratch key. Re-run provision --stop-after first-contact.",
    );
  }
  const variant = args.get("variant") ?? "boundary";
  const identity = identityFor(rec.loginUser);
  const ssh = new SshClient(targetFor(rec), exec);
  const seconds = Number(args.get("seconds") ?? "120");

  const scratch = await generateKeyPair(
    KEYS_DIR,
    `${rec.runId}-scratch-${variant}`,
    exec,
  );
  const clock = await ssh.script("date -u +%s\n");
  const boxEpoch = Number(clock.stdout.trim());
  const deadline = new Date((boxEpoch + seconds) * 1000);
  const { formatExpiry } = await import("./driver.ts");
  const expiry = formatExpiry(deadline);
  reporter.line(
    `box epoch ${boxEpoch}, ours ${Math.floor(Date.now() / 1000)} ` +
      `(skew ${boxEpoch - Math.floor(Date.now() / 1000)}s); scratch key expires ${expiry}`,
  );

  // The key line is rebuilt on the box from tokens that cannot be re-split.
  // Passing the whole "ssh-ed25519 AAAA... comment" line as one argument does
  // not survive the remote shell - see SshClient.pipe.
  const add = await ssh.pipe(
    [
      ...privilegeArgvFor(identity.loginUser),
      "bash",
      "-s",
      "--",
      identity.authorizedKeysPath,
      expiry,
      scratch.algorithm,
      scratch.blob,
    ],
    'set -euo pipefail\nprintf \'expiry-time="%s" %s %s scratch\\n\' "$2" "$3" "$4" >>"$1"\n' +
      'grep -cF -- "$4" "$1"\n',
  );
  if (add.code !== 0)
    die(`could not add the scratch key: ${add.stderr.trim()}`);

  const scratchTarget: SshTarget = {
    ...targetFor(rec),
    identityFile: scratch.privateKeyPath,
  };
  const before = await new SshClient(scratchTarget, exec).probeAuth();
  reporter.line(`BEFORE the deadline: ${before.kind} (expected authenticated)`);
  // Enforced, not merely printed. A scratch key that never authenticated makes
  // the AFTER assertion vacuous: it would be rejected whether or not sshd
  // honours expiry-time, and the test would pass while proving nothing.
  if (before.kind !== "authenticated") {
    die(
      `the scratch key did not authenticate BEFORE its deadline (${JSON.stringify(before)}). ` +
        `The test proves nothing in this state, so it fails rather than reporting a pass.`,
    );
  }

  if (variant === "powered-off") {
    const adapter = makeAdapter();
    reporter.line("powering the box off across the deadline");
    await adapter.powerOff(rec.instanceId);
    await Bun.sleep((seconds + 60) * 1000);
    reporter.line("powering back on");
    await adapter.powerOn(rec.instanceId);
    await waitForSshWithKey(rec, scratchTarget);
  } else {
    await Bun.sleep((seconds + 20) * 1000);
  }

  const after = await new SshClient(scratchTarget, exec).probeAuth();
  reporter.line(
    `AFTER the deadline: ${JSON.stringify(after)} (expected rejected)`,
  );
  if (after.kind !== "rejected") {
    die(
      `expiry-time did NOT hold: ${after.kind}. The whole access ceiling rests on this.`,
    );
  }
  // Take the scratch line off the box. An expired key is harmless - sshd
  // refuses it - but revocation only removes our provisioning blob, so without
  // this the test would leave its litter behind on a customer's machine.
  const swept = await ssh.pipe(
    [
      ...privilegeArgvFor(identity.loginUser),
      "bash",
      "-s",
      "--",
      identity.authorizedKeysPath,
      scratch.blob,
    ],
    'set -uo pipefail\ngrep -vF -- "$2" "$1" > "$1.tmp" || true\n' +
      'chmod --reference="$1" "$1.tmp" 2>/dev/null || chmod 600 "$1.tmp"\n' +
      'mv -f "$1.tmp" "$1"\ngrep -cF -- "$2" "$1" || true\n',
  );
  if (swept.code !== 0) {
    reporter.problem(`warning: could not sweep the scratch key off the box`);
  }
  destroyPrivateKey(scratch);
  reporter.line(`expiry-time verified (${variant} variant).`);
}

/** Wait for the box to answer at all again after a power cycle. Uses the
 * PROVISIONING key, since the scratch key is expected to be dead by then. */
async function waitForSshWithKey(
  rec: RunRecord,
  _scratch: SshTarget,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const outcome = await new SshClient(targetFor(rec), exec).probeAuth();
    if (outcome.kind !== "inconclusive") return;
    await Bun.sleep(5000);
  }
  die("box did not come back after the power cycle");
}

// -------------------------------------------------------------------- entry

async function main(): Promise<void> {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "list":
      return cmdList();
    case "recycle":
      return cmdRecycle(args);
    case "provision":
      return cmdProvision(args);
    case "connect":
      return cmdConnect(args);
    case "mint":
      return mintInvite(loadRun(required(args, "run")));
    case "finish":
      return finishHandoff(loadRun(required(args, "run")), args);
    case "resume":
      return cmdResume(args);
    case "status":
      return cmdStatus(args);
    case "revoke":
      return cmdRevoke(args);
    case "expiry-test":
      return cmdExpiryTest(args);
    default:
      reporter.line(
        "usage: bun control-plane/cli.ts <list|recycle|connect|resume|provision|finish|mint|status|revoke|expiry-test> [--flags]",
      );
      process.exit(2);
  }
}

await main();

// One poll-once handler per operation kind.
//
// Slice 1 drove the box with three blocking loops: wait-for-SSH, the installer
// tick loop and the HTTPS wait. Nothing here loops. Each handler makes ONE
// bounded remote call and returns a verdict; the scheduler owns the waiting, so
// a crash between two polls is just a tick that did not happen rather than a
// half-finished flow nobody can resume.
//
// The slice-1 primitives are called, not reimplemented: the authorized_keys
// surgery, the pin-into-a-throwaway probe, the launch/tick protocol and the
// removal proof all still live in driver.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { CREATE_ARMED_PHASE } from "./create-latch.ts";
import type { CreateCoordinator } from "./create-coordinator.ts";
import {
  CLEANUP_REMOTE_PATH,
  CLEANUP_UNIT_NAME,
  WRAPPER_REMOTE_PATH,
  composeRemoteScript,
  identityFor,
  installFile,
  installText,
  parseLaunch,
  parseTick,
  parseTimerEvidence,
  probeAndPinOnce,
  proveRemoval,
  renderCleanupUnits,
  repoFile,
  resetHostKeyPin,
  revokeAccess,
  rewriteKeyWithExpiry,
  timerIsArmed,
} from "./driver.ts";
import { destroyPrivateKey, type KeyPair } from "./keys.ts";
import { probeLiveness } from "./liveness.ts";
import type { Reporter } from "./report.ts";
import { loadRun, saveRun, type RunRecord } from "./run-record.ts";
import {
  ObserverWriteFailed,
  SshClient,
  type Exec,
  type SshTarget,
} from "./ssh.ts";
import { auditOutcomeOf } from "./tick.ts";
import type { HandlerContext, Handler, HandlerResult } from "./tick.ts";
import type { CreateRequest } from "./provider.ts";

export interface HandlerDeps {
  exec: Exec;
  reporter: Reporter;
  runsDir: string;
  keysDir: string;
  /** Present only where a create is possible at all. The CLI never supplies it. */
  coordinator?: CreateCoordinator;
  createRequest?: (instanceId: string) => CreateRequest;
  /** Where the installer comes from. Injected so a test needs no 100KB fixture. */
  installerPath?: string;
  ownerName?: string;
  /**
   * Where a DASHBOARD-REQUESTED invite goes: the provisioner's in-memory
   * one-shot hold, and nowhere else.
   *
   * A narrow structural type rather than the class, so this file cannot reach
   * anything else on it. Present only in the long-lived provisioner; its
   * ABSENCE is what makes a customer-requested mint refuse rather than fall
   * back to printing a live credential at whoever is watching the process.
   */
  deliver?: {
    hold(operationId: string, instanceId: string, url: string): void;
  };
}

// --------------------------------------------------------------- utilities

function evidenceOf(ctx: HandlerContext): Record<string, unknown> {
  try {
    return JSON.parse(ctx.op.evidence) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function runFor(ctx: HandlerContext, deps: HandlerDeps): RunRecord {
  const runId = ctx.instance.run_id;
  if (!runId) throw new Error(`instance ${ctx.instance.id} has no run record`);
  const rec = loadRun(deps.runsDir, runId);
  if (!rec) throw new Error(`no run record ${runId} under ${deps.runsDir}`);
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

/**
 * An ssh client whose every call is bounded by what is LEFT of the handler's
 * shared budget.
 *
 * A per-child bound is not a bound on a handler that runs several children, so
 * the client is handed a function rather than a number: each call re-reads the
 * remaining budget, and a call with nothing left is refused before it starts
 * rather than killed halfway.
 */
function sshFor(
  ctx: HandlerContext,
  rec: RunRecord,
  deps: HandlerDeps,
  /** The STEP this client belongs to. Every child it runs is audited under this
   * name, so a primitive that issues three commands leaves three records. */
  label: string,
): SshClient {
  return new SshClient(
    targetFor(rec),
    deps.exec,
    "yes",
    () => ctx.budget.claim(label),
    (phase, kind) => ctx.audit(label, phase, kind),
  );
}

/**
 * Run one remote step: claim budget, record that it STARTED, act, record the
 * outcome.
 *
 * The `started` row goes down BEFORE the call is issued, which is the only crash
 * boundary we can actually guarantee: a process that dies mid-call leaves a
 * started event with no outcome, and that is exactly the state a human needs to
 * see. Details are classified - never remote output, never a URL.
 */
async function remote<T>(
  ctx: HandlerContext,
  action: string,
  fn: () => Promise<T>,
): Promise<T> {
  ctx.budget.claim(action);
  ctx.audit(action, "started");
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    // A call that threw may still have acted, so the audit says ambiguous
    // rather than failed whenever the transport is what gave up.
    try {
      ctx.audit(action, auditOutcomeOf(err));
    } catch {
      // The original error describes the situation better than this one.
    }
    throw err;
  }
  try {
    ctx.audit(action, "succeeded");
  } catch (err) {
    try {
      ctx.audit(action, "ambiguous");
    } catch {
      // The store is the thing that is failing; there is nowhere else to say so.
    }
    // The call HAPPENED. A storage failure here must never come back as a plain
    // failure, or a scheduler would retry a mutation the box already applied.
    throw new ObserverWriteFailed(
      `${action} ran and could not be recorded: ${messageOf(err)}`,
    );
  }
  return out;
}

function privilegeArgvFor(loginUser: string): string[] {
  return loginUser === "root" ? [] : ["sudo", "-n"];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a string out of persisted evidence. Anything that is not a string is
 * treated as absent rather than stringified: evidence is JSON we wrote, and a
 * field of the wrong shape is a bug to notice, not to coerce. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ------------------------------------------------------------ wait_for_ssh

/**
 * Wait for the box to authenticate our key, one probe per tick.
 *
 * The crash ordering is the interesting part. The run's known_hosts must be
 * cleared before the first probe, or a pin from a previous life survives into
 * this run. So the removal happens FIRST and the "it was removed" evidence is
 * recorded SECOND: a crash in between repeats a harmless removal, whereas
 * recording first could skip the removal entirely and leave a stale pin that
 * every later connection would trip over.
 */
export function waitForSshHandler(deps: HandlerDeps): Handler {
  return {
    kind: "wait_for_ssh",
    // Read-only: a probe that timed out changed nothing on the box.
    timeoutIsRetryable: true,
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const ev = evidenceOf(ctx);
      if (!ev.pinReset) {
        resetHostKeyPin(rec.knownHostsFile);
        return { kind: "progress", evidence: { pinReset: true, probes: 0 } };
      }
      const probes = Number(ev.probes ?? 0);
      const outcome = await remote(ctx, "ssh_probe", () =>
        probeAndPinOnce({
          target: targetFor(rec),
          exec: deps.exec,
          // Holder and attempt in the name: two holders never share a temp path.
          tempKnownHosts: path.join(
            deps.keysDir,
            `${rec.runId}.known_hosts.${ctx.fence.holder.replace(/[^A-Za-z0-9]/g, "")}.${probes}`,
          ),
          timeoutMs: () => ctx.budget.claim("ssh_probe"),
        }),
      );
      if (outcome.kind === "authenticated") {
        if (rec.state === "reinstall_requested") {
          rec.state = "reachable";
          saveRun(deps.runsDir, rec);
        }
        return {
          kind: "done",
          evidence: { pinReset: true, authenticated: true },
        };
      }
      const last = outcome.kind === "rejected" ? "rejected" : outcome.reason;
      if (last !== ev.last) {
        return {
          kind: "progress",
          evidence: { pinReset: true, probes: probes + 1, last },
        };
      }
      return {
        kind: "waiting",
        evidence: { pinReset: true, probes: probes + 1, last },
      };
    },
  };
}

// ------------------------------------------------ wait_for_package_manager

/**
 * The box is not ready when SSH answers: a rebuilt cloud image runs its own apt
 * work on boot and holds the dpkg lock for minutes. One check per tick, using
 * the remote script's `once` mode - the loop mode would sleep inside a tick.
 */
export function waitForPackageManagerHandler(deps: HandlerDeps): Handler {
  return {
    kind: "wait_for_package_manager",
    timeoutIsRetryable: true,
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const ev = evidenceOf(ctx);
      const ssh = sshFor(ctx, rec, deps, "package_manager_probe");
      const res = await remote(ctx, "package_manager_probe", () =>
        ssh.pipe(
          [...privilegeArgvFor(rec.loginUser), "bash", "-s", "--", "once"],
          fs.readFileSync(repoFile("remote/wait-apt.sh"), "utf8"),
        ),
      );
      const out = res.stdout.trim();
      if (out.includes("RESULT: ready")) {
        return { kind: "done", evidence: { ready: true } };
      }
      if (!out.startsWith("RESULT: busy")) {
        return { kind: "retry", reason: `unreadable package-manager probe` };
      }
      // The reason string is the evidence: while it changes, the box is making
      // progress rather than being stuck on one holder.
      return out === ev.busy
        ? { kind: "waiting", evidence: { busy: out } }
        : { kind: "progress", evidence: { busy: out } };
    },
  };
}

// ----------------------------------------------------------- first_contact

/**
 * Rewrite our authorized_keys line to carry an absolute expiry, and prove it
 * took. Nothing else may happen on the box until this succeeds: until the
 * read-back passes, the box holds a key with no ceiling.
 */
export function firstContactHandler(deps: HandlerDeps): Handler {
  return {
    kind: "first_contact",
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const expiresAt = ctx.instance.access_window_expires_at;
      if (!expiresAt) {
        // The same refusal the driver makes, one layer earlier: a missing
        // ceiling stops the run at every layer.
        return {
          kind: "fatal",
          reason:
            "the instance has no access-window ceiling; refusing to rewrite an " +
            "authorized_keys line without an absolute expiry instant",
        };
      }
      const ssh = sshFor(ctx, rec, deps, "arm_expiry");
      const contact = await remote(ctx, "arm_expiry", () =>
        rewriteKeyWithExpiry(
          ssh,
          identityFor(rec.loginUser),
          { algorithm: rec.algorithm, blob: rec.blob },
          new Date(expiresAt),
        ),
      );
      rec.expiry = contact.expiry;
      rec.boxClockUtc = contact.boxClockUtc;
      saveRun(deps.runsDir, rec);
      ctx.report(`expiry confirmed on the box: ${contact.expiry}`);
      return {
        kind: "done",
        evidence: { expiry: contact.expiry, boxClockUtc: contact.boxClockUtc },
      };
    },
  };
}

// ---------------------------------------------------------- arm_revocation

/**
 * Arm the box-local backstop at the same instant, and read systemd's own answer
 * back. `systemctl enable --now` exiting 0 says the command was accepted, not
 * that a timer is loaded, active, persistent and pointed at OUR instant.
 */
export function armRevocationHandler(deps: HandlerDeps): Handler {
  return {
    kind: "arm_revocation",
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      if (!rec.expiry) {
        return {
          kind: "fatal",
          reason:
            "no confirmed expiry on the run; first contact has not passed",
        };
      }
      const identity = identityFor(rec.loginUser);
      const expiresAt = new Date(ctx.instance.access_window_expires_at ?? 0);
      await remote(ctx, "install_cleanup_script", () =>
        installText(
          sshFor(ctx, rec, deps, "install_cleanup_script"),
          identity,
          composeRemoteScript(["remote/authorized-keys.sh", "cleanup.sh"]),
          CLEANUP_REMOTE_PATH,
          "0755",
        ),
      );
      const units = renderCleanupUnits(
        identity.authorizedKeysPath,
        rec.blob,
        expiresAt,
      );
      const unitSsh = sshFor(ctx, rec, deps, "install_cleanup_units");
      await remote(ctx, "install_cleanup_units", async () => {
        await installText(
          unitSsh,
          identity,
          units.service,
          `/etc/systemd/system/${CLEANUP_UNIT_NAME}.service`,
          "0644",
        );
        await installText(
          unitSsh,
          identity,
          units.timer,
          `/etc/systemd/system/${CLEANUP_UNIT_NAME}.timer`,
          "0644",
        );
      });
      const enable = await remote(ctx, "enable_cleanup_timer", () =>
        sshFor(ctx, rec, deps, "enable_cleanup_timer").script(
          `set -euo pipefail\nsystemctl daemon-reload\nsystemctl enable --now ${CLEANUP_UNIT_NAME}.timer\n`,
        ),
      );
      if (enable.code !== 0) {
        return { kind: "retry", reason: "arming the cleanup timer failed" };
      }
      const shown = await remote(ctx, "read_cleanup_timer", () =>
        sshFor(ctx, rec, deps, "read_cleanup_timer").script(
          `systemctl show ${CLEANUP_UNIT_NAME}.timer ` +
            `-p UnitFileState -p ActiveState -p Persistent -p NextElapseUSecRealtime ` +
            `-p TimersCalendar\n`,
        ),
      );
      const evidence = parseTimerEvidence(shown.stdout);
      if (!timerIsArmed(evidence, units.onCalendar)) {
        return {
          kind: "retry",
          reason:
            `the cleanup timer is not armed for OUR instant (wanted ` +
            `${units.onCalendar}, systemd reports ${evidence.onCalendar || "nothing"})`,
        };
      }
      rec.timerArmed = evidence;
      rec.state = "first_contact_done";
      saveRun(deps.runsDir, rec);
      return { kind: "done", evidence: { timer: evidence } };
    },
  };
}

// ----------------------------------------------------------- run_installer

/**
 * Drive install.sh through the box wrapper, one tick at a time.
 *
 * The persisted phase decides what may happen, and each phase has exactly one
 * legal act:
 *
 *   staged                 -> allocate a runId and PERSIST IT, without launching
 *   launching              -> tick; if the box has no generation, re-issue the
 *                             launch with the SAME runId. The wrapper refuses to
 *                             reuse a generation directory, so the BOX arbitrates
 *                             whether the launch we were unsure about happened
 *   awaiting_publication   -> tick only. An UNCONFIRMED or LOCKED launch is
 *                             never relaunched, for the same reason an ambiguous
 *                             create is never replayed
 *   running                -> tick
 *
 * Persisting the runId BEFORE the launch is what makes a crash between the
 * remote launch and the result write recoverable: recovery reads a runId, ticks,
 * and can only ever re-issue the same generation.
 */
export function runInstallerHandler(deps: HandlerDeps): Handler {
  return {
    kind: "run_installer",
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const ev = evidenceOf(ctx);
      const phase = str(ev.phase);
      const identity = identityFor(rec.loginUser);
      const ssh = sshFor(ctx, rec, deps, "run_installer");
      const attempts = (ev.attempts as unknown[]) ?? [];

      if (phase === "") {
        await remote(ctx, "stage_wrapper", () =>
          installFile(
            ssh,
            identity,
            repoFile("wrapper.sh"),
            WRAPPER_REMOTE_PATH,
            "0755",
          ),
        );
        // Upload the installer from THIS tree rather than curling it from
        // GitHub: the point of driving it is to test the installer we have.
        await remote(ctx, "stage_installer", () =>
          installText(
            ssh,
            identity,
            fs.readFileSync(
              deps.installerPath ??
                path.join(import.meta.dir, "..", "deploy", "install.sh"),
              "utf8",
            ),
            "/tmp/isomux-install.sh",
            "0755",
          ),
        );
        return { kind: "progress", evidence: { phase: "staged", attempts } };
      }

      if (phase === "staged") {
        // Persisted before anything is launched. Nothing else happens this tick.
        const runId = `install-${ctx.now}-${attempts.length}`;
        return {
          kind: "progress",
          evidence: { phase: "launching", runId, attempts },
        };
      }

      const runId = str(ev.runId);
      if (!runId) {
        return {
          kind: "retry",
          reason: "no runId recorded for this generation",
        };
      }

      const tick = parseTick(
        (
          await remote(ctx, "installer_tick", () =>
            ssh.script(`${WRAPPER_REMOTE_PATH} tick\n`),
          )
        ).stdout,
      );

      // Does the box's `current` point at OUR generation? Anything else - no
      // generation at all, or one from an earlier attempt that crashed and left
      // `current` behind - means ours has not published.
      const currentRunId = tick.state === "none" ? "" : tick.runId;
      const oursIsCurrent = currentRunId === runId;

      if (!oursIsCurrent) {
        if (phase === "awaiting_publication") {
          // Ruled: an unconfirmed launch is resolved by ticking, never by
          // launching again.
          return { kind: "waiting", evidence: ev };
        }
        if (phase !== "launching") {
          // We believed our generation was running, and the box says otherwise.
          // That is evidence for a human; it is never our success or our crash.
          return {
            kind: "ambiguous",
            reason:
              `the box's current generation is ${currentRunId || "none"}, not ours ` +
              `(${runId}); not treating another run's verdict as ours`,
          };
        }
        const launch = parseLaunch(
          await remote(ctx, "installer_launch", () =>
            ssh.script(
              `${rec.loginUser === "root" ? "" : "sudo -n "}${WRAPPER_REMOTE_PATH} launch "$1" env DOMAIN="$2" OWNER_NAME="$3" bash /tmp/isomux-install.sh\n`,
              [runId, rec.host, deps.ownerName ?? "Owner"],
            ),
          ),
        );
        switch (launch.kind) {
          case "confirmed":
          case "already-exists":
            return {
              kind: "progress",
              evidence: { phase: "running", runId, attempts },
            };
          case "unconfirmed":
            return {
              kind: "progress",
              evidence: {
                phase: "awaiting_publication",
                runId,
                attempts,
                launch: launch.reason,
              },
            };
          case "failed":
            return { kind: "retry", reason: `launch failed: ${launch.reason}` };
        }
      }

      // Below this line the tick is known to be about OUR generation, which is
      // the precondition for advancing or concluding the operation at all.
      if (tick.state === "running") {
        const marker = `${tick.step}`;
        return marker === ev.step
          ? { kind: "waiting", evidence: { ...ev, phase: "running" } }
          : {
              kind: "progress",
              evidence: { ...ev, phase: "running", step: marker },
            };
      }
      if (tick.state === "finished" && tick.exit === 0) {
        return {
          kind: "done",
          evidence: { ...ev, phase: "finished", exit: 0 },
        };
      }
      // A confirmed crashed or non-zero generation is the ONLY thing that may
      // enter a retry, and the retry re-stages so a FRESH runId is allocated -
      // the old generation's exit and log stay on the box, untouched.
      const verdict =
        tick.state === "crashed"
          ? "crashed"
          : `exit ${tick.state === "finished" ? tick.exit : "?"}`;
      const lastStep = tick.state === "none" ? "" : tick.step;
      return {
        kind: "retry",
        reason: `installer generation ${runId} ${verdict} at step ${lastStep}`,
        evidence: {
          phase: "staged",
          attempts: [...attempts, { runId, verdict, step: lastStep }],
        },
      };
    },
  };
}

// ------------------------------------------------------------ verify_https

export function verifyHttpsHandler(_deps: HandlerDeps): Handler {
  return {
    kind: "verify_https",
    timeoutIsRetryable: true,
    async run(ctx): Promise<HandlerResult> {
      const ev = evidenceOf(ctx);
      const asset = ctx.asset;
      const live = await remote(ctx, "liveness_probe", () =>
        probeLiveness(ctx.instance.name, {}, asset?.ipv4 ?? undefined),
      );
      if (live.rung === "ok") return { kind: "done", evidence: { rung: "ok" } };
      return live.rung === ev.rung
        ? { kind: "waiting", evidence: { rung: live.rung } }
        : {
            kind: "progress",
            evidence: { rung: live.rung, detail: live.detail },
          };
    },
  };
}

// ------------------------------------------------------------- mint_invite

/**
 * Mint an owner invite and hand it over exactly once.
 *
 * WHERE IT GOES IS DECIDED BY THE ROW, not by how this process was wired. A row
 * carrying `via: "dashboard"` was opened by a customer through requests.ts, and
 * its URL goes to the in-memory hold the seam serves - never to the operator's
 * terminal, where it would land in a journal belonging to someone who is not
 * the owner. Any other row is the operator's own interactive mint and keeps
 * slice 1's reporter path with its redacted-transcript contract.
 *
 * Either way the URL reaches exactly one sink: not the evidence, not the audit
 * row, not the JSONL, not an error message. That last one is why this handler
 * does not use the firstLineOf(stdout, stderr) pattern the rest of the driver
 * uses - it would put remote output on an error path.
 */
export function mintInviteHandler(deps: HandlerDeps): Handler {
  return {
    kind: "mint_invite",
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const ev = evidenceOf(ctx);
      const phase = str(ev.phase);
      const forDashboard = str(ev.via) === "dashboard";

      // FAIL CLOSED, AND BEFORE THE REMOTE CALL. A customer's invite minted in
      // a process with nowhere to deliver it would have to go somewhere, and
      // every "somewhere" available here is wrong: a terminal, a journal, a
      // row. So nothing is minted at all. Fatal rather than retry: no amount
      // of waiting gives this process a delivery channel.
      if (forDashboard && !deps.deliver) {
        return {
          kind: "fatal",
          reason:
            "this process has no delivery channel for a dashboard-requested " +
            "invite; refusing to mint a credential it cannot hand to its owner",
        };
      }

      // Did we ENTER this invocation with a marker? That, and only that, is
      // recovery: it means some earlier invocation got as far as intending to
      // mint, and a URL may already be in the operator's hands. Setting the
      // marker ourselves below is not evidence of anything - it is what we are
      // about to do.
      const isRecovery = phase === "minting" || ev.minted === true;

      // A URL cannot be un-printed, so the intent is persisted BEFORE the
      // remote seam - through the fence, in this same invocation, so the normal
      // path is one tick and one link. A process killed after the print and
      // before the result is written comes back with the marker and knows to
      // warn.
      if (!isRecovery) {
        const marked = ctx.store.casOperation(ctx.fence, {
          // THE STAMP IS CARRIED FORWARD. This write replaces the evidence
          // wholesale, and a later attempt re-reads it to decide where the URL
          // goes - so dropping `via` here would make a retried customer mint
          // look like an operator's and print their credential to a terminal.
          evidence: {
            phase: "minting",
            ...(forDashboard ? { via: "dashboard" } : {}),
          },
          evidence_at: ctx.now,
        });
        if (!marked) {
          return {
            kind: "retry",
            reason: "lost the fence before recording the intent to mint",
          };
        }
      }

      const ssh = sshFor(ctx, rec, deps, "mint_invite");
      const minted = await remote(ctx, "mint_invite", () =>
        ssh.pipe(
          [...privilegeArgvFor(rec.loginUser), "bash", "-s"],
          fs.readFileSync(repoFile("remote/mint-invite.sh"), "utf8"),
        ),
      );
      if (minted.code !== 0) {
        return { kind: "retry", reason: "minting the invite failed" };
      }
      const url = minted.stdout.trim();
      if (forDashboard) {
        // The one write of this value anywhere, and it is to memory in this
        // process. The customer's browser collects it through the seam; the
        // hold drops it on collection, on its TTL, and on restart.
        deps.deliver!.hold(ctx.op.id, ctx.instance.id, url);
      } else {
        if (isRecovery || ctx.op.attempt > 0) {
          // A second mint revokes the first unconsumed link, so the operator is
          // told rather than left holding a dead URL that looks fine. Only on
          // the operator path: a customer's page already knows that asking
          // again replaces their link.
          deps.reporter.line(
            "the invite printed earlier is no longer valid; use this one",
          );
        }
        deps.reporter.invite(url);
      }
      return {
        kind: "done",
        // STATUS ONLY. `minted: true` says a link was produced; nothing here
        // says anything about what it was.
        evidence: {
          phase: "minted",
          minted: true,
          mintedAt: ctx.now,
          ...(forDashboard ? { via: "dashboard" } : {}),
        },
      };
    },
  };
}

// ----------------------------------------------------------- revoke_access

/**
 * Remove our key, prove it, destroy our half.
 *
 * There is no fatal arm. A failed revocation is never quietly abandoned: it
 * raises attention and keeps retrying with persisted backoff, because the
 * box-local timer means a failure here costs a broken promise about WHEN, not a
 * broken guarantee. Only a classified public-key rejection concludes it.
 */
export function revokeAccessHandler(deps: HandlerDeps): Handler {
  return {
    kind: "revoke_access",
    async run(ctx): Promise<HandlerResult> {
      const rec = runFor(ctx, deps);
      const identity = identityFor(rec.loginUser);
      const ssh = sshFor(ctx, rec, deps, "revoke_key");
      try {
        await remote(ctx, "revoke_key", () =>
          revokeAccess(ssh, identity, rec.blob),
        );
      } catch (err) {
        // The reason is CLASSIFIED, not the remote error text. Attention
        // reasons and audit rows are durable, and remote output is where key
        // material and invite URLs live - so the detail goes to the operator's
        // live transcript and nowhere that outlives the run.
        ctx.report(`revocation attempt failed: ${messageOf(err)}`);
        return {
          kind: "ambiguous",
          reason: "the box did not confirm our key was removed from disk",
        };
      }
      const proof = await remote(ctx, "prove_removal", () =>
        // Bounded like every other remote call: an unbounded proof could outlive
        // the lease that authorised it.
        proveRemoval(targetFor(rec), deps.exec, () =>
          ctx.budget.claim("prove_removal"),
        ),
      );
      if (!proof.proven) {
        return {
          kind: "ambiguous",
          reason: `REVOCATION NOT PROVEN: ${proof.reason}`,
        };
      }
      destroyPrivateKey({
        privateKeyPath: rec.privateKeyPath,
        publicKeyPath: rec.publicKeyPath,
      } as KeyPair);
      rec.state = "revoked";
      saveRun(deps.runsDir, rec);
      ctx.report(
        "proof: sshd refused the removed key (publickey). Access is gone.",
      );
      return { kind: "done", evidence: { proven: true } };
    },
  };
}

// --------------------------------------------------------- create_instance

/**
 * The money operation.
 *
 * Its whole shape is "one call, ever". Any persisted armed or unresolved state
 * means the paid call MAY have happened, and the only legal remote action from
 * there is find - there is no branch in this function that can reach
 * armAndCreate once evidence exists.
 */
export function createInstanceHandler(deps: HandlerDeps): Handler {
  return {
    kind: "create_instance",
    async run(ctx): Promise<HandlerResult> {
      const coordinator = deps.coordinator;
      const build = deps.createRequest;
      if (!coordinator || !build) {
        return {
          kind: "fatal",
          reason: "no create coordinator is wired into this process",
        };
      }
      const ev = evidenceOf(ctx);
      const req = build(ctx.instance.id);
      const intentId = str(ev.intentId) || req.intentId;
      const intent = ctx.store.getIntent(intentId);

      // ---- find-only recovery. Reached by every state except "nothing yet".
      if (
        ev.phase === CREATE_ARMED_PHASE ||
        ev.phase === "quarantine" ||
        (intent &&
          (intent.state === "intended" || intent.state === "ambiguous"))
      ) {
        return quarantineFind(ctx, coordinator, intentId);
      }
      if (intent?.state === "created" || ev.phase === "created") {
        const providerId = intent?.provider_id ?? str(ev.providerId);
        if (!providerId) {
          // A created intent with no provider id is a box we paid for and
          // cannot name. Advancing the chain here would certify success on
          // evidence that identifies nothing.
          return {
            kind: "ambiguous",
            reason:
              `intent ${intentId} is recorded as created but carries no provider ` +
              `id; a human has to identify the box before anything else happens`,
          };
        }
        try {
          adoptAsset(ctx, providerId, intentId);
        } catch (err) {
          return { kind: "ambiguous", reason: messageOf(err) };
        }
        return { kind: "done", evidence: { phase: "created", providerId } };
      }
      if (intent?.state === "rejected" || ev.phase === "rejected") {
        return {
          kind: "fatal",
          reason:
            `the provider rejected the order (${intent?.reason ?? "no reason recorded"}); ` +
            `a new intent is a human act`,
        };
      }

      // ---- the one arm that may spend. Reachable only with nothing persisted.
      try {
        const outcome = await coordinator.armAndCreate(
          req,
          ctx.fence,
          (settled, op) => {
            if (settled.outcome === "created") {
              adoptAssetIn(ctx, op.instance_id, settled.providerId, intentId);
            }
          },
        );
        if (outcome.outcome === "created") return { kind: "done" };
        if (outcome.outcome === "rejected") {
          return {
            kind: "fatal",
            reason: `provider rejected: ${outcome.reason}`,
          };
        }
        return {
          kind: "ambiguous",
          reason: `create ambiguous: ${outcome.reason}`,
        };
      } catch (err) {
        // The coordinator already wrote the ambiguous outcome; returning
        // ambiguous here keeps the tick from overwriting it with a plain retry.
        return {
          kind: "ambiguous",
          reason: `create may have happened: ${messageOf(err)}`,
        };
      }
    },
  };
}

/** Bounded quarantine: find, and only find. There is deliberately no path from
 * here back to a create. */
async function quarantineFind(
  ctx: HandlerContext,
  coordinator: CreateCoordinator,
  intentId: string,
): Promise<HandlerResult> {
  let found;
  try {
    found = await coordinator.resolve(intentId);
  } catch (err) {
    return {
      kind: "ambiguous",
      reason: `find could not establish anything: ${messageOf(err)}`,
    };
  }
  if (found?.confidence === "exact") {
    if (!found.providerId) {
      return {
        kind: "ambiguous",
        reason: `find claimed an exact match with no provider id for ${intentId}`,
      };
    }
    try {
      adoptAsset(ctx, found.providerId, intentId);
    } catch (err) {
      return { kind: "ambiguous", reason: messageOf(err) };
    }
    ctx.report(`adopted ${found.providerId} for intent ${intentId}`);
    return {
      kind: "done",
      evidence: { phase: "adopted", providerId: found.providerId },
    };
  }
  if (found?.confidence === "unproven") {
    return {
      kind: "ambiguous",
      reason:
        `find matched ${found.providerId} but cannot prove it is ours; ` +
        `not adopting on unproven evidence`,
    };
  }
  // Nothing yet. Keep polling; the quarantine's absolute deadline is what
  // eventually raises a human, and it never opens a second intent.
  return { kind: "waiting", evidence: { phase: "quarantine", intentId } };
}

function adoptAsset(
  ctx: HandlerContext,
  providerId: string,
  intentId: string,
): void {
  ctx.store.tx(() => adoptAssetIn(ctx, ctx.instance.id, providerId, intentId));
}

/**
 * Idempotent: a retry after a crash finds the row already there. It THROWS
 * rather than returning quietly when it cannot attach the asset - the caller
 * turns that into attention, because an operation that reports done without a
 * provider asset has certified a box nobody can find again.
 */
function adoptAssetIn(
  ctx: HandlerContext,
  instanceId: string,
  providerId: string,
  intentId: string,
): void {
  if (!providerId) {
    throw new Error(`refusing to adopt an empty provider id for ${intentId}`);
  }
  const existing = ctx.store.assetForInstance(instanceId);
  if (existing?.provider_id === providerId) return;
  if (existing?.provider_id && existing.provider_id !== providerId) {
    // Two different boxes for one instance is the failure class the whole
    // create path exists to prevent. It is never resolved automatically.
    throw new Error(
      `instance ${instanceId} already holds provider asset ${existing.provider_id}; ` +
        `refusing to replace it with ${providerId}`,
    );
  }
  if (existing) {
    if (
      !ctx.store.casAsset(existing.id, existing.version, {
        provider_id: providerId,
        asset_state: "active",
      })
    ) {
      throw new Error(
        `provider asset ${existing.id} moved while adopting ${providerId}`,
      );
    }
    return;
  }
  ctx.store.createAsset({
    id: `asset-${instanceId}`,
    instance_id: instanceId,
    provider: "contabo",
    provider_id: providerId,
    intent_id: intentId,
    asset_state: "active",
    ipv4: null,
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: ctx.now,
  });
}

/** Everything the CLI drives. create_instance is deliberately NOT here: the CLI
 * exposes no path that can spend money. */
export function boxHandlers(deps: HandlerDeps): Handler[] {
  return [
    waitForSshHandler(deps),
    waitForPackageManagerHandler(deps),
    firstContactHandler(deps),
    armRevocationHandler(deps),
    runInstallerHandler(deps),
    verifyHttpsHandler(deps),
    mintInviteHandler(deps),
    revokeAccessHandler(deps),
  ];
}

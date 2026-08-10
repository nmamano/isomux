// What the machine can be doing, how long each thing may take, and what follows
// what.
//
// Fine-grained progress deliberately does NOT live in the service state. It
// lives in these typed operation rows, which is what makes recovery
// deterministic: "installing" is no longer one word covering not-launched,
// running, and exited.

/** Kinds with a handler in this slice. */
export type OperationKind =
  | "create_instance"
  | "wait_for_ssh"
  | "wait_for_package_manager"
  | "first_contact"
  | "arm_revocation"
  | "run_installer"
  | "verify_https"
  | "mint_invite"
  | "revoke_access"
  /** Suspension. Enqueued by billing (slice 3) rather than by the provisioning
   * chain, which is why `nextKind` never returns it and it has no successor. */
  | "power_off"
  /** The customer's own lever (slice 4b). Like `power_off` it is opened on
   * demand rather than by the chain, so `nextKind` never returns it. */
  | "reboot"
  /**
   * Suspension resume (slice 5). The mirror of a DUNNING power_off and of
   * nothing else: a cancellation-retention box is never resumed, because its
   * suspension is not a lever we pulled on an unpaid account, it is the
   * customer's own cancellation running its course.
   */
  | "power_on"
  /**
   * End of life (slice 5), opened by the lifecycle tick at the retention
   * deadline. Both are separate retryable operations rather than one "destroy",
   * per the design: Stripe's clock and the provider's term are independent, so
   * if one succeeds and our write fails the next reconcile adopts the truth.
   */
  | "cancel_asset"
  | "remove_dns";

/**
 * Kinds the design names that this slice does not drive. They are listed rather
 * than forgotten, and they have no deadline entry, so `deadlinesFor` refuses
 * them and nothing can enqueue one by accident. A silent no-op arm would be
 * worse than an error: it would look like the operation ran.
 */
export const DECLARED_UNIMPLEMENTED_KINDS = [
  // The only one left. Slice 5 drove power_on, cancel_asset and remove_dns;
  // `set_dns` stays undriven because no deployment here creates a record, and a
  // silent no-op arm would look like work that ran.
  "set_dns",
] as const;

export type Goal = "first_contact" | "installed" | "live" | "handed_off";

export interface Deadlines {
  /** Reset whenever the operation's evidence advances. */
  inactivityMs: number;
  /** The ceiling. Blowing it flags; it never concludes. */
  absoluteMs: number;
  /**
   * Hard wall-clock bound on ALL of this kind's remote work, however many
   * children the handler runs. The tick refuses to start unless it owns the
   * lease for longer than this plus the safety margin, and every individual call
   * is bounded by what is LEFT of it - so a five-call handler cannot outlive the
   * lease that authorised it.
   */
  maxRemoteMs: number;
}

const MINUTE = 60_000;

/**
 * Seeded from the measurements dated 2026-08-09 in control-plane-design.md
 * (Contabo V153 in EU, instance 203474835, one end-to-end run).
 *
 * Where inactivity equals absolute, the step has no intermediate evidence to
 * advance, so the two are the same number on purpose rather than by omission.
 */
export const DEADLINES: Record<OperationKind, Deadlines> = {
  // The 15-minute quarantine the design specifies for an ambiguous create.
  create_instance: {
    inactivityMs: 15 * MINUTE,
    absoluteMs: 15 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // Measured: reinstall-to-SSH 88s; the pilot's create-to-SSH was 110s.
  wait_for_ssh: {
    inactivityMs: 15 * MINUTE,
    absoluteMs: 15 * MINUTE,
    maxRemoteMs: 30_000,
  },
  // Measured: apt still held the dpkg lock at T+2min on a box SSH-able at T+88s.
  wait_for_package_manager: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 15 * MINUTE,
    maxRemoteMs: 30_000,
  },
  // Two children: the authorized_keys rewrite with its read-back, then the box
  // clock. The budget is for both.
  first_contact: {
    inactivityMs: 3 * MINUTE,
    absoluteMs: 3 * MINUTE,
    maxRemoteMs: 90_000,
  },
  // Five children: the cleanup script, two unit files, the enable, and reading
  // systemd's own answer back. This is the kind that proves a per-child bound is
  // not a bound on a handler.
  arm_revocation: {
    inactivityMs: 3 * MINUTE,
    absoluteMs: 3 * MINUTE,
    maxRemoteMs: 150_000,
  },
  // Measured: install 236s to exit 0, largest gap between consecutive step
  // markers 67s (the Chrome download). 8 minutes is about a 7x margin on that.
  run_installer: {
    inactivityMs: 8 * MINUTE,
    absoluteMs: 40 * MINUTE,
    maxRemoteMs: 120_000,
  },
  // Measured: install exit to HTTPS 200 in 16s. The binding constraint on this
  // rung is the A record existing before Caddy attempts HTTP-01, not the delay.
  verify_https: {
    inactivityMs: 10 * MINUTE,
    absoluteMs: 20 * MINUTE,
    maxRemoteMs: 40_000,
  },
  mint_invite: {
    inactivityMs: 3 * MINUTE,
    absoluteMs: 3 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // Its absolute deadline flags and it keeps retrying: revocation is never
  // quietly abandoned, and only a proven removal concludes it. Two children, and
  // the second is the proof - bounded like everything else, or it could outlive
  // the lease that authorised it.
  revoke_access: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 10 * MINUTE,
    maxRemoteMs: 120_000,
  },
  // Suspension. One provider call with no intermediate evidence, so the inactivity
  // deadline bounds a single attempt while the absolute ceiling covers the RETRIES:
  // a provider API that is down for twenty minutes must not turn a suspension into
  // a silently dropped one, and revocation's shape - keep trying, flag early - is
  // the right one for a promise about someone's money.
  power_off: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 30 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // The customer's restart. It concludes when the PROVIDER has accepted the
  // reboot, not when the office answers again: coming back is what liveness
  // reports, and tying the operation to it would turn a slow boot into a failed
  // restart. Same retry shape as power_off - a provider API that is down for a
  // few minutes must not silently drop somebody's restart.
  reboot: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 30 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // Suspension resume. One provider call, same retry shape as the power_off it
  // undoes: a provider API that is down for a few minutes must not leave a
  // paying customer's box switched off.
  power_on: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 30 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // The money-ending call. Its ceiling is wide because giving up is not an
  // option a deprovision has: an asset we asked to cancel and then forgot about
  // is a bill that renews forever.
  cancel_asset: {
    inactivityMs: 5 * MINUTE,
    absoluteMs: 60 * MINUTE,
    maxRemoteMs: 60_000,
  },
  // NOT a remote mutation: nothing here writes DNS. It re-reads the record until
  // the record is gone, so its ceiling is measured in the time a HUMAN takes to
  // reap a record after being told to. A day, and then it flags - which is the
  // point, because a flagged one is what puts it on the ops floor a second time.
  remove_dns: {
    inactivityMs: 6 * 60 * MINUTE,
    absoluteMs: 24 * 60 * MINUTE,
    maxRemoteMs: 30_000,
  },
};

export function deadlinesFor(kind: string): Deadlines {
  const d = DEADLINES[kind as OperationKind];
  if (!d) {
    throw new Error(
      `no handler and no deadlines for operation kind "${kind}"; this slice ` +
        `does not drive it, and enqueueing it would look like work that never runs`,
    );
  }
  return d;
}

/**
 * What follows what, as a pure function of the completed kind and the goal.
 *
 * The goal is on the instance row, so slice 1's --stop-after is state rather
 * than control flow, and a restart resumes the same chain without being told
 * again where it was going.
 */
export function nextKind(
  completed: OperationKind,
  goal: Goal,
): OperationKind | null {
  switch (completed) {
    case "create_instance":
      return "wait_for_ssh";
    case "wait_for_ssh":
      return "first_contact";
    case "first_contact":
      return "arm_revocation";
    case "arm_revocation":
      return goal === "first_contact" ? null : "wait_for_package_manager";
    case "wait_for_package_manager":
      return "run_installer";
    case "run_installer":
      return goal === "installed" ? null : "verify_https";
    case "verify_https":
      // A HOSTED OFFICE STOPS HERE AND WAITS FOR THE CUSTOMER TO ASK.
      //
      // Minting before demand would put a live 24h credential in the hands of
      // whoever is watching the provisioner - its stdout, its journal - and the
      // design says the link goes only to the authenticated session that asked
      // for it. So an instance whose goal is `live` reaches verified-live and
      // stops; the dashboard's request is what opens the mint.
      //
      // `handed_off` is the OPERATOR's deliberate one-command flow (slice 1's
      // north star: an office with an invite in hand and our key removed), and
      // it is invoked interactively, so it keeps minting through the reporter
      // with its redacted-transcript contract.
      return goal === "handed_off" ? "mint_invite" : null;
    case "mint_invite":
      return goal === "handed_off" ? "revoke_access" : null;
    case "revoke_access":
      return null;
    // Not part of the provisioning chain: billing, the customer and the
    // lifecycle tick open these on their own evidence, and nothing follows them.
    //
    // cancel_asset and remove_dns are the design's "separate retryable
    // operations rather than one destroy", so deprovision is deliberately NOT a
    // chain either: neither one's completion opens the other, and the tick
    // opens both at the retention deadline.
    case "power_off":
    case "reboot":
    case "power_on":
    case "cancel_asset":
    case "remove_dns":
      return null;
  }
}

/** The first operation of a chain that starts from an already-adopted box. */
export const FIRST_KIND: OperationKind = "wait_for_ssh";

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 300_000;

/** Persisted as next_attempt_at. Nothing sleeps inside a tick. */
export function backoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(raw, BACKOFF_CAP_MS);
}

export function newOperationId(kind: string, seq: number): string {
  return `op-${kind}-${seq}`;
}

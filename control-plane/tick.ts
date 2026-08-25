// One tick: reconcile provider truth, lease what is due, act once, evaluate
// deadlines. Nothing sleeps inside it.
//
// The lease is not just a mutual-exclusion flag. A version CAS fences a stale
// WRITE, but it does nothing about a stale ACT: a holder that stalls at a remote
// seam past its lease could otherwise have a second holder repeat the same
// remote work. So a handler declares a hard bound on its remote work, the bound
// is enforced by killing the child process, and the tick refuses to start unless
// it provably owns the lease for longer than that bound plus a margin.

import * as os from "node:os";
import {
  raiseAttentionIn,
  clearAttentionIn,
  type RaiseArgs,
} from "./attention.ts";
import {
  backoffMs,
  deadlinesFor,
  nextKind,
  newOperationId,
  type Goal,
  type OperationKind,
} from "./operations.ts";
import { IndeterminateProviderError } from "./provider.ts";
import { GRACE_MS, RETENTION_MS } from "./lifecycle.ts";
import { AmbiguousRemoteError, RemoteTimeoutError } from "./ssh.ts";
import type {
  AssetRow,
  Fence,
  InstanceRow,
  OperationRow,
  ReasonClass,
  ServiceState,
  Store,
} from "./store.ts";

/**
 * Long enough that the longest WHOLE-HANDLER budget plus the safety margin fits
 * inside it. It is not a guess: arm_revocation makes five sequential remote
 * calls, so the bound that matters is the sum, not any one child.
 */
export const LEASE_MS = 300_000;
/** Margin between a handler's whole-handler remote budget and the lease end. */
export const LEASE_SAFETY_MS = 60_000;
export const POLL_INTERVAL_MS = 5_000;
export const IDLE_MAINTENANCE_INTERVAL_MS = 60_000;
export const RECONCILE_INTERVAL_MS = 60_000;
export const MAX_OPS_PER_TICK = 8;

/**
 * The remaining wall-clock a handler may spend on remote work.
 *
 * A per-CHILD timeout is not a bound on a HANDLER: arm_revocation runs five
 * children, so five 60s children under a 180s lease could outlive it and let a
 * second holder act while the first was still talking to the box. The budget is
 * therefore shared by every call a handler makes, and it is additionally capped
 * by the lease itself, so a process that was stopped and resumed cannot begin a
 * call it no longer has the right to make.
 */
export class RemoteBudget {
  constructor(
    private readonly deadlineAt: number,
    private readonly leaseUntil: number,
    private readonly clock: () => number,
  ) {}

  remaining(): number {
    return (
      Math.min(this.deadlineAt, this.leaseUntil - LEASE_SAFETY_MS) -
      this.clock()
    );
  }

  /** Called before EVERY remote call. Returns the timeout that call may use. */
  claim(what: string): number {
    const left = this.remaining();
    if (left <= 0) {
      throw new LeaseHeadroomLost(
        `refusing to start ${what}: no remote budget left within this lease`,
      );
    }
    return left;
  }
}

/**
 * Raised instead of starting a remote call. It extends RemoteTimeoutError so it
 * inherits the ambiguous-by-default classification: by the time a budget runs
 * out, earlier calls in the same handler may already have acted.
 */
export class LeaseHeadroomLost extends RemoteTimeoutError {}

export interface HandlerContext {
  store: Store;
  op: OperationRow;
  instance: InstanceRow;
  asset: AssetRow | null;
  /** Produced by the lease/headroom check IMMEDIATELY before acting, so it
   * carries the current holder and the current version rather than a value
   * copied from the earlier selection read. */
  fence: Fence;
  /** Shared by every remote call this handler makes. */
  budget: RemoteBudget;
  now: number;
  report(line: string): void;
  /** One classified audit row. Never remote output, never a URL. Awaited by
   * every caller: it opens its own transaction, so a dropped await would let a
   * handler's next statement race the row it is writing. */
  audit(action: string, outcome: AuditOutcome, detail?: string): Promise<void>;
}

export type AuditOutcome = "started" | "succeeded" | "failed" | "ambiguous";

export type HandlerResult =
  /** Terminal success; the chain moves on. */
  | { kind: "done"; evidence?: unknown }
  /** Still working, and the evidence advanced. Resets the inactivity deadline. */
  | { kind: "progress"; evidence: unknown }
  /** Still working, nothing new. Polls again without resetting the inactivity
   * deadline - which is the whole point of having one. */
  | { kind: "waiting"; evidence?: unknown }
  /** Failed in a way that costs nothing to redo. */
  | { kind: "retry"; reason: string; evidence?: unknown }
  /** The remote action may have happened. Never redone blind. */
  | { kind: "ambiguous"; reason: string; evidence?: unknown }
  /** Deterministically wrong. Raises attention and stops this operation. */
  | { kind: "fatal"; reason: string; evidence?: unknown };

export interface Handler {
  kind: OperationKind;
  /**
   * Read-only remote work may downgrade a timeout to a plain retry. Everything
   * else treats RemoteTimeoutError as AMBIGUOUS: a killed child proves nothing
   * about whether the remote side acted.
   */
  timeoutIsRetryable?: boolean;
  run(ctx: HandlerContext): Promise<HandlerResult>;
}

export interface TickSummary {
  leased: number;
  acted: number;
  completed: number;
  flagged: number;
  live: number;
}

export function holderId(): string {
  return `${os.hostname()}:${process.pid}:${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface TickerOptions {
  store: Store;
  handlers: Handler[];
  holder?: string;
  /** Provider truth. Injected so the stub tier needs no account. */
  reconcile?: (asset: AssetRow) => Promise<{
    assetState: string;
    ipv4?: string;
    serviceEndsAt?: string;
  } | null>;
  report?: (line: string) => void;
  now?: () => number;
}

export class Ticker {
  private readonly store: Store;
  private readonly handlers: Map<string, Handler>;
  readonly holder: string;
  private readonly reconcileFn: TickerOptions["reconcile"];
  private readonly report: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: TickerOptions) {
    this.store = opts.store;
    this.handlers = new Map(opts.handlers.map((h) => [h.kind, h]));
    this.holder = opts.holder ?? holderId();
    this.reconcileFn = opts.reconcile;
    this.report = opts.report ?? (() => {});
    this.now = opts.now ?? (() => this.store.now());
  }

  /**
   * Open an operation, seeding its deadlines from the measured table. The
   * partial unique index refuses a second active row for the same
   * (instance, kind); that refusal is the arbiter, not a check in front of it.
   */
  /**
   * Whether a kind has a handler in THIS ticker.
   *
   * Read by the deployed process to answer what it registered rather than what
   * it believes it registered: the roster decides whether the provider handlers
   * exist, and a second derivation of that answer beside it is a copy that can
   * drift (the class of omission run-roster.ts was extracted to prevent).
   */
  handles(kind: OperationKind): boolean {
    return this.handlers.has(kind);
  }

  async enqueue(
    instanceId: string,
    kind: OperationKind,
    evidence?: unknown,
  ): Promise<OperationRow> {
    const d = deadlinesFor(kind);
    const now = this.now();
    return this.store.enqueue({
      id: newOperationId(kind, await this.store.nextSeq("audit")),
      instance_id: instanceId,
      kind,
      inactivity_deadline_at: now + d.inactivityMs,
      absolute_deadline_at: now + d.absoluteMs,
      evidence,
    });
  }

  async once(): Promise<TickSummary> {
    const summary: TickSummary = {
      leased: 0,
      acted: 0,
      completed: 0,
      flagged: 0,
      live: 0,
    };
    await this.reconcileAssets();

    for (const candidate of await this.store.dueOperations(
      this.now(),
      MAX_OPS_PER_TICK,
    )) {
      const outcome = await this.dispatch(candidate);
      if (outcome === "not-leased") continue;
      summary.leased++;
      if (outcome === "acted") summary.acted++;
      if (outcome === "completed") {
        summary.acted++;
        summary.completed++;
      }
    }

    const live = await this.store.liveOperations();
    summary.flagged = await this.evaluateDeadlines(live);
    summary.live = live.length;
    return summary;
  }

  /** The provisioner's one-statement wake probe. */
  async hasWork(): Promise<boolean> {
    return this.store.hasPendingWork(this.now(), GRACE_MS, RETENTION_MS);
  }

  /** One classified audit row, in its own transaction. */
  async auditRow(
    instanceId: string | null,
    action: string,
    outcome: AuditOutcome,
    detail?: string,
  ): Promise<void> {
    await this.store.tx(() =>
      this.store.appendAudit({
        actor: "control-plane",
        instance_id: instanceId,
        action,
        target: instanceId ?? "-",
        outcome,
        detail: detail ?? null,
      }),
    );
  }

  // ------------------------------------------------------------- reconcile

  private async reconcileAssets(): Promise<void> {
    if (!this.reconcileFn) return;
    for (const asset of await this.store.assetsDueForReconcile(this.now())) {
      let truth;
      await this.auditRow(asset.instance_id, "provider_get", "started");
      try {
        truth = await this.reconcileFn(asset);
        await this.auditRow(asset.instance_id, "provider_get", "succeeded");
      } catch (err) {
        await this.auditRow(
          asset.instance_id,
          "provider_get",
          auditOutcomeOf(err),
        );
        this.report(`reconcile ${asset.provider_id} failed: ${messageOf(err)}`);
        await this.rescheduleReconcile(asset.id, asset.version);
        continue;
      }
      if (!truth) continue;
      // The provider is the authority; every tick moves our row toward what it
      // says rather than toward what we last intended.
      const patch = {
        asset_state: truth.assetState,
        ...(truth.ipv4 === undefined ? {} : { ipv4: truth.ipv4 }),
        ...(truth.serviceEndsAt === undefined
          ? {}
          : { service_ends_at: truth.serviceEndsAt }),
        next_reconcile_at: this.now() + RECONCILE_INTERVAL_MS,
      };
      if (!(await this.store.casAsset(asset.id, asset.version, patch))) {
        // A losing writer re-reads and DECIDES - and the decision here is to
        // DROP this response. Re-applying it on the winner's version would put
        // our older provider answer on top of their newer one, which is the
        // blind retry the whole slice forbids, just spelled with a fresh
        // version number. The winner has already scheduled the next reconcile;
        // a fresh `get` is what settles it.
        // Re-read to CLASSIFY, not to replay: the decision this loser makes is
        // that no mutation of ours is needed, and saying whose answer stands is
        // what makes that a decision rather than a shrug.
        const winner = await this.store.getAsset(asset.id);
        this.report(
          `asset ${asset.id} was reconciled by another holder ` +
            `(now ${winner?.asset_state ?? "gone"}); discarding this provider ` +
            `response rather than replaying it over theirs`,
        );
      }
    }
  }

  /**
   * Push the next reconcile out after a failed provider read.
   *
   * If the CAS loses, somebody else has already written this row more recently
   * than we read it, and their schedule is the newer one. Forcing ours on top
   * could push out an urgent re-check that a successful reconcile just set, so
   * a loser here does nothing at all.
   */
  private async rescheduleReconcile(
    id: string,
    expectedVersion: number,
  ): Promise<void> {
    const at = this.now() + RECONCILE_INTERVAL_MS;
    if (
      !(await this.store.casAsset(id, expectedVersion, {
        next_reconcile_at: at,
      }))
    ) {
      this.report(
        `asset ${id} moved while rescheduling a failed reconcile; leaving the ` +
          `newer schedule alone`,
      );
    }
  }

  // -------------------------------------------------------------- dispatch

  private async dispatch(
    candidate: OperationRow,
  ): Promise<"not-leased" | "acted" | "completed"> {
    const now = this.now();
    const leased = await this.store.tryLease(
      candidate.id,
      candidate.version,
      this.holder,
      now + LEASE_MS,
      now,
    );
    if (!leased) return "not-leased";

    const handler = this.handlers.get(leased.kind);
    if (!handler) {
      // Unreachable through enqueue (deadlinesFor refuses an unknown kind), and
      // still not a silent no-op if it ever happens.
      await this.finish(
        { id: leased.id, version: leased.version, holder: this.holder },
        leased,
        {
          kind: "fatal",
          reason: `no handler registered for kind ${leased.kind}`,
        },
      );
      return "acted";
    }

    const held = await this.headroom(leased, handler);
    if (!held) {
      this.report(
        `skipping ${leased.id}: cannot prove enough lease for ${handler.kind}`,
      );
      return "not-leased";
    }
    const { fence, leaseUntil } = held;

    const instance = await this.store.getInstance(leased.instance_id);
    if (!instance) {
      await this.finish(fence, leased, {
        kind: "fatal",
        reason: `operation ${leased.id} has no instance row`,
      });
      return "acted";
    }

    let result: HandlerResult;
    try {
      result = await handler.run({
        store: this.store,
        op: (await this.store.getOperation(leased.id)) ?? leased,
        instance,
        asset: await this.store.assetForInstance(instance.id),
        fence,
        budget: new RemoteBudget(
          this.now() + deadlinesFor(handler.kind).maxRemoteMs,
          leaseUntil,
          this.now,
        ),
        now: this.now(),
        report: this.report,
        audit: async (action, outcome, detail) => {
          await this.store.tx(() =>
            this.store.appendAudit({
              actor: "control-plane",
              instance_id: instance.id,
              action,
              target: leased.id,
              outcome,
              detail: detail ?? null,
            }),
          );
        },
      });
    } catch (err) {
      result = this.classifyThrow(err, handler);
    }

    const completed = await this.finish(fence, leased, result);
    return completed ? "completed" : "acted";
  }

  /**
   * Prove we own the lease for longer than this handler's remote work can take.
   *
   * The leased row we just wrote carries the current holder and version, which
   * is the fence. If the remaining lease is not comfortably longer than the
   * handler's hard bound, renew first - and if the renewal loses, DO NOT ACT. A
   * losing or expired holder must never touch a remote seam.
   */
  private async headroom(
    op: OperationRow,
    handler: Handler,
  ): Promise<{ fence: Fence; leaseUntil: number } | null> {
    // The budget is for the WHOLE handler, however many children it runs.
    const need = deadlinesFor(handler.kind).maxRemoteMs + LEASE_SAFETY_MS;
    const fence: Fence = {
      id: op.id,
      version: op.version,
      holder: this.holder,
    };
    if ((op.lease_until ?? 0) - this.now() >= need) {
      return { fence, leaseUntil: op.lease_until ?? 0 };
    }
    const renewed = await this.store.renewLease(fence, this.now() + LEASE_MS);
    if (!renewed) return null;
    if ((renewed.lease_until ?? 0) - this.now() < need) return null;
    return {
      fence: { id: renewed.id, version: renewed.version, holder: this.holder },
      leaseUntil: renewed.lease_until ?? 0,
    };
  }

  private classifyThrow(err: unknown, handler: Handler): HandlerResult {
    if (err instanceof RemoteTimeoutError) {
      // A killed child proves nothing about whether the remote side acted, so
      // the default is ambiguous. Only read-only work opts out.
      return handler.timeoutIsRetryable
        ? { kind: "retry", reason: `remote timeout: ${err.message}` }
        : { kind: "ambiguous", reason: `remote timeout: ${err.message}` };
    }
    if (err instanceof AmbiguousRemoteError) {
      // Failing to RECORD a remote call is not evidence that the call failed,
      // whatever the handler's read-only opt-out says: the effect happened and
      // we cannot prove what it was.
      return { kind: "ambiguous", reason: messageOf(err) };
    }
    return { kind: "retry", reason: messageOf(err) };
  }

  /**
   * Apply one handler result. Completion and the successor enqueue are ONE
   * transaction, with the CAS on the completed row and the one-active partial
   * unique index as the final arbiter: if another holder already opened the
   * successor, the whole thing rolls back and this holder re-reads.
   */
  private async finish(
    fence: Fence,
    op: OperationRow,
    result: HandlerResult,
  ): Promise<boolean> {
    const d = deadlinesFor(op.kind);
    const now = this.now();
    try {
      // AWAITED INSIDE THE TRY on purpose. Returning the promise instead would
      // settle it after this frame has left, so the catch below - the arm that
      // turns a rolled-back result into a reported line rather than a dead tick
      // - would never run.
      return await this.store.tx(async () => {
        const patch: Parameters<Store["casOperation"]>[1] = {
          lease_until: null,
          lease_holder: null,
        };
        if (result.evidence !== undefined) {
          patch.evidence = result.evidence;
          patch.evidence_at = now;
        }
        let terminal = false;
        switch (result.kind) {
          case "done":
            patch.status = "succeeded";
            patch.inactivity_flagged = 0;
            patch.absolute_flagged = 0;
            terminal = true;
            break;
          case "progress":
            // Status is deliberately untouched: the lease already moved a
            // pending row to running, and an operation in quarantine must stay
            // ambiguous while it makes progress on finding its box.
            patch.inactivity_deadline_at = now + d.inactivityMs;
            patch.next_attempt_at = now + POLL_INTERVAL_MS;
            // ONLY the inactivity flag. A crossed absolute ceiling stays
            // crossed until the operation concludes - clearing it here would
            // make it flap: raised by the deadline pass, cleared by the next
            // step marker, raised again a tick later.
            patch.inactivity_flagged = 0;
            break;
          case "waiting":
            patch.next_attempt_at = now + POLL_INTERVAL_MS;
            break;
          case "retry":
            patch.attempt = op.attempt + 1;
            patch.next_attempt_at = now + backoffMs(op.attempt);
            break;
          case "ambiguous":
            patch.status = "ambiguous";
            patch.attempt = op.attempt + 1;
            patch.next_attempt_at = now + backoffMs(op.attempt);
            break;
          case "fatal":
            patch.status = "failed";
            terminal = true;
            break;
        }

        // The fence carries the CURRENT version; a handler that wrote through
        // the store has already moved it, so re-read rather than trusting the
        // copy taken before the remote call.
        const current = await this.store.getOperation(fence.id);
        const live: Fence = {
          id: fence.id,
          version: current?.version ?? fence.version,
          holder: fence.holder,
        };
        const written = await this.store.casOperation(live, patch);
        if (!written) {
          throw new Error(
            `lost the fence on ${fence.id} while recording a ${result.kind} result`,
          );
        }

        // WHAT a result may clear is decided by the CONDITION, not by which
        // operation raised it. Progress answers "nothing has happened lately"
        // and nothing else: it must not clear a failed revocation or an
        // ambiguous create just because the operation moved. Only the operation
        // finishing resolves those.
        const clearable: ReasonClass[] =
          result.kind === "done"
            ? [
                "inactivity_deadline",
                "absolute_deadline",
                "operation_condition",
              ]
            : result.kind === "progress"
              ? ["inactivity_deadline"]
              : [];
        if (clearable.length > 0) {
          for (const r of await this.store.openReasons(op.instance_id)) {
            if (r.source_op_id !== op.id) continue;
            if (!clearable.includes(r.reason_class)) continue;
            await clearAttentionIn(this.store, op.instance_id, r.id);
          }
        }

        if (result.kind === "fatal" || result.kind === "ambiguous") {
          await raiseAttentionIn(this.store, {
            instanceId: op.instance_id,
            sourceOpId: op.id,
            reasonClass: "operation_condition",
            reason: `${op.kind}: ${result.reason}`,
            severity: result.kind === "fatal" ? "critical" : "warning",
          });
        }

        if (result.kind === "done") {
          await this.store.appendAudit({
            actor: "control-plane",
            instance_id: op.instance_id,
            action: op.kind,
            target: op.id,
            outcome: "succeeded",
            detail: null,
          });
          // Service state is coarse and moves only at a PROVEN boundary. It is
          // not a rename of operation progress: `verify_https` succeeding means
          // the office answered at its own address, which is the first moment
          // the customer has something.
          const becomes = serviceStateAfter(op.kind as OperationKind);
          const instance = await this.store.getInstance(op.instance_id);
          if (instance && becomes && instance.service_state !== becomes) {
            if (
              !(await this.store.casInstance(instance.id, instance.version, {
                service_state: becomes,
              }))
            ) {
              throw new Error(
                `instance ${instance.id} moved while ${op.kind} was marking it ${becomes}`,
              );
            }
            await this.store.appendAudit({
              actor: "control-plane",
              instance_id: instance.id,
              action: "service_state",
              target: instance.id,
              outcome: "succeeded",
              detail: becomes,
            });
          }
          const next = nextKind(
            op.kind as OperationKind,
            (instance?.goal ?? "live") as Goal,
          );
          if (next) {
            const nd = deadlinesFor(next);
            await this.store.enqueue({
              id: newOperationId(next, await this.store.nextSeq("audit")),
              instance_id: op.instance_id,
              kind: next,
              inactivity_deadline_at: now + nd.inactivityMs,
              absolute_deadline_at: now + nd.absoluteMs,
            });
          }
        }
        if (result.kind === "fatal") {
          await this.store.appendAudit({
            actor: "control-plane",
            instance_id: op.instance_id,
            action: op.kind,
            target: op.id,
            outcome: "failed",
            detail: result.reason,
          });
        }
        return terminal;
      });
    } catch (err) {
      // A rolled-back result is not a lost one: the operation keeps its lease
      // until it expires and the next tick re-reads it.
      this.report(`could not record ${op.id}: ${messageOf(err)}`);
      return false;
    }
  }

  // ------------------------------------------------------------- deadlines

  /**
   * Deadlines FLAG. They never conclude.
   *
   * Only unleased operations are examined: an operation somebody is acting on
   * right now is not stuck, and bumping its version from outside would knock the
   * holder's fence out from under an in-flight remote call.
   */
  async evaluateDeadlines(live?: OperationRow[]): Promise<number> {
    const now = this.now();
    let flagged = 0;
    for (const op of live ?? (await this.store.liveOperations())) {
      if ((op.lease_until ?? 0) > now) continue;
      // Both are examined, and they flag separately: an operation can be past
      // its ceiling AND stalled, and answering one does not answer the other.
      for (const which of ["absolute", "inactivity"] as const) {
        const already =
          which === "absolute" ? op.absolute_flagged : op.inactivity_flagged;
        if (already) continue;
        const at =
          which === "absolute"
            ? op.absolute_deadline_at
            : op.inactivity_deadline_at;
        if (now <= at) continue;
        const args: RaiseArgs = {
          instanceId: op.instance_id,
          sourceOpId: op.id,
          reasonClass:
            which === "absolute" ? "absolute_deadline" : "inactivity_deadline",
          reason: `${op.kind} passed its ${which} deadline and is still ${op.status}`,
          severity: which === "absolute" ? "critical" : "warning",
        };
        try {
          // Awaited inside the try for the same reason finish() is: the catch
          // below is what keeps one unflaggable operation from ending the pass.
          await this.store.tx(async () => {
            // CAS without a holder predicate: nobody holds this row (checked
            // above), and the version predicate is what makes a loser re-read.
            const fresh = await this.store.getOperation(op.id);
            if (!fresh) return;
            const written = await this.store.flagDeadline(
              op.id,
              fresh.version,
              which,
              now,
            );
            if (!written) return;
            await raiseAttentionIn(this.store, args);
            flagged++;
          });
        } catch (err) {
          this.report(`could not flag ${op.id}: ${messageOf(err)}`);
        }
      }
    }
    return flagged;
  }
}

/**
 * The proven boundary at which the coarse service state moves.
 *
 * Deliberately sparse: most operations say nothing about what the customer has.
 */
export function serviceStateAfter(kind: OperationKind): ServiceState | null {
  if (kind === "verify_https") return "live";
  // A proven power-off is the other boundary where what the customer has
  // changes: suspension is a provider-level power state, because ruling 3 leaves
  // no way to stop a service from inside.
  if (kind === "power_off") return "suspended";
  // And its inverse. `suspended` is a claim about something WE did to the box,
  // and after a proven power_on it is no longer true. Whether the office ANSWERS
  // is the liveness axis, which the design keeps separate on purpose - folding
  // "is it up" into service state is exactly the collapse it warns about.
  if (kind === "power_on") return "live";
  return null;
}

/**
 * What a throw means for the audit trail.
 *
 * "failed" is a claim that nothing happened. Only errors that establish that
 * may use it: a timeout, an unrecorded call and a provider answer that cannot
 * establish anything are all `ambiguous`.
 */
export function auditOutcomeOf(err: unknown): AuditOutcome {
  return err instanceof AmbiguousRemoteError ||
    err instanceof IndeterminateProviderError
    ? "ambiguous"
    : "failed";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

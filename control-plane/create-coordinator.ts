// The only way to spend money.
//
// `ProviderAdapter.create` exists because the portable interface in
// control-plane/provider.ts declares it, and the adapter has to satisfy that
// contract. It is NOT the seam anything should call: on its own it will happily
// order a second box for an intent that already spent one.
//
// This coordinator is that seam, and it is the ONLY body in the codebase that
// contains a call to `adapter.create` (asserted by a test). It owns the arming
// transaction and the immediate call that follows it. There is deliberately no
// public method that takes an intent id and infers permission from an existing
// row: permission exists only as an ephemeral CreatePermit in this call stack,
// so a restart can never reconstruct one.

import {
  CreateLatch,
  CreatePermit,
  FenceLostError,
  type ArmRequest,
} from "./create-latch.ts";
import type {
  CreateOutcome,
  CreateRequest,
  FindResult,
  ProviderAdapter,
} from "./provider.ts";
import type { Fence, OperationRow, Store } from "./store.ts";
import { auditOutcomeOf } from "./tick.ts";

/**
 * Extra writes that belong to the SAME transaction as the outcome - the
 * provider asset row, the operation's completion. Run inside it, so losing the
 * fence rolls them back with everything else.
 */
export type SettleCreate = (
  outcome: CreateOutcome,
  op: OperationRow,
) => Promise<void> | void;

export class CreateCoordinator {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly latch: CreateLatch,
    private readonly store: Store,
  ) {}

  /**
   * Arm and issue exactly one create.
   *
   * The order is the guarantee: latch (one transaction, intent row plus the
   * operation's fenced evidence), consume the permit, then call. Consuming
   * BEFORE the await matters - a permit left live across it would still be
   * spendable by a re-entrant path.
   */
  async armAndCreate(
    req: CreateRequest,
    fence: Fence,
    settle?: SettleCreate,
  ): Promise<CreateOutcome> {
    const arm: ArmRequest = {
      intentId: req.intentId,
      plan: req.plan,
      region: req.region,
    };
    const { permit, armed } = await this.latch.armOnce(arm, fence);
    permit.consume();
    if (!(permit instanceof CreatePermit) || !permit.spent) {
      throw new Error("refusing to call create without a spent permit");
    }

    let outcome: CreateOutcome;
    await this.audit(
      armed.instance_id,
      "provider_create",
      "started",
      req.intentId,
    );
    try {
      outcome = await this.adapter.create(req);
      await this.audit(
        armed.instance_id,
        "provider_create",
        outcome.outcome === "created"
          ? "succeeded"
          : outcome.outcome === "rejected"
            ? "failed"
            : "ambiguous",
        req.intentId,
      );
    } catch (err) {
      await this.audit(
        armed.instance_id,
        "provider_create",
        "ambiguous",
        req.intentId,
      );
      // A throw is not evidence that nothing was ordered. AWAITED: an
      // unawaited settle would let the throw below leave before the ambiguous
      // outcome was written, and the intent would stay in a state whose only
      // legal next act nobody had recorded.
      await this.settleOutcome(
        req,
        armed,
        fence.holder,
        {
          outcome: "ambiguous",
          reason: `create threw: ${err instanceof Error ? err.message : String(err)}`,
        },
        settle,
      );
      throw err;
    }
    await this.settleOutcome(req, armed, fence.holder, outcome, settle);
    return outcome;
  }

  /**
   * Resolve an intent that is still owed an answer, by search only.
   *
   * There is deliberately no path from here back to create. This method takes an
   * intent id and grants nothing: `find` cannot spend.
   */
  async resolve(intentId: string): Promise<FindResult | null> {
    await this.audit(null, "provider_find", "started", intentId);
    try {
      const found = await this.adapter.find(intentId);
      await this.audit(null, "provider_find", "succeeded", intentId);
      return found;
    } catch (err) {
      // A find that cannot establish anything is ambiguity, not failure: it is
      // the state that keeps an intent in quarantine rather than resolving it.
      await this.audit(null, "provider_find", auditOutcomeOf(err), intentId);
      throw err;
    }
  }

  /** One classified row per provider call, in its own transaction. Never a
   * response body, never a credential - an action, a target and an outcome. */
  private async audit(
    instanceId: string | null,
    action: string,
    outcome: "started" | "succeeded" | "failed" | "ambiguous",
    target: string,
  ): Promise<void> {
    await this.store.tx(() =>
      this.store.appendAudit({
        actor: "control-plane",
        instance_id: instanceId,
        action,
        target,
        outcome,
        detail: null,
      }),
    );
  }

  /**
   * Write down what the call turned out to do - intent row, operation evidence
   * and whatever the caller settles - in ONE transaction, fenced.
   *
   * If the lease moved while we were at the remote seam, EVERY write here rolls
   * back and FenceLostError is raised. That is deliberate: the operation stays
   * at `create_call_armed` and the intent stays `intended`, which is the state
   * whose only legal next act is `find`. A blind retry of this transaction, or
   * of the call, is exactly what must not happen.
   */
  private async settleOutcome(
    req: CreateRequest,
    armed: OperationRow,
    holder: string,
    outcome: CreateOutcome,
    settle?: SettleCreate,
  ): Promise<void> {
    await this.store.tx(async () => {
      const intent = await this.store.getIntent(req.intentId);
      if (!intent) {
        throw new Error(
          `intent ${req.intentId} vanished between arming and settling`,
        );
      }
      const patch =
        outcome.outcome === "created"
          ? { state: "created" as const, provider_id: outcome.providerId }
          : outcome.outcome === "rejected"
            ? { state: "rejected" as const, reason: outcome.reason }
            : { state: "ambiguous" as const, reason: outcome.reason };
      if (!(await this.store.casIntent(req.intentId, intent.version, patch))) {
        throw new FenceLostError(
          `intent ${req.intentId} moved while settling the create outcome`,
        );
      }
      const op = await this.store.casOperation(
        { id: armed.id, version: armed.version, holder },
        {
          status:
            outcome.outcome === "created"
              ? "running"
              : outcome.outcome === "rejected"
                ? "failed"
                : "ambiguous",
          evidence: {
            phase:
              outcome.outcome === "created"
                ? "created"
                : outcome.outcome === "rejected"
                  ? "rejected"
                  : "quarantine",
            intentId: req.intentId,
            ...(outcome.outcome === "created"
              ? { providerId: outcome.providerId }
              : { reason: outcome.reason }),
          },
          evidence_at: this.store.now(),
        },
      );
      if (!op) {
        throw new FenceLostError(
          `operation ${armed.id} moved while settling the create outcome for ` +
            `${req.intentId}; every write is rolled back and the only legal next ` +
            `act is find`,
        );
      }
      await settle?.(outcome, op);
      await this.store.appendAudit({
        actor: "control-plane",
        instance_id: op.instance_id,
        action: "create_instance",
        target: req.intentId,
        outcome:
          outcome.outcome === "created"
            ? "succeeded"
            : outcome.outcome === "rejected"
              ? "failed"
              : "ambiguous",
        detail: null,
      });
    });
  }
}

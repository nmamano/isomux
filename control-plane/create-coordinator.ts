// The only way to spend money.
//
// `ProviderAdapter.create` exists because the portable interface in
// control-plane/provider.ts declares it, and the adapter has to satisfy that
// contract. It is NOT the seam anything should call: on its own it will happily
// order a second box for an intent that already spent one.
//
// This coordinator is the seam. It reserves the intent durably, then calls the
// adapter, then records what the call turned out to do - and the reservation is
// what forbids a second attempt, whatever happens afterwards. Everything that
// can reach a paid create goes through here.

import type {
  CreateOutcome,
  CreateRequest,
  ProviderAdapter,
} from "./provider.ts";
import { IntentJournal } from "./intents.ts";

export class CreateCoordinator {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly journal: IntentJournal,
  ) {}

  /**
   * Order a box, exactly once per intent, ever.
   *
   * The reservation is written and fsynced BEFORE the call and already means
   * "the paid call may have happened". So a crash anywhere after this point -
   * including between Contabo accepting the order and our result write - leaves
   * the intent in the state that forbids create, and the only way forward is
   * `find`.
   */
  async create(req: CreateRequest): Promise<CreateOutcome> {
    // Throws if the intent has been used, if another process reserved it first,
    // or if the journal is unreadable. All three fail closed.
    this.journal.latchBeforeCreate(req.intentId, {
      plan: req.plan,
      region: req.region,
    });

    let outcome: CreateOutcome;
    try {
      outcome = await this.adapter.create(req);
    } catch (err) {
      // A throw from the adapter is not evidence that nothing was ordered.
      this.journal.recordOutcome(req.intentId, {
        state: "ambiguous",
        reason: `create threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    switch (outcome.outcome) {
      case "created":
        this.journal.recordOutcome(req.intentId, {
          state: "created",
          providerId: outcome.providerId,
        });
        break;
      case "rejected":
        this.journal.recordOutcome(req.intentId, {
          state: "rejected",
          reason: outcome.reason,
        });
        break;
      case "ambiguous":
        this.journal.recordOutcome(req.intentId, {
          state: "ambiguous",
          reason: outcome.reason,
        });
        break;
    }
    return outcome;
  }

  /**
   * Resolve an intent that is still owed an answer, by search only.
   *
   * There is deliberately no path from here back to create: an `exact` hit
   * adopts the box, and anything else is a human's problem.
   */
  async resolve(intentId: string) {
    return this.adapter.find(intentId);
  }
}

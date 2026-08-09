// The only path to a paid create, and the latch that makes it a one-shot.
//
// THE RULE, AND IT IS THE WHOLE FILE: a successful INSERT permits only its
// returning call stack to issue one call. The persisted row permanently forbids
// all later calls. A row is a latch, never a reconstructable grant - nothing
// reads an existing row and infers permission from it, because "the paid call
// may already have happened" is exactly what an existing row means.
//
// Two mechanisms carry that:
//
//   1. ONE TRANSACTION arms both sides. The intent INSERT and the fenced CAS of
//      the operation's evidence to `create_call_armed` commit together, so the
//      state "intent latched but nobody knows which operation owns it" cannot
//      exist. If the fenced CAS finds a stale holder or version, the whole
//      transaction rolls back and the intent id is left un-latched - which is
//      correct precisely because nothing was ever sent.
//   2. THE CAPABILITY IS EPHEMERAL. On commit, and only on commit, a
//      `CreatePermit` is minted into the caller's stack frame. It is not
//      serialisable, it is never stored on an object or returned upward, and a
//      crash loses it permanently. There is no way to reconstruct one from the
//      database, which is what makes restart recovery find-only by construction
//      rather than by a check somebody could forget.

import * as fs from "node:fs";
import * as path from "node:path";
import { IntentJournal } from "./intents.ts";
import type { Store, Fence, OperationRow } from "./store.ts";

/** Held only by the module that mints permits. Not exported, so a caller
 * outside this file cannot reach the constructor even at runtime. */
const MINT_KEY = Symbol("create-permit-mint");

export class LatchRefused extends Error {}
/** The lease moved while we were at the remote seam. Never retried. */
export class FenceLostError extends Error {}

/**
 * Permission to issue exactly one paid create, valid only in the call stack
 * that latched.
 *
 * `#spent` is a true private field rather than a convention: a duck-typed
 * forgery fails both `instanceof` and `consume()`, so the type system is not the
 * only thing standing between a bug and a second box.
 */
export class CreatePermit {
  #spent = false;

  private constructor(readonly intentId: string) {}

  /** Only CreateLatch can reach this, and only with the module-private key. */
  static mint(intentId: string, key: symbol): CreatePermit {
    if (key !== MINT_KEY) {
      throw new Error("create permits are minted only by CreateLatch");
    }
    return new CreatePermit(intentId);
  }

  /** Spend the permission. Called BEFORE the provider call, so a re-entrant
   * path finds it already spent rather than racing the await. */
  consume(): void {
    if (this.#spent) {
      throw new LatchRefused(
        `create permit for ${this.intentId} has already been spent`,
      );
    }
    this.#spent = true;
  }

  get spent(): boolean {
    return this.#spent;
  }
}

export interface ArmRequest {
  intentId: string;
  plan: string;
  region: string;
}

export interface ArmResult {
  permit: CreatePermit;
  /** The operation as it stands AFTER arming, so the caller's post-call
   * transaction fences against the right version instead of a stale one. */
  armed: OperationRow;
}

export const CREATE_ARMED_PHASE = "create_call_armed";

export class CreateLatch {
  constructor(
    private readonly store: Store,
    /** Legacy evidence from slice 1. Read-only, and it can only ever veto. */
    private readonly journal: IntentJournal | null = null,
  ) {}

  /**
   * Arm one create. Returns a permit, or throws - there is no third answer.
   *
   * Every failure class forbids: a duplicate intent id, a stale fence, a busy
   * or unreadable database, a failed commit, a legacy journal that cannot be
   * read. Database unavailability is a reason to refuse to spend, never a reason
   * to proceed.
   */
  armOnce(req: ArmRequest, fence: Fence): ArmResult {
    const armed = this.store.tx(() => {
      // The legacy journal can only veto. It fails closed on its own terms:
      // only ENOENT reads as absent, and a permission error or corrupt JSON
      // throws - which rolls this transaction back and refuses the create.
      if (this.journal && this.journal.read(req.intentId) !== null) {
        throw new LatchRefused(
          `intent ${req.intentId} is latched in the legacy journal; create is ` +
            `permanently forbidden for it. Resolve it with find.`,
        );
      }

      // No SELECT in front of this. The primary key is the arbiter, exactly as
      // O_EXCL was: two workers holding the same pre-read cannot both pass.
      try {
        this.store.db.run(
          "insert into create_intents (intent_id, state, latched_at, plan, region, version) " +
            "values (?, 'intended', ?, ?, ?, 1)",
          [req.intentId, this.store.now(), req.plan, req.region],
        );
      } catch (err) {
        throw new LatchRefused(
          `intent ${req.intentId} could not be latched (${messageOf(err)}); ` +
            `create is forbidden. A latch that did not commit is never a licence to spend.`,
          { cause: err },
        );
      }

      const op = this.store.casOperation(fence, {
        status: "running",
        evidence: { phase: CREATE_ARMED_PHASE, intentId: req.intentId },
        evidence_at: this.store.now(),
      });
      if (!op) {
        // Rolls back the INSERT too, which is the point of one transaction: an
        // intent latched against an operation we do not hold would forbid a
        // create that never reached the provider.
        throw new FenceLostError(
          `operation ${fence.id} moved while arming intent ${req.intentId}; ` +
            `nothing was sent and nothing is latched`,
        );
      }

      this.store.appendAudit({
        actor: "control-plane",
        instance_id: op.instance_id,
        action: "arm_create",
        target: req.intentId,
        outcome: "started",
        detail: null,
      });
      return op;
    });

    // Minted only after the commit returned.
    return { permit: CreatePermit.mint(req.intentId, MINT_KEY), armed };
  }
}

/**
 * Import slice-1's O_EXCL journal into the schema, conservatively.
 *
 * Importing a latch can only ever forbid more, so every rule here errs toward
 * forbidding. The legacy files are never deleted or rewritten: they stay as
 * evidence and keep vetoing for the whole slice.
 */
export function migrateLegacyIntents(store: Store, dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    // A directory that exists but cannot be enumerated might be hiding a latch.
    // Refusing to open the store means nothing runs, so nothing spends.
    throw new Error(
      `the legacy intent journal at ${dir} cannot be read (${code}); refusing to ` +
        `open the store, because an unreadable journal is not evidence that no ` +
        `intent was latched.`,
      { cause: err },
    );
  }
  let imported = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const intentId = name.slice(0, -".json".length);
    if (store.getIntent(intentId)) continue;
    let state: "intended" | "created" | "rejected" | "ambiguous" = "ambiguous";
    let plan = "unknown";
    let region = "unknown";
    let providerId: string | null = null;
    let reason: string | null = "imported from the legacy journal";
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      ) as Record<string, unknown>;
      // Validate rather than trust: a legacy file is just bytes on disk, and an
      // unrecognised state must import as `ambiguous` (which forbids) instead of
      // entering a column whose type claims a closed set.
      const claimed = rec.state;
      state =
        claimed === "intended" ||
        claimed === "created" ||
        claimed === "rejected" ||
        claimed === "ambiguous"
          ? claimed
          : "ambiguous";
      if (state !== claimed) {
        reason = `legacy journal state ${JSON.stringify(claimed)} not recognised`;
      }
      plan = typeof rec.plan === "string" ? rec.plan : "unknown";
      region = typeof rec.region === "string" ? rec.region : "unknown";
      providerId = typeof rec.providerId === "string" ? rec.providerId : null;
    } catch {
      // The contents are not needed to forbid: the id in the FILENAME is enough
      // to write a row that permanently refuses a create.
      state = "ambiguous";
      reason = "legacy journal record unreadable";
    }
    store.tx(() => {
      store.db.run(
        "insert into create_intents (intent_id, state, latched_at, plan, region, " +
          "provider_id, reason, version) values (?, ?, ?, ?, ?, ?, ?, 1)",
        [intentId, state, store.now(), plan, region, providerId, reason],
      );
    });
    imported++;
  }
  return imported;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

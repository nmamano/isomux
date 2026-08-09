// The durable latch that stops us ever buying a box twice.
//
// The rule is carried by the PRE-CALL record, not by anything written
// afterwards. Writing `intended` and fsyncing it already means:
//
//     the paid call may have happened; create is permanently forbidden for
//     this intent.
//
// That is what makes the journal safe at every instruction boundary. If the
// process dies between Contabo accepting the order and our result write, the
// intent is left in exactly the state that already forbids create; if it dies
// before the write, no call was ever issued, because we write first. Nothing
// depends on the post-call transition being reached.
//
// Consequences, both deliberate:
//   - An intent that has touched create never reaches it again, whatever the
//     outcome was. Even a clean rejection resolves through a NEW intent.
//   - Opening a new intent is never automatic. A paid duplicate is worse than
//     a stalled signup, so the machine fails toward a human.

import * as fs from "node:fs";
import * as path from "node:path";

export type IntentState = "intended" | "created" | "rejected" | "ambiguous";

export interface IntentRecord {
  intentId: string;
  state: IntentState;
  /** ms epoch of the pre-call latch. */
  latchedAt: number;
  plan: string;
  region: string;
  providerId?: string;
  reason?: string;
}

/** States that still owe us a resolution, and may only be resolved by
 * find/list - never by calling create again. */
export function isNonTerminal(rec: IntentRecord): boolean {
  return rec.state === "intended" || rec.state === "ambiguous";
}

export class IntentJournal {
  constructor(private readonly dir: string) {}

  private file(intentId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(intentId)) {
      throw new Error(`unsafe intent id: ${intentId}`);
    }
    return path.join(this.dir, `${intentId}.json`);
  }

  /**
   * Read a record, failing CLOSED.
   *
   * Only "this file does not exist" counts as absent. A permission error, an
   * I/O error or unparseable JSON must never read as "no record here": that
   * would turn an unreadable journal into a licence to buy another box, which
   * is the one outcome this whole file exists to prevent.
   */
  read(intentId: string): IntentRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(intentId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        `intent journal for ${intentId} is unreadable (${(err as NodeJS.ErrnoException).code}); ` +
          `refusing to treat that as "no record". Fix the journal by hand.`,
        { cause: err },
      );
    }
    try {
      return JSON.parse(raw) as IntentRecord;
    } catch (err) {
      throw new Error(
        `intent journal for ${intentId} is corrupt; refusing to treat that as "no record".`,
        { cause: err },
      );
    }
  }

  /**
   * True only when this intent has never touched create. Any record at all -
   * including a terminal one - means the answer is no, and an unreadable
   * journal throws rather than answering.
   */
  canCreate(intentId: string): boolean {
    return this.read(intentId) === null;
  }

  /**
   * Reserve the intent and return only once the record is durable. Call this
   * BEFORE the provider call, always.
   *
   * The reservation is an EXCLUSIVE create (`wx`), so it is the filesystem
   * that decides who wins when two processes race - not a read followed by a
   * write, which both would pass. A check-then-act here would let two workers
   * each observe "no record" and each order a box.
   */
  latchBeforeCreate(
    intentId: string,
    meta: { plan: string; region: string },
    now: number = Date.now(),
  ): IntentRecord {
    const existing = this.read(intentId);
    if (existing) throw alreadyUsed(intentId, existing.state);
    return this.reserve(intentId, meta, now);
  }

  /**
   * The reservation itself: an EXCLUSIVE create, durable before it returns.
   *
   * Separate from the read-check above because it is the part that has to be
   * correct when the check is useless. Two workers can both read "absent" in
   * the same instant and both pass that check; only O_EXCL can decide which of
   * them is allowed to spend money. Called directly by the concurrency test,
   * where a prior read would mask exactly the race being tested.
   */
  reserve(
    intentId: string,
    meta: { plan: string; region: string },
    now: number = Date.now(),
  ): IntentRecord {
    const rec: IntentRecord = {
      intentId,
      state: "intended",
      latchedAt: now,
      plan: meta.plan,
      region: meta.region,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    let fd: number;
    try {
      fd = fs.openSync(this.file(intentId), "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw alreadyUsed(intentId, "reserved by another writer");
      }
      throw err;
    }
    try {
      fs.writeSync(fd, JSON.stringify(rec, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.fsyncDir();
    return rec;
  }

  /** Record what the call turned out to do. Never relaxes the latch. */
  recordOutcome(
    intentId: string,
    outcome: {
      state: Exclude<IntentState, "intended">;
      providerId?: string;
      reason?: string;
    },
  ): void {
    const rec = this.read(intentId);
    if (!rec) {
      throw new Error(`no latched intent ${intentId} to record an outcome for`);
    }
    this.writeDurably({ ...rec, ...outcome });
  }

  /** Every intent still owing a resolution, for restart reconciliation. */
  pending(): IntentRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: IntentRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.dir, name), "utf8"),
        ) as IntentRecord;
        if (isNonTerminal(rec)) out.push(rec);
      } catch {
        // An unreadable journal entry is not a licence to spend: it is left in
        // place for a human and simply not reported as resolvable.
      }
    }
    return out;
  }

  /**
   * temp -> fsync(file) -> rename -> fsync(parent directory).
   *
   * The directory fsync is the step people skip: without it, a rename can be
   * lost across power failure even though the file's own data was synced, and
   * the journal would come back claiming an intent it had already spent
   * against was never latched.
   */
  private fsyncDir(): void {
    const dirFd = fs.openSync(this.dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  private writeDurably(rec: IntentRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(rec.intentId);
    // Per-intent temp name: a shared ".tmp" would let two writers for different
    // intents clobber each other's half-written file.
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(rec, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    this.fsyncDir();
  }
}

function alreadyUsed(intentId: string, state: string): Error {
  return new Error(
    `intent ${intentId} has already been used for a create (state: ${state}); ` +
      `create is permanently forbidden for it. Resolve it with find, or have a ` +
      `human open a new intent.`,
  );
}

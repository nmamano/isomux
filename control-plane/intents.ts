// The slice-1 intent journal: one JSON file per intent, from before the latch
// moved into the database (create-latch.ts). Nothing writes it any more. It is
// read for two things only: `migrateLegacyIntents` imports it, and CreateLatch
// treats any record in it as a veto, because a pre-call record already means
// the paid call may have happened.

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
}

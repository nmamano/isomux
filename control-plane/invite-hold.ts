// The only place a minted invite exists on our side, and it is memory.
//
// Ruling R-2026-08-10-1-AMENDED: the plaintext URL lives ONLY in provisioner
// process memory, in a one-shot map keyed by operation id with a short TTL, and
// it is dropped on fetch, on TTL expiry, and on restart. Nothing here writes to
// a database, a file, a log or a transcript, and nothing here has a code path
// that returns a URL to more than one caller.
//
// WHAT IS AND IS NOT CLAIMED. Dropping a JavaScript string releases a
// reference; it does not scrub the bytes, and this file cannot promise
// otherwise. What it does promise is that the value is reachable from exactly
// one map, for at most INVITE_HOLD_MS, inside one process that never persists
// it - so a database dump, a log, a backup and a restart all contain nothing.

/**
 * How long a minted link waits to be collected.
 *
 * Five minutes, as a plain constant rather than a knob: it is the same value
 * for every deployment, and the customer who just pressed the button is
 * collecting it in the next few seconds. Longer would leave live credentials
 * sitting in memory for people who closed the tab; shorter would lose links to
 * an ordinary slow page load.
 */
export const INVITE_HOLD_MS = 5 * 60_000;

interface Entry {
  instanceId: string;
  url: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export type TakeResult =
  | { found: true; url: string }
  | { found: false; reason: "absent" | "expired" };

export class InviteHold {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = INVITE_HOLD_MS,
  ) {}

  /**
   * Hold a freshly minted URL for the operation that produced it.
   *
   * Any earlier entry for the SAME INSTANCE is dropped, and that is not
   * housekeeping - it is the product rule. A new mint revokes the previous
   * unconsumed link on the box, so an older held URL is already dead and
   * handing it over would be handing over a credential that cannot work.
   */
  hold(operationId: string, instanceId: string, url: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.instanceId === instanceId) this.remove(key);
    }
    const expiresAt = this.now() + this.ttlMs;
    // SCHEDULED expiry, so an uncollected link does not sit in memory until
    // somebody happens to ask. unref'd because a pending invite must never be
    // the reason a process refuses to exit.
    const timer = setTimeout(() => this.remove(operationId), this.ttlMs);
    (timer as { unref?: () => void }).unref?.();
    this.entries.set(operationId, { instanceId, url, expiresAt, timer });
  }

  /**
   * Take it once.
   *
   * The read and the delete are ONE SYNCHRONOUS BLOCK with no await between
   * them, so two racing callers cannot both observe the entry: whichever the
   * runtime runs first empties the map, and the other sees an absent entry.
   * That is a property of this block never yielding, not of a lock - there is
   * no mutex here and the code must not grow an await inside it.
   *
   * `instanceId` is checked rather than trusted from the key: an operation id
   * belongs to an instance, and a caller asking with the wrong one gets the
   * same answer as a caller asking for something that is not there.
   */
  take(operationId: string, instanceId: string): TakeResult {
    const entry = this.entries.get(operationId);
    if (!entry || entry.instanceId !== instanceId) {
      return { found: false, reason: "absent" };
    }
    this.remove(operationId);
    // LAZY expiry beside the scheduled one. A timer is a promise about
    // scheduling; the deadline is a fact, and a process that was suspended
    // between the two would otherwise hand over a stale link.
    if (entry.expiresAt <= this.now())
      return { found: false, reason: "expired" };
    return { found: true, url: entry.url };
  }

  /** Drop an entry without reading it. Used when a window closes under a link
   * nobody may collect any more. */
  drop(operationId: string): void {
    this.remove(operationId);
  }

  /** Entries currently held. Tests assert on it; nothing else should need it,
   * and it deliberately exposes no value. */
  size(): number {
    return this.entries.size;
  }

  private remove(operationId: string): void {
    const entry = this.entries.get(operationId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(operationId);
  }
}

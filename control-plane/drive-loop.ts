// The provisioner's one process loop. Provisioning and billing lifecycle work
// stay sequential here, so a restart can resume durable rows without two local
// passes acting at once.

import type { Reporter } from "./report.ts";
import type { Store } from "./store.ts";
import {
  IDLE_MAINTENANCE_INTERVAL_MS,
  POLL_INTERVAL_MS,
  type TickSummary,
  type Ticker,
} from "./tick.ts";

export interface CadencePass {
  run(): Promise<void>;
  failureLabel: string;
}

/**
 * Drive ticks until the work is done, or forever.
 *
 * Raised attention NEVER stops the loop. A deadline flags and the operation
 * keeps going, so stopping on the first flag would stop the process that must
 * keep reconciling it.
 */
export async function driveTicks(
  store: Store,
  ticker: Pick<Ticker, "hasWork" | "once">,
  opts: {
    forever: boolean;
    reporter: Pick<Reporter, "line" | "problem">;
    watch?: () => Promise<void>;
    /** Runs after the operation tick, in the same process and never beside it. */
    cadence?: CadencePass;
    /** Called only after both operation and cadence passes completed. */
    onTick?: () => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void> {
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    opts.reporter.line("stopping after this tick");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const announced = new Set<string>();
  const now = opts.now ?? Date.now;
  let lastFullPassAt = Number.NEGATIVE_INFINITY;
  let runFullPass = true;
  try {
    for (;;) {
      if (runFullPass) {
        const summary: TickSummary = await ticker.once();
        let cadenceCompleted = true;
        if (opts.cadence) {
          try {
            await opts.cadence.run();
          } catch (err) {
            // Unlike a failed measurement below, a failed lifecycle pass means
            // the process did not complete its job, so health stays stale.
            cadenceCompleted = false;
            opts.reporter.problem(
              `${opts.cadence.failureLabel}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (cadenceCompleted) opts.onTick?.();
        if (opts.watch) {
          // Liveness is a MEASUREMENT, not an operation. A probe that throws
          // must not stop the provisioner: the reading is worth less than the
          // loop.
          try {
            await opts.watch();
          } catch (err) {
            opts.reporter.problem(
              `monitoring pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // This N+1 belongs to the full maintenance pass, not the cheap wake
        // probe. An idle office therefore pays it once a minute, not once per
        // five-second wake.
        for (const inst of await store.listInstances()) {
          for (const reason of await store.openReasons(inst.id)) {
            if (announced.has(reason.id)) continue;
            announced.add(reason.id);
            opts.reporter.problem(
              `ATTENTION (${reason.severity}) on ${inst.id}: ${reason.reason}`,
            );
          }
        }
        lastFullPassAt = now();
        if (stopping) return;
        if (!opts.forever && summary.live === 0) return;
      }
      await (opts.sleep ?? Bun.sleep)(POLL_INTERVAL_MS);
      if (stopping) return;
      runFullPass =
        (await ticker.hasWork()) ||
        now() - lastFullPassAt >= IDLE_MAINTENANCE_INTERVAL_MS;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

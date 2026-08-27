// The provisioner's one process loop. Independent work classes stay sequential
// here, so a restart can resume durable rows without two local passes acting at
// once.

import type { Reporter } from "./report.ts";
import type { Store, WorkSchedule } from "./store.ts";
import {
  ACTIVE_LOOP_INTERVAL_MS,
  IDLE_LOOP_INTERVAL_MS,
  type TickSummary,
  type Ticker,
} from "./tick.ts";
import { GRACE_MS, RETENTION_MS } from "./lifecycle.ts";

export interface CadencePass {
  run(): Promise<void>;
  failureLabel: string;
}

export interface ScheduleCapabilities {
  providerConfigured: boolean;
  provisioningConfigured: boolean;
  checkoutConfigured: boolean;
  staleProvisioningMs: number;
  staleProvisioningReason: string;
}

/** A level-triggered in-memory poke. Durable rows remain the source of truth. */
export class DriveWake {
  private latched = false;
  private waiter: (() => void) | null = null;

  signal(): void {
    this.latched = true;
    this.waiter?.();
    this.waiter = null;
  }

  pending(): boolean {
    return this.latched;
  }

  /** Consume immediately before the pass. A signal during it re-arms the latch. */
  consume(): void {
    this.latched = false;
  }

  async wait(ms: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    if (this.latched) return;
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        this.waiter = resolve;
        if (this.latched) {
          this.waiter = null;
          resolve();
        }
      }),
    ]);
    this.waiter = null;
  }
}

/** Drive only the actionable classes named by one scheduling query. */
export async function driveTicks(
  store: Store,
  ticker: Pick<Ticker, "once">,
  opts: {
    forever: boolean;
    reporter: Pick<Reporter, "line" | "problem">;
    capabilities: ScheduleCapabilities;
    wake?: DriveWake;
    watch?: () => Promise<void>;
    cadence?: CadencePass;
    /** Called after each successful schedule read. */
    onTick?: () => void;
    /** Records only attempted cadence passes; idle intervals leave it alone. */
    onCadenceResult?: (succeeded: boolean) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Test seam for stopping without emitting a process-wide signal. */
    shouldStop?: () => boolean;
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
  const sleep = opts.sleep ?? Bun.sleep;
  const wake = opts.wake ?? new DriveWake();
  let first = true;

  const readSchedule = async (): Promise<WorkSchedule> => {
    const schedule = await store.workSchedule(now(), GRACE_MS, RETENTION_MS, {
      providerConfigured: opts.capabilities.providerConfigured,
      provisioningConfigured: opts.capabilities.provisioningConfigured,
      checkoutConfigured: opts.capabilities.checkoutConfigured,
      cadenceConfigured: opts.cadence !== undefined,
      livenessConfigured: opts.watch !== undefined,
      staleProvisioningMs: opts.capabilities.staleProvisioningMs,
      staleProvisioningReason: opts.capabilities.staleProvisioningReason,
    });
    opts.onTick?.();
    return schedule;
  };
  const announce = async (): Promise<void> => {
    for (const reason of await store.allOpenReasons()) {
      if (announced.has(reason.id)) continue;
      announced.add(reason.id);
      opts.reporter.problem(
        `ATTENTION (${reason.severity}) on ${reason.instance_id}: ${reason.reason}`,
      );
    }
  };

  try {
    let schedule = await readSchedule();
    await announce();
    for (;;) {
      const wakeTick = wake.pending();
      const forceStartupTick = first;
      const forceStartupCadence = first && opts.cadence !== undefined;
      first = false;
      const runTick = wakeTick || forceStartupTick || schedule.tickDue;
      const runCadence = forceStartupCadence || schedule.cadenceDue;
      const anyClass = runTick || runCadence || schedule.livenessDue;
      if (anyClass) {
        const passStartedAt = now();
        wake.consume();
        let summary: TickSummary | null = null;
        if (runTick) summary = await ticker.once();
        if (runCadence && opts.cadence) {
          try {
            await opts.cadence.run();
            opts.onCadenceResult?.(true);
          } catch (err) {
            opts.onCadenceResult?.(false);
            opts.reporter.problem(
              `${opts.cadence.failureLabel}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (schedule.livenessDue && opts.watch) {
          try {
            await opts.watch();
          } catch (err) {
            opts.reporter.problem(
              `monitoring pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        await announce();
        if (stopping || opts.shouldStop?.()) return;
        if (!opts.forever && summary?.live === 0) return;
        schedule = await readSchedule();
        const floorRemaining =
          ACTIVE_LOOP_INTERVAL_MS - (now() - passStartedAt);
        if (floorRemaining > 0) await sleep(floorRemaining);
        if (stopping || opts.shouldStop?.()) return;
        continue;
      }
      if (stopping || opts.shouldStop?.()) return;
      const untilDue =
        schedule.nextDueAt === null
          ? IDLE_LOOP_INTERVAL_MS
          : Math.min(
              IDLE_LOOP_INTERVAL_MS,
              Math.max(0, schedule.nextDueAt - now()),
            );
      // Applied after the due/ceiling calculation: a stale timestamp can never
      // spin, while the wake races this timer and therefore pays no floor.
      const delay = Math.max(ACTIVE_LOOP_INTERVAL_MS, untilDue);
      await wake.wait(delay, sleep);
      if (stopping || opts.shouldStop?.()) return;
      schedule = await readSchedule();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// The office process's stop: SIGTERM (a service manager's stop or restart) or
// SIGINT (Ctrl-C on a foreground server).
//
// systemd stops the unit with SIGTERM to its whole control group, so every
// agent backend gets the signal in the same moment as the server and dies with
// exit 143 while the server still runs its stop hooks. serverStopping() lets
// the death notice name the stop instead of out-of-memory protection
// (backend-failure-text.ts, task e438f301). No ordering between the server's
// signal handler and a backend's exit event is guaranteed; measured 2026-10-19,
// the flag was already set in 10 of 10 runs, child killed first included.
//
// This module is the process's only SIGTERM/SIGINT listener: a second
// listener that re-raises on its own would kill the process before a slower
// hook settles. The first signal sets the flag, runs every hook, and re-raises
// the same signal once all have settled, so the process dies by that signal. A
// hook that throws or rejects is logged and does not stop the others or the
// re-raise. A second signal while hooks run ends the process at once by that
// signal, so a hung hook never needs SIGKILL. The flag never resets, and a
// hook registered after the signal does not run.
//
// A repeat within FORWARDED_COPY_MS of the first is ignored: under a unit that
// runs `bun run dev`, systemd signals the outer bun and the office together,
// and bun run forwards its copy to the office (measured 2026-11-04). Taking
// that copy as the second signal would skip every hook.
//
// After the hooks, one final step runs before the re-raise: the office's
// SIGKILL of what outlived the signal (stop-reap.ts). It fails like a hook.

type StopSignal = "SIGINT" | "SIGTERM";

// How soon after the first signal a repeat is taken as a forwarded copy.
const FORWARDED_COPY_MS = 500;

let stopping = false;
let signalAt = 0;
let finalStep: ((signalAt: number) => Promise<unknown>) | null = null;
const hooks: (() => Promise<unknown>)[] = [];

/** True once this process got SIGTERM or SIGINT. Never resets. */
export function serverStopping(): boolean {
  return stopping;
}

/**
 * Run `hook` when the stop signal arrives. The signal is re-raised after
 * every hook settles, so the process still dies by that signal.
 */
export function runAtServerStop(hook: () => Promise<unknown>): void {
  hooks.push(hook);
}

/**
 * Run `step` after every hook settles and before the re-raise, with the time
 * the signal arrived. One slot: a later call replaces it, null clears it.
 */
export function setStopFinalStep(
  step: ((signalAt: number) => Promise<unknown>) | null,
): void {
  finalStep = step;
}

function dieBy(signal: StopSignal): void {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.kill(process.pid, signal);
}

function onStopSignal(signal: StopSignal): void {
  if (stopping) {
    if (Date.now() - signalAt < FORWARDED_COPY_MS) return;
    dieBy(signal);
    return;
  }
  stopping = true;
  signalAt = Date.now();
  void Promise.allSettled(hooks.map(async (hook) => hook()))
    .then(async (results) => {
      for (const result of results)
        if (result.status === "rejected")
          console.error("[server-stop] stop hook failed:", result.reason);
      const step = finalStep;
      if (step) await step(signalAt);
    })
    .catch((err: unknown) => {
      console.error("[server-stop] final stop step failed:", err);
    })
    .finally(() => dieBy(signal));
}

const onSigint = () => onStopSignal("SIGINT");
const onSigterm = () => onStopSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

// Giving the office server's process a name of its own, so that out-of-memory
// protection can tell it apart from the agents it spawns.
//
// earlyoom picks what to kill by process NAME, and the office server's name is
// `bun` - the same name as every `bun install` and `bun run build` an agent
// starts. Shielding the name `bun` therefore shielded the multi-GB build spike
// that most needs killing, and the server gained nothing it did not already
// share with its own workload. Renaming the server breaks the tie:
// deploy/oom-protect.sh shields `isomux`, and an agent's build keeps `bun`.
//
// Two properties of the kernel interface shape how this is used. Writing
// /proc/self/comm affects only the calling thread, so it has to happen on the
// main thread at process entry rather than in a module anything might import.
// And a name is reset by exec, so nothing the server spawns inherits it.

import { writeFileSync } from "fs";

/** What the office server calls itself; deploy/oom-protect.sh shields this. */
export const OFFICE_PROCESS_NAME = "isomux";

/**
 * Rename the calling thread's process, and say so if the kernel refuses.
 *
 * Returns whether the name took. Callers are not expected to care: this is
 * protection metadata, not part of serving the office, so a box where it fails
 * runs exactly as well - it just falls back to being named `bun` and loses the
 * distinction that out-of-memory protection relies on.
 */
export function setProcessName(): boolean {
  if (process.platform !== "linux") return false;
  try {
    writeFileSync("/proc/self/comm", OFFICE_PROCESS_NAME);
    return true;
  } catch (err) {
    console.warn(
      `[oom] could not name this process "${OFFICE_PROCESS_NAME}" (${String(err)}); under memory pressure the office may not be told apart from the builds it runs.`,
    );
    return false;
  }
}

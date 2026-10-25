// Live-test support: close a Codex App Server client and wait until its whole
// process group is gone, so a caller can remove the scratch CODEX_HOME without
// the stopping server writing auth.json and its state back into it.
import { CODEX_KILL_GRACE_MS, type JsonRpcLiteClient } from "./client.ts";

const POLL_MS = 25;
// After closeAndReap's own SIGKILL, how long it waits for the group to go.
const AFTER_KILL_MS = 1000;

// The group check is valid only under the local agent host (the live suites
// always run there): a runner host's pid belongs to another user, so kill
// reports EPERM, which counts as alive.
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Resolves true when the group is gone, or false when it outlives the deadline and
// a SIGKILL. The async sleep lets Bun reap the launcher, and it keeps the event
// loop alive for the client's own SIGKILL escalation timer.
export async function waitForGroupExit(
  pgid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

// Never throws: callers run it in finally blocks, where a throw would replace
// the test's own error.
export async function closeAndReap(
  client: JsonRpcLiteClient,
  timeoutMs = CODEX_KILL_GRACE_MS + 3000,
): Promise<boolean> {
  const pgid = client.pid();
  await client.close();
  if (pgid === undefined) return true;
  if (await waitForGroupExit(pgid, timeoutMs)) return true;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
  return await waitForGroupExit(pgid, AFTER_KILL_MS);
}

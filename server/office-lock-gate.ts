// The lock the lockdown route sets (task cdd7883d). From the moment it is set,
// the office's fetch handler answers every request with the locked page
// (server/locked-office.ts lockedResponse), before app hosts, webhooks, MCP,
// static files or a WebSocket upgrade, until the process stops and boots
// locked. No unlock: only the host command removes a lock.

// Every open WebSocket of the office listener: the office's own, API token,
// extension and app relay sockets alike.
interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

let locked = false;
const sockets = new Set<ClosableSocket>();

export function trackOfficeSocket(ws: ClosableSocket): void {
  sockets.add(ws);
}

export function untrackOfficeSocket(ws: ClosableSocket): void {
  sockets.delete(ws);
}

/** Closes every tracked socket. The lockdown route's closeSockets. */
export function closeOfficeSockets(): void {
  for (const ws of [...sockets]) {
    sockets.delete(ws);
    try {
      ws.close(1012, "office locked");
    } catch {
      // Already closing.
    }
  }
}

/** True once the lockdown route locked this process. */
export function officeLockedNow(): boolean {
  return locked;
}

/** Locks this process. Never undone in production. */
export function lockOfficeNow(): void {
  locked = true;
}

/** The in-process harness boots several offices in one process. */
export function resetOfficeLockGate(): void {
  locked = false;
  sockets.clear();
}

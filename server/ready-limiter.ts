// Fixed-window per-client rate limits for the unauthenticated /readyz probe
// and the public office card (internal-docs/release-design.md).
//
// Both answer off-box callers with no identity at all, so each gets an
// anti-abuse limit. On-box callers are exempt AT THE
// CALL SITE (the updater's post-restart poll must never be able to
// manufacture a rollback by tripping its own limit); this module only ever
// sees off-box clients. The key is the client address from
// server/proxy-trust.ts, which behind a declared proxy is the address the
// proxy forwarded, not the proxy's own.
//
// Failure posture is fail-OPEN: /readyz exists to report availability, and
// the limiter is a nuisance control, not a security boundary. When the
// tracking map is full of live windows, an unknown IP is allowed untracked
// rather than denied.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
// Bounds the map so a spoofed-source flood can't grow memory unboundedly.
const MAX_TRACKED_IPS = 1024;

interface Window {
  start: number;
  count: number;
}

// One budget per caller of the limiter: the public office card
// (server/office-card.ts) has the same posture as /readyz but its own windows,
// so card probes never use up the updater's /readyz budget.
function createLimiter() {
  const windows = new Map<string, Window>();
  const allow = (ip: string, now: number): boolean => {
    const w = windows.get(ip);
    if (w && now - w.start < WINDOW_MS) {
      w.count++;
      return w.count <= MAX_PER_WINDOW;
    }
    if (!w && windows.size >= MAX_TRACKED_IPS) {
      for (const [key, win] of windows) {
        if (now - win.start >= WINDOW_MS) windows.delete(key);
      }
      if (windows.size >= MAX_TRACKED_IPS) return true; // fail open, untracked
    }
    windows.set(ip, { start: now, count: 1 });
    return true;
  };
  return { allow, reset: () => windows.clear() };
}

const ready = createLimiter();
const officeCard = createLimiter();

export const allowReadyRequest = ready.allow;
export const allowOfficeCardRequest = officeCard.allow;

export function _resetReadyLimiterForTests(): void {
  ready.reset();
  officeCard.reset();
}

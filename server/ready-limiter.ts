// Fixed-window per-IP rate limit for the unauthenticated /readyz probe
// (internal-docs/release-design.md).
//
// /readyz is the one endpoint that answers non-loopback callers with no
// identity at all, so it gets an anti-abuse limit. Loopback is exempt AT THE
// CALL SITE (the updater's post-restart poll must never be able to
// manufacture a rollback by tripping its own limit); this module only ever
// sees non-loopback addresses.
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

const windows = new Map<string, Window>();

export function allowReadyRequest(ip: string, now: number): boolean {
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
}

export function _resetReadyLimiterForTests(): void {
  windows.clear();
}

// Rate limits for app-to-agent messages. See internal-docs/agent-apps-design.md
// section 5: "A message wakes an agent and burns model tokens. An app in a loop
// is a bill."
//
// TWO LIMITS, BECAUSE THERE ARE TWO COSTS. A burst limit protects the office
// from a hammering caller (the cost is isomux's, and it is paid whether or not
// anything is delivered), and a daily cap protects the boss's model spend (the
// cost is paid only when an agent actually wakes up). They are therefore spent
// at different moments, which is why this is not one `take()`:
//
//   - takeBurst() is called for every syntactically valid request that is about
//     to be delivered, and spends its slot even if the delivery then fails. An
//     app retrying against a stopped agent is exactly the loop worth arresting.
//   - commitDaily() is called only after a delivery the receiver ACCEPTED. A
//     stopped, missing or queue-full receiver burned no model tokens, so it must
//     not burn the app's day - otherwise one app whose agent is down for an hour
//     comes back to a spent budget it never used.
//
// IN MEMORY, AND THAT IS STATED RATHER THAN HIDDEN. The counters reset when
// isomux restarts. A restart is a human act (or a crash) that an app in a loop
// cannot cause, so the protection holds for as long as a bill could accrue,
// while persisting it would put a disk write on every message. Nothing here
// claims to be durable, and the report says the same.

// Burst: how many messages one app may send in the window. Five rather than
// three so an event-driven app (a webhook that fires a few times in a row, a
// nightly job reporting several results) does not trip the limit doing something
// legitimate, while a runaway loop still stops within seconds.
export const APP_MESSAGE_BURST_LIMIT = 10;
export const APP_MESSAGE_BURST_WINDOW_MS = 60_000;

// Daily: how many messages one app may successfully deliver per ROLLING 24
// hours. Rolling rather than calendar-day, which would need a timezone nobody
// has chosen and would hand back a full budget at midnight to an app that had
// just spent one.
export const APP_MESSAGE_DAILY_CAP = 500;
export const APP_MESSAGE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Message length. Agent-to-agent sends have no cap, and that is defensible for a
// caller with a model's judgment; an unattended process has none, and a
// megabyte-long message is the same bill as a thousand short ones. The contract
// is JS string length (UTF-16 code units), not bytes - what the caller counted
// in its own source is what is measured here.
export const APP_MESSAGE_MAX_CHARS = 4000;

export type AppMessageLimitOutcome =
  | { ok: true }
  // `kind` is the limit that is actually blocking, and retryAfterSec is when the
  // request could ACTUALLY succeed - see the max() below.
  | { ok: false; kind: "burst" | "daily"; retryAfterSec: number };

export interface AppMessageLimiter {
  // Check both limits and, when the message may go, spend the burst slot in the
  // same synchronous step (no window between deciding and recording).
  takeBurst(appName: string): AppMessageLimitOutcome;
  // Spend one of the app's daily messages. Called after a delivery the receiver
  // accepted, never before.
  commitDaily(appName: string): void;
  // Drop everything recorded against a name, because the app that spent it is
  // gone. Called by the delete route once the record is removed. NEVER throws:
  // it runs after the delete has committed, and a rate-limit counter is not
  // worth failing a delete that already happened.
  forget(appName: string): void;
}

export interface AppMessageLimiterOptions {
  now?: () => number;
}

interface AppCounters {
  // Timestamps, oldest first (pushes are monotonic in `now`).
  burst: number[];
  daily: number[];
}

// Drop everything that has aged out of `windowMs`. Called on every access, so
// the arrays never grow past their limit + whatever arrived inside one window.
function prune(times: number[], now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  let drop = 0;
  while (drop < times.length && times[drop] <= cutoff) drop++;
  if (drop > 0) times.splice(0, drop);
}

// When does the oldest entry leave the window? Rounded UP so the advice is never
// optimistic (a caller that retries at the truncated second is refused again),
// and never below 1: "retry in 0 seconds" reads as "retry now", which is wrong.
function waitSecs(oldest: number, now: number, windowMs: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

// The limiter plus a handle on its state, so the production singleton can be
// cleared by the test harness (see _testResetAppMessageLimits) without `reset`
// becoming part of the interface every caller sees.
function buildLimiter(options: AppMessageLimiterOptions): {
  limiter: AppMessageLimiter;
  clear: () => void;
} {
  const now = options.now ?? (() => Date.now());
  // Keyed by app name, which is unique across LIVE apps - so an entry is only
  // unambiguous while its app exists, and delete calls forget() to keep it that
  // way. Without that, an app deleted and re-registered under the same name
  // would inherit the previous one's spent budget, and since names are
  // claimable by anyone that is one user's app denying another user's app for
  // up to a day. An entry costs two small arrays; the registry's own app cap
  // bounds how many exist.
  const counters = new Map<string, AppCounters>();

  const countersFor = (appName: string): AppCounters => {
    let c = counters.get(appName);
    if (!c) {
      c = { burst: [], daily: [] };
      counters.set(appName, c);
    }
    return c;
  };

  const limiter: AppMessageLimiter = {
    takeBurst(appName) {
      const t = now();
      const c = countersFor(appName);
      prune(c.burst, t, APP_MESSAGE_BURST_WINDOW_MS);
      prune(c.daily, t, APP_MESSAGE_DAILY_WINDOW_MS);

      const burstBlocked = c.burst.length >= APP_MESSAGE_BURST_LIMIT;
      const dailyBlocked = c.daily.length >= APP_MESSAGE_DAILY_CAP;

      if (burstBlocked || dailyBlocked) {
        // BOTH waits are computed when both block, and the longer one is what
        // the caller is told. Reporting the burst's "retry in 30s" while the
        // rolling day still blocks for six hours would be advice that sends a
        // well-behaved app into a retry loop - the exact behavior these limits
        // exist to prevent.
        const burstWait = burstBlocked
          ? waitSecs(c.burst[0], t, APP_MESSAGE_BURST_WINDOW_MS)
          : 0;
        const dailyWait = dailyBlocked
          ? waitSecs(c.daily[0], t, APP_MESSAGE_DAILY_WINDOW_MS)
          : 0;
        return dailyWait > burstWait
          ? { ok: false, kind: "daily", retryAfterSec: dailyWait }
          : { ok: false, kind: "burst", retryAfterSec: burstWait };
      }

      c.burst.push(t);
      return { ok: true };
    },

    commitDaily(appName) {
      const c = countersFor(appName);
      const t = now();
      prune(c.daily, t, APP_MESSAGE_DAILY_WINDOW_MS);
      c.daily.push(t);
    },

    // Deliberately not countersFor(): forgetting an unknown name must not
    // CREATE an entry for it.
    forget(appName) {
      counters.delete(appName);
    },
  };

  return { limiter, clear: () => counters.clear() };
}

export function createAppMessageLimiter(
  options: AppMessageLimiterOptions = {},
): AppMessageLimiter {
  return buildLimiter(options).limiter;
}

// Production singleton. Process-lifetime state by design (see the header).
const production = buildLimiter({});
export const appMessageLimiter: AppMessageLimiter = production.limiter;

// TEST-ONLY. The counters reset when isomux restarts - that is the documented
// lifecycle, and it is the honest justification for keeping them off disk. A
// test harness that cold-restarts the server inside ONE process would otherwise
// carry them across a restart it is modelling as an isomux restart, making the
// harness disagree with the thing it tests. Called from the harness's boot
// resets beside _testResetTokens; deliberately not part of AppMessageLimiter, so
// no production caller can reach it.
export function _testResetAppMessageLimits(): void {
  production.clear();
}

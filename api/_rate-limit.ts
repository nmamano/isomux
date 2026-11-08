// Sliding-window rate limits per IP, in memory, per server process. Each
// limiter keeps its own counts. Responses report them in the RateLimit-Policy
// and RateLimit fields of the IETF draft draft-ietf-httpapi-ratelimit-headers.

export type Policy = { name: string; quota: number; windowMs: number };

export type Quota = Policy & {
  remaining: number;
  /** Seconds until the oldest counted request leaves the window; 0 if none. */
  resetSeconds: number;
};

export type RateLimiter = {
  /** Count a request if every window has room. Quotas are the state after it. */
  check(ip: string): { allowed: boolean; quotas: Quota[] };
  /** Where an IP stands in each window, without counting a request. */
  state(ip: string): Quota[];
  /** How many IPs the limiter holds. */
  trackedIpCount(): number;
};

export function createRateLimiter(policies: Policy[]): RateLimiter {
  const longestWindowMs = Math.max(...policies.map((p) => p.windowMs));
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  /**
   * Forgets each IP whose newest hit no window counts any more, at most once a
   * minute, so that one long-running process does not keep every visitor.
   */
  function forgetStale(now: number): void {
    if (now >= lastSweep && now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [ip, timestamps] of hits)
      if (!timestamps.length || now - timestamps.at(-1)! >= longestWindowMs)
        hits.delete(ip);
  }

  function quotaState(ip: string, now: number): Quota[] {
    const timestamps = hits.get(ip) ?? [];
    return policies.map((policy) => {
      const inWindow = timestamps.filter((t) => now - t < policy.windowMs);
      return {
        ...policy,
        remaining: Math.max(0, policy.quota - inWindow.length),
        resetSeconds: inWindow.length
          ? Math.ceil((inWindow[0] + policy.windowMs - now) / 1000)
          : 0,
      };
    });
  }

  return {
    check(ip) {
      const now = Date.now();
      forgetStale(now);
      const timestamps = (hits.get(ip) ?? []).filter(
        (t) => now - t < longestWindowMs,
      );
      hits.set(ip, timestamps);
      if (quotaState(ip, now).some((q) => q.remaining === 0)) {
        return { allowed: false, quotas: quotaState(ip, now) };
      }
      timestamps.push(now);
      return { allowed: true, quotas: quotaState(ip, now) };
    },
    state: (ip) => quotaState(ip, Date.now()),
    trackedIpCount: () => hits.size,
  };
}

/** The client address: the first X-Forwarded-For entry, else "unknown". */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Seconds until a request is allowed: the latest reset of a spent window. */
export function retryAfterSeconds(quotas: Quota[]): number {
  return Math.max(
    0,
    ...quotas.filter((q) => q.remaining === 0).map((q) => q.resetSeconds),
  );
}

export function setRateLimitFields(headers: Headers, quotas: Quota[]): void {
  headers.set(
    "RateLimit-Policy",
    quotas
      .map((q) => `"${q.name}";q=${q.quota};w=${q.windowMs / 1000}`)
      .join(", "),
  );
  headers.set(
    "RateLimit",
    quotas
      .map((q) => `"${q.name}";r=${q.remaining};t=${q.resetSeconds}`)
      .join(", "),
  );
}

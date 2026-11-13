// The office names the elevator panel shows (GET /api/floors/name): one card
// probe per origin, shared by every caller and kept for a while, failures
// included, with a limit on the probes one caller has in flight.

import type { OfficeCard } from "../shared/floors.ts";

export type OfficeNameLookup =
  { kind: "card"; name: string | null } | { kind: "failed" } | { kind: "busy" };

export interface OfficeNameCacheOptions {
  probe(origin: string): Promise<OfficeCard | "outdated" | null>;
  now?: () => number;
  ttlMs?: number;
  maxOrigins?: number;
  maxInFlightPerCaller?: number;
}

export const OFFICE_NAME_TTL_MS = 60 * 60 * 1000;
export const OFFICE_NAME_MAX_ORIGINS = 1000;
export const OFFICE_NAME_MAX_IN_FLIGHT = 4;

export interface OfficeNameCache {
  lookup(origin: string, callerKey: string): Promise<OfficeNameLookup>;
}

export function createOfficeNameCache(
  opts: OfficeNameCacheOptions,
): OfficeNameCache {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? OFFICE_NAME_TTL_MS;
  const maxOrigins = opts.maxOrigins ?? OFFICE_NAME_MAX_ORIGINS;
  const maxInFlight = opts.maxInFlightPerCaller ?? OFFICE_NAME_MAX_IN_FLIGHT;
  // In insertion order, so the first key is the oldest answer.
  const answers = new Map<string, { answer: OfficeNameLookup; at: number }>();
  const probes = new Map<string, Promise<OfficeNameLookup>>();
  const inFlight = new Map<string, number>();

  const probeOnce = (origin: string): Promise<OfficeNameLookup> => {
    const running = probes.get(origin);
    if (running) return running;
    const started = (async (): Promise<OfficeNameLookup> => {
      let answer: OfficeNameLookup = { kind: "failed" };
      try {
        const card = await opts.probe(origin);
        if (card && card !== "outdated")
          answer = { kind: "card", name: card.name };
      } catch {
        // A probe that throws is a failed probe; it must never reject.
      }
      answers.delete(origin);
      answers.set(origin, { answer, at: now() });
      while (answers.size > maxOrigins) {
        const oldest = answers.keys().next().value;
        if (oldest === undefined) break;
        answers.delete(oldest);
      }
      probes.delete(origin);
      return answer;
    })();
    probes.set(origin, started);
    return started;
  };

  return {
    async lookup(origin, callerKey) {
      const kept = answers.get(origin);
      if (kept && now() - kept.at < ttlMs) return kept.answer;
      const count = inFlight.get(callerKey) ?? 0;
      if (count >= maxInFlight) return { kind: "busy" };
      inFlight.set(callerKey, count + 1);
      try {
        return await probeOnce(origin);
      } finally {
        const left = (inFlight.get(callerKey) ?? 1) - 1;
        if (left > 0) inFlight.set(callerKey, left);
        else inFlight.delete(callerKey);
      }
    },
  };
}

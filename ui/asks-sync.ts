// The asks' client half (internal-docs/asks-design.md): the
// snapshot behind the store's asks slice, and the per-agent view of it.

import { useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { apiFetch } from "./api.ts";
import type { AskEntry } from "../shared/types.ts";

/**
 * Keep the store's asks slice filled. Mounted once, by App. Keyed on
 * hydrationEpoch for the reason usePagerSync is: every reconnect may have
 * missed deltas. A snapshot that a delta overtook is refused by the reducer,
 * which bumps asksFetchSeq and so re-runs this effect.
 */
export function useAsksSync(): void {
  const { hydrationEpoch, asksFetchSeq, asksRevision } =
    useAppState();
  const dispatch = useDispatch();
  const revision = asksRevision;
  useEffect(() => {
    if (hydrationEpoch === 0) return;
    let cancelled = false;
    apiFetch<AskEntry[]>("GET", "/api/asks").then(
      (entries) => {
        if (cancelled || !Array.isArray(entries)) return;
        dispatch({ type: "asks_loaded", entries, revision });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // revision is deliberately not a dependency: see usePagerSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hydrationEpoch, asksFetchSeq]);
}

/** One agent's open asks for this member, oldest first. */
export function asksFor(
  entries: readonly AskEntry[],
  agentId: string,
): AskEntry[] {
  return entries
    .filter((e) => e.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Open asks per agent, for the desk dots. */
export function askCounts(
  entries: readonly AskEntry[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1);
  return counts;
}

// The actionables' client half (internal-docs/actionables-design.md): the
// snapshot behind the store's actionables slice, and the per-agent view of it.

import { useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { apiFetch } from "./api.ts";
import type { ActionableEntry } from "../shared/types.ts";

/**
 * Keep the store's actionables slice filled. Mounted once, by App. Keyed on
 * hydrationEpoch for the reason usePagerSync is: every reconnect may have
 * missed deltas. A snapshot that a delta overtook is refused by the reducer,
 * which bumps actionablesFetchSeq and so re-runs this effect.
 */
export function useActionablesSync(): void {
  const { hydrationEpoch, actionablesFetchSeq, actionablesRevision } =
    useAppState();
  const dispatch = useDispatch();
  const revision = actionablesRevision;
  useEffect(() => {
    if (hydrationEpoch === 0) return;
    let cancelled = false;
    apiFetch<ActionableEntry[]>("GET", "/api/actionables").then(
      (entries) => {
        if (cancelled || !Array.isArray(entries)) return;
        dispatch({ type: "actionables_loaded", entries, revision });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // revision is deliberately not a dependency: see usePagerSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hydrationEpoch, actionablesFetchSeq]);
}

/** One agent's open actionables for this member, oldest first. */
export function actionablesFor(
  entries: readonly ActionableEntry[],
  agentId: string,
): ActionableEntry[] {
  return entries
    .filter((e) => e.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Open actionables per agent, for the desk dots. */
export function actionableCounts(
  entries: readonly ActionableEntry[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1);
  return counts;
}

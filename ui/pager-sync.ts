// The pager's client half (internal-docs/pager-design.md): the snapshot fetch
// behind the store's pager slice, and the badge count.

import { useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { apiFetch } from "./api.ts";
import type { PagerEntry } from "../shared/types.ts";

/**
 * Keep the store's pager slice filled. Mounted once, by App.
 *
 * Keyed on hydrationEpoch, not `connected`: ws.ts can reconnect a frozen
 * mobile socket without `connected` ever going false, and every reconnect may
 * have missed deltas. A run whose epoch has passed is cancelled, so a slow
 * response from an earlier connection never lands. A snapshot that a delta
 * overtook is refused by the reducer, which bumps pagerFetchSeq and so re-runs
 * this effect.
 */
export function usePagerSync(): void {
  const { hydrationEpoch, pagerFetchSeq, pagerRevision } = useAppState();
  const dispatch = useDispatch();
  // Read in the effect body only. A delta re-renders but does not re-run the
  // effect, so the revision captured here is the one current at the request.
  const revision = pagerRevision;
  useEffect(() => {
    if (hydrationEpoch === 0) return;
    let cancelled = false;
    apiFetch<PagerEntry[]>("GET", "/api/pager?state=all").then(
      (entries) => {
        if (cancelled) return;
        // Anything but a list is a failed read: the office bar renders from
        // this slice, so a malformed answer must not reach it.
        dispatch(
          Array.isArray(entries)
            ? { type: "pager_loaded", entries, revision }
            : { type: "pager_load_failed" },
        );
      },
      () => {
        if (!cancelled) dispatch({ type: "pager_load_failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // revision is deliberately not a dependency: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hydrationEpoch, pagerFetchSeq]);
}

/** The badge: open pages whose target is this member, in any room. */
export function openPagesFor(
  entries: readonly PagerEntry[],
  userId: string | null,
): number {
  if (userId === null) return 0;
  let count = 0;
  for (const e of entries) {
    if (e.state === "open" && e.targetUserId === userId) count++;
  }
  return count;
}

/** The view's order: open pages first, then the newest raise. */
export function comparePagerEntries(a: PagerEntry, b: PagerEntry): number {
  const openA = a.state === "open" ? 0 : 1;
  const openB = b.state === "open" ? 0 : 1;
  return openA - openB || b.lastRaisedAt - a.lastRaisedAt;
}

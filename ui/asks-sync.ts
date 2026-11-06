// The asks' client half (internal-docs/asks-design.md): the
// snapshot behind the store's asks slice, and the per-agent view of it.

import { useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { apiFetch } from "./api.ts";
import type { AskMemberWire } from "../shared/types.ts";
import type { AskAgentWire } from "../shared/contract-shapes.ts";

/**
 * Keep the store's asks slice filled. Mounted once, by App. Keyed on
 * hydrationEpoch for the reason usePagerSync is: every reconnect may have
 * missed deltas. A snapshot that a delta overtook is refused by the reducer,
 * which bumps asksFetchSeq and so re-runs this effect. A failed read sets
 * asksLoadFailed; the Asks tab's Try again bumps asksFetchSeq.
 */
export function useAsksSync(): void {
  const { hydrationEpoch, asksFetchSeq, asksRevision } = useAppState();
  const dispatch = useDispatch();
  const revision = asksRevision;
  useEffect(() => {
    if (hydrationEpoch === 0) return;
    let cancelled = false;
    apiFetch<AskMemberWire[]>("GET", "/api/asks").then(
      (entries) => {
        if (cancelled) return;
        if (!Array.isArray(entries)) dispatch({ type: "asks_load_failed" });
        else dispatch({ type: "asks_loaded", entries, revision });
      },
      () => {
        if (!cancelled) dispatch({ type: "asks_load_failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // revision is deliberately not a dependency: see usePagerSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hydrationEpoch, asksFetchSeq]);
}

/**
 * Keep the store's othersAsks slice filled for an office owner: other
 * members' open asks, which the owner answers on the Asks tab. Mounted once,
 * by App; it reads nothing for a member who is not an owner. Keyed as useAsksSync, and
 * on the role, so a member made owner reads them at once.
 */
export function useOthersAsksSync(): void {
  const {
    hydrationEpoch,
    othersAsksFetchSeq,
    othersAsksRevision,
    sessionContext,
  } = useAppState();
  const dispatch = useDispatch();
  const isOwner = sessionContext?.role === "owner";
  const revision = othersAsksRevision;
  useEffect(() => {
    if (hydrationEpoch === 0 || !isOwner) return;
    let cancelled = false;
    apiFetch<AskAgentWire[]>("GET", "/api/asks/others").then(
      (entries) => {
        if (cancelled) return;
        if (!Array.isArray(entries))
          dispatch({ type: "others_asks_load_failed" });
        else dispatch({ type: "others_asks_loaded", entries, revision });
      },
      () => {
        if (!cancelled) dispatch({ type: "others_asks_load_failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // revision is deliberately not a dependency: see usePagerSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hydrationEpoch, othersAsksFetchSeq, isOwner]);
}

/** One agent's open asks for this member, oldest first. */
export function asksFor(
  entries: readonly AskMemberWire[],
  agentId: string,
): AskMemberWire[] {
  return entries
    .filter((e) => e.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Open asks per agent, for the desk dots. */
export function askCounts(
  entries: readonly AskMemberWire[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1);
  return counts;
}

/**
 * The asks the Inbox's Asks tab lists and counts: those whose agent is
 * in the agents slice, and those with no agent. GET /api/asks filters on room access, but an agent in
 * a room the member hides never reaches the client, so its desk and chat
 * cannot show the ask either.
 */
export function visibleAsks<T extends AskMemberWire>(
  entries: readonly T[],
  agents: readonly { id: string }[],
): T[] {
  const ids = new Set(agents.map((a) => a.id));
  // An ask with no agent (agentId "", task 74e8fc07) is for the member alone.
  return entries.filter((e) => e.agentId === "" || ids.has(e.agentId));
}

/**
 * The asks the member still has to answer: those without an answer on the
 * Inbox (answeredAsks, in either phase). The counts, the desk dots and the
 * chat's ask stack read this.
 */
export function openAsks(
  entries: readonly AskMemberWire[],
  answered: ReadonlyMap<string, unknown>,
): AskMemberWire[] {
  return entries.filter((e) => !answered.has(e.id));
}

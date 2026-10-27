// The Inbox (task c952e551): one top-bar entry over two tabs, the pager's
// pages and the asks. Each tab is its own route ("pager" and "asks" in
// ui/routes.ts), so this module holds only what the bar and the tabs share.

import { useMemo } from "react";
import { useAppState } from "./store.tsx";
import { openPagesFor } from "./pager-sync.ts";
import { openAsks, visibleAsks } from "./asks-sync.ts";
import type { AskMemberWire, PagerEntry } from "../shared/types.ts";

/** An Inbox tab is the page it shows. */
export type InboxTab = "pager" | "asks";

export interface InboxCounts {
  pages: number;
  asks: number;
}

/**
 * The open items per tab. The bar's badge is their sum. An ask answered on
 * the Inbox (`answered`) no longer counts.
 */
export function inboxCounts(
  pager: readonly PagerEntry[],
  asks: readonly AskMemberWire[],
  agents: readonly { id: string }[],
  userId: string | null,
  answered: ReadonlyMap<string, unknown>,
): InboxCounts {
  return {
    pages: openPagesFor(pager, userId),
    asks: openAsks(visibleAsks(asks, agents), answered).length,
  };
}

/** The tab the bar entry opens: Pages when a page is open, else Asks. */
export function inboxTabFor(counts: InboxCounts): InboxTab {
  return counts.pages > 0 ? "pager" : "asks";
}

export function useInboxCounts(): InboxCounts {
  const { pager, asks, agents, sessionContext, answeredAsks } = useAppState();
  const userId = sessionContext?.userId ?? null;
  return useMemo(
    () => inboxCounts(pager, asks, agents, userId, answeredAsks),
    [pager, asks, agents, userId, answeredAsks],
  );
}

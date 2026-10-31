// The Inbox (task c952e551): one top-bar entry over two tabs, the pager's
// pages and the asks. Each tab is its own route ("pager" and "asks" in
// ui/routes.ts), so this module holds only what the bar and the tabs share.

import { useMemo, useSyncExternalStore } from "react";
import { useAppState } from "./store.tsx";
import { useI18n } from "./i18n.tsx";
import { InboxIcon } from "./components/NavIcons.tsx";
import type { NavAction } from "./components/NavActions.tsx";
import { openPagesFor } from "./pager-sync.ts";
import { openAsks, visibleAsks } from "./asks-sync.ts";
import { getAsksSeen, subscribeAsksSeen } from "./device-settings.ts";
import type { AskMemberWire, PagerEntry } from "../shared/types.ts";

/** An Inbox tab is the page it shows. */
export type InboxTab = "pager" | "asks";

export interface InboxCounts {
  pages: number;
  asks: number;
  // The open asks not yet shown on the Asks tab (getAsksSeen).
  newAsks: number;
}

/**
 * The open items per tab, and of the open asks those not in `seen`, which
 * this browser has not shown on the Asks tab. The bar's badge is the pages
 * and the new asks (task a930c9d6). An ask answered on the Inbox (`answered`)
 * no longer counts, nor do the asks of `exceptAgentId`: the chat bar leaves
 * out the asks its chat already shows.
 */
export function inboxCounts(
  pager: readonly PagerEntry[],
  asks: readonly AskMemberWire[],
  agents: readonly { id: string }[],
  userId: string | null,
  answered: ReadonlyMap<string, unknown>,
  seen: ReadonlySet<string>,
  exceptAgentId?: string,
): InboxCounts {
  const open = openAsks(visibleAsks(asks, agents), answered).filter(
    (e) => e.agentId !== exceptAgentId,
  );
  return {
    pages: openPagesFor(pager, userId),
    asks: open.length,
    newAsks: open.filter((e) => !seen.has(e.id)).length,
  };
}

/**
 * The tab the bar entry opens: the first tab, Asks, unless only Pages has
 * open items.
 */
export function inboxTabFor(
  counts: Pick<InboxCounts, "pages" | "asks">,
): InboxTab {
  return counts.asks === 0 && counts.pages > 0 ? "pager" : "asks";
}

// A server render has seen no ask.
const NONE_SEEN: ReadonlySet<string> = new Set();
const serverSeen = () => NONE_SEEN;

export function useInboxCounts(exceptAgentId?: string): InboxCounts {
  const { pager, asks, agents, sessionContext, answeredAsks } = useAppState();
  const userId = sessionContext?.userId ?? null;
  const seen = useSyncExternalStore(subscribeAsksSeen, getAsksSeen, serverSeen);
  return useMemo(
    () =>
      inboxCounts(
        pager,
        asks,
        agents,
        userId,
        answeredAsks,
        seen,
        exceptAgentId,
      ),
    [pager, asks, agents, userId, answeredAsks, seen, exceptAgentId],
  );
}

/**
 * The Inbox entry of the office bar and the chat bar, one source so the two
 * cannot drift. The chat bar passes its agent as `exceptAgentId`, so the
 * badge and the tab it opens count only what is elsewhere. The badge counts
 * the open pages and the new asks; the title, every open item. Null without
 * `onOpen`, for fixtures without the Inbox.
 */
export function useInboxNavAction(
  onOpen: ((tab: InboxTab) => void) | undefined,
  exceptAgentId?: string,
): NavAction | null {
  const counts = useInboxCounts(exceptAgentId);
  const i18n = useI18n();
  if (!onOpen) return null;
  const open = counts.pages + counts.asks;
  return {
    id: "inbox",
    icon: InboxIcon,
    label: i18n.t("nav.inbox"),
    title: open ? i18n.tn("nav.inboxOpenCount", open) : i18n.t("nav.inbox"),
    onClick: () => onOpen(inboxTabFor(counts)),
    badge: counts.pages + counts.newAsks,
  };
}

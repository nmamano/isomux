// The Inbox (task c952e551): the asks, behind one top-bar entry. A page is a
// paged ask (task 74e8fc07), so it counts and shows as an ask, and so do the
// agent items (task ddf02829). This module holds what the bar and the Inbox
// share.

import { useMemo, useSyncExternalStore } from "react";
import { useAppState } from "./store.tsx";
import { useI18n } from "./i18n.tsx";
import { InboxIcon } from "./components/NavIcons.tsx";
import type { NavAction } from "./components/NavActions.tsx";
import { openAsks, visibleAsks } from "./asks-sync.ts";
import { getAsksSeen, subscribeAsksSeen } from "./device-settings.ts";
import { apiFetch } from "./api.ts";
import type { AskMemberWire, PagerEntry } from "../shared/types.ts";
import { agentInboxItems, type AgentInboxItem } from "./inbox-agent-items.ts";

export interface InboxCounts {
  asks: number;
  // The open asks not yet shown on the Asks tab (getAsksSeen).
  newAsks: number;
}

/**
 * The open asks, and of them those not in `seen`, which this browser has not
 * shown on the Asks tab. The bar's badge is the new asks (task a930c9d6).
 * An ask answered on the Inbox (`answered`) no longer counts, nor do the
 * asks of `exceptAgentId`: the chat bar leaves out the asks its chat
 * already shows. The agent items (`items`, task ddf02829) count as asks,
 * seen by their key.
 */
export function inboxCounts(
  asks: readonly AskMemberWire[],
  agents: readonly { id: string }[],
  answered: ReadonlyMap<string, unknown>,
  seen: ReadonlySet<string>,
  exceptAgentId?: string,
  items: readonly AgentInboxItem[] = [],
): InboxCounts {
  const open = openAsks(visibleAsks(asks, agents), answered).filter(
    (e) => e.agentId !== exceptAgentId,
  );
  const shown = items.filter((i) => i.agentId !== exceptAgentId);
  return {
    asks: open.length + shown.length,
    newAsks:
      open.filter((e) => !seen.has(e.id)).length +
      shown.filter((i) => !seen.has(i.key)).length,
  };
}

/**
 * The ask a page id names (a Discord or push link from before pages were
 * asks, `/?pager=<pageId>`): GET /api/pager/<pageId> and its askId. Null on a
 * 404 or any failure.
 */
export async function askIdForPage(pageId: string): Promise<string | null> {
  try {
    const page = await apiFetch<Partial<PagerEntry> | null>(
      "GET",
      `/api/pager/${encodeURIComponent(pageId)}`,
    );
    return typeof page?.askId === "string" && page.askId !== ""
      ? page.askId
      : null;
  } catch {
    return null;
  }
}

const NO_KEYS: readonly string[] = [];

/** The failures the session's member dismissed (UserRecord.inboxDismissed). */
export function useInboxDismissed(): readonly string[] {
  const { sessionContext, users } = useAppState();
  const me = sessionContext?.userId ?? null;
  return useMemo(() => {
    if (me === null) return NO_KEYS;
    for (const user of users.values())
      if (user.id === me) return user.inboxDismissed ?? NO_KEYS;
    return NO_KEYS;
  }, [users, me]);
}

/**
 * The member's agent items (ui/inbox-agent-items.ts): the session's member,
 * and the failures they dismissed from their own user record, which
 * user_self_updated keeps current on every device.
 */
export function useAgentInboxItems(): AgentInboxItem[] {
  const { agents, interactions, sessionContext } = useAppState();
  const me = sessionContext?.userId ?? null;
  const dismissed = useInboxDismissed();
  return useMemo(
    () => agentInboxItems(agents, interactions, me, dismissed),
    [agents, interactions, me, dismissed],
  );
}

// A server render has seen no ask.
const NONE_SEEN: ReadonlySet<string> = new Set();
const serverSeen = () => NONE_SEEN;

export function useInboxCounts(exceptAgentId?: string): InboxCounts {
  const { asks, agents, answeredAsks } = useAppState();
  const seen = useSyncExternalStore(subscribeAsksSeen, getAsksSeen, serverSeen);
  const items = useAgentInboxItems();
  return useMemo(
    () => inboxCounts(asks, agents, answeredAsks, seen, exceptAgentId, items),
    [asks, agents, answeredAsks, seen, exceptAgentId, items],
  );
}

/**
 * The Inbox entry of the office bar and the chat bar, one source so the two
 * cannot drift. The chat bar passes its agent as `exceptAgentId`, so the
 * badge counts only what is elsewhere. The badge counts the new asks; the
 * title and the count (the phone menu's neutral pill, task 760818d5), every
 * open ask. Null without `onOpen`, for fixtures without the Inbox.
 */
export function useInboxNavAction(
  onOpen: (() => void) | undefined,
  exceptAgentId?: string,
): NavAction | null {
  const counts = useInboxCounts(exceptAgentId);
  const i18n = useI18n();
  if (!onOpen) return null;
  const open = counts.asks;
  return {
    id: "inbox",
    icon: InboxIcon,
    label: i18n.t("nav.inbox"),
    title: open
      ? i18n.tn("nav.inboxOpenCount", open)
      : i18n.t("nav.inboxShortcut"),
    onClick: () => onOpen(),
    badge: counts.newAsks,
    count: open,
  };
}

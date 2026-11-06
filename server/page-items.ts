// The pages the pager delivery engines send (server/pager-delivery.ts,
// server/web-push-delivery.ts): every paged ask once per recipient (task
// 74e8fc07). A page is a paged ask; pagerPageItem builds the item of an old
// pager entry, for the delivery engines' own tests.
//
// A paged ask's item exists while the recipient may still see the ask
// (askVisibleTo, read at each list and get), so a recipient who loses the
// room gets no further send. At the close, the source keeps one "resolved"
// item per recipient in memory until Discord records its notice done: a
// restart before that loses the paged ask's "resolved" message. The close
// snapshot takes the agent's name and room from the last item built for the
// ask, because an agent's removal closes its asks after the agent is gone.

import type { AskEntry, PagerDelivery, PagerEntry } from "../shared/types.ts";
import { stripColorMarkup } from "../shared/color-markup.ts";
import { askVisibleTo, type AskAudienceDeps, type AskStore } from "./asks.ts";
import { PAGER_BODY_MAX, PAGER_TITLE_MAX } from "./pager-compat.ts";
import { pagerLink } from "./pager-delivery.ts";

// One page as the delivery engines see it.
export interface PageItem {
  // "ask:<askId>:<userId>": one recipient of a paged ask. A pager entry's
  // item (pagerPageItem) has the page id.
  id: string;
  targetUserId: string;
  title: string;
  body?: string;
  state: "open" | "acked" | "resolved";
  delivery: PagerDelivery;
  // The agent's or app's name, for the message footer.
  sourceName: string;
  roomId: string | null;
  // The office path the message links to: "/?pager=<id>" for a page,
  // "/inbox/asks/<askId>" for a paged ask.
  path: string;
}

export interface PageItemSourceDeps {
  asks: Pick<AskStore, "listAll" | "get" | "recordPageDelivery">;
  audience: AskAudienceDeps;
  // The agent's name now, or null when it is gone.
  agentName: (agentId: string) => string | null;
}

export interface PageItemSource {
  list(): PageItem[];
  get(id: string): PageItem | null;
  // Null when the item is gone.
  recordDelivery(id: string, delivery: PagerDelivery): PageItem | null;
  // The items of one paged ask for a store event (AskStoreDeps.onPage). On
  // "closed" the source keeps a resolved snapshot per recipient until its
  // "resolved" notice is recorded done.
  askItems(entry: AskEntry, event: "created" | "acked" | "closed"): PageItem[];
}

// One pager entry as an item.
export function pagerPageItem(entry: PagerEntry): PageItem {
  return {
    id: entry.id,
    targetUserId: entry.targetUserId,
    title: entry.title,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    state: entry.state,
    delivery: entry.delivery,
    sourceName: entry.source.name,
    roomId: entry.source.roomId,
    path: pagerLink("", entry.id),
  };
}

const ASK_ITEM_PREFIX = "ask:";

const askItemId = (askId: string, userId: string) =>
  `${ASK_ITEM_PREFIX}${askId}:${userId}`;

// The ask and the recipient an item id names, or null for a page id.
function parseAskItemId(id: string): { askId: string; userId: string } | null {
  if (!id.startsWith(ASK_ITEM_PREFIX)) return null;
  const rest = id.slice(ASK_ITEM_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0) return null;
  return { askId: rest.slice(0, cut), userId: rest.slice(cut + 1) };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// A page's title and body from an ask's prompt, in plain text: the first line
// with text is the title, the rest is the body.
function pageText(prompt: string): { title: string; body?: string } {
  const lines = stripColorMarkup(prompt).split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return { title: "" };
  const title = clip(lines[first].trim(), PAGER_TITLE_MAX);
  const body = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  return body === "" ? { title } : { title, body: clip(body, PAGER_BODY_MAX) };
}

interface SourceLabel {
  sourceName: string;
  roomId: string | null;
}

export function createPageItemSource(deps: PageItemSourceDeps): PageItemSource {
  // The name and room last built for each open paged ask.
  const labels = new Map<string, SourceLabel>();
  // Closed paged asks' "resolved" items, by item id, until Discord records
  // the notice done.
  const closed = new Map<string, PageItem>();

  const labelOf = (entry: AskEntry): SourceLabel => {
    const last = labels.get(entry.id);
    const label = {
      sourceName:
        entry.app?.name ??
        entry.office?.name ??
        deps.agentName(entry.agentId) ??
        last?.sourceName ??
        entry.agentId,
      roomId: deps.audience.agentRoomId(entry.agentId) ?? last?.roomId ?? null,
    };
    labels.set(entry.id, label);
    return label;
  };

  const itemOf = (
    entry: AskEntry,
    userId: string,
    delivery: PagerDelivery,
    state: PageItem["state"],
    label: SourceLabel,
  ): PageItem => ({
    id: askItemId(entry.id, userId),
    targetUserId: userId,
    ...pageText(entry.prompt),
    state,
    delivery,
    ...label,
    path: `/inbox/asks/${encodeURIComponent(entry.id)}`,
  });

  // The items of an open paged ask: one per recipient who still sees it.
  const openItems = (entry: AskEntry): PageItem[] => {
    const page = entry.page;
    if (!page) return [];
    const label = labelOf(entry);
    const state = page.state === "ringing" ? "open" : "acked";
    return Object.entries(page.delivery)
      .filter(([userId]) => askVisibleTo(entry, userId, deps.audience))
      .map(([userId, delivery]) =>
        itemOf(entry, userId, delivery, state, label),
      );
  };

  const openItem = (askId: string, userId: string): PageItem | null => {
    const entry = deps.asks.get(askId);
    if (!entry) return null;
    return (
      openItems(entry).find((item) => item.targetUserId === userId) ?? null
    );
  };

  return {
    list() {
      return [
        ...deps.asks.listAll().flatMap(openItems),
        ...[...closed.values()].map((item) => ({ ...item })),
      ];
    },

    get(id) {
      const ref = parseAskItemId(id);
      if (!ref) return null;
      const done = closed.get(id);
      return done ? { ...done } : openItem(ref.askId, ref.userId);
    },

    // A closed ask's item takes the record in memory: its "resolved" notice,
    // or a first send that ended after the close.
    recordDelivery(id, delivery) {
      const ref = parseAskItemId(id);
      if (!ref) return null;
      const done = closed.get(id);
      if (done) {
        const next = { ...done, delivery };
        if (delivery.resolvedNotice === "done") closed.delete(id);
        else closed.set(id, next);
        return { ...next };
      }
      if (!deps.asks.recordPageDelivery(ref.askId, ref.userId, delivery))
        return null;
      return openItem(ref.askId, ref.userId);
    },

    askItems(entry, event) {
      if (event !== "closed") return openItems(entry);
      const page = entry.page;
      if (!page) return [];
      const label = labelOf(entry);
      labels.delete(entry.id);
      // While the agent is here, a recipient who no longer sees the ask
      // hears nothing more of it. After the agent's removal nobody sees it,
      // and every recipient gets the "resolved" message. An ask with no
      // agent goes to its one member, who always sees it.
      const agentHere = deps.audience.agentRoomId(entry.agentId) !== null;
      const items = Object.entries(page.delivery)
        .filter(
          ([userId]) =>
            !agentHere || askVisibleTo(entry, userId, deps.audience),
        )
        .map(([userId, delivery]) =>
          itemOf(
            entry,
            userId,
            { ...delivery, resolvedNotice: "pending" },
            "resolved",
            label,
          ),
        );
      for (const item of items) closed.set(item.id, item);
      return items.map((item) => ({ ...item }));
    },
  };
}

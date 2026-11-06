// A page source for the delivery engines' tests (server/pager-delivery.ts,
// server/opencode gone-model page): pages raised, acked and resolved in
// memory, with the old pager store's rules (task 74e8fc07 removed that
// store; a page is a paged ask in the office). A raise with the same source,
// target and key updates the open or acked page; a resolve owes the
// "resolved" message; a resolved page whose message is done leaves `list`
// and `get` for the archive, as the old store moved it.

import { pagerPageItem, type PageItemSource } from "../page-items.ts";
import type {
  PagerDelivery,
  PagerEntry,
  PagerSource,
} from "../../shared/types.ts";

export interface PageBookDeps {
  now?: () => number;
  // The pages at the start, as a saved file held them.
  pages?: PagerEntry[];
  // After each change, as the old store pushed it.
  onChange?: (entry: PagerEntry) => void;
  onRaised?: (entry: PagerEntry, kind: "created" | "reraised") => void;
  onTransitioned?: (entry: PagerEntry, to: "acked" | "resolved") => void;
}

export type PageBookAct =
  | { outcome: "changed" | "unchanged" | "already_resolved"; entry: PagerEntry }
  | { outcome: "not_found" };

const sourceKey = (s: PagerSource, target: string) =>
  `${s.kind}:${s.kind === "agent" ? s.agentId : s.kind === "app" ? `${s.appName}:${s.registrationGen}` : s.feature}:${target}`;

export function createPageBook(deps: PageBookDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const copy = (e: PagerEntry): PagerEntry => structuredClone(e);
  let entries: PagerEntry[] = (deps.pages ?? []).map(copy);
  const archived: PagerEntry[] = [];
  let seq = 0;
  // What the last change left, as a saved file would hold it.
  let saved: PagerEntry[] | null = deps.pages ? entries.map(copy) : null;

  const commit = (changed: PagerEntry) => {
    entries = entries.map((e) => (e.id === changed.id ? changed : e));
    if (!entries.some((e) => e.id === changed.id)) entries.push(changed);
    for (const e of entries.filter(
      (x) => x.state === "resolved" && x.delivery.resolvedNotice !== "pending",
    ))
      archived.push(e);
    entries = entries.filter((e) => !archived.includes(e));
    saved = entries.map(copy);
    deps.onChange?.(copy(changed));
  };

  const transition = (
    id: string,
    by: string,
    to: "acked" | "resolved",
  ): PageBookAct => {
    const current = entries.find((e) => e.id === id);
    if (!current) return { outcome: "not_found" };
    if (current.state === to)
      return { outcome: "unchanged", entry: copy(current) };
    if (current.state === "resolved")
      return { outcome: "already_resolved", entry: copy(current) };
    const updated: PagerEntry = {
      ...copy(current),
      state: to,
      [to]: { by, at: now() },
    };
    if (to === "resolved") updated.delivery.resolvedNotice = "pending";
    commit(updated);
    deps.onTransitioned?.(copy(updated), to);
    return { outcome: "changed", entry: copy(updated) };
  };

  return {
    get saved() {
      return saved;
    },
    list: () => entries.map(copy),
    get: (id: string) => {
      const e = entries.find((x) => x.id === id);
      return e ? copy(e) : null;
    },
    // A resolved page whose message is done.
    findArchived: async (id: string) => {
      const e = archived.find((x) => x.id === id);
      return e ? copy(e) : null;
    },
    raise(input: {
      source: PagerSource;
      targetUserId: string;
      fields: { title: string; body?: string; key?: string };
    }):
      | { outcome: "created" | "updated"; entry: PagerEntry }
      | { outcome: "too_many" } {
      const { source, targetUserId, fields } = input;
      const t = now();
      const key = sourceKey(source, targetUserId);
      const existing =
        fields.key === undefined
          ? undefined
          : entries.find(
              (e) =>
                e.state !== "resolved" &&
                e.key === fields.key &&
                sourceKey(e.source, e.targetUserId) === key,
            );
      if (existing) {
        const updated: PagerEntry = {
          ...copy(existing),
          title: fields.title,
          lastRaisedAt: t,
          raiseCount: existing.raiseCount + 1,
        };
        if (fields.body === undefined) delete updated.body;
        else updated.body = fields.body;
        commit(updated);
        deps.onRaised?.(copy(updated), "reraised");
        return { outcome: "updated", entry: copy(updated) };
      }
      const entry: PagerEntry = {
        id: `${(++seq).toString(16).padStart(8, "0")}${"0".repeat(8)}`,
        createdAt: t,
        lastRaisedAt: t,
        raiseCount: 1,
        source: { ...source },
        targetUserId,
        title: fields.title,
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.key !== undefined ? { key: fields.key } : {}),
        state: "open",
        delivery: { state: "not_delivered", sends: 0 },
      };
      commit(entry);
      deps.onRaised?.(copy(entry), "created");
      return { outcome: "created", entry: copy(entry) };
    },
    ack: (id: string, by: string) => transition(id, by, "acked"),
    resolve: (id: string, by: string) => transition(id, by, "resolved"),
    recordDelivery(id: string, delivery: PagerDelivery): PagerEntry | null {
      const current = entries.find((e) => e.id === id);
      if (!current) return null;
      const updated = { ...copy(current), delivery: { ...delivery } };
      commit(updated);
      return copy(updated);
    },
  };
}

export type PageBook = ReturnType<typeof createPageBook>;

// The book as the delivery engines read it: every page as a page item.
export function pageItemsOf(
  book: Pick<PageBook, "list" | "get" | "recordDelivery">,
): Pick<PageItemSource, "list" | "get" | "recordDelivery"> {
  const item = (entry: PagerEntry | null) =>
    entry ? pagerPageItem(entry) : null;
  return {
    list: () => book.list().map(pagerPageItem),
    get: (id) => item(book.get(id)),
    recordDelivery: (id, delivery) => item(book.recordDelivery(id, delivery)),
  };
}

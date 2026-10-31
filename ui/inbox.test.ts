import { expect, it } from "bun:test";
import { inboxCounts, inboxTabFor } from "./inbox.ts";
import type { AskMemberWire } from "../shared/types.ts";

// The bar entry opens the first tab, Asks, unless only Pages has open items.
it("opens Asks unless only pages are open", () => {
  for (const [pages, asks, tab] of [
    [1, 1, "asks"],
    [0, 1, "asks"],
    [0, 0, "asks"],
    [2, 0, "pager"],
  ] as const)
    expect([pages, asks, inboxTabFor({ pages, asks })]).toEqual([
      pages,
      asks,
      tab,
    ]);
});

// The badge counts the open asks not yet shown (task a930c9d6); `asks`, the
// Asks tab's count, keeps every open ask. Both leave out the same asks: one
// whose agent the client does not have, one answered on the Inbox, and the
// chat bar's own agent's.
it("counts as new only the open asks not seen, out of the same asks the tab counts", () => {
  const ask = (id: string, agentId: string) =>
    ({ id, agentId, createdAt: 1, updatedAt: 1 }) as AskMemberWire;
  const asks = [
    ask("seen", "a1"),
    ask("fresh", "a1"),
    ask("other", "a2"),
    ask("ghost", "gone"),
    ask("answered", "a1"),
  ];
  const agents = [{ id: "a1" }, { id: "a2" }];
  const answered = new Map([["answered", "undo"]]);
  const seen = new Set(["seen", "ghost-seen-elsewhere"]);
  const counts = (except?: string) => {
    const c = inboxCounts([], asks, agents, "u1", answered, seen, except);
    return [c.asks, c.newAsks];
  };
  expect(counts()).toEqual([3, 2]);
  expect(counts("a2")).toEqual([2, 1]);
  expect(counts("a1")).toEqual([1, 1]);
  // Seen everything: nothing new, the tab still counts every open ask.
  const all = inboxCounts(
    [],
    asks,
    agents,
    "u1",
    answered,
    new Set(asks.map((a) => a.id)),
  );
  expect([all.asks, all.newAsks]).toEqual([3, 0]);
});

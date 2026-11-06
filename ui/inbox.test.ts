import { afterEach, expect, it } from "bun:test";
import { askIdForPage, inboxCounts } from "./inbox.ts";
import { ApiError, setApiShim } from "./api.ts";
import type { AskMemberWire } from "../shared/types.ts";

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
    const c = inboxCounts(asks, agents, answered, seen, except);
    return [c.asks, c.newAsks];
  };
  expect(counts()).toEqual([3, 2]);
  expect(counts("a2")).toEqual([2, 1]);
  expect(counts("a1")).toEqual([1, 1]);
  // Seen everything: nothing new, the tab still counts every open ask.
  const all = inboxCounts(
    asks,
    agents,
    answered,
    new Set(asks.map((a) => a.id)),
  );
  expect([all.asks, all.newAsks]).toEqual([3, 0]);
});

// A Discord or push link from before pages were asks names a page id
// (task 74e8fc07, slice 4): the page's askId, or null when the office does
// not answer with one.
it("finds the ask of an old page link, and null for a 404, a failure or no ask", async () => {
  const reads: string[] = [];
  let answer: () => Promise<unknown> = async () => ({ askId: "q1" });
  setApiShim(async (method, path) => {
    reads.push(`${method} ${path}`);
    return answer();
  });
  expect(await askIdForPage("abcd1234")).toBe("q1");
  expect(reads).toEqual(["GET /api/pager/abcd1234"]);
  // An id from a link is encoded into the path.
  reads.length = 0;
  await askIdForPage("a/b?c");
  expect(reads).toEqual([`GET /api/pager/${encodeURIComponent("a/b?c")}`]);
  answer = async () => {
    throw new ApiError(404, "not_found", "No such page.");
  };
  expect(await askIdForPage("ffffffffffffffff")).toBeNull();
  answer = async () => {
    throw new Error("offline");
  };
  expect(await askIdForPage("abcd1234")).toBeNull();
  answer = async () => ({ id: "abcd1234" });
  expect(await askIdForPage("abcd1234")).toBeNull();
});
afterEach(() => setApiShim(null));

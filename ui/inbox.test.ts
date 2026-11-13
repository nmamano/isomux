import { afterEach, expect, it } from "bun:test";
import {
  askIdForPage,
  documentTitle,
  inboxCounts,
  syncAppBadge,
} from "./inbox.ts";
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

// The tab title (task 91a69e4c): the unseen Inbox count in front, as messaging
// apps do, the exact number, and today's title at 0.
it("puts the exact count in front of the tab title, and no count at 0", () => {
  for (const label of ["Scout", null]) {
    const plain = documentTitle(label, 0);
    expect(plain).toContain("Isomux");
    if (label) expect(plain).toContain(label);
    expect(plain.startsWith("(")).toBe(false);
    for (const n of [1, 3, 120])
      expect(documentTitle(label, n)).toBe(`(${n}) ${plain}`);
  }
  expect(documentTitle("Scout", 0)).not.toBe(documentTitle(null, 0));
});

// The installed app's icon badge (task 91a69e4c). A fake of the Badging API:
// the count the icon shows, null for none, and the receiver of each call
// (a detached method throws Illegal invocation in a browser).
function fakeBadge(
  set: (n: number) => Promise<void> = async () => {},
  clear: () => Promise<void> = async () => {},
) {
  const state = { shown: null as number | null, detached: 0 };
  Object.defineProperty(navigator, "setAppBadge", {
    configurable: true,
    value: function (this: unknown, n: number) {
      if (this !== navigator) state.detached++;
      state.shown = n === 0 ? null : n;
      return set(n);
    },
  });
  Object.defineProperty(navigator, "clearAppBadge", {
    configurable: true,
    value: function (this: unknown) {
      if (this !== navigator) state.detached++;
      state.shown = null;
      return clear();
    },
  });
  return state;
}
const nav = navigator as unknown as Record<string, unknown>;
afterEach(() => {
  delete nav.setAppBadge;
  delete nav.clearAppBadge;
});

it("shows the count on the app icon and clears it at 0", () => {
  const badge = fakeBadge();
  syncAppBadge(3);
  expect(badge.shown).toBe(3);
  syncAppBadge(1);
  expect(badge.shown).toBe(1);
  syncAppBadge(0);
  expect(badge.shown).toBeNull();
  expect(badge.detached).toBe(0);
});

it("does nothing without the Badging API", () => {
  expect("setAppBadge" in navigator).toBe(false);
  syncAppBadge(2);
  syncAppBadge(0);
});

// Chrome rejects outside an installed app, and an embed can throw at the
// call: neither reaches the page. A throw fails the test, and so does an
// unhandled rejection (bun names the error below).
it("swallows a refusal, thrown or rejected", async () => {
  const refused = new Error("badge refused, and syncAppBadge let it through");
  fakeBadge(
    () => Promise.reject(refused),
    () => Promise.reject(refused),
  );
  syncAppBadge(2);
  syncAppBadge(0);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const badge = fakeBadge(
    () => {
      throw refused;
    },
    () => {
      throw refused;
    },
  );
  syncAppBadge(2);
  expect(badge.shown).toBe(2);
  syncAppBadge(0);
  expect(badge.shown).toBeNull();
});

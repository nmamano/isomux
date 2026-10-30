import { expect, it } from "bun:test";
import { inboxTabFor } from "./inbox.ts";

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

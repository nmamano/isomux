// The Discord link through the real App: boot at /?pager=<id>, a delayed
// snapshot, and the unavailable notice. The view itself is covered in
// ui/components/PagerView.dom.test.tsx; shared setup is in
// ui/test-support/pager-app-fixture.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { boot, page, pending, settle, setupPagerAppTests, toggleOf } =
  await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

describe("the Discord link", () => {
  it("opens the pager at /pager and expands the page once the delayed snapshot lands", async () => {
    const view = await boot("/?pager=p1");
    expect(window.location.pathname).toBe("/pager");
    expect(window.location.search).toBe("");
    expect(pending.map((p) => p.path)).toEqual(["/api/pager?state=all"]);
    // Still loading: no rows, and no verdict on the id yet.
    expect(view.container.querySelector("[data-pager-id]")).toBeNull();
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();

    await settle(0, [
      page("p2", { lastRaisedAt: 9_000 }),
      page("p1", { state: "resolved" }),
    ]);
    expect(toggleOf(view, "p1")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf(view, "p2")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("ends in the unavailable notice for a page the snapshot does not hold", async () => {
    const view = await boot("/?pager=hidden1");
    await settle(0, [page("p2")]);
    expect(view.container.querySelector(".pager-unavailable")).not.toBeNull();
  });
});

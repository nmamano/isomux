// The Discord link through the real App: boot at /?pager=<id>, a delayed
// snapshot, and the unavailable notice. The view itself is covered in
// ui/components/PagerView.dom.test.tsx; shared setup is in
// ui/test-support/pager-app-fixture.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  boot,
  fullState,
  page,
  pending,
  rowIds,
  settle,
  setupPagerAppTests,
  toggleOf,
} = await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

describe("the Discord link", () => {
  it("opens the pager at /pager and expands the page once the delayed snapshot lands", async () => {
    const view = await boot("/?pager=p1");
    expect(window.location.pathname).toBe("/pager");
    expect(window.location.search).toBe("");
    expect(pending.map((p) => p.path)).toEqual([
      "/api/pager?state=all&limit=50",
    ]);
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

  it("ends in the unavailable notice for a page the snapshot does not hold and the server refuses", async () => {
    const view = await boot("/?pager=hidden1");
    await settle(0, [page("p2")]);
    // Outside the loaded slices, the page is read by id first.
    expect(pending.map((p) => p.path)).toEqual([
      "/api/pager?state=all&limit=50",
      "/api/pager/hidden1",
    ]);
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();
    await act(async () => pending[1].reject(new Error("not found")));
    expect(view.container.querySelector(".pager-unavailable")).not.toBeNull();
  });

  it("reads an older resolved page outside the snapshot by id and expands it", async () => {
    const view = await boot("/?pager=old1");
    await settle(0, [page("p2")]);
    expect(pending[1].path).toBe("/api/pager/old1");
    await act(async () =>
      pending[1].resolve(page("old1", { state: "resolved" }) as never),
    );
    expect(toggleOf(view, "old1")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();
  });

  it("a by-id reply from before a reconnect does not refill the new snapshot; the page is read again", async () => {
    // Reviewer 3's R4: the new snapshot may have dropped the page because
    // the member lost access to its room.
    const view = await boot("/?pager=old1");
    await settle(0, []);
    expect(pending[1].path).toBe("/api/pager/old1");
    await act(async () => fullState());
    expect(pending[2].path).toBe("/api/pager?state=all&limit=50");
    await settle(2, []);
    expect(rowIds(view)).toEqual([]);
    await act(async () =>
      pending[1].resolve(page("old1", { state: "resolved" }) as never),
    );
    expect(rowIds(view)).toEqual([]);
    // Read again on the new connection, where the server refuses it.
    expect(pending[3].path).toBe("/api/pager/old1");
    await act(async () => pending[3].reject(new Error("not found")));
    expect(rowIds(view)).toEqual([]);
    expect(view.container.querySelector(".pager-unavailable")).not.toBeNull();
  });
});

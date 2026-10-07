// The pager list's bound on resolved pages through the real App (task
// af346c0c, PM ruling 2026-10-07): live resolves drop the oldest resolved
// pages past what the view loaded, and "Load more" continues from the oldest
// page it still holds, so the dropped ones come back. Split from
// ui/App.pager-slices.dom.test.tsx for the DOM per-file cap; the reducer-only
// cases are in ui/pager-trim.test.ts.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  boot,
  page,
  pending,
  rowIds,
  settle,
  setupPagerAppTests,
  shimEmit,
} = await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

type View = Awaited<ReturnType<typeof boot>>;

// Resolved pages r<from>..r<to-1>, newest first by resolve and by raise.
const resolved = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) =>
    page(`r${from + i}`, {
      state: "resolved",
      lastRaisedAt: 100_000 - (from + i),
      resolved: { by: "Boss", at: 100_000 - (from + i) },
    }),
  );

const loadMore = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("[data-pager-load-more]");

function showAll(view: View) {
  const state = view.container.querySelector<HTMLSelectElement>("select")!;
  fireEvent.change(state, { target: { value: "all" } });
}

describe("the bound on resolved pages", () => {
  it("live resolves keep the list at its loaded size, and Load more brings the dropped pages back, none skipped or repeated", async () => {
    const view = await boot("/pager");
    await settle(0, [page("open1"), ...resolved(0, 50)]);
    showAll(view);
    // Three pages resolve while the view is open; they are the newest.
    for (const id of ["n1", "n2", "n3"]) {
      await act(async () =>
        shimEmit({
          type: "pager_upserted",
          entry: page(id, {
            state: "resolved",
            lastRaisedAt: 200_000,
            resolved: { by: "Boss", at: 200_000 },
          }),
        }),
      );
    }
    const held = rowIds(view);
    expect(held).toHaveLength(51);
    expect(held).toContain("n3");
    expect(held).toContain("open1");
    // The three oldest went, and Load more starts after the oldest still held.
    expect(held).not.toContain("r47");
    await act(async () => fireEvent.click(loadMore(view)!));
    expect(pending[1].path).toBe(
      "/api/pager?state=resolved&limit=50&before=r46",
    );
    await settle(1, resolved(47, 60));
    const after = rowIds(view);
    expect(after.filter((id) => /^r4[7-9]$/.test(id!)).sort()).toEqual([
      "r47",
      "r48",
      "r49",
    ]);
    expect(new Set(after).size).toBe(after.length);
    expect(after).toHaveLength(64);
  });

  it("a drop while Load more is out: the slice is read again from the oldest page held, none missing or twice", async () => {
    // Reviewer 3's R3a.
    const view = await boot("/pager");
    await settle(0, resolved(0, 50));
    showAll(view);
    await act(async () => fireEvent.click(loadMore(view)!));
    expect(pending[1].path).toBe(
      "/api/pager?state=resolved&limit=50&before=r49",
    );
    await act(async () =>
      shimEmit({
        type: "pager_upserted",
        entry: page("n1", {
          state: "resolved",
          resolved: { by: "Boss", at: 200_000 },
        }),
      }),
    );
    // Enabling condition: the drop took the page the read continues from.
    expect(rowIds(view)).not.toContain("r49");
    await settle(1, resolved(50, 60));
    expect(pending[2].path).toBe(
      "/api/pager?state=resolved&limit=50&before=r48",
    );
    await settle(2, resolved(49, 99));
    const held = rowIds(view);
    expect(held).toContain("r49");
    expect(held).toContain("r98");
    expect(new Set(held).size).toBe(held.length);
    expect(held).toHaveLength(100);
  });
});

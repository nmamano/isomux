// Resolved pages in slices through the real App (task af346c0c): the
// snapshot carries the newest slice, "Load more" asks for the next older one
// after the last resolved page, and a hydration starts again from the newest
// slice, so the list does not grow with every reconnect. Shared setup is in
// ui/test-support/pager-app-fixture.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  boot,
  en,
  fullState,
  page,
  pending,
  rowIds,
  settle,
  setupPagerAppTests,
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

describe("resolved pages in slices", () => {
  it("loads the next older slice after the last resolved page, and stops after a short one", async () => {
    const view = await boot("/pager");
    await settle(0, [page("open1"), ...resolved(0, 50)]);
    // The default filter shows open and acked pages only.
    expect(loadMore(view)).toBeNull();
    showAll(view);
    expect(rowIds(view)).toHaveLength(51);
    expect(loadMore(view)?.textContent).toBe(en["pager.view.loadMore"]);

    await act(async () => fireEvent.click(loadMore(view)!));
    expect(pending[1].path).toBe(
      "/api/pager?state=resolved&limit=50&before=r49",
    );
    expect(loadMore(view)?.disabled).toBe(true);
    await settle(1, resolved(50, 60));
    expect(rowIds(view)).toHaveLength(61);
    expect(rowIds(view).at(-1)).toBe("r59");
    // A short slice is the last one.
    expect(loadMore(view)).toBeNull();
  });

  it("a hydration starts again from the newest slice", async () => {
    const view = await boot("/pager");
    await settle(0, resolved(0, 50));
    showAll(view);
    await act(async () => fireEvent.click(loadMore(view)!));
    await settle(1, resolved(50, 100));
    expect(rowIds(view)).toHaveLength(100);

    // A reconnect: the older slice is dropped with the rest of the snapshot.
    await act(async () => fullState());
    expect(pending[2].path).toBe("/api/pager?state=all&limit=50");
    await settle(2, resolved(0, 50));
    expect(rowIds(view)).toHaveLength(50);
    expect(rowIds(view).at(-1)).toBe("r49");
  });

  it("drops a slice read before a reconnect", async () => {
    const view = await boot("/pager");
    await settle(0, resolved(0, 50));
    showAll(view);
    await act(async () => fireEvent.click(loadMore(view)!));
    await act(async () => fullState());
    await settle(2, resolved(0, 50));
    // The slice asked for on the old connection lands late.
    await settle(1, resolved(50, 60));
    expect(rowIds(view)).toHaveLength(50);
  });
});

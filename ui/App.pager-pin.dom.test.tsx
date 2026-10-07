// A page opened from a Discord link is kept while the view shows it (PM
// ruling, 2026-10-07): a live resolve never drops it, and "Load more" does not
// continue from it. Split from ui/App.pager-trim.dom.test.tsx for the DOM
// per-file cap.

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
  toggleOf,
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

describe("the Discord-linked page", () => {
  it("a page opened from a Discord link stays, and is not where Load more continues", async () => {
    const view = await boot("/?pager=ancient");
    await settle(0, resolved(0, 50));
    expect(pending[1].path).toBe("/api/pager/ancient");
    await act(async () =>
      pending[1].resolve(
        page("ancient", {
          state: "resolved",
          resolved: { by: "Boss", at: 5 },
        }) as never,
      ),
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
    expect(rowIds(view)).toContain("ancient");
    await act(async () => fireEvent.click(loadMore(view)!));
    expect(pending[2].path).toBe(
      "/api/pager?state=resolved&limit=50&before=r48",
    );
  });

  it("a Discord-linked page already in the snapshot stays while a live resolve trims", async () => {
    // Reviewer 3's R3b.
    const view = await boot("/?pager=r49");
    await settle(0, resolved(0, 50));
    // Enabling condition: found in the snapshot, no read by id, expanded.
    expect(pending).toHaveLength(1);
    expect(toggleOf(view, "r49")?.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["n1", "n2"]) {
      await act(async () =>
        shimEmit({
          type: "pager_upserted",
          entry: page(id, {
            state: "resolved",
            resolved: { by: "Boss", at: 200_000 },
          }),
        }),
      );
    }
    // The trim passed over the linked page and took the next oldest.
    expect(rowIds(view)).toContain("r49");
    expect(rowIds(view)).not.toContain("r48");
  });
});

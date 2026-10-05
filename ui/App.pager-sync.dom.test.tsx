// The App-level pager snapshot: a response from an earlier connection, and a
// delta that overtakes the snapshot. The view itself is covered in
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
  shimEmit,
} = await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

describe("the snapshot sync", () => {
  // Booted on the pager view, which lists only a landed snapshot.
  it("drops a response from an earlier connection", async () => {
    const view = await boot("/pager");
    // A reconnect re-hydrates while the first read is still out.
    await act(async () => fullState());
    expect(pending.length).toBe(2);
    await settle(1, [page("a"), page("b", { lastRaisedAt: 2_000 })]);
    expect(rowIds(view)).toEqual(["b", "a"]);
    // The first connection's answer lands late and is ignored.
    await settle(0, [page("stale")]);
    expect(rowIds(view)).toEqual(["b", "a"]);
  });

  it("refetches when a delta overtakes the snapshot", async () => {
    const view = await boot("/pager");
    expect(pending.length).toBe(1);
    await act(async () =>
      shimEmit({ type: "pager_upserted", entry: page("q") }),
    );
    // The snapshot was issued before q existed, so it is refused and read
    // again; the view does not show it as loaded.
    await settle(0, []);
    expect(pending.length).toBe(2);
    expect(rowIds(view)).toEqual([]);
    await settle(1, [page("q"), page("r", { lastRaisedAt: 2_000 })]);
    expect(rowIds(view)).toEqual(["r", "q"]);
  });
});

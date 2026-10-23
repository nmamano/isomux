// The office bar badge and a failed pager load, through the real App. Which
// Inbox tab the bar entry opens is in ui/App.inbox.dom.test.tsx; the view is in
// ui/components/PagerView.dom.test.tsx; shared setup is in
// ui/test-support/pager-app-fixture.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  badge,
  boot,
  en,
  page,
  pending,
  settle,
  setupPagerAppTests,
  shimEmit,
  toggleOf,
} = await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

describe("the badge", () => {
  it("counts the member's open pages only, and drops a page when it is acked", async () => {
    const view = await boot("/");
    await settle(0, [
      page("mine"),
      page("theirs", { targetUserId: "u2" }),
      page("seen", { state: "acked" }),
      page("done", { state: "resolved" }),
    ]);
    expect(badge(view)).toBe("1");
    await act(async () =>
      shimEmit({
        type: "pager_upserted",
        entry: page("mine", {
          state: "acked",
          acked: { by: "member", at: 2_000 },
        }),
      }),
    );
    expect(badge(view)).toBeNull();
  });
});

describe("a failed load", () => {
  it("shows a failed load with Retry in the view, and Retry reads again", async () => {
    const view = await boot("/inbox/pages");
    await act(async () => pending[0].reject(new Error("down")));
    expect(view.container.querySelector(".pager-load-failed")).not.toBeNull();
    expect(view.queryByText(en["pager.view.empty"])).toBeNull();
    await act(async () =>
      fireEvent.click(
        view.getByRole("button", { name: en["pager.view.retry"] }),
      ),
    );
    expect(pending.length).toBe(2);
    await settle(1, [page("p1")]);
    expect(view.container.querySelector(".pager-load-failed")).toBeNull();
    expect(toggleOf(view, "p1")).not.toBeNull();
  });
});

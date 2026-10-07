// The pager view over a real reducer: list order, both filters, ack and
// resolve, the deep-link selection, the unavailable notice, and a failed
// load. App sources are in PagerView.apps.dom.test.tsx; App-level wiring
// (boot, sync, badge) is in ui/App.pager-*.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../../shared/i18n/en.ts");
const {
  h,
  mount,
  page,
  row,
  rowIds,
  selects,
  setupPagerViewTests,
  shim,
  toggle,
} = await import("../test-support/pager-view-fixture.tsx");
setupPagerViewTests();

describe("the pager list", () => {
  it("puts open pages first, then the newest raise, and hides resolved by default", async () => {
    const { view } = await mount([
      page("acked-new", { state: "acked", lastRaisedAt: 9_000 }),
      page("open-old", { lastRaisedAt: 2_000 }),
      page("open-new", { lastRaisedAt: 5_000 }),
      page("resolved", { state: "resolved", lastRaisedAt: 10_000 }),
    ]);
    expect(rowIds(view)).toEqual(["open-new", "open-old", "acked-new"]);
  });

  it("filters by state and by room, with no-room app pages on their own", async () => {
    const appPage = page("app", {
      source: {
        kind: "app",
        appName: "health",
        registrationGen: 1,
        name: "health",
        roomId: null,
      },
    });
    const { view } = await mount([
      page("r1-open"),
      page("r2-acked", {
        state: "acked",
        source: { kind: "agent", agentId: "a2", name: "B", roomId: "r2" },
      }),
      page("r1-resolved", { state: "resolved" }),
      appPage,
    ]);
    const [state, room] = selects(view);
    fireEvent.change(state, { target: { value: "resolved" } });
    expect(rowIds(view)).toEqual(["r1-resolved"]);
    fireEvent.change(state, { target: { value: "acked" } });
    expect(rowIds(view)).toEqual(["r2-acked"]);
    fireEvent.change(state, { target: { value: "all" } });
    expect(rowIds(view).sort()).toEqual(
      ["app", "r1-open", "r1-resolved", "r2-acked"].sort(),
    );
    fireEvent.change(room, { target: { value: "r1" } });
    expect(rowIds(view).sort()).toEqual(["r1-open", "r1-resolved"]);
    fireEvent.change(room, { target: { value: "none" } });
    expect(rowIds(view)).toEqual(["app"]);
  });

  it("gives every row a state label, the raise count and the delivery status", async () => {
    const { view } = await mount([
      page("p1", {
        raiseCount: 1,
        delivery: {
          state: "not_delivered",
          sends: 0,
          lastFailure: "no_webhook",
        },
      }),
      page("p2", { state: "acked", raiseCount: 4 }),
    ]);
    expect(row(view, "p1").querySelector(".pager-state")?.textContent).toBe(
      en["pager.state.open"],
    );
    expect(row(view, "p2").querySelector(".pager-state")?.textContent).toBe(
      en["pager.state.acked"],
    );
    // The count is shown for a single raise too.
    expect(row(view, "p1").querySelector(".pager-raised")?.textContent).toBe(
      en["pager.view.raised.one"].replace("{count}", "1"),
    );
    expect(row(view, "p2").querySelector(".pager-raised")?.textContent).toBe(
      en["pager.view.raised.other"].replace("{count}", "4"),
    );
    expect(
      row(view, "p1").querySelector(".pager-delivery")?.textContent,
    ).toContain(en["pager.failure.noWebhook"]);
  });
});

describe("acting on a page", () => {
  it("acks an open page and then resolves it, through the row's own buttons", async () => {
    const { view } = await mount([page("p1")]);
    // Actions live in the expanded row; the toggle is a real button.
    expect(toggle(view, "p1").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle(view, "p1"));
    expect(toggle(view, "p1").getAttribute("aria-expanded")).toBe("true");
    const ack = view.getByRole("button", { name: en["pager.action.ack"] });
    await act(async () => fireEvent.click(ack));
    expect(shim.calls).toContain("POST /api/pager/p1/ack");
    expect(h.latest.pager[0].state).toBe("acked");
    expect(
      view.queryByRole("button", { name: en["pager.action.ack"] }),
    ).toBeNull();

    shim.current = h.latest.pager;
    const resolve = view.getByRole("button", {
      name: en["pager.action.resolve"],
    });
    await act(async () => fireEvent.click(resolve));
    expect(shim.calls).toContain("POST /api/pager/p1/resolve");
    expect(h.latest.pager[0].state).toBe("resolved");
  });

  it("shows a refused action on the row and keeps the page", async () => {
    shim.failActions = true;
    const { view } = await mount([page("p1")]);
    fireEvent.click(toggle(view, "p1"));
    await act(async () =>
      fireEvent.click(
        view.getByRole("button", { name: en["pager.action.ack"] }),
      ),
    );
    expect(row(view, "p1").querySelector('[role="alert"]')).not.toBeNull();
    expect(h.latest.pager[0].state).toBe("open");
  });

  it("links an agent source to its chat, outside the expand button", async () => {
    const { view, focused } = await mount([page("p1")]);
    const link = row(view, "p1").querySelector<HTMLElement>(
      ".pager-source-link",
    )!;
    expect(toggle(view, "p1").contains(link)).toBe(false);
    fireEvent.click(link);
    expect(focused).toEqual(["a1"]);
    // Following the link does not toggle the row.
    expect(toggle(view, "p1").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the deep link", () => {
  it("expands the named page, even a resolved one, and resets the filters", async () => {
    const { view } = await mount([
      page("p1"),
      page("gone", { state: "resolved", lastRaisedAt: 500 }),
    ]);
    const [state] = selects(view);
    fireEvent.change(state, { target: { value: "open" } });
    await act(async () => h.requestSelect({ id: "gone" }));
    expect(state.value).toBe("all");
    expect(toggle(view, "gone").getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();
  });

  it("waits for the first snapshot, then says an unknown page is unavailable", async () => {
    const { view } = await mount([], { pagerLoaded: false });
    await act(async () => h.requestSelect({ id: "nope" }));
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();
    // The snapshot lands through the reducer, as usePagerSync lands it.
    await act(async () =>
      h.dispatch({
        type: "pager_loaded",
        entries: [page("p1")],
        revision: h.latest.pagerRevision,
        more: false,
      }),
    );
    expect(view.container.querySelector(".pager-unavailable")).not.toBeNull();
    expect(toggle(view, "p1").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("loading", () => {
  it("shows a failed first load as an error with Retry, never as an empty list", async () => {
    const { view } = await mount([], {
      pagerLoaded: false,
      pagerLoadFailed: true,
    });
    expect(view.container.querySelector(".pager-load-failed")).not.toBeNull();
    expect(view.queryByText(en["pager.view.empty"])).toBeNull();
    const seq = h.latest.pagerFetchSeq;
    fireEvent.click(view.getByRole("button", { name: en["pager.view.retry"] }));
    expect(h.latest.pagerFetchSeq).toBe(seq + 1);
    expect(h.latest.pagerLoadFailed).toBe(false);
  });
});

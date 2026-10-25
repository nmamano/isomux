// The pager view over a real reducer: list order, both filters, ack and
// resolve, and the deep-link selection. App sources are in
// PagerView.apps.dom.test.tsx; App-level wiring (boot, sync, badge, the
// unavailable notice, a failed load) is in ui/App.pager-*.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../../shared/i18n/en.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const EN = translatorFor("en");
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

  it("opens on the room the office shows, and on all rooms from the lobby", async () => {
    const entries = () => [
      page("r1-open"),
      page("r2-open", {
        source: { kind: "agent", agentId: "a2", name: "B", roomId: "r2" },
      }),
    ];
    const fromR2 = await mount(entries(), { currentRoomId: "r2" });
    expect(selects(fromR2.view)[1].value).toBe("r2");
    expect(rowIds(fromR2.view)).toEqual(["r2-open"]);
    fromR2.view.unmount();
    const fromLobby = await mount(entries(), {
      currentRoomId: "r2",
      lobbyOpen: true,
    });
    expect(selects(fromLobby.view)[1].value).toBe("all");
    expect(rowIds(fromLobby.view).sort()).toEqual(["r1-open", "r2-open"]);
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
      EN.tn("pager.view.raised", 1),
    );
    expect(row(view, "p2").querySelector(".pager-raised")?.textContent).toBe(
      EN.tn("pager.view.raised", 4),
    );
    expect(row(view, "p1").querySelector(".pager-delivery")?.textContent).toBe(
      EN.t("pager.delivery.notSent", {
        reason: EN.t("pager.failure.noWebhook"),
      }),
    );
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
    const { view } = await mount(
      [page("p1"), page("gone", { state: "resolved", lastRaisedAt: 500 })],
      { currentRoomId: "r2" },
    );
    const [state, room] = selects(view);
    fireEvent.change(state, { target: { value: "open" } });
    await act(async () => h.requestSelect({ id: "gone" }));
    expect(state.value).toBe("all");
    expect(room.value).toBe("all");
    expect(toggle(view, "gone").getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".pager-unavailable")).toBeNull();
  });
});

// The badge counts the member's open pages in every room, so the list must
// not open on a room that holds none of them, and an empty list says what the
// room filter hides.
describe("the opening room filter and the hidden pages", () => {
  const me = { sessionContext: { userId: "u1" } } as Parameters<
    typeof mount
  >[1];
  const inR2 = {
    source: { kind: "agent", agentId: "a2", name: "B", roomId: "r2" },
  } as const;
  // The hint line's text, or null when there is no hint.
  const hint = (view: Awaited<ReturnType<typeof mount>>["view"]) =>
    view.container.querySelector<HTMLElement>("[data-pager-hidden-elsewhere]")
      ?.textContent ?? null;
  const showAll = (view: Awaited<ReturnType<typeof mount>>["view"]) =>
    view.container.querySelector<HTMLButtonElement>(
      "[data-pager-show-all-rooms]",
    );

  it("opens on all rooms when the room the office shows has none of the member's open pages", async () => {
    // r1 holds an acked page of the member and an open page of another
    // member: neither is in the badge, so neither keeps the list on r1.
    const { view } = await mount(
      [
        page("mine-r2", inR2),
        page("mine-acked-r1", { state: "acked" }),
        page("theirs-r1", { targetUserId: "u2" }),
      ],
      { ...me, currentRoomId: "r1" },
    );
    expect(selects(view)[1].value).toBe("all");
    expect(rowIds(view)).toContain("mine-r2");
  });

  it("stays on the room the office shows when it has one of them, or when the member has none open", async () => {
    const withMine = await mount([page("mine-r1"), page("mine-r2", inR2)], {
      ...me,
      currentRoomId: "r1",
    });
    expect(selects(withMine.view)[1].value).toBe("r1");
    expect(rowIds(withMine.view)).toEqual(["mine-r1"]);
    withMine.view.unmount();

    // The badge is 0: the list keeps today's room. The open page of another
    // member counts in the hint; the acked page does not.
    const noneMine = await mount(
      [
        page("theirs-r2", { ...inR2, targetUserId: "u2" }),
        page("mine-acked-r2", { ...inR2, state: "acked" }),
      ],
      { ...me, currentRoomId: "r1" },
    );
    expect(selects(noneMine.view)[1].value).toBe("r1");
    expect(rowIds(noneMine.view)).toEqual([]);
    expect(hint(noneMine.view)).toBe(EN.tn("pager.view.hiddenElsewhere", 1));
  });

  it("settles once the pages and the member are both known, and then stays", async () => {
    // A cold load: the pages arrive after the view mounts.
    const cold = await mount([], {
      ...me,
      currentRoomId: "r1",
      pagerLoaded: false,
    });
    expect(selects(cold.view)[1].value).toBe("r1");
    await act(async () =>
      h.dispatch({
        type: "pager_loaded",
        entries: [page("mine-r2", inR2)],
        revision: h.latest.pagerRevision,
        more: false,
      }),
    );
    expect(selects(cold.view)[1].value).toBe("all");
    // A page that arrives later does not move the filter.
    await act(async () =>
      h.dispatch({ type: "pager_upserted", entry: page("mine-r1") }),
    );
    expect(selects(cold.view)[1].value).toBe("all");
    cold.view.unmount();

    // The member arrives after the pages.
    const noMember = await mount([page("mine-r2", inR2)], {
      currentRoomId: "r1",
      sessionContext: null,
    });
    expect(selects(noMember.view)[1].value).toBe("r1");
    await act(async () =>
      h.dispatch({
        type: "session_context",
        context: { userId: "u1" } as NonNullable<
          NonNullable<Parameters<typeof mount>[1]>["sessionContext"]
        >,
      }),
    );
    expect(selects(noMember.view)[1].value).toBe("all");
  });

  it("says how many open pages other rooms hold and shows them on a click, unless the state filter hides them", async () => {
    const { view } = await mount(
      [
        page("mine-r2", inR2),
        page("theirs-r2", { ...inR2, targetUserId: "u2" }),
        page("acked-r2", { ...inR2, state: "acked" }),
      ],
      { ...me, currentRoomId: "r1" },
    );
    const [state, room] = selects(view);
    fireEvent.change(room, { target: { value: "r1" } });
    expect(rowIds(view)).toEqual([]);
    expect(hint(view)).toBe(EN.tn("pager.view.hiddenElsewhere", 2));
    // The hint takes the place of the plain empty line and the settings link.
    expect(view.container.textContent).not.toContain(en["pager.view.empty"]);
    expect(
      view.container.querySelector("[data-pager-settings-link]"),
    ).toBeNull();

    fireEvent.click(showAll(view)!);
    expect(room.value).toBe("all");
    expect(rowIds(view).sort()).toEqual(["acked-r2", "mine-r2", "theirs-r2"]);

    // Acked hides the open pages: the button would not show them.
    fireEvent.change(room, { target: { value: "r1" } });
    fireEvent.change(state, { target: { value: "acked" } });
    expect(rowIds(view)).toEqual([]);
    expect(hint(view)).toBeNull();
    expect(showAll(view)).toBeNull();
    expect(view.container.textContent).toContain(en["pager.view.empty"]);
    expect(
      view.container.querySelector("[data-pager-settings-link]"),
    ).not.toBeNull();
  });
});

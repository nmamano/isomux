// The Asks page's filter row (ui/components/AsksView.tsx): what the room and
// priority filters do to the page - the counts, the groups and runs they
// leave, and the empty state with Show all.
// This file is separate from the other AsksView.filter*.dom.test.tsx files
// and from AsksView.dom.test.tsx only because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { checkedFilterValues, filterCounts } =
  await import("../test-support/checkbox-filters.ts");
const {
  ranked,
  mount,
  mountSorted,
  pageOrder,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  BY_AGENT,
  ALL_PRIORITIES,
  setRooms,
  setPriorities,
} = await import("../test-support/asks-view.ts");

describe("the filter row", () => {
  beforeEach(() => localStorage.clear());

  it("counts each room's asks under the priority filter, and each level's under the room filter", async () => {
    const { view, latest } = mount(
      [
        ...SORT_ASKS,
        // An agent the client does not have: no group, so no count.
        ranked("ghostAsk", "ghost", 50, "P0"),
        // Being sent: gone from the page, so gone from the counts.
        ranked("leaving", "a3", 40, "P0"),
      ],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    act(() =>
      latest.dispatch({
        type: "ask_answered",
        id: "leaving",
        phase: "sending",
      }),
    );
    // Both are in the slice, so only the page's own rule leaves them out.
    expect(latest.state.asks.map((e) => e.id)).toContain("ghostAsk");
    expect(latest.state.answeredAsks.get("leaving")).toBe("sending");
    const c = view.container;
    expect(await filterCounts(c, "room")).toEqual({ r2: 3, r1: 3 });
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 1,
      P1: 2,
      P2: 1,
      P3: 0,
      P4: 0,
      none: 2,
    });
    // A level's count follows the room filter, and not its own.
    await setRooms(view, ["r2"]);
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 0,
      P1: 1,
      P2: 0,
      P3: 0,
      P4: 0,
      none: 2,
    });
    expect(await filterCounts(c, "room")).toEqual({ r2: 3, r1: 3 });
    // A room's count follows the priority filter, and not its own.
    await setPriorities(view, ["P0", "P1"]);
    expect(await filterCounts(c, "room")).toEqual({ r2: 1, r1: 2 });
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 0,
      P1: 1,
      P2: 0,
      P3: 0,
      P4: 0,
      none: 2,
    });
  });

  it("filters by the checked rooms and levels, several at once, and groups by the cards it shows", async () => {
    const { view } = mountSorted();
    await setRooms(view, ["r1"]);
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top", "a3:a3p1"]);
    await setRooms(view, ["r2", "r1"]);
    await setPriorities(view, ["P1"]);
    // a4's oldest ask is hidden, so its P1 card places the group.
    expect(pageOrder(view)).toEqual(["a3:a3p1", "a4:a4p1"]);
    await setPriorities(view, ["P1", "none"]);
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1", "a2:a2only", "a3:a3p1"]);
    await setPriorities(view, ["P0", "P2"]);
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top"]);
    await setPriorities(view, ["P0", "P1"]);
    await setRooms(view, ["r2"]);
    expect(pageOrder(view)).toEqual(["a4:a4p1"]);
  });

  it("says when the filters hide every ask, and Show all clears both filters", async () => {
    const { view } = mountSorted();
    await setRooms(view, ["r1"]);
    await setPriorities(view, ["P1", "none"]);
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    await setPriorities(view, ["none"]);
    expect(pageOrder(view)).toEqual([]);
    const filtered = view.container.querySelector("[data-asks-filtered-empty]");
    expect(filtered).not.toBeNull();
    // Not the "no open asks" state: asks are open, only hidden.
    expect(view.container.querySelector("[data-asks-empty]")).toBeNull();
    await act(async () =>
      fireEvent.click(
        view.container.querySelector<HTMLButtonElement>(
          "[data-asks-show-all]",
        )!,
      ),
    );
    expect(await checkedFilterValues(view.container, "room")).toEqual([
      "r2",
      "r1",
    ]);
    expect(await checkedFilterValues(view.container, "priority")).toEqual(
      ALL_PRIORITIES,
    );
    expect(pageOrder(view)).toEqual(BY_AGENT);
    expect(
      view.container.querySelector("[data-asks-filtered-empty]"),
    ).toBeNull();
  });
});

// The Asks page's filter row (ui/components/AsksView.tsx): the sort, the
// filters and the room's Only button, remembered on this device. The stored
// sort is in ui/device-settings.test.ts.
// This file is separate from the other AsksView.filter*.dom.test.tsx files
// and from AsksView.dom.test.tsx only because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { checkedFilterValues, onlyFilterButton } =
  await import("../test-support/checkbox-filters.ts");
const {
  mount,
  mountSorted,
  runsOf,
  pageOrder,
  control,
  choose,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  ALL_PRIORITIES,
  setRooms,
  setPriorities,
  isOpen,
} = await import("../test-support/asks-view.ts");

describe("the filter row", () => {
  beforeEach(() => localStorage.clear());

  // Task a930c9d6: the filters are remembered per browser like the sort, so
  // an Inbox opened again shows what the member left; Show all is remembered
  // too.
  it("remembers the sort and both filters on this device, and Show all", async () => {
    const first = mountSorted();
    choose(first.view, "data-asks-sort", "priority");
    await setRooms(first.view, ["r2"]);
    await setPriorities(first.view, ["P1"]);
    expect(pageOrder(first.view)).toEqual(["a4:a4p1"]);
    first.view.unmount();
    const second = mountSorted();
    expect(control(second.view, "data-asks-sort").value).toBe("priority");
    expect(await checkedFilterValues(second.view.container, "room")).toEqual([
      "r2",
    ]);
    expect(
      await checkedFilterValues(second.view.container, "priority"),
    ).toEqual(["P1"]);
    expect(pageOrder(second.view)).toEqual(["a4:a4p1"]);
    // No level checked is remembered as such, not read back as all.
    await setPriorities(second.view, []);
    second.view.unmount();
    const empty = mountSorted();
    expect(pageOrder(empty.view)).toEqual([]);
    const showAll = empty.view.container.querySelector<HTMLButtonElement>(
      "[data-asks-filtered-empty] [data-asks-show-all]",
    );
    expect(showAll).not.toBeNull();
    await act(async () => fireEvent.click(showAll!));
    empty.view.unmount();
    const third = mountSorted();
    expect(await checkedFilterValues(third.view.container, "room")).toEqual([
      "r2",
      "r1",
    ]);
    expect(await checkedFilterValues(third.view.container, "priority")).toEqual(
      ALL_PRIORITIES,
    );
    expect(pageOrder(third.view)).toEqual([
      "a1:a1top,a1old",
      "a3:a3p1",
      "a4:a4p1,a4none",
      "a2:a2only",
    ]);
  });

  // Task 286eaa5d: one room in one click, and all of them back in one.
  it("shows one room with its Only button, without toggling that room, and remembers it", async () => {
    const first = mountSorted();
    const c = first.view.container;
    // Each Only names its room for a screen reader.
    const only1 = await onlyFilterButton(c, "room", "r1");
    const only2 = await onlyFilterButton(c, "room", "r2");
    expect(only1.getAttribute("aria-label")).toContain("Room One");
    expect(only2.getAttribute("aria-label")).toContain("Room Two");
    // r1 is checked: Only leaves it checked (a toggle as well would clear it).
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    await act(async () => fireEvent.click(only1));
    expect(await checkedFilterValues(c, "room")).toEqual(["r1"]);
    expect(pageOrder(first.view)).toEqual(["a1:a1old,a1top", "a3:a3p1"]);
    expect(isOpen(first.view, "room")).toBe("true");
    // r2 is unchecked: Only checks it and unchecks the rest.
    await act(async () =>
      fireEvent.click(await onlyFilterButton(c, "room", "r2")),
    );
    expect(await checkedFilterValues(c, "room")).toEqual(["r2"]);
    expect(pageOrder(first.view)).toEqual(["a4:a4none,a4p1", "a2:a2only"]);
    expect(isOpen(first.view, "room")).toBe("true");
    first.view.unmount();
    const second = mountSorted();
    expect(await checkedFilterValues(second.view.container, "room")).toEqual([
      "r2",
    ]);
    expect(pageOrder(second.view)).toEqual(["a4:a4none,a4p1", "a2:a2only"]);
  });

  // A room the member unchecks stays unchecked while it is gone from the
  // office, so it comes back unchecked, and hides nothing meanwhile.
  it("keeps a remembered unchecked room that went away, and it hides that room again when it comes back", async () => {
    const first = mountSorted();
    await setRooms(first.view, ["r1"]);
    first.view.unmount();
    const gone = mount(SORT_ASKS, {
      rooms: SORT_ROOMS.filter((r) => r.id !== "r2"),
      agents: SORT_AGENTS.map((a) => ({ ...a, roomId: "r1" })),
    });
    // r2 is gone and its agents moved: every ask shows.
    expect(runsOf(gone.view).flatMap((r) => r.cards)).toHaveLength(
      SORT_ASKS.length,
    );
    gone.view.unmount();
    const back = mountSorted();
    expect(await checkedFilterValues(back.view.container, "room")).toEqual([
      "r1",
    ]);
    expect(pageOrder(back.view)).toEqual(["a1:a1old,a1top", "a3:a3p1"]);
  });
});

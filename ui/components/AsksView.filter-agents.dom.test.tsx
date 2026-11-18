// The Asks page's agent filter (ui/components/AsksView.tsx, task b3cb0a41):
// the agents it offers and their order (by room, task 899360d3), what it hides, its counts against the
// room and priority filters, and Show all. Its memory on this device, the
// owner's member set and the requested agent are in
// AsksView.filter-agents-memory.dom.test.tsx. The stored shape is in
// ui/device-settings.test.ts ("asks filter").
// This file is separate from the other AsksView.filter*.dom.test.tsx files
// and from AsksView.dom.test.tsx only because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  allFilterBox,
  checkedFilterValues,
  filterButton,
  filterCounts,
  filterOptions,
  onlyFilterButton,
  setCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
const {
  ranked,
  mount,
  mountSorted,
  pageOrder,
  groupIds,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  BY_AGENT,
  setRooms,
  setPriorities,
  isOpen,
} = await import("../test-support/asks-view.ts");
type AppState = import("../test-support/asks-view.ts").AppState;
type View = ReturnType<typeof mount>["view"];

const setAgents = (view: View, ids: string[]) =>
  setCheckboxFilter(view.container, "agent", ids);
const summary = (view: View) =>
  filterButton(view.container, "agent").textContent ?? "";

// SORT_AGENTS by room in SORT_ROOMS order, by desk inside one: Room Two's
// Tracker (a4) and Ranger (a2), then Room One's Pathfinder (a3) and Scout (a1).
const BY_ROOM = ["a4", "a2", "a3", "a1"];

describe("the agent filter", () => {
  beforeEach(() => localStorage.clear());

  it("offers each agent with an open ask, by room, all checked, and hides an unchecked agent's run", async () => {
    const { view } = mount([...SORT_ASKS, ranked("lowAsk", "a5", 15, "P3")], {
      rooms: SORT_ROOMS,
      agents: [
        ...SORT_AGENTS,
        // Room Two's last desk.
        { id: "a5", name: "apex", roomId: "r2", desk: 5 },
        // No open ask: not offered.
        { id: "a6", name: "Idle", roomId: "r1" },
      ] as AppState["agents"],
    });
    const c = view.container;
    const offered = ["a4", "a2", "a5", "a3", "a1"];
    expect(await checkedFilterValues(c, "agent")).toEqual(offered);
    expect(filterOptions(c, "agent")).toEqual(offered);
    // Agent names are not translated, in the list or on the button.
    const nameEl = (text: string, within: Element) =>
      [...within.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.children.length === 0 && el.textContent === text,
      );
    const list = filterButton(c, "agent").parentElement!;
    for (const name of ["apex", "Scout"])
      expect(
        nameEl(name, list)?.closest("[translate=no]") ?? null,
      ).not.toBeNull();

    const all = summary(view);
    expect(all).not.toContain("Scout");
    await setAgents(view, ["a5", "a3", "a2", "a4"]);
    expect(groupIds(view)).not.toContain("a1");
    expect(pageOrder(view)).toEqual([
      "a4:a4none,a4p1",
      "a2:a2only",
      "a3:a3p1",
      "a5:lowAsk",
    ]);
    // Only shows one agent, names it on the button, and leaves the list open.
    await act(async () =>
      fireEvent.click(await onlyFilterButton(c, "agent", "a4")),
    );
    expect(await checkedFilterValues(c, "agent")).toEqual(["a4"]);
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1"]);
    expect(isOpen(view, "agent")).toBe("true");
    expect(summary(view)).toContain("Tracker");
    expect(summary(view)).not.toContain("Scout");
    expect(
      nameEl(summary(view), filterButton(c, "agent"))?.closest(
        "[translate=no]",
      ) ?? null,
    ).not.toBeNull();
    // None checked: a word, not the names, and not the all word.
    await setAgents(view, []);
    expect(pageOrder(view)).toEqual([]);
    expect(summary(view)).not.toContain("Tracker");
    expect(summary(view)).not.toBe(all);
    // The All box brings every agent back.
    await act(async () => fireEvent.click(await allFilterBox(c, "agent")));
    expect(await checkedFilterValues(c, "agent")).toEqual(offered);
    expect(summary(view)).toBe(all);
  });

  it("counts each agent's asks under the room and priority filters, and the room and priority counts follow it", async () => {
    const { view } = mountSorted();
    const c = view.container;
    expect(await filterCounts(c, "agent")).toEqual({
      a3: 1,
      a2: 1,
      a1: 2,
      a4: 2,
    });
    // An agent in an unchecked room stays listed, with no asks to count.
    await setRooms(view, ["r2"]);
    expect(await filterCounts(c, "agent")).toEqual({
      a3: 0,
      a2: 1,
      a1: 0,
      a4: 2,
    });
    await setPriorities(view, ["P1"]);
    expect(await filterCounts(c, "agent")).toEqual({
      a3: 0,
      a2: 0,
      a1: 0,
      a4: 1,
    });
    await setRooms(view, ["r2", "r1"]);
    await setPriorities(view, ["P0", "P1", "P2", "P3", "P4", "none"]);
    // a4 unchecked: the room and priority counts leave its asks out, and its
    // own count stays.
    await setAgents(view, ["a3", "a2", "a1"]);
    expect(await filterCounts(c, "room")).toEqual({ r2: 1, r1: 3 });
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 1,
      P1: 1,
      P2: 1,
      P3: 0,
      P4: 0,
      none: 1,
    });
    expect(await filterCounts(c, "agent")).toEqual({
      a3: 1,
      a2: 1,
      a1: 2,
      a4: 2,
    });
  });

  it("is cleared by Show all, which is remembered, and closes on Escape", async () => {
    const first = mountSorted();
    const c = first.view.container;
    await setAgents(first.view, []);
    expect(pageOrder(first.view)).toEqual([]);
    await act(async () =>
      fireEvent.click(
        c.querySelector<HTMLButtonElement>(
          "[data-asks-filtered-empty] [data-asks-show-all]",
        )!,
      ),
    );
    expect(pageOrder(first.view)).toEqual(BY_AGENT);
    expect(await checkedFilterValues(c, "agent")).toEqual(BY_ROOM);
    // Escape closes the open agent list, focus back on its button.
    expect(isOpen(first.view, "agent")).toBe("true");
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(isOpen(first.view, "agent")).toBe("false");
    expect(
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        "[data-checkbox-filter]",
      )?.dataset.checkboxFilter,
    ).toBe("agent");
    first.view.unmount();
    const second = mountSorted();
    expect(await checkedFilterValues(second.view.container, "agent")).toEqual(
      BY_ROOM,
    );
  });
});

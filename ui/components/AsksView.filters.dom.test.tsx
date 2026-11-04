// The Asks page's filter row (ui/components/AsksView.tsx): the room and
// priority filters, the sort select, and what the page remembers of them.
// The orders each sort gives are in ui/components/AsksView.test.ts, and the
// stored sort in ui/device-settings.test.ts. This file is separate from
// AsksView.dom.test.tsx only because each DOM file has a wall-time budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  allFilterBox,
  allFilterState,
  checkedFilterValues,
  filterButton,
  filterCounts,
  filterOptions,
  onlyFilterButton,
  openCheckboxFilter,
  setCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
const {
  ranked,
  mount,
  mountSorted,
  runsOf,
  groupIds,
  pageOrder,
  control,
  choose,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  BY_AGENT,
  BY_AGE,
} = await import("../test-support/asks-view.ts");
type AppState = import("../test-support/asks-view.ts").AppState;
type View = ReturnType<typeof mount>["view"];

// The room and priority filters are the Tasks page's checkbox lists
// (CheckboxFilter, task 2bbc5021): several choices at once, all checked at
// open, each with a count.
const ALL_PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "none"];
const setRooms = (view: View, rooms: string[]) =>
  setCheckboxFilter(view.container, "room", rooms);
const setPriorities = (view: View, levels: string[]) =>
  setCheckboxFilter(view.container, "priority", levels);
const isOpen = (view: View, which: string) =>
  filterButton(view.container, which).getAttribute("aria-expanded");

describe("the filter row", () => {
  beforeEach(() => localStorage.clear());

  it("opens on all rooms, all priorities and the agent sort, and offers each room and level", async () => {
    const { view } = mountSorted();
    const c = view.container;
    // Each room in the office's order, every one checked.
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(filterOptions(c, "room")).toEqual(["r2", "r1"]);
    expect(await checkedFilterValues(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(filterOptions(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(control(view, "data-asks-sort").value).toBe("agent");
    expect(
      [...control(view, "data-asks-sort").options].map((o) => o.value).sort(),
    ).toEqual(["age", "agent", "priority", "room"]);
    expect(pageOrder(view)).toEqual(BY_AGENT);
  });

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

  it("names the checked rooms on the button, and keeps room names out of page translation", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const summary = () => filterButton(c, "room").textContent ?? "";
    // All checked, and none: a word, not the rooms.
    const all = summary();
    expect(all).not.toContain("Room One");
    expect(all).not.toContain("Room Two");
    await setRooms(view, []);
    const none = summary();
    expect(none).not.toContain("Room One");
    expect(none).not.toContain("Room Two");
    expect(none).not.toBe(all);
    await setRooms(view, ["r1"]);
    expect(summary()).toContain("Room One");
    expect(summary()).not.toContain("Room Two");
    // A room name, in the list or on the button, is not translated.
    const nameEl = (text: string, within: Element) =>
      [...within.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.children.length === 0 && el.textContent === text,
      );
    const button = filterButton(c, "room");
    expect(
      nameEl("Room One", button)?.closest("[translate=no]") ?? null,
    ).not.toBeNull();
    await openCheckboxFilter(c, "room");
    const list = button.parentElement!;
    for (const name of ["Room One", "Room Two"])
      expect(
        nameEl(name, list)?.closest("[translate=no]") ?? null,
      ).not.toBeNull();
    // A priority level's label is translatable.
    await openCheckboxFilter(c, "priority");
    const none_ = filterButton(c, "priority").parentElement!.querySelector(
      'input[value="none"]',
    )!;
    expect(none_.closest("label")!.querySelector("[translate=no]")).toBeNull();
  });

  it("shows a room that appears while the tab is open as checked, and drops a room that goes", async () => {
    const { view, latest } = mountSorted();
    const c = view.container;
    const all = filterButton(c, "room").textContent;
    await setRooms(view, ["r2"]);
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1", "a2:a2only"]);
    act(() =>
      latest.setPlace({
        rooms: [
          ...SORT_ROOMS,
          { id: "r3", name: "Room Three" },
        ] as AppState["rooms"],
        agents: [
          ...SORT_AGENTS,
          { id: "a5", name: "Scribe", roomId: "r3" },
        ] as AppState["agents"],
      }),
    );
    act(() =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a5new", "a5", 1, "P3"),
      }),
    );
    // The new room is checked and its ask shows; the unchecked room stays out.
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r3"]);
    expect(pageOrder(view)).toEqual([
      "a4:a4none,a4p1",
      "a2:a2only",
      "a5:a5new",
    ]);
    expect(filterButton(c, "room").textContent).not.toBe(all);
    // r1 goes while unchecked: it leaves the list, nothing listed is
    // unchecked, so the button reads as all rooms again and no ask is hidden
    // by a room the list no longer offers.
    act(() =>
      latest.setPlace({
        rooms: [
          { id: "r2", name: "Room Two" },
          { id: "r3", name: "Room Three" },
        ] as AppState["rooms"],
        agents: latest.state.agents,
      }),
    );
    expect(filterOptions(c, "room")).toEqual(["r2", "r3"]);
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r3"]);
    expect(filterButton(c, "room").textContent).toBe(all);
    expect(groupIds(view).sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("closes an open list on Escape, focus back on its button, and the Inbox stays", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const reached: string[] = [];
    // App closes the page on a window bubble keydown (App.tsx handleKey).
    const appEscape = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener("keydown", appEscape);
    try {
      // With no list open, Escape reaches App: the probe can see it.
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(reached).toEqual(["Escape"]);
      reached.length = 0;
      // A list open, focus on one of its boxes.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      const box = c.querySelector<HTMLInputElement>(
        '[data-checkbox-filter="room"] input[value="r1"]',
      )!;
      act(() => box.focus());
      await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
      expect(isOpen(view, "room")).toBe("false");
      expect(reached).toEqual([]);
      // A scalar: a failed toBe on two DOM nodes serialises both.
      const active = () => {
        const el = document.activeElement as HTMLElement | null;
        return `${el?.closest<HTMLElement>("[data-checkbox-filter]")?.dataset.checkboxFilter}/${el?.tagName}`;
      };
      expect(active()).toBe("room/BUTTON");
      // Focus on the page, as after a click in Safari: the list still closes
      // first, and focus goes to its button.
      await openCheckboxFilter(c, "priority");
      expect(isOpen(view, "priority")).toBe("true");
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(active()).toBe("undefined/BODY");
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(isOpen(view, "priority")).toBe("false");
      expect(reached).toEqual([]);
      expect(active()).toBe("priority/BUTTON");
      // Other keys with a list open still reach the page.
      await openCheckboxFilter(c, "priority");
      await act(async () => fireEvent.keyDown(document.body, { key: "a" }));
      expect(reached).toEqual(["a"]);
      // One list at a time.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      expect(isOpen(view, "priority")).toBe("false");
    } finally {
      window.removeEventListener("keydown", appEscape);
    }
  });

  // Sort by age (task 66532fa7): one list, longest wait first, with a header
  // at each change of agent, so an agent can head more than one run.
  it("sorts by age: one list, longest wait first, a header with the agent and room at each change of agent", async () => {
    const { view } = mountSorted();
    choose(view, "data-asks-sort", "age");
    expect(pageOrder(view)).toEqual(BY_AGE);
    // The second a1 run has its own header: the name that opens the chat
    // and the room.
    const runs = view.container.querySelectorAll<HTMLElement>(
      '[data-asks-group="a1"]',
    );
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.querySelector("[data-asks-agent]")?.tagName).toBe("BUTTON");
      expect(run.textContent).toContain("Scout");
      expect(run.textContent).toContain("Room One");
    }
    // A filter change redraws the runs, and no header is left behind.
    await setRooms(view, ["r2"]);
    await setRooms(view, ["r2", "r1"]);
    expect(pageOrder(view)).toEqual(BY_AGE);
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

  it("has an All box that is checked, mixed or clear, and checks every room unless all are checked", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const clickAll = async () => {
      const box = await allFilterBox(c, "room");
      await act(async () => fireEvent.click(box));
      expect(isOpen(view, "room")).toBe("true");
    };
    expect(await allFilterState(c, "room")).toBe("all");
    // All checked: a click clears every room.
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual([]);
    expect(await allFilterState(c, "room")).toBe("none");
    expect(pageOrder(view)).toEqual([]);
    // None checked: a click checks every room.
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
    expect(pageOrder(view)).toEqual(BY_AGENT);
    // Some checked: mixed, and a click checks every room.
    await setRooms(view, ["r1"]);
    expect(await allFilterState(c, "room")).toBe("some");
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
    // A room toggled back on in the list makes All checked again.
    await setRooms(view, ["r2"]);
    await setRooms(view, ["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
  });

  it("has Only and All on the priority list too", async () => {
    const { view } = mountSorted();
    const c = view.container;
    await act(async () =>
      fireEvent.click(await onlyFilterButton(c, "priority", "P1")),
    );
    expect(await checkedFilterValues(c, "priority")).toEqual(["P1"]);
    expect(pageOrder(view)).toEqual(["a3:a3p1", "a4:a4p1"]);
    expect(await allFilterState(c, "priority")).toBe("some");
    await act(async () => fireEvent.click(await allFilterBox(c, "priority")));
    expect(await checkedFilterValues(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(pageOrder(view)).toEqual(BY_AGENT);
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

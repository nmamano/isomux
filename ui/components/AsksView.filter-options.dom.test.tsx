// The Asks page's filter row (ui/components/AsksView.tsx): what the filter
// lists and the sort select offer at open, the room names on the button, a
// room that appears or goes while the tab is open, the age sort's runs, and
// the agent list's room groups (task 899360d3).
// The orders each sort gives are in ui/components/AsksView.test.ts.
// This file is separate from the other AsksView.filter*.dom.test.tsx files
// and from AsksView.dom.test.tsx only because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  checkedFilterValues,
  filterButton,
  filterGroups,
  filterOptions,
  openCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
const {
  ask,
  mount,
  ranked,
  mountSorted,
  groupIds,
  pageOrder,
  control,
  choose,
  SORT_ROOMS,
  SORT_AGENTS,
  BY_AGENT,
  BY_AGE,
  ALL_PRIORITIES,
  setRooms,
} = await import("../test-support/asks-view.ts");
type AppState = import("../test-support/asks-view.ts").AppState;

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

  it("groups the agents under their room's name in office order, by desk inside a room, and the agents of no known room last, by name", async () => {
    const { view } = mount(
      ["b1", "b2", "b3", "b4", "b5"].map((id, i) => ask(`k${id}`, id, i + 1)),
      {
        rooms: [
          { id: "r2", name: "Room Two" },
          { id: "r3", name: "Room Three" },
          { id: "r1", name: "Room One" },
        ] as AppState["rooms"],
        agents: [
          { id: "b1", name: "Twin", roomId: "r1", desk: 2 },
          { id: "b2", name: "Twin", roomId: "r2", desk: 4 },
          // A back seat: after the front desks, whatever its name.
          { id: "b3", name: "Abe", roomId: "r2", desk: 9 },
          // A room the member does not see.
          { id: "b4", name: "Zed", roomId: "r9", desk: 0 },
          { id: "b5", name: "Ace", roomId: "r9", desk: 1 },
          // No open ask: Room Three gets no group.
          { id: "b6", name: "Idle", roomId: "r3", desk: 0 },
        ] as AppState["agents"],
      },
    );
    const c = view.container;
    await openCheckboxFilter(c, "agent");
    expect(filterGroups(c, "agent")).toEqual([
      { id: "r2", role: "group", label: "Room Two", values: ["b2", "b3"] },
      { id: "r1", role: "group", label: "Room One", values: ["b1"] },
      { id: "", role: "group", label: null, values: ["b5", "b4"] },
    ]);
    // Each room's heading shows its name, which page translation leaves alone.
    for (const name of ["Room Two", "Room One"]) {
      const group = c.querySelector(`[aria-label="${name}"]`)!;
      const heading = [...group.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.children.length === 0 && el.textContent === name,
      );
      expect(heading?.closest("[translate=no]") ?? null).not.toBeNull();
    }
    // The room list has no groups.
    await openCheckboxFilter(c, "room");
    expect(filterOptions(c, "room")).toEqual(["r2", "r3", "r1"]);
    expect(filterGroups(c, "room")).toEqual([]);
  });
});

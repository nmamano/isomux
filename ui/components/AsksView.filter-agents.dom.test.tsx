// The Asks page's agent filter (ui/components/AsksView.tsx, task b3cb0a41):
// the agents it offers and their order, what it hides, its counts against the
// room and priority filters, its memory on this device, and Show all. The
// stored shape is in ui/device-settings.test.ts ("asks filter").
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
  openCheckboxFilter,
  setCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
const {
  ask,
  ranked,
  mount,
  mountSorted,
  pageOrder,
  groupIds,
  control,
  choose,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  BY_AGENT,
  setRooms,
  setPriorities,
  isOpen,
  ALL_PRIORITIES,
} = await import("../test-support/asks-view.ts");
type AppState = import("../test-support/asks-view.ts").AppState;
type View = ReturnType<typeof mount>["view"];

const setAgents = (view: View, ids: string[]) =>
  setCheckboxFilter(view.container, "agent", ids);
const summary = (view: View) =>
  filterButton(view.container, "agent").textContent ?? "";

// SORT_AGENTS by name: Pathfinder (a3), Ranger (a2), Scout (a1), Tracker (a4).
const BY_NAME = ["a3", "a2", "a1", "a4"];

describe("the agent filter", () => {
  beforeEach(() => localStorage.clear());

  it("offers each agent with an open ask, by name whatever the case, all checked, and hides an unchecked agent's run", async () => {
    const { view } = mount([...SORT_ASKS, ranked("lowAsk", "a5", 15, "P3")], {
      rooms: SORT_ROOMS,
      agents: [
        ...SORT_AGENTS,
        // A lower-case name sorts first only when case does not count.
        { id: "a5", name: "apex", roomId: "r2" },
        // No open ask: not offered.
        { id: "a6", name: "Idle", roomId: "r1" },
      ] as AppState["agents"],
    });
    const c = view.container;
    expect(await checkedFilterValues(c, "agent")).toEqual(["a5", ...BY_NAME]);
    expect(filterOptions(c, "agent")).toEqual(["a5", ...BY_NAME]);
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
    expect(await checkedFilterValues(c, "agent")).toEqual(["a5", ...BY_NAME]);
    expect(summary(view)).toBe(all);
  });

  it("orders two agents with one name by id, whatever the agents slice's order", async () => {
    const { view } = mount([ask("y", "b2", 10), ask("x", "b1", 20)], {
      rooms: SORT_ROOMS,
      agents: [
        { id: "b2", name: "Twin", roomId: "r1" },
        { id: "b1", name: "Twin", roomId: "r2" },
      ] as AppState["agents"],
    });
    await openCheckboxFilter(view.container, "agent");
    expect(filterOptions(view.container, "agent")).toEqual(["b1", "b2"]);
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

  it("remembers an unchecked agent, shows a new one checked, and keeps listing an unchecked agent with no asks", async () => {
    const fresh = mountSorted();
    const allSummary = summary(fresh.view);
    fresh.view.unmount();
    const first = mountSorted();
    await setAgents(first.view, ["a3", "a1", "a4"]);
    first.view.unmount();

    const second = mountSorted();
    const c = second.view.container;
    expect(await checkedFilterValues(c, "agent")).toEqual(["a3", "a1", "a4"]);
    expect(groupIds(second.view)).not.toContain("a2");
    // An agent that opens its first ask shows checked, and its ask shows.
    act(() =>
      second.latest.setPlace({
        rooms: SORT_ROOMS,
        agents: [
          ...SORT_AGENTS,
          { id: "a5", name: "Scribe", roomId: "r1" },
        ] as AppState["agents"],
      }),
    );
    act(() =>
      second.latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a5new", "a5", 1, "P3"),
      }),
    );
    expect(await checkedFilterValues(c, "agent")).toEqual([
      "a3",
      "a1",
      "a5",
      "a4",
    ]);
    expect(groupIds(second.view)).toContain("a5");
    second.view.unmount();

    // a2 is gone from the office: not offered, and the button reads all.
    const gone = mount(
      SORT_ASKS.filter((e) => e.agentId !== "a2"),
      {
        rooms: SORT_ROOMS,
        agents: SORT_AGENTS.filter((a) => a.id !== "a2"),
      },
    );
    await openCheckboxFilter(gone.view.container, "agent");
    expect(filterOptions(gone.view.container, "agent")).toEqual([
      "a3",
      "a1",
      "a4",
    ]);
    expect(summary(gone.view)).toBe(allSummary);
    gone.view.unmount();

    // a2 is back with no open ask: still unchecked and listed, with no
    // count, so it can be checked back.
    const idle = mount(
      SORT_ASKS.filter((e) => e.agentId !== "a2"),
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    const ic = idle.view.container;
    expect(await checkedFilterValues(ic, "agent")).toEqual(["a3", "a1", "a4"]);
    expect(filterOptions(ic, "agent")).toEqual(BY_NAME);
    expect((await filterCounts(ic, "agent")).a2).toBe(0);
    await setAgents(idle.view, BY_NAME);
    expect(summary(idle.view)).toBe(allSummary);
    idle.view.unmount();
    // Checked back, it is remembered as checked.
    const last = mountSorted();
    expect(await checkedFilterValues(last.view.container, "agent")).toEqual(
      BY_NAME,
    );
    expect(pageOrder(last.view)).toEqual(BY_AGENT);
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
    expect(await checkedFilterValues(c, "agent")).toEqual(BY_NAME);
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
      BY_NAME,
    );
  });

  it("offers the agents of the owner's chosen member set, after the priority filter and before the member select", async () => {
    const { view } = mount([ask("mine1", "a1", 30)], {
      sessionContext: {
        userId: "u1",
        username: "nil",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as AppState["sessionContext"],
      othersAsks: [
        { ...ask("abe1", "a2", 10), memberUserId: "u-Abe", member: "Abe" },
      ] as AppState["othersAsks"],
    });
    const c = view.container;
    const precedes = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const member = control(view, "data-asks-member");
    expect(
      precedes(filterButton(c, "priority"), filterButton(c, "agent")),
    ).toBe(true);
    expect(precedes(filterButton(c, "agent"), member)).toBe(true);
    // Mine: only a1 has an ask in the set.
    await openCheckboxFilter(c, "agent");
    expect(filterOptions(c, "agent")).toEqual(["a1"]);
    choose(view, "data-asks-member", "all");
    await openCheckboxFilter(c, "agent");
    // Ranger (a2), then Scout (a1).
    expect(filterOptions(c, "agent")).toEqual(["a2", "a1"]);
    await setAgents(view, ["a2"]);
    expect(pageOrder(view)).toEqual(["a2:abe1"]);
  });

  // The chat stack's View in Inbox (task 586ebfe1): a one-shot request to show
  // exactly one agent's asks for this member, whatever filters were left on.
  it("shows exactly the requested agent's own asks once, over the stored rooms, priorities and member, and remembers that", async () => {
    const owner = {
      sessionContext: {
        userId: "u1",
        username: "nil",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as AppState["sessionContext"],
      othersAsks: [
        { ...ask("abeA1", "a1", 10), memberUserId: "u-Abe", member: "Abe" },
        // a5's only ask is Abe's: no agent of the member's own set.
        { ...ask("abeA5", "a5", 12), memberUserId: "u-Abe", member: "Abe" },
      ] as AppState["othersAsks"],
      rooms: SORT_ROOMS,
      agents: [
        ...SORT_AGENTS,
        { id: "a5", name: "Scribe", roomId: "r1" },
        // No ask at all.
        { id: "a6", name: "Idle", roomId: "r1" },
      ] as AppState["agents"],
    };
    // Left on before: Room One (a1's room) unchecked, P1 only (a1 has none),
    // every member's asks.
    const before = mount(SORT_ASKS, owner);
    await setRooms(before.view, ["r2"]);
    await setPriorities(before.view, ["P1"]);
    choose(before.view, "data-asks-member", "all");
    expect(pageOrder(before.view)).toEqual(["a4:a4p1"]);
    before.view.unmount();

    const { view, latest } = mount(SORT_ASKS, owner, "a1");
    const c = view.container;
    // The member's own a1 asks, not Abe's.
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top"]);
    expect(latest.handled).toBe(1);
    expect(control(view, "data-asks-member").value).toBe("mine");
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(await checkedFilterValues(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(await checkedFilterValues(c, "agent")).toEqual(["a1"]);
    // Unchecked: the agents the filter lists for the member's own asks; not
    // a5 (Abe's ask only) nor a6 (no ask).
    expect(filterOptions(c, "agent")).toEqual(BY_NAME);
    expect(summary(view)).toContain("Scout");

    // Applied once: the member's next change stands.
    await setAgents(view, ["a1", "a2"]);
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top", "a2:a2only"]);
    expect(latest.handled).toBe(1);

    // A later request on the open page applies too.
    await act(async () => latest.requestAgent("a4"));
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1"]);
    expect(latest.handled).toBe(2);
    expect(await checkedFilterValues(c, "agent")).toEqual(["a4"]);
    view.unmount();

    // Remembered on this device like a filter the member set.
    const again = mount(SORT_ASKS, owner);
    expect(pageOrder(again.view)).toEqual(["a4:a4none,a4p1"]);
    expect(control(again.view, "data-asks-member").value).toBe("mine");
    expect(await checkedFilterValues(again.view.container, "room")).toEqual([
      "r2",
      "r1",
    ]);
    expect(again.latest.handled).toBe(0);
  });
});

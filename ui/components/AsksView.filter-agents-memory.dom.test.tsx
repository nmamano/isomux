// The Asks page's agent filter (ui/components/AsksView.tsx, task b3cb0a41):
// its memory on this device, the agents of the owner's chosen member set, and
// the requested agent's own asks. Split from
// ui/components/AsksView.filter-agents.dom.test.tsx, which holds the agents it
// offers, their counts and Show all, because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  checkedFilterValues,
  filterButton,
  filterCounts,
  filterOptions,
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
  ALL_PRIORITIES,
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

  it("remembers an unchecked agent, shows a new one checked, and keeps listing an unchecked agent with no asks", async () => {
    const fresh = mountSorted();
    const allSummary = summary(fresh.view);
    fresh.view.unmount();
    const first = mountSorted();
    await setAgents(first.view, ["a4", "a3", "a1"]);
    first.view.unmount();

    const second = mountSorted();
    const c = second.view.container;
    expect(await checkedFilterValues(c, "agent")).toEqual(["a4", "a3", "a1"]);
    expect(groupIds(second.view)).not.toContain("a2");
    // An agent that opens its first ask shows checked, and its ask shows.
    act(() =>
      second.latest.setPlace({
        rooms: SORT_ROOMS,
        agents: [
          ...SORT_AGENTS,
          { id: "a5", name: "Scribe", roomId: "r1", desk: 1 },
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
      "a4",
      "a3",
      "a5",
      "a1",
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
      "a4",
      "a3",
      "a1",
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
    expect(await checkedFilterValues(ic, "agent")).toEqual(["a4", "a3", "a1"]);
    expect(filterOptions(ic, "agent")).toEqual(BY_ROOM);
    expect((await filterCounts(ic, "agent")).a2).toBe(0);
    await setAgents(idle.view, BY_ROOM);
    expect(summary(idle.view)).toBe(allSummary);
    idle.view.unmount();
    // Checked back, it is remembered as checked.
    const last = mountSorted();
    expect(await checkedFilterValues(last.view.container, "agent")).toEqual(
      BY_ROOM,
    );
    expect(pageOrder(last.view)).toEqual(BY_AGENT);
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
    // Room One's Scout (a1), then Room Two's Ranger (a2).
    expect(filterOptions(c, "agent")).toEqual(["a1", "a2"]);
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
    expect(filterOptions(c, "agent")).toEqual(BY_ROOM);
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

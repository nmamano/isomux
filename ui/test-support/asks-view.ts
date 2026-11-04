// The shared harness for the AsksView DOM tests: one mount over the real
// reducer, the ask fixtures, and readers for the page order. UI code is
// imported by the test file after the DOM is set up, so this module evaluates
// then, too: a test file that imports it statically evaluates UI code before
// the DOM exists, which can pass and record the wrong state.
import { createElement, useReducer, useState } from "react";
import { render } from "@testing-library/react";
import { AsksView } from "../components/AsksView.tsx";
import { StateCtx, DispatchCtx, initialState, reducer } from "../store.tsx";
import { act, fireEvent } from "@testing-library/react";
import { filterButton, setCheckboxFilter } from "./checkbox-filters.ts";

type AskEntry = import("../../shared/types.ts").AskEntry;
type TaskPriority = import("../../shared/types.ts").TaskPriority;
export type AppState = typeof initialState;
type View = ReturnType<typeof render>;

const NOW = Date.now();
export const ask = (id: string, agentId: string, ageMin: number): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});
export const ranked = (
  id: string,
  agentId: string,
  ageMin: number,
  priority?: TaskPriority,
): AskEntry => ({
  ...ask(id, agentId, ageMin),
  ...(priority ? { priority } : {}),
});

// `place` seeds any other slice: the rooms and agents, or for an office
// owner the session and other members' asks.
export function mount(asks: AskEntry[], place: Partial<AppState> = {}) {
  const seeded: AppState = {
    ...initialState,
    asks,
    rooms: [
      { id: "r1", name: "Room One" },
      { id: "r2", name: "Room Two" },
    ] as AppState["rooms"],
    agents: [
      { id: "a1", name: "Scout", roomId: "r1" },
      { id: "a2", name: "Ranger", roomId: "r2" },
    ] as AppState["agents"],
    ...place,
  };
  const focused: string[] = [];
  const latest: {
    state: AppState;
    dispatch: (action: Parameters<typeof reducer>[1]) => void;
    // Replaces the rooms and agents slices, as a full_state would.
    setPlace: (place: Pick<AppState, "rooms" | "agents">) => void;
  } = { state: seeded, dispatch: () => {}, setPlace: () => {} };
  function Harness() {
    const [reduced, dispatch] = useReducer(reducer, seeded);
    const [place, setPlace] = useState<Partial<AppState>>({});
    const state = { ...reduced, ...place };
    latest.state = state;
    latest.dispatch = dispatch;
    latest.setPlace = setPlace;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(AsksView, {
          onFocusAgent: (id: string) => focused.push(id),
        }),
      ),
    );
  }
  const view = render(createElement(Harness));
  return { view, focused, latest };
}

// The list in order: each group's agent and the cards under it up to the next
// group, whether the group wraps its cards or only heads them. A held
// answer's Undo line is a toast outside the list, so it is no card here.
export const runsOf = (view: View) => {
  const runs: { agent: string; cards: string[] }[] = [];
  for (const el of view.container.querySelectorAll<HTMLElement>(
    "[data-asks-list] [data-asks-group], [data-asks-list] [data-ask]",
  )) {
    if (el.dataset.asksGroup !== undefined)
      runs.push({ agent: el.dataset.asksGroup, cards: [] });
    else runs[runs.length - 1].cards.push(el.dataset.ask!);
  }
  return runs;
};
export const groupIds = (view: View) => runsOf(view).map((r) => r.agent);
export const cardIds = (view: View, agentId: string) =>
  runsOf(view)
    .filter((r) => r.agent === agentId)
    .flatMap((r) => r.cards);
export const pageOrder = (view: View) =>
  runsOf(view).map((r) => `${r.agent}:${r.cards.join(",")}`);

export const control = (
  view: View,
  attr: "data-asks-sort" | "data-asks-sort-dir" | "data-asks-member",
) => view.container.querySelector<HTMLSelectElement>(`select[${attr}]`)!;
export const choose = (
  view: View,
  attr: "data-asks-sort" | "data-asks-sort-dir" | "data-asks-member",
  value: string,
) =>
  act(() => void fireEvent.change(control(view, attr), { target: { value } }));

// The filter row's room order is the rooms slice's, which differs from both
// id order and name order; these sets drive the sort tests.
export const SORT_ROOMS = [
  { id: "r2", name: "Room Two" },
  { id: "r1", name: "Room One" },
] as AppState["rooms"];
export const SORT_AGENTS = [
  { id: "a1", name: "Scout", roomId: "r1" },
  { id: "a2", name: "Ranger", roomId: "r2" },
  { id: "a3", name: "Pathfinder", roomId: "r1" },
  { id: "a4", name: "Tracker", roomId: "r2" },
] as AppState["agents"];
export const SORT_ASKS = [
  ranked("a1old", "a1", 100, "P2"),
  ranked("a1top", "a1", 5, "P0"),
  ranked("a2only", "a2", 60),
  ranked("a3p1", "a3", 30, "P1"),
  ranked("a4p1", "a4", 10, "P1"),
  ranked("a4none", "a4", 200),
];
export const mountSorted = () =>
  mount(SORT_ASKS, { rooms: SORT_ROOMS, agents: SORT_AGENTS });
export const BY_AGENT = [
  "a4:a4none,a4p1",
  "a1:a1old,a1top",
  "a2:a2only",
  "a3:a3p1",
];
export const BY_AGE = [
  "a4:a4none",
  "a1:a1old",
  "a2:a2only",
  "a3:a3p1",
  "a4:a4p1",
  "a1:a1top",
];

// The room and priority filters are the Tasks page's checkbox lists
// (CheckboxFilter, task 2bbc5021): several choices at once, all checked at
// open, each with a count.
export const ALL_PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "none"];
export const setRooms = (view: View, rooms: string[]) =>
  setCheckboxFilter(view.container, "room", rooms);
export const setPriorities = (view: View, levels: string[]) =>
  setCheckboxFilter(view.container, "priority", levels);
export const isOpen = (view: View, which: string) =>
  filterButton(view.container, which).getAttribute("aria-expanded");

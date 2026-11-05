// The board's side of task 83f71be9: a task names its assignee and creator by
// agent id first. A killed agent's name does not link to a new agent that took
// that name, and the board marks the name as killed. The assignee chips of
// the task panel are grouped by room (task 899360d3).
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const DEAD = "agent-1000-dead";
const LIVE = "agent-2000-live";
const UNKNOWN = "agent-3000-gone";

const base = {
  status: "open",
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
  version: "v",
};
const tasks = [
  // The killed agent's task; a live agent has the same name now.
  {
    ...base,
    id: "11111111",
    title: "Dead holder",
    assignee: "Worker",
    assigneeAgentId: DEAD,
  },
  // The live agent's task, with the name it had before a rename.
  {
    ...base,
    id: "22222222",
    title: "Live holder",
    assignee: "Old Name",
    assigneeAgentId: LIVE,
  },
  // An id in neither list (the killed roster is capped).
  {
    ...base,
    id: "33333333",
    title: "Unknown holder",
    assignee: "Worker",
    assigneeAgentId: UNKNOWN,
  },
  // A row from before the ids: the name lookup as before.
  { ...base, id: "44444444", title: "Legacy holder", assignee: "worker" },
  // Created by the killed agent.
  {
    ...base,
    id: "55555555",
    title: "Dead creator",
    createdBy: "Worker",
    username: "Worker",
    createdByAgentId: DEAD,
  },
] as TaskItem[];

function mount() {
  const focused: string[] = [];
  const state = {
    ...initialState,
    tasks,
    tasksLoaded: true,
    currentRoomId: "r1",
    rooms: [{ id: "r1", name: "One" }],
    agents: [{ id: LIVE, name: "Worker", roomId: "r1", desk: 0 }],
    killedAgents: [
      {
        id: DEAD,
        name: "Worker",
        agentType: "claude",
        lastRoomId: "r1",
        lastRoomName: "One",
        topic: null,
        killedAt: 1,
      },
    ],
  } as unknown as typeof initialState;
  const view = render(
    <StateCtx.Provider value={state}>
      <TaskView onClose={() => {}} onFocusAgent={(id) => focused.push(id)} />
    </StateCtx.Provider>,
  );
  // The cell after a task's title cell is its assignee; the one after that,
  // its creator.
  const cellAfterTitle = (title: string, offset: 1 | 2) => {
    const titleCell = [...view.container.querySelectorAll("td")].find((td) =>
      td.textContent?.includes(title),
    );
    if (!titleCell) throw new Error(`no row for ${title}`);
    let cell: Element | null = titleCell;
    for (let i = 0; i < offset; i++) cell = cell?.nextElementSibling ?? null;
    if (!cell) throw new Error(`no cell ${offset} after ${title}`);
    return cell as HTMLElement;
  };
  // Click every element in the cell; report the agents it focused.
  const clickAll = (cell: HTMLElement) => {
    focused.length = 0;
    for (const el of [cell, ...cell.querySelectorAll("*")]) fireEvent.click(el);
    return [...new Set(focused)];
  };
  return { cellAfterTitle, clickAll };
}

it("a live id links to that agent under its current name", () => {
  const { cellAfterTitle, clickAll } = mount();
  const cell = cellAfterTitle("Live holder", 1);
  expect(cell.textContent).toBe("Worker");
  expect(clickAll(cell)).toEqual([LIVE]);
});

it("a killed id keeps its stored name, unlinked, with a marker; an unknown id shows the name plain", () => {
  const { cellAfterTitle, clickAll } = mount();
  const dead = cellAfterTitle("Dead holder", 1);
  const unknown = cellAfterTitle("Unknown holder", 1);
  // Neither links to the live agent that has the name now.
  expect(clickAll(dead)).toEqual([]);
  expect(clickAll(unknown)).toEqual([]);
  // Both show the stored name; only the killed one carries more (its marker).
  expect(dead.textContent).toContain("Worker");
  expect(unknown.textContent).toBe("Worker");
  expect(dead.textContent).not.toBe("Worker");
});

it("a row with no id keeps the name lookup", () => {
  const { cellAfterTitle, clickAll } = mount();
  const cell = cellAfterTitle("Legacy holder", 1);
  expect(cell.textContent).toBe("worker");
  expect(clickAll(cell)).toEqual([LIVE]);
});

it("the creator column resolves by id too", () => {
  const { cellAfterTitle, clickAll } = mount();
  const cell = cellAfterTitle("Dead creator", 2);
  expect(clickAll(cell)).toEqual([]);
  expect(cell.textContent).toContain("Worker");
  expect(cell.textContent).not.toBe("Worker");
});

// Twelve agents: the ten most recently spawned get a chip, and recency does
// not follow rooms or desks. Office order: Two, Three, One, then Four with
// no agent; r9 is a room the member does not see.
const CHIP_AGENTS = [
  ["agent-1001-a", "Old1", "r1", 0],
  ["agent-1002-b", "Old2", "r2", 0],
  ["agent-1003-j", "J", "r9", 0],
  ["agent-1004-f", "F", "r2", 3],
  ["agent-1005-d", "D", "r1", 1],
  ["agent-1006-h", "H", "r2", 5],
  ["agent-1007-k", "K", "r3", 0],
  ["agent-1008-l", "L", "r3", 1],
  ["agent-1009-e", "E", "r1", 9],
  ["agent-1010-i", "I", "r9", 1],
  ["agent-1011-g", "G", "r2", 2],
  ["agent-1012-c", "C", "r1", 4],
].map(([id, name, roomId, desk]) => ({ id, name, roomId, desk }));

function mountChips() {
  const state = {
    ...initialState,
    tasks,
    tasksLoaded: true,
    currentRoomId: "r1",
    rooms: [
      { id: "r2", name: "Two" },
      { id: "r3", name: "Three" },
      { id: "r1", name: "One" },
      { id: "r4", name: "Four" },
    ],
    agents: CHIP_AGENTS,
  } as unknown as typeof initialState;
  const view = render(
    <StateCtx.Provider value={state}>
      <TaskView
        onClose={() => {}}
        openTaskRequest={{ id: "44444444" }}
        onTaskOpenRequestHandled={() => {}}
      />
    </StateCtx.Provider>,
  );
  // Each chip group: its room id ("" for no known room), the text of its
  // label (null when it has none) and its chips.
  const chipGroups = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>("[data-assignee-group]"),
    ].map((group) => {
      const label = [...group.querySelectorAll<HTMLElement>("*")].find(
        (el) =>
          !el.closest("button") &&
          el.children.length === 0 &&
          (el.textContent ?? "") !== "",
      );
      if (label) expect(label.closest("[translate=no]")).not.toBeNull();
      return {
        id: group.dataset.assigneeGroup,
        label: label?.textContent ?? null,
        chips: [...group.querySelectorAll("button")].map(
          (chip) => chip.textContent,
        ),
      };
    });
  return { view, chipGroups };
}

it("the assignee chips sit under their room in office order, by desk; recency picks the ten, and more adds the rest in place", async () => {
  const { view, chipGroups } = mountChips();
  await view.findByDisplayValue("Legacy holder");
  // The panel shows the chips: the most recent agent's is one.
  expect(
    [...view.container.querySelectorAll("button")].some(
      (b) => b.textContent === "C",
    ),
  ).toBe(true);
  expect(chipGroups()).toEqual([
    { id: "r2", label: "Two", chips: ["G", "F", "H"] },
    { id: "r3", label: "Three", chips: ["K", "L"] },
    { id: "r1", label: "One", chips: ["D", "C", "E"] },
    { id: "", label: null, chips: ["I", "J"] },
  ]);
  const more = view.container.querySelector<HTMLElement>(
    "[data-assignee-more]",
  )!;
  expect(more.closest("[data-assignee-group]")).toBeNull();
  await act(async () => fireEvent.click(more));
  expect(chipGroups()).toEqual([
    { id: "r2", label: "Two", chips: ["Old2", "G", "F", "H"] },
    { id: "r3", label: "Three", chips: ["K", "L"] },
    { id: "r1", label: "One", chips: ["Old1", "D", "C", "E"] },
    { id: "", label: null, chips: ["I", "J"] },
  ]);
});

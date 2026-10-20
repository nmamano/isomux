// The board's side of task 83f71be9: a task names its assignee and creator by
// agent id first. A killed agent's name does not link to a new agent that took
// that name, and the board marks the name as killed.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
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

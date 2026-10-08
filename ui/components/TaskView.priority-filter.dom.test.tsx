import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;
type TaskPriority = import("../../shared/types.ts").TaskPriority;
type TaskStatus = import("../../shared/types.ts").TaskStatus;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

let seq = 0;
function task(
  title: string,
  status: TaskStatus,
  priority?: TaskPriority,
): TaskItem {
  seq += 1;
  return {
    id: String(seq).padStart(8, "0"),
    title,
    status,
    priority,
    createdBy: "Nil",
    username: "Nil",
    createdAt: seq,
  } as TaskItem;
}

const tasks = [
  task("p0-open", "open", "P0"),
  task("p1-open", "open", "P1"),
  task("p2-progress", "in_progress", "P2"),
  task("p3-open", "open", "P3"),
  task("p3-done", "done", "P3"),
  task("p4-open", "open", "P4"),
  task("p4-progress", "in_progress", "P4"),
  task("p4-done", "done", "P4"),
  task("none-open", "open"),
  task("none-done", "done"),
];

function renderView() {
  const state = {
    ...initialState,
    tasks,
    tasksLoaded: true,
    currentRoomId: null,
    lobbyOpen: true,
    rooms: [],
  } as unknown as typeof initialState;
  const view = render(
    <StateCtx.Provider value={state}>
      <TaskView onClose={() => {}} />
    </StateCtx.Provider>,
  );
  const select = (option: string) =>
    view.container.querySelector(
      `select:has(option[value="${option}"])`,
    ) as HTMLSelectElement;
  const status = select("active");
  const priority = select("none");
  const shown = () =>
    tasks
      .map((t) => t.title)
      .filter((title) => view.queryByText(title) !== null)
      .sort();
  return { view, status, priority, shown };
}

it("defaults to any priority", () => {
  const { priority, shown } = renderView();
  expect(priority.value).toBe("");
  expect(shown()).toEqual(
    [
      "p0-open",
      "p1-open",
      "p2-progress",
      "p3-open",
      "p4-progress",
      "none-open",
    ].sort(),
  );
});

it("lists only the chosen priority, ANDed with the status filter", async () => {
  const { status, priority, shown } = renderView();
  await act(async () => fireEvent.change(status, { target: { value: "all" } }));
  for (const p of ["P0", "P1", "P2", "P3", "P4"]) {
    await act(async () =>
      fireEvent.change(priority, { target: { value: p } }),
    );
    const expected = tasks
      .filter((t) => t.priority === p)
      .map((t) => t.title)
      .sort();
    expect(expected.length > 0).toBe(true);
    expect(shown()).toEqual(expected);
  }
  await act(async () =>
    fireEvent.change(priority, { target: { value: "none" } }),
  );
  expect(shown()).toEqual(["none-done", "none-open"]);

  await act(async () =>
    fireEvent.change(status, { target: { value: "done" } }),
  );
  expect(shown()).toEqual(["none-done"]);
  await act(async () =>
    fireEvent.change(priority, { target: { value: "P3" } }),
  );
  expect(shown()).toEqual(["p3-done"]);
  await act(async () =>
    fireEvent.change(status, { target: { value: "open" } }),
  );
  expect(shown()).toEqual(["p3-open"]);
  await act(async () =>
    fireEvent.change(priority, { target: { value: "P2" } }),
  );
  expect(shown()).toEqual([]);
});

it("shows the P4 view's tasks for P4 with the default status view", async () => {
  const { status, priority, shown } = renderView();
  await act(async () => fireEvent.change(status, { target: { value: "P4" } }));
  const p4View = shown();
  expect(p4View).toEqual(["p4-open", "p4-progress"]);

  await act(async () =>
    fireEvent.change(status, { target: { value: "active" } }),
  );
  await act(async () =>
    fireEvent.change(priority, { target: { value: "P4" } }),
  );
  expect(shown()).toEqual(p4View);

  // Other priorities keep the default view's rule.
  await act(async () =>
    fireEvent.change(priority, { target: { value: "P3" } }),
  );
  expect(shown()).toEqual(["p3-open"]);
});

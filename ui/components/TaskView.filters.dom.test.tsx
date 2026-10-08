// The Tasks page's status and priority checkbox filters (task 2f470114).
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const {
  checkedFilterValues,
  filterButton,
  filterOptions,
  openTaskFilter,
  setTaskFilter,
  toggleTaskFilter,
} = await import("../test-support/task-filters.ts");
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
  let closed = 0;
  const view = render(
    <StateCtx.Provider value={state}>
      <TaskView onClose={() => closed++} />
    </StateCtx.Provider>,
  );
  const shown = () =>
    tasks
      .map((t) => t.title)
      .filter((title) => view.queryByText(title) !== null)
      .sort();
  return { view, shown, closed: () => closed, c: view.container };
}

it("defaults to Open and In progress, and every priority but P4", async () => {
  const { c, shown } = renderView();
  expect(await checkedFilterValues(c, "status")).toEqual([
    "open",
    "in_progress",
  ]);
  expect(await checkedFilterValues(c, "priority")).toEqual([
    "P0",
    "P1",
    "P2",
    "P3",
    "none",
  ]);
  // P4 is hidden only because it is unchecked: an in-progress P4 task too.
  expect(shown()).toEqual(
    ["p0-open", "p1-open", "p2-progress", "p3-open", "none-open"].sort(),
  );
});

it("lists only statuses in the status filter", async () => {
  const { c } = renderView();
  await openTaskFilter(c, "status");
  expect(filterOptions(c, "status")).toEqual(["open", "in_progress", "done"]);
  await openTaskFilter(c, "priority");
  expect(filterOptions(c, "priority")).toEqual([
    "P0",
    "P1",
    "P2",
    "P3",
    "P4",
    "none",
  ]);
});

it("shows a task when its status AND its priority are checked", async () => {
  const { c, shown } = renderView();
  await toggleTaskFilter(c, "status", "done");
  expect(shown()).toEqual(
    [
      "p0-open",
      "p1-open",
      "p2-progress",
      "p3-open",
      "p3-done",
      "none-open",
      "none-done",
    ].sort(),
  );
  await toggleTaskFilter(c, "priority", "P4");
  expect(shown()).toEqual(tasks.map((t) => t.title).sort());

  for (const p of ["P0", "P1", "P2", "P3", "P4"]) {
    await setTaskFilter(c, "priority", [p]);
    const expected = tasks
      .filter((t) => t.priority === p)
      .map((t) => t.title)
      .sort();
    expect(expected.length > 0).toBe(true);
    expect(shown()).toEqual(expected);
  }
  await setTaskFilter(c, "priority", ["none"]);
  expect(shown()).toEqual(["none-done", "none-open"]);

  await setTaskFilter(c, "status", ["done"]);
  expect(shown()).toEqual(["none-done"]);
  await setTaskFilter(c, "priority", ["P3", "P4"]);
  expect(shown()).toEqual(["p3-done", "p4-done"]);
  await setTaskFilter(c, "status", ["in_progress"]);
  expect(shown()).toEqual(["p4-progress"]);
});

it("shows nothing when a filter has nothing checked", async () => {
  const { c, shown } = renderView();
  await setTaskFilter(c, "status", []);
  expect(shown()).toEqual([]);
  await setTaskFilter(c, "status", ["open"]);
  expect(shown().length > 0).toBe(true);
  await setTaskFilter(c, "priority", []);
  expect(shown()).toEqual([]);
});

it("summarizes the checked priorities as ranges", async () => {
  const { c } = renderView();
  const summary = () => filterButton(c, "priority").textContent ?? "";
  const defaults = summary();
  expect(defaults).toContain("P0-P3");
  expect(defaults).not.toContain("P4");
  await setTaskFilter(c, "priority", ["P0", "P1", "P3"]);
  expect(summary()).toContain("P0-P1");
  expect(summary()).toContain("P3");
  expect(summary()).not.toContain("P2");
  await setTaskFilter(c, "priority", ["P0", "P1", "P2", "P3", "none"]);
  expect(summary()).toBe(defaults);
});

it("closes the list on Escape or an outside tap, and keeps the board open", async () => {
  const { c, closed } = renderView();
  const button = filterButton(c, "status");
  await openTaskFilter(c, "status");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const box = c.querySelector<HTMLInputElement>(
    '[data-task-filter] input[value="open"]',
  )!;
  box.focus();
  await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button);
  expect(closed()).toBe(0);

  await openTaskFilter(c, "status");
  await act(async () => fireEvent.pointerDown(document.body));
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(closed()).toBe(0);

  // Opening one list closes the other.
  await openTaskFilter(c, "status");
  await openTaskFilter(c, "priority");
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

// Each checkbox's count, read from its row: the tasks it would show, given the
// other checkbox filter.
async function filterCounts(
  c: HTMLElement,
  which: "status" | "priority",
): Promise<Record<string, number>> {
  await openTaskFilter(c, which);
  const counts: Record<string, number> = {};
  for (const box of c.querySelectorAll<HTMLInputElement>(
    '[data-task-filter] input[type="checkbox"]',
  ))
    counts[box.value] = Number(
      box.closest("label")!.lastElementChild!.textContent,
    );
  return counts;
}

it("counts each checkbox's tasks under the other filter", async () => {
  const { c } = renderView();
  expect(await filterCounts(c, "status")).toEqual({
    open: 4,
    in_progress: 1,
    done: 2,
  });
  expect(await filterCounts(c, "priority")).toEqual({
    P0: 1,
    P1: 1,
    P2: 1,
    P3: 1,
    P4: 2,
    none: 1,
  });
  await toggleTaskFilter(c, "status", "done");
  expect(await filterCounts(c, "priority")).toEqual({
    P0: 1,
    P1: 1,
    P2: 1,
    P3: 2,
    P4: 3,
    none: 2,
  });
  await toggleTaskFilter(c, "priority", "P4");
  expect(await filterCounts(c, "status")).toEqual({
    open: 5,
    in_progress: 2,
    done: 3,
  });
});

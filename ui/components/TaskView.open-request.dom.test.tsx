import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const first = {
  id: "11111111",
  title: "First task",
  status: "open",
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
} as TaskItem;
const second = {
  ...first,
  id: "22222222",
  title: "Second task",
  status: "done",
  roomId: "r2",
} as TaskItem;

it("routes a new chip request through the open panel's discard flow", async () => {
  const state = {
    ...initialState,
    tasks: [first, second],
    tasksLoaded: true,
    currentRoomId: "r1",
    rooms: [
      { id: "r1", name: "One" },
      { id: "r2", name: "Two" },
    ],
  } as unknown as typeof initialState;
  let requestTask!: (request: { id: string } | null) => void;
  function Harness() {
    const [request, setRequest] = useState<{ id: string } | null>(null);
    requestTask = setRequest;
    return (
      <TaskView
        onClose={() => {}}
        openTaskRequest={request}
        onTaskOpenRequestHandled={() => setRequest(null)}
      />
    );
  }
  const view = render(
    <StateCtx.Provider value={state}>
      <Harness />
    </StateCtx.Provider>,
  );
  await act(async () => requestTask({ id: first.id }));
  const title = await view.findByDisplayValue(first.title);
  fireEvent.change(title, { target: { value: "Unsaved edit" } });
  await act(async () => requestTask({ id: second.id }));
  expect(await view.findByText("Discard unsaved changes?")).toBeDefined();
  expect(view.getByDisplayValue("Unsaved edit")).toBeDefined();

  await act(async () => fireEvent.click(view.getByText("Discard")));
  expect(await view.findByDisplayValue(second.title)).toBeDefined();
  const scope = view.container.querySelector(
    'select:has(option[value="global"])',
  ) as HTMLSelectElement;
  const status = view.container.querySelector(
    'select:has(option[value="active"])',
  ) as HTMLSelectElement;
  expect(scope.value).toBe("r2");
  expect(status.value).toBe("all");

  await act(async () => fireEvent.click(view.getByText("×")));
  expect(view.queryByDisplayValue(second.title) === null).toBe(true);
  await act(async () => requestTask({ id: second.id }));
  expect(await view.findByDisplayValue(second.title)).toBeDefined();
});

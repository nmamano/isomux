// A task an agent below Standard filed (TaskItem.limited, task e77304b1) is
// marked in the board row and in the detail, with a title that says why:
// its text can come from strangers.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

afterEach(() => setApiShim(async () => ({})));
afterAll(() => setApiShim(null));

const limited = {
  id: "11111111",
  title: "Reply to the vendor",
  status: "open",
  priority: "P2",
  createdBy: "Email Triage",
  createdAt: 1,
  roomId: "r1",
  version: "v1",
  limited: true,
} as TaskItem;
const plain = {
  ...limited,
  id: "22222222",
  title: "A plain task",
  limited: undefined,
} as TaskItem;

function mount() {
  setApiShim(async (method, path) => {
    if (method === "GET" && path === `/api/tasks/${limited.id}`) return limited;
    if (method === "GET" && path === `/api/tasks/${plain.id}`) return plain;
    return {};
  });
  const state = {
    ...initialState,
    tasks: [limited, plain],
    tasksLoaded: true,
    currentRoomId: "r1",
    rooms: [{ id: "r1", name: "One" }],
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
  return { view, open: (id: string) => act(async () => requestTask({ id })) };
}

it("marks the row of a limited task only, with a title that explains it", () => {
  const { view } = mount();
  const chips = [...view.container.querySelectorAll("[data-limited-task]")];
  expect(chips).toHaveLength(1);
  expect(chips[0].closest("tr")!.textContent).toContain(limited.title);
  expect((chips[0].getAttribute("title") ?? "").length).toBeGreaterThan(0);
  view.unmount();
});

// The detail opens beside the board, so the board's one chip stays: the
// detail adds a second only for the limited task.
it("marks the detail of a limited task only", async () => {
  const chips: Record<string, number> = {};
  for (const task of [limited, plain]) {
    const { view, open } = mount();
    await open(task.id);
    await view.findByDisplayValue(task.title);
    await act(async () => {});
    chips[task.id] = view.container.querySelectorAll(
      "[data-limited-task]",
    ).length;
    view.unmount();
  }
  expect(chips).toEqual({ [limited.id]: 2, [plain.id]: 1 });
});

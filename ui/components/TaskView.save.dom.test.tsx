// The board's side of tasks 4243ecc0 (versioned edits) and 77460aea (backlog
// is priority P4).
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { toggleTaskFilter } = await import("../test-support/task-filters.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

afterEach(() => setApiShim(null));

const base = {
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
};
const editable = {
  ...base,
  id: "11111111",
  title: "Editable task",
  status: "open",
  version: "v-editable",
} as TaskItem;
const shelved = {
  ...base,
  id: "22222222",
  title: "Shelved task",
  status: "open",
  priority: "P4",
  version: "v-shelved",
} as TaskItem;
const startedP4 = {
  ...base,
  id: "33333333",
  title: "Started P4 task",
  status: "in_progress",
  priority: "P4",
  version: "v-started",
} as TaskItem;

function mount() {
  const state = {
    ...initialState,
    tasks: [editable, shelved, startedP4],
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

async function editAndSave(view: ReturnType<typeof mount>["view"]) {
  const title = await view.findByDisplayValue(editable.title);
  fireEvent.change(title, { target: { value: "Edited" } });
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
}

it("an edit sends the version of the task it shows, and closes once saved", async () => {
  const sent: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "PATCH") sent.push(body);
    return {};
  });
  const { view, open } = mount();
  await open(editable.id);
  await editAndSave(view);
  expect(sent).toHaveLength(1);
  expect((sent[0] as { version?: string }).version).toBe(editable.version);
  expect(view.queryByDisplayValue("Edited") === null).toBe(true);
  expect(view.queryByRole("alert") === null).toBe(true);
});

it("a 409 keeps the panel open with the edit and says the save did not land", async () => {
  setApiShim(async (method) => {
    if (method === "PATCH") {
      throw new ApiError(409, "version_conflict", "stale");
    }
    return {};
  });
  const { view, open } = mount();
  await open(editable.id);
  await editAndSave(view);
  expect(view.getByDisplayValue("Edited")).toBeDefined();
  expect(view.getByRole("alert")).toBeDefined();
});

it("P4 replaces backlog: a priority option, no status option, and a board filter", async () => {
  setApiShim(async () => ({}));
  const { view, open } = mount();
  // The default view leaves P4 unchecked, so it hides open and started P4 tasks.
  expect(view.queryByText(shelved.title) === null).toBe(true);
  expect(view.queryByText(startedP4.title) === null).toBe(true);
  expect(view.getByText(editable.title)).toBeDefined();
  await toggleTaskFilter(view.container, "priority", "P4");
  expect(view.getByText(shelved.title)).toBeDefined();
  expect(view.getByText(startedP4.title)).toBeDefined();

  await open(shelved.id);
  await view.findByDisplayValue(shelved.title);
  const priority = view.container.querySelector(
    'select:has(option[value="P0"])',
  ) as HTMLSelectElement;
  expect(priority.value).toBe("P4");
  const status = view.container.querySelector(
    'select:has(option[value="in_progress"])',
  ) as HTMLSelectElement;
  expect(status.querySelector('option[value="backlog"]')).toBeNull();
});

// A save in flight belongs to the task it was sent for. The user can select
// another task before the response arrives; the late response must not close
// that task's panel or flag it.
function deferredPatch(outcome: "ok" | "conflict") {
  let finish!: () => void;
  setApiShim(async (method) => {
    if (method !== "PATCH") return {};
    await new Promise<void>((r) => {
      finish = r;
    });
    if (outcome === "conflict") {
      throw new ApiError(409, "version_conflict", "stale");
    }
    return {};
  });
  // A macrotask after the release, so the whole rejection chain of the
  // conflict outcome settles inside act().
  return () =>
    act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 0));
    });
}

async function saveAThenEditB(
  view: ReturnType<typeof mount>["view"],
  open: ReturnType<typeof mount>["open"],
) {
  await open(editable.id);
  const title = await view.findByDisplayValue(editable.title);
  // Unchanged fields, so selecting B needs no discard prompt.
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
  await open(startedP4.id);
  fireEvent.change(view.getByDisplayValue(startedP4.title), {
    target: { value: "B unsaved draft" },
  });
}

for (const outcome of ["ok", "conflict"] as const) {
  it(`a late ${outcome} response for A leaves B's panel and draft alone`, async () => {
    const finish = deferredPatch(outcome);
    const { view, open } = mount();
    await saveAThenEditB(view, open);
    expect(view.getByDisplayValue("B unsaved draft")).toBeDefined();
    await finish();
    expect(view.getByDisplayValue("B unsaved draft")).toBeDefined();
    expect(view.queryByRole("alert") === null).toBe(true);
  });
}

it("the form is inert while its save is in flight", async () => {
  const finish = deferredPatch("ok");
  const { view, open } = mount();
  await open(editable.id);
  const title = await view.findByDisplayValue(editable.title);
  expect(title.closest("[inert]")).toBeNull();
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
  expect(title.closest("[inert]")).not.toBeNull();
  await finish();
  // Saved: the panel closed.
  expect(view.queryByDisplayValue(editable.title) === null).toBe(true);
});

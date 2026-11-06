// The detail panel's side of tasks 4243ecc0 (versioned edits), 77460aea
// (backlog is priority P4) and 3b749d1f (a failed save keeps the edits).
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
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

const assigned = {
  ...base,
  id: "44444444",
  title: "Assigned task",
  status: "in_progress",
  assignee: "Worker",
  version: "v-assigned",
} as TaskItem;

function mount() {
  const state = {
    ...initialState,
    tasks: [editable, shelved, startedP4, assigned],
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

const statusSelect = (view: ReturnType<typeof mount>["view"]) =>
  view.container.querySelector(
    'select:has(option[value="in_progress"])',
  ) as HTMLSelectElement;

async function editAndSave(view: ReturnType<typeof mount>["view"]) {
  const title = await view.findByDisplayValue(editable.title);
  fireEvent.change(title, { target: { value: "Edited" } });
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
}

it("an edit sends the version of the task it shows and the chosen status, and closes once saved", async () => {
  const sent: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "PATCH") sent.push(body);
    return {};
  });
  const { view, open } = mount();
  await open(editable.id);
  await view.findByDisplayValue(editable.title);
  fireEvent.change(statusSelect(view), { target: { value: "obsolete" } });
  await editAndSave(view);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    version: editable.version,
    status: "obsolete",
  });
  expect(view.queryByDisplayValue("Edited") === null).toBe(true);
  expect(view.queryByRole("alert") === null).toBe(true);
});

// The assignee goes in the body only when the user changed it (task 83f71be9):
// an echo would re-stamp the agent id the server keeps for the name, and a
// cleared field must reach the server as a clear, not vanish from the JSON.
it("an edit sends the assignee only when it changed, and null when cleared", async () => {
  const sent: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "PATCH") sent.push(JSON.parse(JSON.stringify(body)));
    return {};
  });
  const { view, open } = mount();
  await open(assigned.id);
  const title = await view.findByDisplayValue(assigned.title);
  fireEvent.change(title, { target: { value: "Retitled" } });
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
  expect(sent).toHaveLength(1);
  expect((sent[0] as { title?: string }).title).toBe("Retitled");
  expect(sent[0]).not.toHaveProperty("assignee");

  await open(assigned.id);
  const again = await view.findByDisplayValue(assigned.title);
  fireEvent.change(view.getByDisplayValue("Worker"), {
    target: { value: "  " },
  });
  await act(async () => fireEvent.keyDown(again, { key: "Enter" }));
  expect(sent).toHaveLength(2);
  expect((sent[1] as { assignee?: unknown }).assignee).toBeNull();
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

// Any failure keeps the panel open with the edit and an error line, not only a
// 409 (task 3b749d1f). The server's message is shown as it came; a failure with
// no server answer (apiFetch rejects with a TypeError on a network drop) gets
// the generic line, never the raw exception text.
it("a server error keeps the panel open with the edit and shows the server's message", async () => {
  setApiShim(async (method) => {
    if (method === "PATCH") throw new ApiError(500, "internal", "disk full");
    return {};
  });
  const { view, open } = mount();
  await open(editable.id);
  await editAndSave(view);
  expect(view.getByDisplayValue("Edited")).toBeDefined();
  expect(view.getByRole("alert").textContent).toContain("disk full");
});

it("a network failure keeps the panel open with the edit and shows an error", async () => {
  setApiShim(async (method) => {
    if (method === "PATCH") throw new TypeError("net::ERR_RAW_DETAIL");
    return {};
  });
  const { view, open } = mount();
  await open(editable.id);
  await editAndSave(view);
  expect(view.getByDisplayValue("Edited")).toBeDefined();
  const alert = view.getByRole("alert").textContent ?? "";
  expect(alert.trim().length > 0).toBe(true);
  expect(alert).not.toContain("ERR_RAW_DETAIL");
});

// The create panel waits for its POST like an edit (task 3b749d1f): a failure
// keeps the typed title and says so, the form takes no second submit while the
// POST is in flight, and a save that lands closes the panel.
it("a failed create keeps the panel open with the title, and a retry that lands closes it", async () => {
  const posts: unknown[] = [];
  let fail = true;
  let release!: () => void;
  setApiShim(async (method) => {
    if (method !== "POST") return {};
    posts.push(method);
    if (!fail) return {};
    await new Promise<void>((r) => {
      release = r;
    });
    throw new ApiError(500, "internal", "disk full");
  });
  const { view } = mount();
  const quick = view.getByPlaceholderText(en["tasks.quickAdd"]);
  fireEvent.change(quick, { target: { value: "New task title" } });
  await act(async () => fireEvent.keyDown(quick, { key: "Enter" }));
  const title = await view.findByDisplayValue("New task title");
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
  expect(title.closest("[inert]")).not.toBeNull();
  await act(async () => fireEvent.keyDown(title, { key: "Enter" }));
  expect(posts).toHaveLength(1);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(view.getByDisplayValue("New task title")).toBeDefined();
  expect(view.getByRole("alert").textContent).toContain("disk full");

  fail = false;
  await act(async () =>
    fireEvent.keyDown(view.getByDisplayValue("New task title"), {
      key: "Enter",
    }),
  );
  expect(posts).toHaveLength(2);
  expect(view.queryByDisplayValue("New task title") === null).toBe(true);
  expect(view.queryByRole("alert") === null).toBe(true);
});

// Backlog is priority P4, not a status (task 77460aea). The board filter's
// side is in TaskView.filters.dom.test.tsx.
it("the detail panel offers P4 as a priority and only the four statuses", async () => {
  setApiShim(async () => ({}));
  const { view, open } = mount();
  await open(shelved.id);
  await view.findByDisplayValue(shelved.title);
  const priority = view.container.querySelector(
    'select:has(option[value="P0"])',
  ) as HTMLSelectElement;
  expect(priority.value).toBe("P4");
  expect([...statusSelect(view).options].map((o) => o.value)).toStrictEqual([
    "open",
    "in_progress",
    "done",
    "obsolete",
  ]);
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

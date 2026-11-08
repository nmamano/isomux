// The summary task board in the Tasks view (task 9ebe887d), through the real
// store: the socket's tasks frame holds the open and in-progress tasks
// without descriptions, and the view reads the rest over GET /api/tasks -
// the descriptions once when it opens, the closed tasks once a closed status
// is checked or a search is typed, and a linked task the store lacks by id.
// The fetch state is per tasks frame (epoch), outside the component.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { FeaturesProvider, StoreProvider } = await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { ApiError, setApiShim } = await import("../api.ts");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { TaskLookupBridge, resetTaskLookupForTests } =
  await import("../task-lookup.ts");
const { toggleCheckboxFilter, openCheckboxFilter } =
  await import("../test-support/checkbox-filters.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

const { t } = translatorFor("en");

const task = (id: string, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  title: `Title ${id}`,
  description: `About ${id}`,
  status: "open",
  createdBy: "Nil",
  username: "Nil",
  createdAt: Number.parseInt(id, 16),
  version: `v-${id}`,
  ...extra,
});
const stripped = (row: TaskItem): TaskItem => {
  const { description: _description, ...rest } = row;
  return rest;
};

// The server's board, and every GET /api/tasks the view sent, in order.
let board: TaskItem[] = [];
type TaskGet = { ids: string[] | null; statuses: string[] | null };
const taskGets: TaskGet[] = [];
// The answer to one GET; the board, filtered as the server filters it,
// unless a test sets its own.
type Answer = (get: TaskGet) => Promise<TaskItem[]>;
const fromBoard: Answer = async (get) =>
  board.filter(
    (row) =>
      (get.ids === null || get.ids.includes(row.id)) &&
      (get.statuses === null || get.statuses.includes(row.status)),
  );
let answer: Answer = fromBoard;

setApiShim(async (method, path) => {
  const url = new URL(path, "http://office.test");
  if (method === "GET" && url.pathname === "/api/tasks") {
    const list = (name: string) => {
      const value = url.searchParams.get(name);
      return value === null ? null : value.split(",").filter(Boolean);
    };
    const get = { ids: list("ids"), statuses: list("status") };
    taskGets.push(get);
    return answer(get);
  }
  return {};
});

// Put the WS and API shims back for the next file.
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

beforeEach(() => {
  resetTaskLookupForTests();
  board = [];
  taskGets.length = 0;
  answer = fromBoard;
  window.localStorage.clear();
});

const closedGets = () =>
  taskGets.filter(
    (g) =>
      g.ids === null &&
      g.statuses !== null &&
      [...g.statuses].sort().join() === "done,obsolete",
  );

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

// A summary frame of the board's open and in-progress rows, as the server
// sends it to a socket that asked for the summary board.
function emitSummaryFrame() {
  shimEmit({
    type: "tasks",
    tasks: board
      .filter((row) => row.status === "open" || row.status === "in_progress")
      .map(stripped),
    summary: true,
  });
}

// The real store on the WS shim, the lookup bridge, and the Tasks view,
// which the test can unmount and mount again, and ask to open a task.
async function boot() {
  let setShown!: (shown: boolean) => void;
  let requestTask!: (request: { id: string } | null) => void;
  function Tasks() {
    const [shown, setShownState] = useState(true);
    const [request, setRequest] = useState<{ id: string } | null>(null);
    setShown = setShownState;
    requestTask = setRequest;
    return shown
      ? createElement(TaskView, {
          onClose: () => {},
          openTaskRequest: request,
          onTaskOpenRequestHandled: () => setRequest(null),
        })
      : null;
  }
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => {
    hydrated = resolve;
  });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "Nil", userId: "u1", role: "owner" },
      } as never);
      emitSummaryFrame();
      hydrated();
    },
  );
  const view = render(
    createElement(FeaturesProvider, {
      features: PRODUCTION_FEATURES,
      children: createElement(
        StoreProvider,
        null,
        createElement(TaskLookupBridge),
        createElement(Tasks),
      ),
    }),
  );
  await act(async () => {
    await hydration;
  });
  await settle();
  return {
    view,
    remount: async () => {
      await act(async () => setShown(false));
      await act(async () => setShown(true));
      await settle();
    },
    open: async (id: string) => {
      await act(async () => requestTask({ id }));
      await settle();
    },
  };
}

const text = (view: ReturnType<typeof render>) =>
  view.container.textContent ?? "";
// The description fields a member could type into now.
const editableTextareas = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("textarea")].filter(
    (area) => !area.readOnly && !area.disabled,
  );
async function openRow(view: ReturnType<typeof render>, title: string) {
  await act(async () => fireEvent.click(view.getByText(title)));
  await settle();
}
const digitsOf = (value: string) => (value.match(/\d+/g) ?? []).join(",");
// The text of one status checkbox's row: its label and, when known, count.
async function statusRowText(
  view: ReturnType<typeof render>,
  status: string,
): Promise<string> {
  await openCheckboxFilter(view.container, "status");
  const box = view.container.querySelector<HTMLInputElement>(
    `[data-checkbox-filter="status"] input[type="checkbox"][value="${status}"]`,
  );
  return box!.closest("label")!.textContent ?? "";
}

it("opens with titles at once and reads the descriptions once, by id; a remount in the same frame reads nothing again", async () => {
  board = [
    task("0000000a"),
    task("0000000b", { status: "in_progress" }),
    task("0000000c", { status: "done" }),
  ];
  const { view, remount } = await boot();
  expect(text(view)).toContain("Title 0000000a");
  expect(taskGets).toHaveLength(1);
  // 100 summary rows or fewer: their ids, no status list.
  expect([...taskGets[0].ids!].sort()).toEqual(["0000000a", "0000000b"]);
  expect(taskGets[0].statuses).toBeNull();
  expect(text(view)).toContain("About 0000000a");
  expect(text(view)).toContain("About 0000000b");

  await remount();
  expect(text(view)).toContain("About 0000000a");
  expect(taskGets).toHaveLength(1);
});

it("reads more than 100 summary rows' descriptions as one open and in-progress list", async () => {
  board = Array.from({ length: 101 }, (_, i) =>
    task((i + 1).toString(16).padStart(8, "0")),
  );
  await boot();
  expect(taskGets).toHaveLength(1);
  expect(taskGets[0].ids).toBeNull();
  expect([...taskGets[0].statuses!].sort()).toEqual(["in_progress", "open"]);
});

it("after a failed read, the panel of a summary row offers no empty description to edit, and the next mount reads again", async () => {
  board = [task("0000000a")];
  let fail = true;
  answer = async (get) => {
    if (fail) throw new ApiError(503, "unavailable", "Try again.");
    return fromBoard(get);
  };
  const { view, remount } = await boot();
  // Enabling condition: the one read failed, and nothing retried on its own.
  expect(taskGets).toHaveLength(1);
  await settle();
  expect(taskGets).toHaveLength(1);

  await openRow(view, "Title 0000000a");
  // The panel is open (its title field shows the task) ...
  expect(view.getByDisplayValue("Title 0000000a")).toBeDefined();
  // ... but its description is not a blank field a save could start from.
  expect(editableTextareas(view)).toHaveLength(0);

  fail = false;
  await remount();
  expect(taskGets).toHaveLength(2);
  await openRow(view, "Title 0000000a");
  const fields = editableTextareas(view);
  expect(fields).toHaveLength(1);
  expect(fields[0].value).toBe("About 0000000a");
});

it("reads the closed tasks once when Done is checked, not again for a search; until then Done shows no count and the list no closed row", async () => {
  board = [
    task("0000000a"),
    task("0000000d", { status: "done" }),
    task("0000000e", { status: "done" }),
    task("0000000f", { status: "obsolete" }),
  ];
  let release!: () => void;
  const { view } = await boot();
  expect(closedGets()).toHaveLength(0);

  // A closed task the store holds from a chip lookup, before any closed read.
  const { lookUpTaskIds } = await import("../task-lookup.ts");
  await act(async () => lookUpTaskIds(["0000000d"]));
  await settle();
  // Enabling condition: the lookup read it.
  expect(taskGets.some((g) => g.ids?.includes("0000000d"))).toBe(true);
  expect(await statusRowText(view, "done")).not.toMatch(/\d/);

  answer = (get) =>
    get.statuses?.includes("done")
      ? new Promise((resolve) => {
          release = () => void fromBoard(get).then(resolve);
        })
      : fromBoard(get);
  await toggleCheckboxFilter(view.container, "status", "done");
  await settle();
  expect(closedGets()).toHaveLength(1);
  // In flight: the chip's row does not stand in for the closed tasks.
  expect(text(view)).not.toContain("Title 0000000d");
  expect(await statusRowText(view, "done")).not.toMatch(/\d/);

  await act(async () => release());
  await settle();
  expect(text(view)).toContain("Title 0000000d");
  expect(text(view)).toContain("Title 0000000e");
  expect(digitsOf(await statusRowText(view, "done"))).toBe("2");

  const search = view.getByPlaceholderText(t("tasks.searchPlaceholder"));
  await act(async () => fireEvent.change(search, { target: { value: "0" } }));
  await settle();
  expect(closedGets()).toHaveLength(1);
});

it("a search reads the closed tasks once, and finds a closed task by its description", async () => {
  board = [
    task("0000000a"),
    task("0000000d", { status: "done", description: "the needle" }),
  ];
  const { view } = await boot();
  const search = view.getByPlaceholderText(t("tasks.searchPlaceholder"));
  await act(async () => fireEvent.change(search, { target: { value: "nee" } }));
  await settle();
  await act(async () =>
    fireEvent.change(search, { target: { value: "needle" } }),
  );
  await settle();
  expect(closedGets()).toHaveLength(1);
  // Done is not checked, so the found task's row is not listed; the read
  // is what search covers once the member checks it.
  await toggleCheckboxFilter(view.container, "status", "done");
  await settle();
  expect(text(view)).toContain("Title 0000000d");
  expect(closedGets()).toHaveLength(1);
});

it("a link to a closed task the store lacks reads it by id and opens it", async () => {
  board = [task("0000000a"), task("0000000d", { status: "done" })];
  const { view, open } = await boot();
  await open("0000000d");
  expect(taskGets.some((g) => g.ids?.join() === "0000000d")).toBe(true);
  expect(view.getByDisplayValue("Title 0000000d")).toBeDefined();
  // The link checks Done to list the task, and Done lists every closed task.
  expect(closedGets()).toHaveLength(1);
});

it("a new tasks frame reads the closed tasks again while Done stays checked, and no description that did not change", async () => {
  board = [task("0000000a"), task("0000000d", { status: "done" })];
  const { view } = await boot();
  await toggleCheckboxFilter(view.container, "status", "done");
  await settle();
  expect(closedGets()).toHaveLength(1);
  const descriptionReads = taskGets.filter((g) => g.ids !== null).length;
  expect(descriptionReads).toBe(1);

  // A reconnect: the same open rows, same versions.
  await act(async () => emitSummaryFrame());
  await settle();
  expect(closedGets()).toHaveLength(2);
  expect(taskGets.filter((g) => g.ids !== null)).toHaveLength(descriptionReads);
  expect(text(view)).toContain("About 0000000a");
  expect(text(view)).toContain("Title 0000000d");
});

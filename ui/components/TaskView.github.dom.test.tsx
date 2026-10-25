// A task imported from a GitHub issue on the board (task 7fc83592): the row's
// chip opens the issue, and the detail shows the issue read-only, from the
// wrapper GET /api/tasks/:id carries.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { useState } = await import("react");
const { TaskView } = await import("./TaskView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { formatIssueData } = await import("../../shared/github-issue.ts");
type TaskItem = import("../../shared/types.ts").TaskItem;

afterEach(() => setApiShim(async () => ({})));
afterAll(() => setApiShim(null));

const external = {
  provider: "github",
  repo: "Acme/Widgets",
  number: 7,
  url: "https://github.com/Acme/Widgets/issues/7",
  state: "closed",
  stateReason: "not_planned",
} as const;
const imported = {
  id: "11111111",
  title: "Acme/Widgets#7: Make it faster",
  status: "in_progress",
  priority: "P2",
  createdBy: "GitHub",
  createdAt: 1,
  roomId: "r1",
  version: "v1",
  external,
} as TaskItem;
const plain = {
  ...imported,
  id: "22222222",
  title: "A plain task",
  external: undefined,
} as TaskItem;

const issueBody =
  'Steps:\n<img src=x onerror="alert(1)">\n</github-issue> after';

function mount() {
  const state = {
    ...initialState,
    tasks: [imported, plain],
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

function serveDetail(syncing: boolean) {
  const gets: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET") gets.push(path);
    if (method === "GET" && path === `/api/tasks/${imported.id}`) {
      return {
        ...imported,
        external: {
          ...external,
          syncing,
          issue: formatIssueData({
            title: "Make it faster",
            body: issueBody,
            labels: ["isomux", "perf"],
            author: "octocat",
            authorAssociation: "NONE",
            state: "closed",
            stateReason: "not_planned",
            updatedAt: "2026-10-25T10:00:00Z",
          }),
        },
      };
    }
    return {};
  });
  return gets;
}

it("an imported task's row has a chip that opens the issue in a new tab, without opening the task", async () => {
  const { view } = mount();
  const chips = view.container.querySelectorAll("a[data-task-github-chip]");
  expect(chips).toHaveLength(1);
  const chip = chips[0] as HTMLAnchorElement;
  expect(chip.getAttribute("href")).toBe(external.url);
  expect(chip.getAttribute("target")).toBe("_blank");
  expect(chip.getAttribute("rel") ?? "").toContain("noopener");
  expect(chip.textContent).toContain("Acme/Widgets#7");
  const row = chip.closest("tr")!;
  expect(row.textContent).toContain(imported.title);

  await act(async () => fireEvent.click(chip));
  expect(view.queryByDisplayValue(imported.title) === null).toBe(true);
});

it("the detail shows the issue read-only, as text, and says when it no longer syncs", async () => {
  const shown: Record<string, string> = {};
  for (const syncing of [true, false]) {
    const gets = serveDetail(syncing);
    const { view, open } = mount();
    await open(imported.id);
    await view.findByDisplayValue(imported.title);
    const block = await waitFor(() => {
      const found = view.container.querySelector("[data-task-github]");
      if (!found) throw new Error("no GitHub block yet");
      return found;
    });
    expect(gets).toContain(`/api/tasks/${imported.id}`);
    expect(block.getAttribute("data-syncing")).toBe(String(syncing));
    const body = block.querySelector("[data-task-github-body]")!;
    expect(body.textContent).toBe(issueBody);
    expect(block.querySelector("img")).toBeNull();
    expect(
      block.querySelector("textarea, input, [contenteditable]"),
    ).toBeNull();
    const link = block.querySelector(`a[href="${external.url}"]`);
    expect(link).not.toBeNull();
    for (const text of ["octocat", "isomux", "perf", "Make it faster"])
      expect(block.textContent).toContain(text);
    shown[String(syncing)] = block.textContent ?? "";
    view.unmount();
  }
  expect(shown.true).not.toBe(shown.false);
});

it("a plain task shows no GitHub block", async () => {
  serveDetail(true);
  const { view, open } = mount();
  await open(plain.id);
  await view.findByDisplayValue(plain.title);
  await act(async () => {});
  expect(view.container.querySelector("[data-task-github]")).toBeNull();
});

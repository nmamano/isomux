// Task 44872c41: a follow-up the member sends into a cronjob run never
// disappears before the server accepts it. The run composer uses the same
// outbox as agent chat: a failed attempt stays above the composer with Resend /
// Edit / Discard, and Resend reuses the attempt id.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { CronjobRunView } = await import("./CronjobRunView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { _resetOutboxForTests } = await import("../log-view/outbox.ts");
type CronjobRun = import("../../shared/types.ts").CronjobRun;

const run = {
  id: "run1",
  cronjobId: "job/1",
  cronjobName: "Nightly",
  trigger: "manual",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  errorReason: null,
  promptSnapshot: "p",
  agentTypeSnapshot: "claude",
  modelFamilySnapshot: "opus",
  effortSnapshot: "medium",
  cwdSnapshot: "~",
  permissionModeSnapshot: "bypassPermissions",
  rootSessionId: "sess-1",
  previewText: "",
} as unknown as CronjobRun;

interface Post {
  path: string;
  text: string;
  clientMessageId: string;
}
let posts: Post[] = [];
let answer: () => Promise<unknown> = async () => ({});

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});
beforeEach(() => {
  _resetOutboxForTests();
  posts = [];
  answer = async () => ({});
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/messages")) {
      posts.push({ path, ...(body as Omit<Post, "path">) });
      return answer();
    }
    return { run, entries: [] };
  });
});

function Page() {
  const state = useAppState();
  return (
    <StateCtx.Provider
      value={{
        ...state,
        cronjobRunsByJob: new Map([[run.cronjobId, [run]]]),
      }}
    >
      <CronjobRunView jobId={run.cronjobId} runId={run.id} onClose={() => {}} />
    </StateCtx.Provider>
  );
}

function mount() {
  return render(
    <StoreProvider>
      <Page />
    </StoreProvider>,
  );
}

const composer = (c: HTMLElement) => c.querySelector("textarea")!;
const rows = (c: HTMLElement, status: "pending" | "failed") => [
  ...c.querySelectorAll<HTMLElement>(`[data-outbox-attempt="${status}"]`),
];
const action = (row: HTMLElement, name: string) =>
  row.querySelector<HTMLButtonElement>(`[data-outbox-action="${name}"]`)!;

async function sendText(c: HTMLElement, text: string) {
  fireEvent.change(composer(c), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(composer(c), { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("posts to the run's messages route with a clientMessageId and drops the row on the ack", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve({})));
  const view = mount();
  await sendText(view.container, "follow up");

  expect(composer(view.container).value).toBe("");
  expect(rows(view.container, "pending").length).toBe(1);
  expect(posts[0].path).toBe(
    `/api/cronjobs/${encodeURIComponent(run.cronjobId)}/runs/run1/messages`,
  );
  expect(posts[0].text).toBe("follow up");
  expect(posts[0].clientMessageId).toBeTruthy();

  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    expect(view.container.querySelector("[data-outbox-attempt]")).toBeNull(),
  );
  view.unmount();
});

it("keeps a network failure as a not-sent row, and Resend reuses the attempt id", async () => {
  answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await sendText(view.container, "careful follow up");

  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));
  expect(composer(view.container).value).toBe("");
  const failed = rows(view.container, "failed")[0];
  expect(failed.textContent).toContain("careful follow up");

  answer = async () => ({});
  await act(async () => {
    fireEvent.click(action(failed, "resend"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    expect(view.container.querySelector("[data-outbox-attempt]")).toBeNull(),
  );
  expect(posts.length).toBe(2);
  expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
  expect(posts[1].text).toBe("careful follow up");
  view.unmount();
});

it("shows the server's refusal reason, and Edit puts the text back in the composer", async () => {
  answer = async () => {
    throw new ApiError(409, "run_busy", "server-reason-409");
  };
  const view = mount();
  await sendText(view.container, "too soon");

  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));
  const failed = rows(view.container, "failed")[0];
  expect(failed.textContent).toContain("server-reason-409");

  await act(async () => {
    fireEvent.click(action(failed, "edit"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rows(view.container, "failed").length).toBe(0);
  expect(composer(view.container).value).toBe("too soon");
  expect(posts.length).toBe(1);
  view.unmount();
});

it("Discard drops a not-sent row without sending", async () => {
  answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await sendText(view.container, "never mind");
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));

  await act(async () => {
    fireEvent.click(action(rows(view.container, "failed")[0], "discard"));
  });
  expect(view.container.querySelector("[data-outbox-attempt]")).toBeNull();
  expect(posts.length).toBe(1);
  view.unmount();
});

// Losing detail access to a cronjob (an owner demoted, a job deleted) closes
// every open view of its private parts - the run transcript, the edit dialog,
// the run filter - and a transcript fetch still in flight when the view closes
// seeds nothing.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { DispatchCtx } = await import("../store.tsx");
const { onLanguage, stateWithSelfUser } = await import(
  "../test-support/language-fixture.tsx"
);
type AppState = import("../store.tsx").AppState;
type Action = Parameters<typeof import("../store.tsx").reducer>[1];
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type CronjobRun = import("../../shared/types.ts").CronjobRun;

const JOB_PROMPT = "JOB_PROMPT_MARKER";
const RUN_PROMPT = "RUN_PROMPT_MARKER";

const detailJob = {
  id: "job00001",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  prompt: JOB_PROMPT,
  cwd: "/private/dir",
  agentType: "claude",
  modelFamily: "opus",
  effort: "medium",
  permissionMode: "bypassPermissions",
  enabled: true,
  createdBy: "Tester",
  userId: "u1",
  username: "Tester",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: Date.now() + 60_000,
  detail: true,
  canManage: true,
} as unknown as CronjobListWire;

const viewerJob = {
  id: "job00001",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  enabled: true,
  agentType: "claude",
  createdBy: "Tester",
  userId: "u2",
  username: "Tester",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: Date.now() + 60_000,
  lastRun: null,
  detail: false,
  canManage: false,
} as unknown as CronjobListWire;

const run = {
  id: "run00001",
  cronjobId: "job00001",
  cronjobName: "Nightly",
  trigger: "scheduled",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  errorReason: null,
  promptSnapshot: RUN_PROMPT,
  agentTypeSnapshot: "claude",
  modelFamilySnapshot: "opus",
  effortSnapshot: "medium",
  cwdSnapshot: "/private/dir",
  permissionModeSnapshot: "bypassPermissions",
  rootSessionId: "s1",
  currentSessionId: "s1",
  previewText: "",
} as unknown as CronjobRun;

// The transcript fetch stays pending until a test answers it.
let answerTranscript: (() => void) | null = null;
let transcriptGets = 0;
// The all-runs fetch stays pending too, so a test can answer it late.
let answerRunList: (() => void) | null = null;
let runListGets = 0;
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs") {
    runListGets++;
    await new Promise<void>((resolve) => (answerRunList = resolve));
    return { jobs: [{ cronjobId: "job00001", runs: [run] }] };
  }
  if (method === "GET" && path === "/api/cronjobs/job00001/runs/run00001") {
    transcriptGets++;
    await new Promise<void>((resolve) => (answerTranscript = resolve));
    return {
      run,
      entries: [
        {
          id: "e1",
          agentId: "cronrun-run00001",
          timestamp: 1,
          kind: "text",
          content: "transcript",
        },
      ],
    };
  }
  if (method === "GET" && path === "/api/cronjobs/job00001/runs")
    return { runs: [run] };
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

let dispatched: Action[] = [];
beforeEach(() => {
  dispatched = [];
  answerTranscript = null;
  transcriptGets = 0;
  answerRunList = null;
  runListGets = 0;
  localStorage.clear();
});

function stateFor(
  over: Partial<AppState>,
  role: "owner" | "member" = "member",
): Partial<AppState> {
  const base = stateWithSelfUser("en");
  return {
    cronjobsLoaded: true,
    cronjobRunsLoaded: true,
    hydrationEpoch: 1,
    sessionContext: { ...base.sessionContext!, role },
    ...over,
  };
}

// One function for the whole file: a new dispatch identity per render would
// rerun every effect that lists it and hide what a test is measuring.
const recordDispatch = (action: Action) => void dispatched.push(action);

function tree(state: Partial<AppState>) {
  return (
    <DispatchCtx.Provider value={recordDispatch}>
      {onLanguage("en", <CronjobsView onClose={() => {}} />, state)}
    </DispatchCtx.Provider>
  );
}

const readable = stateFor({
  cronjobs: [detailJob],
  cronjobRunsByJob: new Map([["job00001", [run]]]),
});

async function openRun() {
  const view = render(tree(readable));
  await act(async () => {});
  const row = view.container.querySelector<HTMLElement>(
    'tr[data-cronjob-run-row="run00001"]',
  )!;
  await act(async () => row.click());
  expect(view.queryByText(RUN_PROMPT)).not.toBeNull();
  return view;
}

it("an open run view closes when the job becomes a room member's row, and its late transcript seeds nothing", async () => {
  const view = await openRun();
  expect(answerTranscript).not.toBeNull();
  view.rerender(
    tree(stateFor({ cronjobs: [viewerJob], cronjobRunsByJob: new Map() })),
  );
  await act(async () => {});
  expect(view.queryByText(RUN_PROMPT)).toBeNull();
  expect(view.container.textContent).not.toContain("/private/dir");
  await act(async () => answerTranscript!());
  expect(dispatched.map((a) => a.type)).not.toContain("log_entries_batch");
  // Access back does not reopen it.
  view.rerender(tree(readable));
  await act(async () => {});
  expect(view.queryByText(RUN_PROMPT)).toBeNull();
  view.unmount();
});

it("a deleted job's open run view closes for a member and stays for an office owner", async () => {
  const member = await openRun();
  member.rerender(
    tree(
      stateFor({
        cronjobs: [],
        cronjobRunsByJob: new Map([["job00001", [run]]]),
      }),
    ),
  );
  await act(async () => {});
  expect(member.queryByText(RUN_PROMPT)).toBeNull();
  member.unmount();

  const owner = render(tree({ ...readable, ...stateFor({}, "owner") }));
  await act(async () => {});
  await act(async () =>
    owner.container
      .querySelector<HTMLElement>('tr[data-cronjob-run-row="run00001"]')!
      .click(),
  );
  owner.rerender(
    tree(
      stateFor(
        {
          cronjobs: [],
          cronjobRunsByJob: new Map([["job00001", [run]]]),
        },
        "owner",
      ),
    ),
  );
  await act(async () => {});
  expect(owner.queryByText(RUN_PROMPT)).not.toBeNull();
  owner.unmount();
});

it("an owner's open run fetches its transcript again after the delete drops it, and the run list refetches", async () => {
  const ownerState = stateFor(
    { cronjobs: [detailJob], cronjobRunsByJob: new Map([["job00001", [run]]]) },
    "owner",
  );
  const view = render(tree(ownerState));
  await act(async () => {});
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('tr[data-cronjob-run-row="run00001"]')!
      .click(),
  );
  expect(transcriptGets).toBe(1);
  const listsBefore = runListGets;
  // The store's answer to cronjob_deleted: the job and its cached runs gone,
  // the seq bumped.
  view.rerender(
    tree(
      stateFor(
        {
          cronjobs: [],
          cronjobRunsByJob: new Map(),
          cronjobsStateSeq: (ownerState.cronjobsStateSeq ?? 0) + 1,
        },
        "owner",
      ),
    ),
  );
  await act(async () => {});
  expect(transcriptGets).toBe(2);
  expect(runListGets).toBe(listsBefore + 1);
  view.unmount();
});

it("a run-list answer that was already pending when access changed carries the old seq", async () => {
  const view = render(tree(readable));
  await act(async () => {});
  const startSeq = readable.cronjobsStateSeq ?? 0;
  expect(answerRunList).not.toBeNull();
  const pending = answerRunList!;
  view.rerender(
    tree(
      stateFor({
        cronjobs: [viewerJob],
        cronjobRunsByJob: new Map(),
        cronjobsStateSeq: startSeq + 1,
      }),
    ),
  );
  // Same number of jobs, new seq: the page asks again.
  expect(runListGets).toBe(2);
  await act(async () => pending());
  const loaded = dispatched.filter((a) => a.type === "cronjob_runs_loaded");
  expect(loaded.length).toBeGreaterThan(0);
  // The store drops an answer whose seq is not current (store.test.ts).
  expect(loaded.every((a) => "seq" in a && a.seq === startSeq)).toBe(true);
  view.unmount();
});

it("an open edit dialog closes when the job is no longer the viewer's to manage", async () => {
  const view = render(tree(readable));
  await act(async () => {});
  await act(async () => view.getByText("schedules").click());
  const row = view.container.querySelector<HTMLElement>(
    'tr[data-cronjob-row="job00001"]',
  )!;
  const edit = [...row.querySelectorAll("button")].find(
    (b) => b.textContent === "Edit",
  )!;
  await act(async () => edit.click());
  const promptShown = () =>
    [...view.container.ownerDocument.querySelectorAll("textarea")].some(
      (t) => t.value === JOB_PROMPT,
    );
  expect(promptShown()).toBe(true);
  view.rerender(
    tree(stateFor({ cronjobs: [viewerJob], cronjobRunsByJob: new Map() })),
  );
  await act(async () => {});
  expect(promptShown()).toBe(false);
  // The dialog's copy of the job is gone, not hidden: access back does not
  // bring it back.
  view.rerender(tree(readable));
  await act(async () => {});
  expect(promptShown()).toBe(false);
  view.unmount();
});

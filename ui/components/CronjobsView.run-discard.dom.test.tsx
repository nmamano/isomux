// Task d38f611f: Discard on a run follow-up that was not sent asks first
// (AGENTS.md "UI rules"). Escape on the armed Discard ends the confirm and
// nothing else: the Schedules page and the run view both close on Escape from
// a capture listener on window, which runs before the button sees the key.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { DispatchCtx } = await import("../store.tsx");
const { _resetOutboxForTests } = await import("../log-view/outbox.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
type AppState = import("../store.tsx").AppState;
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type CronjobRun = import("../../shared/types.ts").CronjobRun;

const RUN_PROMPT = "RUN_PROMPT_MARKER";

const job = {
  id: "job00001",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  prompt: "p",
  cwd: "~",
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
  canManage: true,
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
  cwdSnapshot: "~",
  permissionModeSnapshot: "bypassPermissions",
  rootSessionId: "s1",
  currentSessionId: "s1",
  previewText: "",
} as unknown as CronjobRun;

let posts = 0;
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
  posts = 0;
  setApiShim(async (method, path) => {
    if (method === "POST" && path.endsWith("/messages")) {
      posts++;
      throw new TypeError("Failed to fetch");
    }
    if (path === "/api/cron-runs")
      return { jobs: [{ cronjobId: job.id, runs: [run] }] };
    if (path === "/api/cronjobs/job00001/runs/run00001")
      return { run, entries: [] };
    return { runs: [run] };
  });
});

const state: Partial<AppState> = {
  cronjobsLoaded: true,
  cronjobRunsLoaded: true,
  hydrationEpoch: 1,
  sessionContext: stateWithSelfUser("en").sessionContext,
  cronjobs: [job],
  cronjobRunsByJob: new Map([[job.id, [run]]]),
};
const dispatch = () => {};

async function openRunWithFailedMessage() {
  const view = render(
    <DispatchCtx.Provider value={dispatch}>
      {onLanguage("en", <CronjobsView onClose={() => {}} />, state)}
    </DispatchCtx.Provider>,
  );
  await act(async () => {});
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('[data-schedules-tab="runs"]')!
      .click(),
  );
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('tr[data-cronjob-run-row="run00001"]')!
      .click(),
  );
  const composer = view.container.querySelector("textarea")!;
  fireEvent.change(composer, { target: { value: "follow up" } });
  await act(async () => {
    fireEvent.keyDown(composer, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    expect(
      view.container.querySelectorAll('[data-outbox-attempt="failed"]').length,
    ).toBe(1),
  );
  return view;
}

const discardButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(
    '[data-outbox-attempt="failed"] [data-outbox-action="discard"]',
  );

it("Escape on an armed Discard ends the confirm and keeps the run view open; two clicks drop the message", async () => {
  const view = await openRunWithFailedMessage();
  // Enabling condition: the run view is open, with a not-sent row.
  expect(view.queryByText(RUN_PROMPT)).not.toBeNull();

  await act(async () => fireEvent.click(discardButton(view.container)!));
  // Armed, not run: the row stays.
  expect(discardButton(view.container) !== null).toBe(true);
  expect(
    discardButton(view.container)!.hasAttribute("data-confirm-armed"),
  ).toBe(true);
  // The armed control holds the focus, so the key starts there and passes
  // window's capture listeners on the way down.
  expect(document.activeElement?.getAttribute("data-outbox-action")).toBe(
    "discard",
  );

  await act(async () =>
    fireEvent.keyDown(discardButton(view.container)!, { key: "Escape" }),
  );
  expect(view.queryByText(RUN_PROMPT)).not.toBeNull();
  expect(
    discardButton(view.container)!.hasAttribute("data-confirm-armed"),
  ).toBe(false);

  // Not armed, Escape closes the run view as before.
  await act(async () => fireEvent.click(discardButton(view.container)!));
  await act(async () => fireEvent.click(discardButton(view.container)!));
  expect(view.container.querySelector("[data-outbox-attempt]")).toBeNull();
  expect(posts).toBe(1);
  await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
  expect(view.queryByText(RUN_PROMPT)).toBeNull();
  view.unmount();
});

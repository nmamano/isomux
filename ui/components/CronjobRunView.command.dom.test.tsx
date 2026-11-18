// The run view of a command job's run (task ab6851f2): a loud run shows how
// the command ended and its output; a quiet run shows it ended with no
// output; neither has a composer.
//
// Hooks: [data-command-exit] (how it ended), [data-command-output] (the
// output tail).

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { CronjobRunView } = await import("./CronjobRunView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { expectValueAsData } = await import("../test-support/data-value.ts");
const { en } = await import("../../shared/i18n/en.ts");
type CronjobRun = import("../../shared/types.ts").CronjobRun;
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;

const OUTPUT = "lint: 2 findings\nserver/x.ts:12 unused import";

function commandRun(over: Partial<CronjobRun>): CronjobRun {
  return {
    id: "run1",
    cronjobId: "job1",
    cronjobName: "Main check",
    trigger: "scheduled",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
    errorReason: null,
    promptSnapshot: "",
    agentTypeSnapshot: "claude",
    modelFamilySnapshot: "opus",
    effortSnapshot: "medium",
    cwdSnapshot: "/srv/repo",
    permissionModeSnapshot: "bypassPermissions",
    rootSessionId: "message-run1",
    currentSessionId: "message-run1",
    previewText: "",
    commandSnapshot: "./check.sh",
    ...over,
  } as unknown as CronjobRun;
}

const LOUD = commandRun({
  targetAgentSnapshot: { agentId: "a1", agentName: "Pat" },
  commandResult: {
    exitCode: 3,
    signal: null,
    timedOut: false,
    durationMs: 1500,
    output: OUTPUT,
  },
});
const QUIET = commandRun({
  commandResult: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 900,
    output: "",
  },
});

let current: CronjobRun = LOUD;
setShim(() => {});
setApiShim(async () => ({ run: current, entries: [] }));
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});

function Page({ run }: { run: CronjobRun }) {
  const state = useAppState();
  return (
    <StateCtx.Provider
      value={{
        ...state,
        cronjobs: [{ id: run.cronjobId, canManage: true } as CronjobListWire],
        cronjobRunsByJob: new Map([[run.cronjobId, [run]]]),
      }}
    >
      <CronjobRunView jobId={run.cronjobId} runId={run.id} onClose={() => {}} />
    </StateCtx.Provider>
  );
}

async function mount(run: CronjobRun) {
  current = run;
  const view = render(
    <StoreProvider>
      <Page run={run} />
    </StoreProvider>,
  );
  await act(async () => {});
  return view;
}

it("a loud run shows the exit code and the output, and has no composer", async () => {
  const view = await mount(LOUD);
  const c = view.container;
  expect(c.querySelector("[data-command-output]")?.textContent).toBe(OUTPUT);
  expect(c.querySelector("[data-command-exit]")?.textContent).toMatch(/\b3\b/);
  expect(c.querySelector("textarea") === null).toBe(true);
  // The agent it messaged is a value in its line (task 419dcb70).
  expectValueAsData(c, "Pat");
  // Its Close goes back to the Automations list in the same page, and says
  // so; it does not take the page's own Close label (task 930a1385).
  expect(c.querySelector("[data-cronjob-run-close]")?.textContent?.trim()).toBe(
    en["common.automations"],
  );
  view.unmount();
});

it("a quiet run shows how it ended, no output block, and has no composer", async () => {
  const view = await mount(QUIET);
  const c = view.container;
  expect(c.querySelector("[data-command-exit]") !== null).toBe(true);
  expect(c.querySelector("[data-command-output]") === null).toBe(true);
  expect(c.querySelector("textarea") === null).toBe(true);
  // The folder it ran in is a value in its line (task 419dcb70).
  expectValueAsData(c, "/srv/repo");
  view.unmount();
});

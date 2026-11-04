// Task 472fa057: a text box that takes focus when it opens decides by the
// input device, not by the layout. On a touch-primary device a focus opens the
// on-screen keyboard over the page, so it is skipped there. A desktop window
// narrow enough for the mobile layout has a hardware keyboard and gets focus
// (Nil, 2026-11-04: on half a screen, clicking into an agent left the chat
// input unfocused). The app widget's composer has its own owner test, in
// ui/AppWidgetPage.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { LogView } = await import("./log-view/LogView.tsx");
const { SkillsPopover } = await import("./log-view/SkillsPopover.tsx");
const { TerminalPanel } = await import("./log-view/TerminalPanel.tsx");
const { CronjobRunView } = await import("./components/CronjobRunView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { setShim, connect } = await import("./ws.ts");
const { primaryPointer } = await import("./test-support/pointer.ts");
type AgentInfo = import("../shared/types.ts").AgentInfo;
type CronjobRun = import("../shared/types.ts").CronjobRun;
type CronjobListWire = import("../shared/types.ts").CronjobListWire;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

const run = {
  id: "run1",
  cronjobId: "job1",
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

// The two cases that tell the device from the layout. The other two corners
// (a narrow touch screen, a wide window with a mouse) behave as before.
const cases = [
  { device: "a narrow desktop window", narrow: true, coarse: false },
  { device: "a wide touch screen", narrow: false, coarse: true },
] as const;

// Mounts the view with the layout set in the store and the pointer stubbed,
// then reports what has focus once effects and frames have run. The test sees
// nothing focused before the mount, so a focus after it came from the mount.
async function focusAfterMount(
  narrow: boolean,
  coarse: boolean,
  view: () => import("react").ReactNode,
): Promise<{ container: HTMLElement; active: Element | null }> {
  const undo = primaryPointer(coarse);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(coarse);
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement === document.body).toBe(true);
    function Page() {
      const state = useAppState();
      return (
        <StateCtx.Provider value={{ ...state, isMobile: narrow }}>
          {view()}
        </StateCtx.Provider>
      );
    }
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <StoreProvider>
          <Page />
        </StoreProvider>,
      );
    });
    // The terminal focuses in a frame after xterm opens.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    return { container: result.container, active: document.activeElement };
  } finally {
    undo();
  }
}

for (const { device, narrow, coarse } of cases) {
  it(`the chat composer takes focus on open only off touch (${device})`, async () => {
    setApiShim(async () => ({ counts: {} }));
    const { container, active } = await focusAfterMount(narrow, coarse, () => (
      <LogView
        agent={agent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    ));
    const composer = container.querySelector("textarea");
    expect(composer === null).toBe(false);
    expect(active === composer).toBe(!coarse);
    if (coarse) expect(active === document.body).toBe(true);
  });

  it(`a schedule run's follow-up box takes focus on open only off touch (${device})`, async () => {
    setApiShim(async () => ({ run, entries: [] }));
    const { container, active } = await focusAfterMount(narrow, coarse, () => (
      <StateCtx.Consumer>
        {(state) => (
          <StateCtx.Provider
            value={{
              ...state,
              // The viewer manages the job, so the follow-up box shows.
              cronjobs: [
                { id: run.cronjobId, canManage: true } as CronjobListWire,
              ],
              cronjobRunsByJob: new Map([[run.cronjobId, [run]]]),
            }}
          >
            <CronjobRunView
              jobId={run.cronjobId}
              runId={run.id}
              onClose={() => {}}
            />
          </StateCtx.Provider>
        )}
      </StateCtx.Consumer>
    ));
    const followUp = container.querySelector("textarea");
    expect(followUp === null).toBe(false);
    expect(active === followUp).toBe(!coarse);
    if (coarse) expect(active === document.body).toBe(true);
  });

  it(`the skills menu's filter takes focus on open only off touch (${device})`, async () => {
    // Usage counts stay pending: a late answer would update an unmounted menu.
    setApiShim(() => new Promise(() => {}));
    const { container, active } = await focusAfterMount(narrow, coarse, () => (
      <SkillsPopover
        skills={[{ name: "verify", origin: "user" }]}
        commands={[]}
        isMobile={narrow}
        onPick={() => {}}
        onClose={() => {}}
      />
    ));
    const filter = container.querySelector("input");
    expect(filter === null).toBe(false);
    expect(active === filter).toBe(!coarse);
    if (coarse) expect(active === document.body).toBe(true);
  });

  it(`the terminal takes keyboard input on open only off touch (${device})`, async () => {
    const { container, active } = await focusAfterMount(narrow, coarse, () => (
      <TerminalPanel agentId={agent.id} mobile={narrow} onClose={() => {}} />
    ));
    // The mobile chrome types through its own input proxy; the desktop
    // chrome through xterm's helper textarea.
    const input = container.querySelector(
      narrow
        ? "textarea:not(.xterm-helper-textarea)"
        : "textarea.xterm-helper-textarea",
    );
    expect(input === null).toBe(false);
    expect(active === input).toBe(!coarse);
    if (coarse) expect(active === document.body).toBe(true);
  });
}

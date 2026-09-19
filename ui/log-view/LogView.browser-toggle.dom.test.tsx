import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StoreProvider, useAppState } = await import("../store.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { createElement } = await import("react");

type AgentInfo = import("../../shared/types.ts").AgentInfo;

const agent = {
  id: "browser-toggle-agent",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "/tmp",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  userId: "u1",
  username: "Tester",
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
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

setShim(() => {});
afterAll(() => {
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

const page = (browserPanel: boolean, isMobile = false, browserOpen = false, browserPanelAvailable?: boolean) =>
  onLanguage(
    null,
    createElement(LogView, {
      agent: { ...agent, browserPanelAvailable },
      logs: [],
      onBack() {},
      onEditAgent() {},
    }),
    {
      agents: [agent],
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: false },
      ],
      connected: true,
      hasReceivedInitialState: true,
      isMobile,
      sidePanels: browserOpen
        ? new Map([[agent.id, "browser" as const]])
        : new Map(),
      office: {
        prompt: null,
        envFile: null,
        name: null,
        experimental: { browserPanel },
      },
    },
  );

it("omits the desktop Browser nav when off and shows it when on", () => {
  const view = render(page(false));
  expect(view.queryByTitle("Open live browser") === null).toBe(true);
  view.rerender(page(true, false, true));
  expect(view.queryByTitle("Open live browser") !== null).toBe(true);
  view.unmount();
});

it("omits the desktop Browser panel when off and shows it when on", () => {
  const view = render(page(false, false, true));
  expect(view.queryByRole("textbox", { name: "Address" }) === null).toBe(true);
  view.rerender(page(true, false, true));
  expect(view.queryByRole("textbox", { name: "Address" }) !== null).toBe(true);
  view.unmount();
});

it("removes an open desktop Browser panel when the setting turns off", () => {
  const view = render(page(true, false, true));
  expect(view.queryByRole("textbox", { name: "Address" }) !== null).toBe(true);
  view.rerender(page(false, false, true));
  expect(view.queryByRole("textbox", { name: "Address" }) === null).toBe(true);
  view.unmount();
});

it("omits the mobile Browser nav when off and shows it when on", async () => {
  const view = render(page(false, true));
  fireEvent.click(view.getByTitle("More actions"));
  await act(async () => {});
  expect(view.queryByText("Browser") === null).toBe(true);
  view.rerender(page(true, true));
  await act(async () => {});
  expect(view.queryByText("Browser") !== null).toBe(true);
  view.unmount();
});

it("omits the mobile Browser panel when off and shows it when on", () => {
  const view = render(page(false, true, true));
  expect(view.queryByRole("textbox", { name: "Address" }) === null).toBe(true);
  view.rerender(page(true, true, true));
  expect(view.queryByRole("textbox", { name: "Address" }) !== null).toBe(true);
  view.unmount();
});

it("hides the mobile control and stored panel in Chrome mode", async () => {
  const view = render(page(true, true, true, false));
  expect(view.queryByRole("textbox", { name: "Address" })).toBeNull();
  fireEvent.click(view.getByTitle("More actions"));
  await act(async () => {});
  expect(view.queryByText("Browser")).toBeNull();
  view.rerender(page(true, true, false, true));
  await act(async () => {});
  expect(view.queryByText("Browser")).not.toBeNull();
  view.unmount();
});

function LiveLogView() {
  const state = useAppState();
  const liveAgent = state.agents[0];
  if (!liveAgent) return null;
  return (
    <>
      <div data-testid="active-side-panel">
        {state.sidePanels.get(liveAgent.id) ?? "none"}
      </div>
      <LogView
        agent={liveAgent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </>
  );
}

it("wires the office flag into auto-open", async () => {
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: {
          username: "Tester",
          userId: "u1",
          role: "owner",
          currentSessionPrefix: "00000000",
          connectionId: "c1",
        },
      });
      shimEmit({
        type: "full_state",
        agents: [agent],
        recentCwds: [],
        office: {
          prompt: null,
          name: null,
          experimental: { browserPanel: false },
        },
        rooms: [
          { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: false },
        ],
        killedAgents: [],
        interactions: [],
      });
    },
  );
  const view = render(
    <StoreProvider>
      <LiveLogView />
    </StoreProvider>,
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

  await act(async () => {
    shimEmit({ type: "browser_action", agentId: agent.id });
    await Promise.resolve();
  });
  expect(view.getByTestId("active-side-panel").textContent).toBe("none");

  await act(async () => {
    shimEmit({
      type: "office_settings_updated",
      prompt: null,
      name: null,
      experimental: { browserPanel: true },
    });
    await Promise.resolve();
  });
  await act(async () => {
    shimEmit({ type: "browser_action", agentId: agent.id });
    await Promise.resolve();
  });
  expect(view.getByTestId("active-side-panel").textContent).toBe("browser");
  await act(async () => {
    shimEmit({ type: "agent_updated", agentId: agent.id, changes: { browserPanelAvailable: false } });
  });
  expect(view.getByTestId("active-side-panel").textContent).toBe("none");
  expect(view.queryByRole("textbox", { name: "Address" })).toBeNull();
  expect(view.queryByTitle("Open live browser")).toBeNull();
  await act(async () => { shimEmit({ type: "browser_action", agentId: agent.id }); });
  expect(view.getByTestId("active-side-panel").textContent).toBe("none");
  await act(async () => {
    shimEmit({ type: "agent_updated", agentId: agent.id, changes: { browserPanelAvailable: true } });
  });
  expect(view.getByTestId("active-side-panel").textContent).toBe("none");
  fireEvent.click(view.getByTitle("Open live browser"));
  expect(view.getByTestId("active-side-panel").textContent).toBe("browser");
  fireEvent.click(view.getByTitle("Open live browser"));
  expect(view.getByTestId("active-side-panel").textContent).toBe("none");
  await act(async () => { shimEmit({ type: "browser_action", agentId: agent.id }); });
  expect(view.getByTestId("active-side-panel").textContent).toBe("browser");
  view.unmount();
});

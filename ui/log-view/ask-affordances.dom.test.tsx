// An ask's editor card inside the agent's chat (task dc79ace0): a click
// opens the editor panel on the ask's file, as the chat's own editor card
// does, through the store's pending path. The terminal panel is not mounted
// (it carries a real xterm); ui/log-view/AsksStack.dom.test.tsx covers the
// command card up to the store, and TerminalPanel.command.dom.test.tsx the
// panel's side of a pending command.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { setEditorState } = await import("./editor-state.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type LogEntry = import("../../shared/types.ts").LogEntry;
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = import("../store.tsx").AppState;

// The paths the editor panel asked the server for, in order.
const opened: string[] = [];
setApiShim(async (method, path) => {
  const m = /^\/api\/agents\/ask-agent\/file\?path=(.*)$/.exec(path);
  if (method === "GET" && m) {
    const p = decodeURIComponent(m[1]);
    opened.push(p);
    return {
      path: p,
      content: "x\n",
      mtime: 1,
      language: "markdown",
      size: 2,
      rev: 1,
    };
  }
  return {};
});
afterAll(() => setApiShim(null));
// The editor's tabs outlive the mount (module store and localStorage); clear
// them so a later file in the same process does not restore this file's tabs.
afterAll(() => {
  setEditorState("ask-agent", null);
  globalThis.localStorage?.removeItem("isomux:editor:tabs:ask-agent");
  globalThis.localStorage?.removeItem("isomux:editor:recent:ask-agent");
});

const AGENT = {
  id: "ask-agent",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "/w",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  userId: "u1",
  username: "Tester",
  queue: [],
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
  capabilities: DEFAULT_AGENT_CAPABILITIES,
} as unknown as AgentInfo;

const LOGS: LogEntry[] = [
  {
    id: "e1",
    agentId: "ask-agent",
    timestamp: 1,
    kind: "edit-request",
    content: "/w/chat.md",
    file: { cwd: "/w", path: "/w/chat.md" },
  },
];

const ASK: AskEntry = {
  id: "ask00001",
  agentId: "ask-agent",
  memberUserId: "u1",
  prompt: "Read the notes?",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  editFiles: [{ cwd: "/w", path: "/w/ask.md" }],
};

function mount() {
  const seeded: AppState = stateWithSelfUser(null, {
    agents: [AGENT],
    rooms: [
      { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
    ] as AppState["rooms"],
    asks: [ASK],
    hasReceivedInitialState: true,
    connected: true,
    isMobile: false,
  });
  const latest: { state: AppState } = { state: seeded };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    latest.state = state;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(LogView, {
            agent: AGENT,
            logs: LOGS,
            onBack: () => {},
            onEditAgent: () => {},
          }),
        ),
      ),
    );
  }
  return { view: render(createElement(Harness)), latest };
}

it("opens the editor on the ask's file, then on the chat card's file, and clears each pending path", async () => {
  const { view, latest } = mount();
  const askButton = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="ask00001"] [data-ask-edit-file] button[data-panel-action]',
  );
  expect(askButton).not.toBeNull();
  await act(async () => {
    fireEvent.click(askButton!);
  });
  await waitFor(() => expect(opened).toEqual(["/w/ask.md"]));
  expect(latest.state.sidePanels.get("ask-agent")).toBe("editor");
  await waitFor(() =>
    expect(latest.state.pendingEditorPaths.has("ask-agent")).toBe(false),
  );

  // The chat's own card goes the same way.
  const chatButton = [
    ...view.container.querySelectorAll<HTMLButtonElement>(
      "button[data-panel-action]",
    ),
  ].find((b) => !b.closest("[data-ask]"));
  expect(chatButton).toBeDefined();
  await act(async () => {
    fireEvent.click(chatButton!);
  });
  await waitFor(() => expect(opened).toEqual(["/w/ask.md", "/w/chat.md"]));
  await waitFor(() =>
    expect(latest.state.pendingEditorPaths.has("ask-agent")).toBe(false),
  );
  view.unmount();
});

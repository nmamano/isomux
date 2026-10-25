// An agent's editor or terminal card sent with `open: true` (task 043bf145):
// the chat on screen does what the card's button does, once, without taking
// the keyboard. The live frame is dispatched as StoreProvider dispatches a
// ServerMessage (ui/store.tsx), into the real reducer under a mounted LogView.
// The server half (only a live frame carries `open`) is in
// server/test-support/routes-agent-affordances-rest.test.ts.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { createElement, useReducer, useState } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit } = await import("../ws.ts");
const { setEditorState } = await import("./editor-state.ts");
const { commandInputBytes } = await import("./terminal-command.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type LogEntry = import("../../shared/types.ts").LogEntry;
type ClientCommand = import("../../shared/types.ts").ClientCommand;
type AppState = import("../store.tsx").AppState;
type Dispatch = import("react").Dispatch<Parameters<typeof reducer>[1]>;

const AGENT_ID = "open-agent";

// The paths the editor panel asked the server for, in order.
const opened: string[] = [];
setApiShim(async (method, path) => {
  const m = /^\/api\/agents\/open-agent\/file\?path=(.*)$/.exec(path);
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
const sent: ClientCommand[] = [];
setShim(
  (cmd) => sent.push(cmd),
  () => {},
);
afterAll(() => {
  setApiShim(null);
  setShim(null);
});

function clearEditorTabs() {
  setEditorState(AGENT_ID, null);
  globalThis.localStorage?.removeItem(`isomux:editor:tabs:${AGENT_ID}`);
  globalThis.localStorage?.removeItem(`isomux:editor:recent:${AGENT_ID}`);
}

const AGENT = {
  id: AGENT_ID,
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

let entrySeq = 0;
function editCard(path: string, agentId = AGENT_ID): LogEntry {
  return {
    id: `edit-${++entrySeq}`,
    agentId,
    timestamp: Date.now(),
    kind: "edit-request",
    content: path,
    file: { cwd: "/w", path },
  };
}
function commandCard(command: string, agentId = AGENT_ID): LogEntry {
  return {
    id: `cmd-${++entrySeq}`,
    agentId,
    timestamp: Date.now(),
    kind: "terminal-command",
    content: command,
    terminal: { command },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => flush());
}

const inputs = () =>
  sent.filter((cmd) => cmd.type === "terminal_input").map((cmd) => cmd.data);

// The shell answers as in TerminalPanel.command.dom.test.tsx: a prompt and an
// owner status, then the fresh status the queued command asks for.
async function answerShell() {
  const status = {
    type: "terminal_status" as const,
    agentId: AGENT_ID,
    process: "bash",
    shell: true,
  };
  act(() => {
    shimEmit({ type: "terminal_output", agentId: AGENT_ID, data: "$ " });
    shimEmit(status);
  });
  await settle();
  act(() => shimEmit(status));
  await settle();
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  opened.length = 0;
  sent.length = 0;
  clearEditorTabs();
});

function mount(opts: { mobile?: boolean; chatShown?: boolean } = {}) {
  const seeded: AppState = stateWithSelfUser(null, {
    agents: [AGENT],
    rooms: [
      { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
    ] as AppState["rooms"],
    hasReceivedInitialState: true,
    connected: true,
    isMobile: opts.mobile === true,
  });
  const h: {
    state: AppState;
    dispatch: Dispatch | null;
    showChat: (() => void) | null;
  } = { state: seeded, dispatch: null, showChat: null };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    const [chatShown, setChatShown] = useState(opts.chatShown !== false);
    h.state = state;
    h.dispatch = dispatch;
    h.showChat = () => setChatShown(true);
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          chatShown
            ? createElement(LogView, {
                agent: AGENT,
                logs: state.logs.get(AGENT_ID) ?? [],
                onBack: () => {},
                onEditAgent: () => {},
              })
            : null,
        ),
      ),
    );
  }
  const view = render(createElement(Harness));
  unmount = () => view.unmount();
  // A live frame, as StoreProvider dispatches it.
  const live = async (entry: LogEntry, open = true) => {
    act(() =>
      h.dispatch!({
        type: "log_entry",
        entry,
        ...(open ? { open: true as const } : {}),
      }),
    );
    await settle();
  };
  const panel = () => h.state.sidePanels.get(AGENT_ID) ?? null;
  return { view, h, live, panel };
}

// Before any side panel opens, the composer is the chat's only textarea.
function composerOf(container: HTMLElement): HTMLTextAreaElement {
  const all = container.querySelectorAll("textarea");
  expect(all.length).toBe(1);
  return all[0];
}

async function terminalMounted() {
  await waitFor(() =>
    expect(sent.some((cmd) => cmd.type === "terminal_open")).toBe(true),
  );
}

describe("an agent's card with open (task 043bf145)", () => {
  it("an editor card opens its file in the editor panel", async () => {
    const { live, panel } = mount();
    await live(editCard("/w/a.md"));
    await waitFor(() => expect(opened).toEqual(["/w/a.md"]));
    expect(panel()).toBe("editor");
  });

  it("a terminal card types its command into the terminal, unrun, and the composer keeps the keyboard", async () => {
    const { view, live, panel } = mount();
    const composer = composerOf(view.container);
    composer.focus();
    expect(document.activeElement === composer).toBe(true);
    await live(commandCard("echo hi"));
    expect(panel()).toBe("terminal");
    await terminalMounted();
    await answerShell();
    // commandInputBytes holds no Enter: the command is typed, not run.
    expect(inputs()).toEqual([commandInputBytes("echo hi")]);
    expect(document.activeElement === composer).toBe(true);
  });

  it("a member's click on the card while the agent's command waits takes the keyboard, as a click does", async () => {
    const { view, live } = mount();
    const composer = composerOf(view.container);
    composer.focus();
    await live(commandCard("echo hi"));
    await terminalMounted();
    const button = view.container.querySelector<HTMLButtonElement>(
      "button[data-panel-action]",
    );
    expect(button).not.toBeNull();
    await act(async () => {
      fireEvent.click(button!);
    });
    await answerShell();
    expect(inputs()).toEqual([commandInputBytes("echo hi")]);
    expect(
      document.activeElement?.classList.contains("xterm-helper-textarea"),
    ).toBe(true);
  });

  it("a request that arrived while the chat was off screen does not open when the chat mounts", async () => {
    const { h, live, panel } = mount({ chatShown: false });
    await live(editCard("/w/early.md"));
    act(() => h.showChat!());
    await settle();
    expect(opened).toEqual([]);
    expect(panel()).toBeNull();
    // The mounted chat does act on a request that arrives now.
    await live(editCard("/w/later.md"));
    await waitFor(() => expect(opened).toEqual(["/w/later.md"]));
  });

  it("a card without open, or another agent's open card, opens nothing", async () => {
    const { h, live, panel } = mount();
    await live(editCard("/w/plain.md"), false);
    await live(commandCard("ls"), false);
    await live(editCard("/w/other.md", "other-agent"));
    await live(commandCard("pwd", "other-agent"));
    expect(opened).toEqual([]);
    expect(panel()).toBeNull();
    expect(h.state.sidePanels.size).toBe(0);
    await live(editCard("/w/mine.md"));
    await waitFor(() => expect(opened).toEqual(["/w/mine.md"]));
  });

  it("while the member types in the editor, an open card of either kind stays a card", async () => {
    const { view, h, live, panel } = mount();
    await live(editCard("/w/a.md"));
    await waitFor(() => expect(opened).toEqual(["/w/a.md"]));
    const content = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>(".cm-content");
      expect(el).not.toBeNull();
      return el!;
    });
    content.focus();
    expect(document.activeElement === content).toBe(true);
    await live(editCard("/w/b.md"));
    await live(commandCard("ls"));
    expect(opened).toEqual(["/w/a.md"]);
    expect(h.state.pendingEditorPaths.has(AGENT_ID)).toBe(false);
    expect(h.state.pendingTerminalCommands.has(AGENT_ID)).toBe(false);
    expect(panel()).toBe("editor");
  });

  it("while the member types in the terminal, an open card of either kind stays a card", async () => {
    const { view, h, live, panel } = mount();
    await live(commandCard("echo one"));
    await terminalMounted();
    await answerShell();
    expect(inputs()).toEqual([commandInputBytes("echo one")]);
    const helper = view.container.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(helper).not.toBeNull();
    helper!.focus();
    expect(document.activeElement === helper).toBe(true);
    await live(commandCard("echo two"));
    await live(editCard("/w/a.md"));
    await answerShell();
    expect(inputs()).toEqual([commandInputBytes("echo one")]);
    expect(opened).toEqual([]);
    expect(h.state.pendingTerminalCommands.has(AGENT_ID)).toBe(false);
    expect(panel()).toBe("terminal");
  });

  it("on a phone, an open card stays a card while a text field has the keyboard", async () => {
    const { view, live, panel } = mount({ mobile: true });
    const composer = composerOf(view.container);
    composer.focus();
    expect(document.activeElement === composer).toBe(true);
    await live(editCard("/w/a.md"));
    await live(commandCard("ls"));
    expect(opened).toEqual([]);
    expect(panel()).toBeNull();
    // With the keyboard down, the phone opens it.
    composer.blur();
    await live(editCard("/w/b.md"));
    await waitFor(() => expect(opened).toEqual(["/w/b.md"]));
    expect(panel()).toBe("editor");
  });
});

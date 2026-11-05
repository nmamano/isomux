// The Run button on an ask's command (task c3b91695), in the agent's chat:
// where it shows (terminal panels on, an agent at Standard access or above, a
// command that shows as it runs), what a tap posts, the run's states on the
// card, a refusal under the command, and the result that stays on screen
// after a success closed the ask. Copy to terminal stays on every command.
//
// Hooks: [data-ask-run] is the Run button; [data-ask-run-result] the run's
// result under the command, with data-state; [data-ask-run-error] a refusal.
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, FeaturesProvider, reducer } =
  await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type AskCommandRun = import("../../shared/types.ts").AskCommandRun;
type AppState = import("../store.tsx").AppState;
type Action = Parameters<typeof reducer>[1];

// The posts the card made, and what the next one answers.
const posts: Array<{ path: string; body: unknown }> = [];
let answer: () => Promise<unknown> = async () => ({});
setApiShim(async (method, path, body) => {
  if (method === "POST") {
    posts.push({ path, body });
    return answer();
  }
  return {};
});
afterEach(() => {
  cleanup();
  posts.length = 0;
  answer = async () => ({});
});

const AGENT = {
  id: "run-agent",
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
  access: "standard",
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

const HIDDEN = "ls \u001b[8mrm -rf ~\u001b[0m";

function ask(commands: string[], runs?: AskCommandRun[]): AskEntry {
  return {
    id: "run00001",
    agentId: "run-agent",
    memberUserId: "u1",
    prompt: "Run the checks?",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    commands,
    ...(runs ? { runs } : {}),
  };
}

const run = (
  command: string,
  over: Partial<AskCommandRun> = {},
): AskCommandRun => ({
  command,
  by: "u1",
  startedAt: 1,
  state: "done",
  exitCode: 0,
  durationMs: 2100,
  output: "",
  ...over,
});

function mount(
  entry: AskEntry,
  opts: { agent?: Partial<AgentInfo>; terminal?: boolean } = {},
) {
  const agent = { ...AGENT, ...opts.agent } as AgentInfo;
  const seeded: AppState = stateWithSelfUser(null, {
    agents: [agent],
    rooms: [
      { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
    ] as AppState["rooms"],
    asks: [entry],
    hasReceivedInitialState: true,
    connected: true,
    isMobile: false,
  });
  const ref: { dispatch: (a: Action) => void } = { dispatch: () => {} };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    ref.dispatch = dispatch;
    const inner = createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(LogView, {
            agent,
            logs: [],
            onBack: () => {},
            onEditAgent: () => {},
          }),
        ),
      ),
    );
    return createElement(FeaturesProvider, {
      features: { ...PRODUCTION_FEATURES, terminal: opts.terminal ?? true },
      children: inner,
    });
  }
  const view = render(createElement(Harness));
  const command = (c: string) =>
    [
      ...view.container.querySelectorAll<HTMLElement>("[data-ask-command]"),
    ].find((el) => el.getAttribute("data-ask-command") === c) ?? null;
  const runButton = (c: string) =>
    command(c)?.querySelector<HTMLButtonElement>("button[data-ask-run]") ??
    null;
  const copyButton = (c: string) =>
    command(c)?.querySelector<HTMLButtonElement>("button[data-panel-action]") ??
    null;
  return { view, ref, command, runButton, copyButton };
}

it("a tap on Run posts the exact command to the ask's run route; Copy to terminal stays", async () => {
  const m = mount(ask(["bun test", "bun lint"]));
  expect(m.runButton("bun test")).not.toBeNull();
  expect(m.runButton("bun lint")).not.toBeNull();
  expect(m.copyButton("bun test")).not.toBeNull();
  await act(async () => {
    fireEvent.click(m.runButton("bun lint")!);
  });
  await waitFor(() =>
    expect(posts).toEqual([
      { path: "/api/asks/run00001/run", body: { command: "bun lint" } },
    ]),
  );
});

it("no Run without terminal panels, for an agent below Standard, or for a command that does not show as it runs", () => {
  const offTerminal = mount(ask(["bun test"]), { terminal: false });
  expect(offTerminal.command("bun test")).not.toBeNull();
  expect(offTerminal.runButton("bun test")).toBeNull();
  cleanup();

  for (const access of ["chat", "office", "folder", "web"] as const) {
    const limited = mount(ask(["bun test"]), { agent: { access } });
    expect({ access, run: limited.runButton("bun test") === null }).toEqual({
      access,
      run: true,
    });
    expect(limited.copyButton("bun test")).not.toBeNull();
    cleanup();
  }

  const hidden = mount(ask(["bun test", HIDDEN]));
  expect(hidden.runButton("bun test")).not.toBeNull();
  expect(hidden.runButton(HIDDEN)).toBeNull();
  expect(hidden.copyButton(HIDDEN)).not.toBeNull();
});

it("while the command runs, Run is disabled; once it failed, the result and output show and Run is back", async () => {
  const m = mount(ask(["bun test"], [run("bun test", { state: "running" })]));
  expect(m.runButton("bun test")?.disabled).toBe(true);
  await act(async () => {
    m.ref.dispatch({
      type: "ask_upserted",
      entry: ask(
        ["bun test"],
        [run("bun test", { exitCode: 3, output: "3 tests failed-c3b\n" })],
      ),
    } as Action);
  });
  const result = m
    .command("bun test")
    ?.querySelector<HTMLElement>("[data-ask-run-result]");
  expect(result?.getAttribute("data-state")).toBe("done");
  expect(result?.textContent).toContain("3 tests failed-c3b");
  expect(m.runButton("bun test")?.disabled).toBe(false);
});

it("a lost run shows as such and can run again", () => {
  const m = mount(
    ask(
      ["bun test"],
      [run("bun test", { state: "lost", exitCode: undefined })],
    ),
  );
  const result = m
    .command("bun test")
    ?.querySelector<HTMLElement>("[data-ask-run-result]");
  expect(result?.getAttribute("data-state")).toBe("lost");
  expect(m.runButton("bun test")?.disabled).toBe(false);
});

it("a refused tap shows under the command, and the ask stays", async () => {
  answer = async () => {
    throw new ApiError(403, "agent_limited", "below Standard");
  };
  const m = mount(ask(["bun test"]));
  await act(async () => {
    fireEvent.click(m.runButton("bun test")!);
  });
  await waitFor(() =>
    expect(
      m.command("bun test")?.querySelector("[data-ask-run-error]"),
    ).not.toBeNull(),
  );
  expect(
    m.view.container.querySelector('[data-ask="run00001"]'),
  ).not.toBeNull();
});

it("after a success closed the ask, its result stays on screen until Close; a closed ask that failed leaves none", async () => {
  const m = mount(
    ask(["bun test"], [run("bun test", { output: "all green-c3b\n" })]),
  );
  await act(async () => {
    m.ref.dispatch({ type: "ask_removed", id: "run00001" } as Action);
  });
  const card = () =>
    m.view.container.querySelector<HTMLElement>('[data-ask-result="run00001"]');
  expect(m.view.container.querySelector('[data-ask="run00001"]')).toBeNull();
  expect(card()?.textContent).toContain("bun test");
  expect(card()?.textContent).toContain("all green-c3b");
  await act(async () => {
    fireEvent.click(
      card()!.querySelector<HTMLElement>("[data-ask-result-close]")!,
    );
  });
  expect(card()).toBeNull();
  cleanup();

  const failed = mount(
    ask(["bun test"], [run("bun test", { exitCode: 1, output: "red\n" })]),
  );
  await act(async () => {
    failed.ref.dispatch({ type: "ask_removed", id: "run00001" } as Action);
  });
  expect(
    failed.view.container.querySelector('[data-ask-result="run00001"]'),
  ).toBeNull();
});

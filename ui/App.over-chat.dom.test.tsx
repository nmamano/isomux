// A page opened on top of an agent chat. Its own file because it renders both a
// page and a chat, and the 5 s cap is per file; the rest of App's Back and
// Forward behaviour is in ui/App.history.dom.test.tsx.
//
// Agent chats are not routes (ruling 3 of internal-docs/url-routing-loop.md),
// so a chat is "/" like the office. Backing out of tasks-over-a-chat lands on
// the chat - the one case where a page closes without the office coming back.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
type AgentInfo = import("../shared/types.ts").AgentInfo;

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

function spyOnPushState() {
  return spyOn(window.history, "pushState");
}

let pushState: ReturnType<typeof spyOnPushState>;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  pushState = spyOnPushState();
});

afterEach(() => {
  pushState.mockRestore();
});

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;

describe("a page opened over a chat", () => {
  // Agent chats are not routes (ruling 3), so a chat is "/" like the office.
  // Back out of tasks-over-a-chat lands on the chat - the one case where a page
  // closes without the office coming back.
  const AGENT = {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "idle",
    agentType: "claude",
    modelFamily: "opus",
    topic: null,
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

  // DispatchCtx is not exported, so this fixture cannot change focus. That is
  // why it covers tasks-over-chat only, and not a plain chat clearing focus.
  const WITH_CHAT = {
    ...initialState,
    agents: [AGENT],
    focusedAgentId: "a1",
    currentRoomId: "r1",
    rooms: [{ id: "r1", name: "Room" }],
  } as unknown as typeof initialState;

  it("lands back on the chat at /", async () => {
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: WITH_CHAT },
        createElement(App),
      ),
    );
    expect(window.location.pathname).toBe("/");

    // The chat pushed the only entry. Opening a page on top of it is a
    // deep-to-deep move, so ruling 5's one-entry-per-page-change means the
    // path changes by replacement, not by a second push.
    expect(pushState).toHaveBeenCalledTimes(1);

    await press("t");
    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
    expect(pushState).toHaveBeenCalledTimes(1);

    await go("back");

    expect(taskPageOpen(view)).toBe(false);
    expect(window.location.pathname).toBe("/");
  });
});

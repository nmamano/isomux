// Settings opened with "s" from an agent chat closes back to that chat, not to
// the office (task e927e6ff), the way tasks over a chat does. Its own file
// because it renders a chat and the settings page, and the 5 s cap is per file.
//
// Focus runs through a real reducer here: with a fixed StateCtx value a close
// that went to the office would clear focus into a no-op dispatch and still
// render the chat, so the test could not tell the two apart. Other actions are
// dropped, as in the fixed-value tests: the API shim answers {} and the
// settings page's list actions would store undefined.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement, useReducer } = await import("react");
type AgentInfo = import("../shared/types.ts").AgentInfo;

type View = ReturnType<typeof render>;

// "s" opens the room's settings, which load its memory file.
setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "v1", size: 0, cap: 10_000 }
    : {},
);
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function goBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

const WITH_CHAT = {
  ...initialState,
  agents: [AGENT],
  focusedAgentId: "a1",
  currentRoomId: "r1",
  rooms: [{ id: "r1", name: "Room" }],
} as unknown as typeof initialState;

function Harness() {
  const [state, dispatch] = useReducer(reducer, WITH_CHAT);
  const focusOnly: typeof dispatch = (action) => {
    if (action.type === "focus") dispatch(action);
  };
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(
      DispatchCtx.Provider,
      { value: focusOnly },
      createElement(App),
    ),
  );
}

const settingsOpen = (view: View) =>
  view.container.querySelector('[data-testid="settings-content"]') !== null;
const chatShowing = (view: View) =>
  view.container.querySelector(".log-view-shell") !== null;

describe("settings opened over a chat", () => {
  it("Escape returns to the chat", async () => {
    const view = render(createElement(Harness));
    expect(chatShowing(view)).toBe(true);

    await press("s");
    expect(settingsOpen(view)).toBe(true);
    expect(chatShowing(view)).toBe(false);

    await press("Escape");
    expect(settingsOpen(view)).toBe(false);
    expect(chatShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("Back returns to the chat", async () => {
    const view = render(createElement(Harness));
    expect(chatShowing(view)).toBe(true);

    await press("s");
    expect(settingsOpen(view)).toBe(true);

    await goBack();
    expect(settingsOpen(view)).toBe(false);
    expect(chatShowing(view)).toBe(true);
  });
});

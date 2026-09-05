// A cold link opened over a chat the saved spot restores - the one sequence in
// this family that needs the REAL store, and its own file because a
// StoreProvider mount plus a chat render is the most expensive case here and
// the 5 s cap is per file.
//
// A fixed StateCtx could not prove this. Its dispatch is a noop, so the agent
// would have been handed to App rather than arriving from the saved spot, and
// the test would assert the fixture instead of the behaviour. StoreProvider
// over the WS shim the demo build already uses sends full_state and
// session_context the way the server does.
//
// What it protects is ruling 8's ownership surviving a page-to-chat transition:
// the entry was never pushed, so the return from that chat has to replace it
// rather than call history.back(), which from the bottom of the stack would
// strand the reader.

import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { saveView } = await import("./view-persistence.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "0", size: 0, cap: 4000 }
    : {},
);

afterAll(() => {
  setApiShim(null);
  // ws.ts holds the shim, the MESSAGE handler and the CONNECTION handler in
  // module state, and StoreProvider's connect() has no teardown - so without
  // this the store this file mounted stays wired to shimEmit after the DOM is
  // gone, and the next file that emits (ui/demo-server.test.ts does)
  // dispatches into an unmounted React tree and dies on a missing `window`.
  // Both callbacks have to be passed: connect() only replaces the connection
  // handler when it is given one.
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks") !== null;

describe("a cold link over a restored chat", () => {
  // The one sequence that needs the REAL store: the agent has to arrive from
  // the saved spot through a dispatch, not be handed to App in a fixed
  // provider. StoreProvider drives it through the WS shim the demo build
  // already uses, so full_state and session_context reach the reducer the way
  // the server sends them.
  const AGENT = {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "idle",
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    topic: null,
    topicStale: false,
    customInstructions: null,
    customInstructionsVersion: "0",
    permissionMode: "default",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  };
  const ROOM = { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true };

  function bootWithSavedAgent(): View {
    saveView("ricky", { roomId: "r1", agentId: "a1", panel: "apps" });
    window.history.replaceState(null, "", "/tasks");
    setShim(
      () => {},
      () => {
        shimEmit({
          type: "session_context",
          context: { username: "ricky", userId: "u1", role: "owner" },
        } as never);
        shimEmit({
          type: "full_state",
          agents: [AGENT],
          rooms: [ROOM],
          office: {},
          recentCwds: [],
          killedAgents: [],
          interactions: [],
        } as never);
      },
    );
    return render(createElement(StoreProvider, null, createElement(App, {})));
  }

  it("closes to that chat at /, and the next return replaces instead of going back", async () => {
    const view = bootWithSavedAgent();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const entries = window.history.length;

    // The URL won the page (ruling 4: it beats the saved panel, which was
    // "apps"), and the saved spot still supplied the agent underneath.
    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");

    // Close the page: it sits over a chat, so this drops the page and lands on
    // the chat - and the entry, which we never pushed, stays unpushed.
    await act(async () => {
      view.getByText("←").click();
    });
    expect(taskPageOpen(view)).toBe(false);
    expect(view.getByText("Tester")).toBeDefined();
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(entries);

    // The return from that chat must replace the entry, not call back() - there
    // is nothing underneath it to go back to.
    const back = spyOn(window.history, "back");
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(back).not.toHaveBeenCalled();
    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(entries);
    back.mockRestore();
  });
});

// The settings page's unsaved-edit guard under its real path.
//
// Its own file because mounting the settings detail pane is one of the more
// expensive renders in the suite, and the 5 s cap is per file. The task board's
// half of the same story is in ui/App.dirty.dom.test.tsx.
//
// The guard is a capture-phase keydown listener on window that calls
// stopPropagation before App's own bubble listener can reach goHome
// (ui/components/UserSettingsView.tsx:306). That mechanism is the enabling
// condition, and it dictates how the key is sent: Escape is dispatched from
// document.body with bubbles:true, never on window. stopPropagation stops an
// event reaching other NODES, not other listeners on the same node, so an event
// dispatched directly on window would run the guard's listener AND App's -
// which no browser does, and the test would pass while proving nothing.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings detail pane mounts useMemoryEditor, which GETs /api/memory and
// reads `text` off the response - a shim answering {} makes the next render
// throw inside injectedMemorySize.
setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "0", size: 0, cap: 4000 }
    : {},
);
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
});

/** The real event path: capture at window, stopPropagation, App never sees it. */
async function escapeFromPage(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

const discardPrompt = (view: View) =>
  view.queryByText(/Discard unsaved changes/) !== null;

describe("dirty settings", () => {
  // The smallest fixture that mounts the editable detail pane: the page selects
  // the signed-in user on its own, which is what makes the name field reachable.
  const SELF = {
    id: "u1",
    name: "Ricky",
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    envFile: null,
    memberPrompt: null,
    language: null,
    avatarColor: "#4A90D9",
    avatarVariant: 0,
    role: "owner",
  };
  const SIGNED_IN = {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
    users: new Map([["ricky", SELF]]),
  } as unknown as typeof initialState;

  it("shows the discard prompt on Escape and stays on /settings", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: SIGNED_IN },
        createElement(App, {}),
      ),
    );

    const nameField = view.getByDisplayValue("Ricky");
    await act(async () => {
      fireEvent.change(nameField, { target: { value: "Ricky Edited" } });
    });
    expect(view.getByDisplayValue("Ricky Edited")).toBeDefined();
    expect(discardPrompt(view)).toBe(false);

    await escapeFromPage();

    expect(discardPrompt(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });
});

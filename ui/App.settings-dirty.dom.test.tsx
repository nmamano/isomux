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

// Four App renders on the settings panes: 5.4 s under push-time CI load on
// 2026-09-17 against the 5 s default cap, about 3 s alone.
setUpDomTestFile({ capMs: 10_000 });

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings detail pane mounts useMemoryEditor, which GETs /api/memory and
// reads `text` off the response - a shim answering {} makes the next render
// throw inside injectedMemorySize.
const apiShim = async (method: string, path: string) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (method === "GET" && path === "/api/office/settings")
    return {
      prompt: null,
      name: null,
      version: "1",
    };
  if (method === "GET" && path === "/api/rooms/r1/settings")
    return { prompt: null, version: "1" };
  return {};
};
setApiShim(apiShim);
afterAll(() => setApiShim(null));

beforeEach(() => {
  setApiShim(apiShim);
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
  const WITH_ROOM = {
    ...SIGNED_IN,
    rooms: [
      {
        id: "r1",
        name: "Blue Room",
        prompt: null,
        canCloseWhenEmpty: true,
      },
    ],
  } as typeof initialState;

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

  it("uses the discard prompt instead of confirm for an Office edit", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: SIGNED_IN },
        createElement(App, {}),
      ),
    );

    fireEvent.click(view.getByRole("button", { name: "Office" }));
    const nameField = await view.findByPlaceholderText("Nil's Office");
    await act(async () => {
      fireEvent.change(nameField, { target: { value: "Edited Office" } });
    });
    const originalConfirm = window.confirm;
    window.confirm = () => {
      throw new Error("native confirm was called");
    };
    try {
      await escapeFromPage();
    } finally {
      window.confirm = originalConfirm;
    }

    expect(discardPrompt(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });

  it("uses the discard prompt instead of confirm for a Device edit", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: SIGNED_IN },
        createElement(App, {}),
      ),
    );

    fireEvent.click(view.getByRole("button", { name: "Device label" }));
    const labelField = await view.findByPlaceholderText("Phone, Laptop, …");
    fireEvent.change(labelField, { target: { value: "Work laptop" } });
    const originalConfirm = window.confirm;
    window.confirm = () => {
      throw new Error("native confirm was called");
    };
    try {
      await escapeFromPage();
    } finally {
      window.confirm = originalConfirm;
    }

    expect(discardPrompt(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });

  it("uses the discard prompt instead of confirm for a Room edit", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: WITH_ROOM },
        createElement(App, {}),
      ),
    );

    fireEvent.click(view.getByRole("button", { name: "Blue Room" }));
    const nameField = await view.findByPlaceholderText("Room name");
    fireEvent.change(nameField, { target: { value: "Edited Room" } });
    const originalConfirm = window.confirm;
    window.confirm = () => {
      throw new Error("native confirm was called");
    };
    try {
      await escapeFromPage();
    } finally {
      window.confirm = originalConfirm;
    }

    expect(discardPrompt(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });
});

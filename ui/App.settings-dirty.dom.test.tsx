// The settings page's unsaved-edit guard under its real path: Escape on a
// dirty pane shows the in-page discard prompt, never the browser's confirm,
// and the page stays. The task board's half of the same story is in
// ui/App.dirty.dom.test.tsx.
//
// One pane is enough here. Escape and a sidebar row both go through the same
// leaveEdit (ui/components/UserSettingsView.tsx), and
// ui/settings.i18n.dom.test.tsx already drives the profile, office and device
// label panes' prompts through a row change. The room pane is the one no other
// test makes dirty.
//
// The guard is a capture-phase keydown listener on window that calls
// stopPropagation before App's own bubble listener can reach goHome. That
// mechanism is the enabling condition, and it dictates how the key is sent:
// Escape is dispatched from document.body with bubbles:true, never on window.
// stopPropagation stops an event reaching other NODES, not other listeners on
// the same node, so an event dispatched directly on window would run the
// guard's listener AND App's - which no browser does, and the test would pass
// while proving nothing.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { en } = await import("../shared/i18n/en.ts");

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
  if (method === "GET" && path === "/api/office/instructions")
    return { instructions: null, version: "1" };
  if (method === "GET" && path === "/api/rooms/r1/instructions")
    return { instructions: null, version: "1" };
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
  view.queryByText(en["common.discardPrompt"]) !== null;

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

  it("uses the discard prompt instead of confirm for a Room edit", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: WITH_ROOM },
        createElement(App, {}),
      ),
    );

    // Rooms starts collapsed (task db800fd8): its header opens it.
    fireEvent.click(
      view.container.querySelector('[data-sidebar-group-toggle="rooms"]')!,
    );
    fireEvent.click(view.getByRole("button", { name: "Blue Room" }));
    const nameField = await view.findByPlaceholderText(
      en["settings.room.namePlaceholder"],
    );
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

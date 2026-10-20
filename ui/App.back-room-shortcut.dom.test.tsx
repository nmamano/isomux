// The "b" shortcut (Nil, 2026-10-15): in a room with the back room setting
// on it goes between the front and the back room; with the setting off it
// does nothing, and it stays out of the way while you type. The rule itself
// is in ui/routes.test.ts; this file proves App's wiring.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { saveView, loadSavedView } = await import("./view-persistence.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));

afterAll(() => {
  setApiShim(null);
  // The store this file mounts stays wired to shimEmit otherwise (see
  // ui/App.restored-chat.dom.test.tsx).
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

let typingField: HTMLInputElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  typingField?.remove();
  typingField = null;
});

function boot(backRoom: boolean, secondRoom = false): View {
  // Land in the room, not the lobby.
  saveView("ricky", { roomId: "r1", agentId: null, panel: null, lobby: false });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "ricky", userId: "u1", role: "owner" },
      } as never);
      shimEmit({
        type: "full_state",
        agents: [],
        rooms: [
          {
            id: "r1",
            name: "Room",
            prompt: null,
            canCloseWhenEmpty: true,
            backRoom,
          },
          ...(secondRoom
            ? [
                {
                  id: "r2",
                  name: "Other room",
                  prompt: null,
                  canCloseWhenEmpty: true,
                  backRoom: false,
                },
              ]
            : []),
        ],
        office: {},
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never);
    },
  );
  return render(createElement(StoreProvider, null, createElement(App, {})));
}

async function pressB(from: EventTarget = document.body) {
  await act(async () => {
    from.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function key(
  type: "keydown" | "keyup",
  key: string,
  init: KeyboardEventInit = {},
  from: EventTarget = document.body,
) {
  await act(async () => {
    from.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

async function loneShift(from: EventTarget = document.body) {
  await key("keydown", "Shift", { shiftKey: true }, from);
  await key("keyup", "Shift", {}, from);
}

async function shiftTab(from: EventTarget = document.body) {
  await key("keydown", "Tab", { shiftKey: true }, from);
}

/** The room App shows, as it saves the view spot. */
function shownRoom(): string | null {
  const saved = loadSavedView("ricky");
  return saved?.lobby ? "lobby" : (saved?.roomId ?? null);
}

const backShowing = (view: View) =>
  view.container.querySelector("[data-back-room]") !== null;
// The front's trap door: the room is up, with its setting on.
const trapDoor = (view: View) =>
  view.container.querySelector("[data-trap-door]") !== null;

describe("the back room shortcut", () => {
  it("goes to the back room and back to the front", async () => {
    const view = boot(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(trapDoor(view)).toBe(true);
    expect(backShowing(view)).toBe(false);

    await pressB();
    expect(backShowing(view)).toBe(true);

    await pressB();
    expect(backShowing(view)).toBe(false);
    expect(trapDoor(view)).toBe(true);
  });

  it("does nothing while typing, or in a room with the setting off", async () => {
    const view = boot(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(trapDoor(view)).toBe(true);
    typingField = document.createElement("input");
    document.body.appendChild(typingField);
    await pressB(typingField);
    expect(backShowing(view)).toBe(false);

    await act(async () =>
      shimEmit({
        type: "room_back_room_updated",
        roomId: "r1",
        backRoom: false,
      } as never),
    );
    // The room is up, and has no trap door now.
    expect(view.queryByTitle("Tasks (t)")).not.toBeNull();
    expect(trapDoor(view)).toBe(false);
    // The office draws no back screen in such a room whatever App holds, so
    // the history entry is what shows App opened nothing.
    const entries = window.history.length;
    await pressB();
    expect(backShowing(view)).toBe(false);
    expect(window.history.length).toBe(entries);
  });
});

// Nil, 2026-10-20: in a back room, a lone Shift or Shift+Tab goes to the
// front of the same room. The rule and the lone-Shift tracker are in
// ui/routes.test.ts; this proves App's wiring.
describe("Shift and Shift+Tab in a back room", () => {
  // Each App boot costs a few hundred ms against the file's DOM cap, so each
  // test walks many cases on one boot.
  async function bootInBack(secondRoom = false): Promise<View> {
    const view = boot(true, secondRoom);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await pressB();
    expect(backShowing(view)).toBe(true);
    return view;
  }

  async function click() {
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, shiftKey: true }),
      );
    });
  }

  async function blur() {
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
  }

  it("a lone Shift goes to the front; a Shift with anything else in it does nothing", async () => {
    const view = await bootInBack();
    await loneShift();
    expect(backShowing(view)).toBe(false);
    expect(trapDoor(view)).toBe(true);
    await pressB();
    expect(backShowing(view)).toBe(true);

    // Shift down: the keydown alone is not a lone press.
    await key("keydown", "Shift", { shiftKey: true });
    expect(backShowing(view)).toBe(true);
    // A capital.
    await key("keydown", "A", { shiftKey: true });
    await key("keyup", "A", { shiftKey: true });
    await key("keyup", "Shift");
    expect(backShowing(view)).toBe(true);
    // Shift+click.
    await key("keydown", "Shift", { shiftKey: true });
    await click();
    await key("keyup", "Shift");
    expect(backShowing(view)).toBe(true);
    // Shift held through a click, long enough to repeat.
    await key("keydown", "Shift", { shiftKey: true });
    await click();
    await key("keydown", "Shift", { shiftKey: true, repeat: true });
    await key("keyup", "Shift");
    expect(backShowing(view)).toBe(true);
    // Shift tapped while Ctrl is held: the keyup carries the modifier.
    await key("keydown", "Control", { ctrlKey: true });
    await key("keydown", "Shift", { ctrlKey: true, shiftKey: true });
    await key("keyup", "Shift", { ctrlKey: true });
    await key("keyup", "Control");
    expect(backShowing(view)).toBe(true);
    // Shift held across a blur.
    await key("keydown", "Shift", { shiftKey: true });
    await blur();
    await key("keyup", "Shift");
    expect(backShowing(view)).toBe(true);
    // A key whose keydown a child stops still spoils the Shift.
    const stopper = document.createElement("div");
    stopper.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.appendChild(stopper);
    try {
      await key("keydown", "Shift", { shiftKey: true });
      await key("keydown", "Enter", { shiftKey: true }, stopper);
      await key("keyup", "Shift");
    } finally {
      stopper.remove();
    }
    expect(backShowing(view)).toBe(true);
    // A lone Shift in a text field.
    typingField = document.createElement("input");
    document.body.appendChild(typingField);
    await loneShift(typingField);
    expect(backShowing(view)).toBe(true);

    // A Shift whose release a blur lost does not spoil the next press.
    await key("keydown", "Shift", { shiftKey: true });
    await blur();
    await loneShift();
    expect(backShowing(view)).toBe(false);
  });

  it("Shift+Tab goes to the front of the same room; from the front it still switches rooms", async () => {
    const view = await bootInBack(true);
    expect(shownRoom()).toBe("r1");
    // Not from a text field.
    typingField = document.createElement("input");
    document.body.appendChild(typingField);
    await shiftTab(typingField);
    expect(backShowing(view)).toBe(true);
    expect(shownRoom()).toBe("r1");

    await shiftTab();
    expect(backShowing(view)).toBe(false);
    expect(trapDoor(view)).toBe(true);
    expect(shownRoom()).toBe("r1");

    await shiftTab();
    expect(shownRoom()).not.toBe("r1");
    expect(trapDoor(view)).toBe(false);
  });
});

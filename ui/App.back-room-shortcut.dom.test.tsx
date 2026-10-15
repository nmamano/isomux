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
const { saveView } = await import("./view-persistence.ts");
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

function boot(backRoom: boolean): View {
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

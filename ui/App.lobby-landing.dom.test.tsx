import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { boot, rooms, setupLandingTests, loadSavedView, saveView } =
  await import("./test-support/lobby-landing-fixture.tsx");
setupLandingTests();

type View = Awaited<ReturnType<typeof boot>>;

// Which scene is open: the lobby's props layer and a room's back-wall window
// (as in ui/App.ride-lobby.dom.test.tsx), and the title, which names the open
// room, or the office in the lobby.
function scene(view: View) {
  return {
    lobby: view.container.querySelector("#lobby-fire-glow") !== null,
    room: view.container.querySelector("#window-clip") !== null,
    title: document.title.split(" | ")[0],
  };
}
const LOBBY = { lobby: true, room: false, title: "Test Office" };
const ONE_ROOM = [rooms[0]!];
const IN_ONE_ROOM = { lobby: false, room: true, title: ONE_ROOM[0]!.name };

for (const visibleRooms of [[], rooms]) {
  it(`lands on Lobby without a saved view with ${visibleRooms.length} room grants`, async () => {
    expect(loadSavedView("member")).toBeNull();
    const view = await boot(visibleRooms);
    expect(view.container.querySelector("[data-floor-scene]")).not.toBeNull();
    expect(scene(view)).toEqual(LOBBY);
    expect(loadSavedView("member")?.lobby).toBe(true);
  });
}

// A member who reaches one room lands in it on a first visit (no saved view
// in this browser), and the saved flag then records the room.
it("opens the one room of a member with no saved view", async () => {
  expect(loadSavedView("member")).toBeNull();
  const view = await boot(ONE_ROOM);
  expect(scene(view)).toEqual(IN_ONE_ROOM);
  expect(loadSavedView("member")).toMatchObject({
    roomId: ONE_ROOM[0]!.id,
    lobby: false,
  });
});

// After the first visit the saved spot wins for a one-room member too: a
// saved Lobby opens the Lobby, also when the saved room is lost.
for (const savedRoom of [ONE_ROOM[0]!.id, rooms[1]!.id]) {
  it(`keeps a saved Lobby for a member with one room, saved over ${savedRoom === ONE_ROOM[0]!.id ? "that room" : "a lost room"}`, async () => {
    saveView("member", {
      roomId: savedRoom,
      agentId: null,
      panel: null,
      lobby: true,
    });
    const view = await boot(ONE_ROOM);
    expect(scene(view)).toEqual(LOBBY);
    expect(loadSavedView("member")?.lobby).toBe(true);
  });
}
// A one-room member who leaves in the Lobby comes back to it: the click saves
// the Lobby, and the next load opens it.
it("brings a member with one room back to the Lobby they left", async () => {
  const first = await boot(ONE_ROOM);
  expect(scene(first)).toEqual(IN_ONE_ROOM);
  const tab = first.container.querySelector("[data-lobby-tab] button");
  expect(tab).not.toBeNull();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(scene(first)).toEqual(LOBBY);
  expect(loadSavedView("member")?.lobby).toBe(true);
  first.unmount();
  const second = await boot(ONE_ROOM);
  expect(scene(second)).toEqual(LOBBY);
  expect(loadSavedView("member")?.lobby).toBe(true);
});

// The rule counts rooms: with two, a saved Lobby still opens the Lobby.
it("keeps a saved Lobby for a member with two rooms", async () => {
  saveView("member", { roomId: "r2", agentId: null, panel: null, lobby: true });
  const view = await boot(rooms);
  expect(scene(view)).toEqual(LOBBY);
  expect(loadSavedView("member")?.lobby).toBe(true);
});

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { OfficeState } = await import("../../shared/office-state.ts");
const { LOBBY_ROOM } = await import("../../shared/types.ts");
const { mount, room, act, fireEvent, shimEmit, fullState, setReply } = fixture;
fixture.setupRoomDoorTests();

for (const broadcastFirst of [true, false]) {
  it(`creates and selects once with broadcast ${broadcastFirst ? "before" : "after"} response`, async () => {
    const view = mount();
    const created = room("created", "Room 2");
    setReply(async () => {
      if (broadcastFirst) shimEmit({ type: "room_created", room: created });
      return { room: created };
    });
    await act(async () =>
      fireEvent.click(
        view.getByRole("button", { hidden: true, name: "New room" }),
      ),
    );
    await act(async () =>
      fireEvent.click(
        view.getByRole("button", { hidden: true, name: "Open room" }),
      ),
    );
    if (!broadcastFirst)
      await act(async () => shimEmit({ type: "room_created", room: created }));
    expect(fixture.requests).toEqual([{}]);
    expect(fixture.snapshot.rooms.map((r) => r.id)).toEqual([
      "first",
      "created",
    ]);
    expect(fixture.snapshot.currentRoomId).toBe("created");
    expect(fixture.snapshot.lobbyOpen).toBe(false);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(
      view.getAllByRole("button", { hidden: true, name: "Room 2 0/8" }),
    ).toHaveLength(1);
    expect(
      view.getAllByRole("button", { hidden: true, name: "New room" }),
    ).toHaveLength(1);
  });
}

it("creates a protected first ordinary room from the canonical lobby and retains selection", async () => {
  const state = new OfficeState({ rooms: [LOBBY_ROOM] });
  const view = mount([LOBBY_ROOM]);
  setReply(async () => {
    state.createRoom();
    return { room: state.ordinaryRooms[0] };
  });
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: "New room" }),
    ),
  );
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: "Open room" }),
    ),
  );
  const created = state.ordinaryRooms[0];
  expect(created.canCloseWhenEmpty).toBe(false);
  expect(state.rooms.find((r) => r.id === "lobby")?.canCloseWhenEmpty).toBe(
    false,
  );
  expect(fixture.snapshot.currentRoomId).toBe(created.id);
  expect(fixture.snapshot.rooms).toHaveLength(2);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  await act(async () => fullState([...state.rooms]));
  expect(fixture.snapshot.currentRoomId).toBe(created.id);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  expect(fixture.snapshot.rooms).toHaveLength(2);
});

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
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
    await act(async () => fireEvent.click(view.getByRole("button", { hidden: true, name: "New room" })));
    await act(async () => fireEvent.click(view.getByRole("button", { hidden: true, name: "Open room" })));
    if (!broadcastFirst) await act(async () => shimEmit({ type: "room_created", room: created }));
    expect(fixture.requests).toEqual([{}]);
    expect(fixture.snapshot.rooms.map((r) => r.id)).toEqual(["first", "created"]);
    expect(fixture.snapshot.currentRoomId).toBe("created");
    expect(fixture.snapshot.lobbyOpen).toBe(false);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getAllByRole("button", { hidden: true, name: "Room 2 0/8" })).toHaveLength(1);
    expect(view.getAllByRole("button", { hidden: true, name: "New room" })).toHaveLength(1);
  });
}

it("creates the first room from the zero-room lobby and retains selection after member full_state", async () => {
  const view = mount([]);
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  await act(async () => fireEvent.click(view.getByRole("button", { hidden: true, name: "New room" })));
  await act(async () => fireEvent.click(view.getByRole("button", { hidden: true, name: "Open room" })));
  expect(fixture.snapshot.currentRoomId).toBe("created");
  expect(fixture.snapshot.rooms).toHaveLength(1);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  await act(async () => fullState([room("created", "Room 2")]));
  expect(fixture.snapshot.currentRoomId).toBe("created");
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  expect(fixture.snapshot.rooms).toHaveLength(1);
});


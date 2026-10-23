// The wall's New room door: creation, its failure and retry, and its absence
// in embed.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { LOBBY_ROOM } = await import("../../shared/types.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { mount, room, act, fireEvent, shimEmit, fullState, setReply } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

const { t } = translatorFor("en");
const NEW_ROOM = t("office.newRoom.door");
const OPEN_ROOM = t("office.newRoom.confirm");

for (const broadcastFirst of [true, false]) {
  it(`creates and selects once with broadcast ${broadcastFirst ? "before" : "after"} response`, async () => {
    // Keep the full door → dialog → store → tab flow for broadcast-before.
    const view = mount(undefined, false, !broadcastFirst);
    const created = room("created", "Room 2");
    setReply(async () => {
      if (broadcastFirst) shimEmit({ type: "room_created", room: created });
      return { room: created };
    });
    if (broadcastFirst)
      await act(async () =>
        fireEvent.click(
          view.getByRole("button", { hidden: true, name: NEW_ROOM }),
        ),
      );
    await act(async () =>
      fireEvent.click(
        view.getByRole("button", { hidden: true, name: OPEN_ROOM }),
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
    expect(view.queryByRole("dialog") === null).toBe(true);
    expect(
      view.getAllByRole("button", { hidden: true, name: "Room 2" }),
    ).toHaveLength(1);
    if (broadcastFirst)
      expect(
        view.getAllByRole("button", { hidden: true, name: NEW_ROOM }),
      ).toHaveLength(1);
  });
}

it("creates the first ordinary room from the canonical lobby and retains selection", async () => {
  // The server's protection of that room is server/test-support/
  // receptionist.test.ts :: "protects the first ordinary room even with
  // lobby-first storage".
  const created = { ...room("created", "Room 1"), canCloseWhenEmpty: false };
  const view = mount([LOBBY_ROOM], false, true);
  setReply(async () => ({ room: created }));
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: OPEN_ROOM }),
    ),
  );
  expect(fixture.snapshot.currentRoomId).toBe(created.id);
  expect(fixture.snapshot.rooms).toHaveLength(2);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  await act(async () => fullState([LOBBY_ROOM, created]));
  expect(fixture.snapshot.currentRoomId).toBe(created.id);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  expect(fixture.snapshot.rooms).toHaveLength(2);
});

it("keeps the dialog and current room on failure, then permits retry", async () => {
  const view = mount();
  setReply(async () => {
    throw new Error("offline");
  });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { hidden: true, name: NEW_ROOM })),
  );
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: OPEN_ROOM }),
    ),
  );
  expect(view.getByRole("alert").textContent?.trim()).not.toBe("");
  expect(view.getByRole("dialog")).toBeTruthy();
  expect(fixture.snapshot.rooms.map((r) => r.id)).toEqual(["first"]);
  expect(fixture.snapshot.currentRoomId).toBe("first");
  setReply(async () => ({ room: room("created") }));
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: OPEN_ROOM }),
    ),
  );
  expect(fixture.snapshot.currentRoomId).toBe("created");
  expect(fixture.requests).toHaveLength(2);
});

it("hides room creation in embed, on the last room and in an empty lobby", async () => {
  const view = mount([room("first")]);
  const newRoomDoor = () =>
    view.queryByRole("button", { hidden: true, name: NEW_ROOM });
  // The control: outside embed the last room offers the door.
  expect(newRoomDoor()).not.toBeNull();
  await act(async () => {
    view.setEmbed(true);
    fullState([room("first")]);
  });
  expect(newRoomDoor()).toBeNull();
  await act(async () => fullState([]));
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(newRoomDoor()).toBeNull();
  // The control: outside embed the empty lobby offers it too.
  await act(async () => view.setEmbed(false));
  expect(newRoomDoor()).not.toBeNull();
});

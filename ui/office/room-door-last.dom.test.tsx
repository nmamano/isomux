// Last-visible-room door coverage split from room-door.dom.test.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

it("uses the right door on the last visible room and has no right drop target", async () => {
  const view = mount([room("first"), room("last")]);
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "last" }),
  );
  const door = view.getByRole("button", { hidden: true, name: "New room" });
  expect(
    view.container.querySelector('[data-door-drop="right"]') === null,
  ).toBe(true);
  expect(fixture.requests).toHaveLength(0);
  await act(async () => fireEvent.click(door));
  expect(
    view.getByRole("dialog", { hidden: true, name: "Open new room?" }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(view.getByRole("button", { hidden: true, name: "Cancel" })),
  );
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.snapshot.currentRoomId).toBe("last");
});

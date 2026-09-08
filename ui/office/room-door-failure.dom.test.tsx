import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent, setReply } = fixture;
fixture.setupRoomDoorTests();

it("keeps the dialog and current room on failure, then permits retry", async () => {
  const view = mount();
  setReply(async () => {
    throw new Error("offline");
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
  expect(view.getByRole("alert").textContent).toBe(
    "Could not open the room. Try again.",
  );
  expect(view.getByRole("dialog")).toBeTruthy();
  expect(fixture.snapshot.rooms.map((r) => r.id)).toEqual(["first"]);
  expect(fixture.snapshot.currentRoomId).toBe("first");
  setReply(async () => ({ room: room("created") }));
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { hidden: true, name: "Open room" }),
    ),
  );
  expect(fixture.snapshot.currentRoomId).toBe("created");
  expect(fixture.requests).toHaveLength(2);
});

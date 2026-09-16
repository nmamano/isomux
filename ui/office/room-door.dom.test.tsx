// Last-room and embed-only coverage live in sibling files so each file stays
// below half of the DOM per-file budget under load.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

it("keeps first-room Lobby navigation and the right drop target", async () => {
  const view = mount([room("first"), room("last")]);
  expect(
    view.queryByRole("button", { hidden: true, name: "New room" }),
  ).toBeNull();
  expect(
    view.container.querySelector('[data-door-drop="right"]') !== null,
  ).toBe(true);
  const lobbyDoor = view.container.querySelector('svg g[aria-label="Lobby"]')!;
  await act(async () => fireEvent.click(lobbyDoor));
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(view.queryByRole("dialog")).toBeNull();
});

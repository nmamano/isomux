// QUARANTINED (P0 039d5acd, Nil 2026-09-13): this file sits at the 5000 ms
// DOM per-file cap and flakes in full runs. Cut its render cost, then
// re-enable every describe/it below. Do not raise the cap.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent, fullState } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

it.skip("uses the right door on the last visible room, keeps first-room Lobby navigation, has no right drop target, and hides creation in embed", async () => {
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
  // Keep the ordinary checks on a fresh ordinary mount, then reuse it for embed.
  await act(async () => {
    view.setEmbed(true);
    fullState([room("first")]);
  });
  expect(
    view.queryByRole("button", { hidden: true, name: "New room" }),
  ).toBeNull();
  await act(async () => fullState([]));
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(
    view.queryByRole("button", { hidden: true, name: "New room" }),
  ).toBeNull();
});

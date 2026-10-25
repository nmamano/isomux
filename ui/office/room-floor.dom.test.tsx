// The office draws the current room's floor pattern, and repaints it when the
// room's decor changes under it. floor-pattern.test.tsx owns what each
// pattern draws; this file owns that the room's choice reaches the floor.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act } = fixture;
fixture.setupRoomDoorTests({ decorations: true });

it("draws the room's floor pattern and goes back to the checker when it clears", async () => {
  const view = mount([room("plain")]);
  await act(async () => {});
  const fills = () =>
    new Set(
      [...view.container.querySelectorAll("[data-floor-tile]")].map((tile) =>
        tile.getAttribute("fill"),
      ),
    );
  expect(fills().size).toBe(2);

  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: { floor: "plain" },
    }),
  );
  expect(fills().size).toBe(1);

  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: null,
    }),
  );
  expect(fills().size).toBe(2);
  view.unmount();
});

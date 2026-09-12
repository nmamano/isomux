// One transition: a skin changed by someone else. It reaches every client as
// room_skin_updated, so the scene has to repaint from the store rather than
// from whatever it mounted with - in both directions, set and cleared.
//
// Decorations off and one mount, for the reason in room-skin-probe.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { skinProbe } from "./room-skin-probe.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act } = fixture;
const { hospitalSceneVars } = await import("./skins/hospital/palette.ts");
const { SCENE_W } = await import("./grid.ts");
fixture.setupRoomDoorTests({ decorations: false });

it("repaints when the room's skin changes under it, and again when it clears", async () => {
  const view = mount([room("plain")]);
  await act(async () => {});
  const { floor, layers } = skinProbe(view.container, SCENE_W);
  expect(floor()).toBe("");

  await act(async () =>
    fixture.dispatch({
      type: "room_skin_updated",
      roomId: "plain",
      skin: "hospital",
    }),
  );
  expect(floor()).toBe(hospitalSceneVars("dark")["--floor-light"]);
  expect(layers()).toHaveLength(2);

  await act(async () =>
    fixture.dispatch({
      type: "room_skin_updated",
      roomId: "plain",
      skin: null,
    }),
  );
  expect(floor()).toBe("");
  expect(layers()).toHaveLength(0);
  view.unmount();
});

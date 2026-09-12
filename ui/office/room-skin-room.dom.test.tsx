// One transition: a hospital room is drawn with the skin's variables and both
// of its layers, and an ordinary room next door is drawn exactly as it was
// before skins existed. This is the file that proves all three mount points -
// the variables on the scene container, SkinWalls inside Walls, SkinProps
// inside the props svg - are wired at all.
//
// Decorations off: the floor tiles, the ground shadows and the seasonal layer
// are the expensive part of a mount and none of them reads the skin. Walls and
// RoomProps render either way.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { skinProbe } from "./room-skin-probe.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act } = fixture;
const { hospitalSceneVars } = await import("./skins/hospital/palette.ts");
const { SCENE_W } = await import("./grid.ts");
fixture.setupRoomDoorTests({ decorations: false });

it("draws a hospital room, and an ordinary room as it was before skins", async () => {
  const view = mount([room("ward", "Ward", "hospital"), room("plain")]);
  await act(async () => {});
  const { floor, layers } = skinProbe(view.container, SCENE_W);
  expect(floor()).toBe(hospitalSceneVars("dark")["--floor-light"]);
  expect(
    view.container.querySelector('[data-skin-layer="hospital-walls"]'),
  ).not.toBeNull();
  expect(
    view.container.querySelector('[data-skin-layer="hospital-props"]'),
  ).not.toBeNull();

  // An ordinary room carries no overrides at all, rather than an override that
  // happens to match the theme.
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "plain" }),
  );
  expect(floor()).toBe("");
  expect(layers()).toHaveLength(0);
  view.unmount();
});

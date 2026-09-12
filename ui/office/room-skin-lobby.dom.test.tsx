// One transition: the step from a hospital room into the lobby. The lobby draws
// its own scene and takes no skin, so nothing of the hospital may come with it.
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

it("drops the skin when the viewer steps into the lobby", async () => {
  const view = mount([room("ward", "Ward", "hospital")]);
  await act(async () => {});
  const { floor, layers } = skinProbe(view.container, SCENE_W);
  expect(floor()).toBe(hospitalSceneVars("dark")["--floor-light"]);
  expect(layers()).toHaveLength(2);

  await act(async () =>
    fixture.dispatch({ type: "set_lobby_open", open: true }),
  );
  expect(floor()).toBe("");
  expect(layers()).toHaveLength(0);
  view.unmount();
});

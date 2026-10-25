// A hospital room is drawn with the skin's variables and both of its layers,
// and an ordinary room next door is drawn exactly as it was before skins. This
// is the file that proves all three mount points - the variables on the scene
// container, SkinWalls inside Walls, SkinProps inside the props svg - are wired
// at all. The lobby draws its own scene and takes no skin, and a skin or decor
// changed by someone else repaints the scene from the store, set and cleared.
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
const { sceneVarsFor } = await import("./skins/index.tsx");
const { DEFAULT_THEME_ID } = await import("../themes.ts");
// The hospital's green is the "clinic" tint, on the default (dark) theme.
const clinicFloor = sceneVarsFor("clinic", DEFAULT_THEME_ID)["--floor-light"];
const { SCENE_W } = await import("./grid.ts");
fixture.setupRoomDoorTests({ decorations: false });

it("draws a hospital room, an ordinary room as it was before skins, and the lobby with no skin", async () => {
  const view = mount([room("ward", "Ward", "hospital"), room("plain")]);
  await act(async () => {});
  const { floor, layers } = skinProbe(view.container, SCENE_W);
  expect(floor()).toBe(clinicFloor);
  expect(
    view.container.querySelector('[data-skin-layer="decor-walls"]'),
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

  // Back in the ward the skin returns; stepping into the lobby drops it.
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "ward" }),
  );
  expect(floor()).toBe(clinicFloor);
  expect(layers()).toHaveLength(2);
  await act(async () =>
    fixture.dispatch({ type: "set_lobby_open", open: true }),
  );
  expect(floor()).toBe("");
  expect(layers()).toHaveLength(0);
  view.unmount();
});

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
  expect(floor()).toBe(clinicFloor);
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

  // Decor choices arrive the same way, as the room's whole map: the clinic
  // palette and a ward on an office room, the neon swapped for a picture, and
  // back to the bare preset when the map clears.
  const neon = () => view.container.querySelectorAll(".neon-sign-on").length;
  expect(neon()).toBe(1);
  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: { walls: "clinic", ward: "beds", wallArt: "chart" },
    }),
  );
  expect(floor()).toBe(clinicFloor);
  expect(layers()).toHaveLength(2);
  expect(neon()).toBe(0);
  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: null,
    }),
  );
  expect(floor()).toBe("");
  expect(layers()).toHaveLength(0);
  expect(neon()).toBe(1);
  view.unmount();
});

// The room-name plate takes the neon sign's place, carries the full name as
// its tooltip, and goes when the choice clears. A blank name has nothing to
// show, so the wall stays bare.
it("hangs the room-name plate in the neon sign's place and opens the room's settings from it", async () => {
  const name = "Payments and billing platform";
  const view = mount([room("plain", name)]);
  await act(async () => {});
  const plate = () =>
    view.container.querySelector<SVGGElement>("[data-room-name-plate]");
  const neon = () => view.container.querySelectorAll(".neon-sign-on").length;
  expect(plate()).toBeNull();
  expect(neon()).toBe(1);

  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: { wallArt: "name" },
    }),
  );
  expect(neon()).toBe(0);
  expect(plate()).not.toBeNull();
  expect(plate()!.querySelector("title")?.textContent ?? "").toContain(name);

  await act(async () =>
    fixture.dispatch({
      type: "room_decor_updated",
      roomId: "plain",
      decor: null,
    }),
  );
  expect(plate()).toBeNull();
  expect(neon()).toBe(1);
  view.unmount();
});

it("a click on the plate opens the room's settings", async () => {
  const { render, fireEvent } = await import("@testing-library/react");
  const { RoomNamePlate } = await import("./Floor.tsx");
  const { StoreProvider } = await import("../store.tsx");
  const { LanguageProvider } = await import("../i18n.tsx");
  let opened = 0;
  const view = render(
    <StoreProvider>
      <LanguageProvider>
        <svg>
          <RoomNamePlate
            name="Payments"
            title="Payments"
            onOpen={() => {
              opened++;
            }}
          />
        </svg>
      </LanguageProvider>
    </StoreProvider>,
  );
  const plate = view.container.querySelector("[data-room-name-plate]")!;
  expect(opened).toBe(0);
  fireEvent.click(plate);
  expect(opened).toBe(1);
  view.unmount();
});

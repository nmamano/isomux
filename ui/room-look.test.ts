// The PATCH body the room settings pane builds from its staged look. The rules
// are the design's (internal-docs/room-customization-design.md): a preset is a
// reset, a reset with picks clears every slot by name, a pick is stored even
// when the preset draws the same, and only what changed is sent.

import { expect, it } from "bun:test";
import {
  initialRoomLook,
  pickDecor,
  pickPet,
  pickPreset,
  roomLookBody,
  savedRoomLook,
} from "./room-look.ts";
import { ROOM_DECOR_SLOTS } from "../shared/room-decor.ts";
import type { RoomWire } from "../shared/types.ts";

const ward: RoomWire = {
  id: "ward",
  name: "Ward",
  prompt: null,
  canCloseWhenEmpty: true,
  skin: "hospital",
  pet: { species: "dog", coat: 1 },
  decor: { curtains: "none" },
};

it("sends nothing for an untouched look", () => {
  const look = initialRoomLook(ward);
  expect(look).toEqual({
    skin: "hospital",
    reset: false,
    picks: {},
    pet: { species: "dog", coat: 1 },
  });
  expect(roomLookBody(look, look)).toBeNull();
});

it("sends a preset as the skin plus every choice cleared", () => {
  const saved = initialRoomLook(ward);
  expect(roomLookBody(pickPreset(saved, "office"), saved)).toEqual({
    skin: "office",
    decor: null,
  });
  // The active preset again is still a reset.
  expect(roomLookBody(pickPreset(saved, "hospital"), saved)).toEqual({
    skin: "hospital",
    decor: null,
  });
});

it("sends a preset with picks as every slot cleared plus the picks", () => {
  const saved = initialRoomLook(ward);
  const look = pickDecor(pickPreset(saved, "office"), "trim", "rail");
  const cleared = Object.fromEntries(ROOM_DECOR_SLOTS.map((s) => [s, null]));
  expect(roomLookBody(look, saved)).toEqual({
    skin: "office",
    decor: { ...cleared, trim: "rail" },
  });
});

it("sends only the picked slots, a value the preset draws included", () => {
  const saved = initialRoomLook(ward);
  const look = pickDecor(pickDecor(saved, "ward", "beds"), "sill", "blossom");
  expect(roomLookBody(look, saved)).toEqual({
    decor: { ward: "beds", sill: "blossom" },
  });
});

it("shows the pet with a species or coat, and hides it alone", () => {
  const saved = initialRoomLook(ward);
  expect(
    roomLookBody(pickPet(saved, { species: "cat", coat: 3 }), saved),
  ).toEqual({ pet: { species: "cat", coat: 3 }, decor: { pet: "shown" } });
  expect(roomLookBody(pickDecor(saved, "pet", "none"), saved)).toEqual({
    decor: { pet: "none" },
  });
});

it("sends nothing more once a save has landed", () => {
  const saved = initialRoomLook(ward);
  const look = pickDecor(pickPreset(saved, "office"), "pet", "none");
  const after = savedRoomLook(look);
  expect(after.reset).toBe(false);
  expect(roomLookBody(after, after)).toBeNull();
  // A later pick is measured against what was saved.
  expect(roomLookBody(pickDecor(after, "pet", "shown"), after)).toEqual({
    decor: { pet: "shown" },
  });
});

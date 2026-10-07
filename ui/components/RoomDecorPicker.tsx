// The room customization section of the room settings pane: a preset row and
// one row per decor slot, laid out like OutfitPicker. Every tile draws its
// option small, from the scene's own drawings, cropped to where the option
// sits in the room; the words are the row label and the tile's accessible
// name. The pane owns the staged look and the Save; this only shows it and
// reports picks.

import { memo, type ReactNode } from "react";
import {
  ROOM_DECOR_OPTIONS,
  ROOM_DECOR_SLOTS,
  storedRoomDecor,
  type ResolvedRoomDecor,
  type RoomDecorSlot,
  type RoomDecorValue,
} from "../../shared/room-decor.ts";
import {
  SELECTABLE_ROOM_SKIN_IDS,
  type RoomSkin,
} from "../../shared/room-skins.ts";
import {
  PET_PALETTES,
  PET_SPECIES,
  type PetSpecies,
} from "../../shared/pets.ts";
import type { MessageKey } from "../../shared/i18n/translate.ts";
import type { RoomWire } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { useTheme } from "../store.tsx";
import {
  DecorWallPieces,
  presetDecor,
  sceneVarsFor,
} from "../office/skins/index.tsx";
import { HospitalProps } from "../office/skins/hospital/props.tsx";
import { NeonSign, WindowPlant } from "../office/Floor.tsx";
import { BlossomJar, CornerPlant, PlantDefs } from "../office/plants.tsx";
import { PetCorner, drawnPet } from "../office/RoomProps.tsx";
import { FLOOR_CLIP } from "../office/grid.ts";
import { pickDecor, pickPet, pickPreset, type RoomLook } from "../room-look.ts";

/** What the pane would draw if saved now. */
export function stagedRoomDecor(
  room: RoomWire,
  rooms: RoomWire[],
  look: RoomLook,
): ResolvedRoomDecor {
  return {
    ...presetDecor(look.skin, room.id, rooms),
    ...(look.reset ? {} : storedRoomDecor(room.decor)),
    ...look.picks,
  };
}

// The neon colour the tiles show. The scene picks one per room; a tile only
// has to read as a neon sign.
const TILE_NEON = "#ff6ec7";

type Box = readonly [number, number, number, number];

// Where each option sits in the scene, as a viewBox (x, y, width, height) in
// scene coordinates. Each tile crops the room to that box.
const ROOM_BOX: Box = [-370, -215, 980, 754];
const SLOT_BOX: Record<Exclude<RoomDecorSlot, "pet">, Box> = {
  walls: ROOM_BOX,
  curtains: [-335, -75, 240, 185],
  sill: [-300, -5, 160, 123],
  wallArt: [295, -80, 160, 123],
  trim: [10, -50, 220, 169],
  cabinet: [-110, 10, 104, 80],
  floorPlant: [-310, 115, 130, 110],
  ward: [110, 250, 350, 269],
};
const PET_BOX: Box = [80, 425, 80, 62];

/** The bare room: both walls, the floor and the window opening. Every tile
 *  draws its option over this, so "none" still shows where the option goes. */
function RoomBase() {
  const { mode } = useTheme();
  return (
    <>
      <path
        d="M-355 277.5 L-355 37.5 L120 -200 L120 40 Z"
        fill="var(--wall-left)"
      />
      <path
        d="M120 -200 L120 40 L595 277.5 L595 37.5 Z"
        fill="var(--wall-right)"
      />
      <path d={FLOOR_CLIP} fill="var(--floor-light)" />
      <path
        d="M-290 120 L-140 45 L-140 -50 L-290 25 Z"
        fill="var(--wall-end-left)"
      />
      <path
        d="M-290 111 L-149 40.5 L-149 -45.5 L-290 25 Z"
        fill={mode === "dark" ? "#0a0e1a" : "#87CEEB"}
      />
    </>
  );
}

function Thumb({
  box,
  walls,
  size,
  children,
}: {
  box: Box;
  walls: ResolvedRoomDecor["walls"];
  size: { width: number; height: number };
  children?: ReactNode;
}) {
  const { mode } = useTheme();
  return (
    <svg
      aria-hidden="true"
      width={size.width}
      height={size.height}
      viewBox={box.join(" ")}
      style={sceneVarsFor(walls, mode)}
    >
      <defs>
        <PlantDefs />
      </defs>
      <RoomBase />
      {children}
    </svg>
  );
}

const TILE = { width: 52, height: 40 };
const PRESET_TILE = { width: 96, height: 74 };

/** One option of one slot, drawn alone at its place in the room. */
function SlotDrawing<S extends Exclude<RoomDecorSlot, "pet">>({
  slot,
  value,
}: {
  slot: S;
  value: ResolvedRoomDecor[S];
}) {
  switch (slot) {
    case "curtains":
    case "trim":
    case "cabinet":
      return (
        <DecorWallPieces
          decor={{
            trim: "none",
            cabinet: "none",
            curtains: "none",
            wallArt: "none",
            [slot]: value,
          }}
        />
      );
    case "wallArt":
      return value === "neon" ? (
        <NeonSign color={TILE_NEON} />
      ) : (
        <DecorWallPieces
          decor={{
            trim: "none",
            cabinet: "none",
            curtains: "none",
            wallArt: value as ResolvedRoomDecor["wallArt"],
          }}
        />
      );
    case "sill":
      if (value === "trailing") return <WindowPlant />;
      if (value === "blossom") {
        return (
          <g transform="translate(-236 92.6)">
            <BlossomJar />
          </g>
        );
      }
      return null;
    case "floorPlant":
      return value === "plant" ? <FloorPlantAt /> : null;
    case "ward":
      return value === "beds" ? <HospitalProps /> : null;
    default:
      // walls: the palette is the drawing, set on the tile's svg.
      return null;
  }
}

function FloorPlantAt() {
  return (
    <g transform="translate(-245, 212) scale(1.5)">
      <CornerPlant />
    </g>
  );
}

/** The whole room in a decor, smaller than life: what a preset tile shows. */
function RoomDrawing({ decor }: { decor: ResolvedRoomDecor }) {
  return (
    <>
      <DecorWallPieces decor={decor} />
      {decor.wallArt === "neon" && <NeonSign color={TILE_NEON} />}
      <SlotDrawing slot="sill" value={decor.sill} />
      {decor.ward === "beds" && <HospitalProps />}
      {decor.floorPlant === "plant" && <FloorPlantAt />}
      {decor.pet === "shown" && <PetCorner pet={null} />}
    </>
  );
}

// KEYS, not words, so a language switch re-reads them (the PetPicker pattern).
type DecorKey = Extract<MessageKey, `office.decor.${string}`>;

const PRESET_KEY: Record<
  RoomSkin,
  Extract<MessageKey, `office.skin.${string}`>
> = {
  office: "office.skin.office",
  hospital: "office.skin.hospital",
};

const SPECIES_KEY: Record<
  PetSpecies,
  Extract<MessageKey, `office.pet.species.${string}`>
> = {
  cat: "office.pet.species.cat",
  dog: "office.pet.species.dog",
  rabbit: "office.pet.species.rabbit",
  tortoise: "office.pet.species.tortoise",
};

// Every slot's label and every option's name, checked against the catalog by
// the compiler. The pet row names its options by species instead.
const SLOT_KEY: Record<Exclude<RoomDecorSlot, "pet">, DecorKey> = {
  walls: "office.decor.walls",
  curtains: "office.decor.curtains",
  sill: "office.decor.sill",
  wallArt: "office.decor.wallArt",
  trim: "office.decor.trim",
  cabinet: "office.decor.cabinet",
  floorPlant: "office.decor.floorPlant",
  ward: "office.decor.ward",
};

const OPTION_KEY: {
  [S in Exclude<RoomDecorSlot, "pet">]: Record<RoomDecorValue<S>, DecorKey>;
} = {
  walls: {
    office: "office.decor.walls.office",
    clinic: "office.decor.walls.clinic",
  },
  curtains: { none: "office.decor.none", tied: "office.decor.curtains.tied" },
  sill: {
    trailing: "office.decor.sill.trailing",
    blossom: "office.decor.sill.blossom",
    none: "office.decor.none",
  },
  wallArt: {
    neon: "office.decor.wallArt.neon",
    landscape: "office.decor.wallArt.landscape",
    chart: "office.decor.wallArt.chart",
    none: "office.decor.none",
  },
  trim: { none: "office.decor.none", rail: "office.decor.trim.rail" },
  cabinet: {
    none: "office.decor.none",
    "first-aid": "office.decor.cabinet.firstAid",
  },
  floorPlant: {
    plant: "office.decor.floorPlant.plant",
    none: "office.decor.none",
  },
  ward: { none: "office.decor.none", beds: "office.decor.ward.beds" },
};

function optionKey<S extends Exclude<RoomDecorSlot, "pet">>(
  slot: S,
  value: RoomDecorValue<S>,
): DecorKey {
  return OPTION_KEY[slot][value];
}

interface TileOption {
  id: string;
  label: string;
  selected: boolean;
  select: () => void;
  picture: ReactNode;
}

function TileRow({
  row,
  label,
  options,
  wide = false,
}: {
  row: string;
  label: string;
  options: TileOption[];
  wide?: boolean;
}) {
  return (
    <fieldset className="outfit-options" data-decor-row={row}>
      <legend>
        {label}
        <span className="outfit-selected-label">
          {" "}
          · {options.find((option) => option.selected)?.label}
        </span>
      </legend>
      <div className="outfit-tiles">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            data-option={option.id}
            className={`outfit-tile ${wide ? "room-decor-preset" : "room-decor-tile"}`}
            aria-label={option.label}
            title={option.label}
            aria-pressed={option.selected}
            onClick={option.select}
          >
            <span aria-hidden="true" className="room-decor-picture">
              {option.picture}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// Memoized: the tiles are a few thousand SVG nodes, and the pane re-renders on
// every keystroke and checkbox elsewhere in it.
export const RoomDecorPicker = memo(function RoomDecorPicker({
  room,
  rooms,
  look,
  onChange,
}: {
  room: RoomWire;
  rooms: RoomWire[];
  look: RoomLook;
  onChange: (look: RoomLook) => void;
}) {
  const { t } = useI18n();
  const decor = stagedRoomDecor(room, rooms, look);
  // What the room draws, by the scene's own fallbacks: a stored species or
  // coat this build does not know must not break the pane.
  const pet = drawnPet(look.pet);
  // A skin held back from the pickers still shows while a room carries it.
  const presets = SELECTABLE_ROOM_SKIN_IDS.includes(look.skin)
    ? SELECTABLE_ROOM_SKIN_IDS
    : [...SELECTABLE_ROOM_SKIN_IDS, look.skin];

  return (
    <div data-room-decor>
      <TileRow
        row="preset"
        wide
        label={t("office.decor.preset")}
        options={presets.map((skin) => {
          const drawn = presetDecor(skin, room.id, rooms);
          return {
            id: skin,
            label: t(PRESET_KEY[skin]),
            selected: look.skin === skin,
            select: () => onChange(pickPreset(look, skin)),
            picture: (
              <Thumb box={ROOM_BOX} walls={drawn.walls} size={PRESET_TILE}>
                <RoomDrawing decor={drawn} />
              </Thumb>
            ),
          };
        })}
      />
      {ROOM_DECOR_SLOTS.filter((slot) => slot !== "pet").map((slot) => {
        const s = slot;
        return (
          <TileRow
            key={s}
            row={s}
            label={t(SLOT_KEY[s])}
            options={ROOM_DECOR_OPTIONS[s].map((value) => ({
              id: value,
              label: t(optionKey(s, value)),
              selected: decor[s] === value,
              select: () => onChange(pickDecor(look, s, value)),
              picture: (
                <Thumb
                  box={SLOT_BOX[s]}
                  walls={
                    s === "walls" ? (value as "office" | "clinic") : decor.walls
                  }
                  size={TILE}
                >
                  <SlotDrawing slot={s} value={value} />
                </Thumb>
              ),
            }))}
          />
        );
      })}
      <TileRow
        row="pet"
        label={t("office.pet.label")}
        options={[
          {
            id: "none",
            label: t("office.decor.none"),
            selected: decor.pet === "none",
            select: () => onChange(pickDecor(look, "pet", "none")),
            picture: <Thumb box={PET_BOX} walls={decor.walls} size={TILE} />,
          },
          ...PET_SPECIES.map((species) => ({
            id: species,
            label: t(SPECIES_KEY[species]),
            selected: decor.pet === "shown" && pet.species === species,
            select: () =>
              onChange(
                pickPet(look, {
                  species,
                  coat: pet.species === species ? pet.coat : 0,
                }),
              ),
            picture: (
              <Thumb box={PET_BOX} walls={decor.walls} size={TILE}>
                <PetCorner pet={{ species, coat: 0 }} />
              </Thumb>
            ),
          })),
        ]}
      />
      {decor.pet === "shown" && (
        <TileRow
          row="coat"
          label={t("office.decor.coat")}
          options={PET_PALETTES[pet.species].map((_, coat) => {
            const name = t(SPECIES_KEY[pet.species]);
            return {
              id: String(coat),
              label: t("office.pet.coat", { species: name, number: coat + 1 }),
              selected: pet.coat === coat,
              select: () =>
                onChange(pickPet(look, { species: pet.species, coat })),
              picture: (
                <Thumb box={PET_BOX} walls={decor.walls} size={TILE}>
                  <PetCorner pet={{ species: pet.species, coat }} />
                </Thumb>
              ),
            };
          })}
        />
      )}
    </div>
  );
});

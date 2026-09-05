import { memo, useState, type ReactElement } from "react";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";
import { CornerPlant } from "./plants.tsx";
import {
  DEFAULT_ROOM_PET,
  PET_PALETTES,
  type PetPalette,
  type PetSpecies,
  type RoomPet,
} from "../../shared/pets.ts";
import { useAppState } from "../store.tsx";
import { apiFetch } from "../api.ts";
import type { RoomRenameReq } from "../../shared/contract-shapes.ts";
import { PetPicker } from "./PetPicker.tsx";

// Every sleeper is drawn curled on the cushion, centred on (0,0), facing left,
// about 34 wide and 20 tall so the bed fits them all. Each one breathes on the
// body's `ry`, and moves one appendage on a slower cycle, so no two rooms tick
// together.

function Cat({ p }: { p: PetPalette }) {
  return (
    <>
      <ellipse cx="0" cy="0" rx="16" ry="9" fill={p.coat}>
        <animate
          attributeName="ry"
          values="9;9.5;9"
          dur="3s"
          repeatCount="indefinite"
        />
      </ellipse>
      <ellipse cx="0" cy="0" rx="16" ry="9" fill="url(#pet-volume)" />
      <path
        d="M-8 -4 Q-4 -7 0 -4"
        stroke={p.mark}
        strokeWidth="1"
        fill="none"
      />
      <path d="M2 -5 Q6 -8 10 -5" stroke={p.mark} strokeWidth="1" fill="none" />
      {/* Tail curling around - gentle sway */}
      <path
        d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
        stroke={p.coat}
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      >
        <animate
          attributeName="d"
          values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
          dur="4s"
          repeatCount="indefinite"
        />
      </path>
      <path
        d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
        stroke={p.mark}
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      >
        <animate
          attributeName="d"
          values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
          dur="4s"
          repeatCount="indefinite"
        />
      </path>
      <ellipse cx="-12" cy="-2" rx="8" ry="7" fill={p.coat} />
      <ellipse cx="-12" cy="-2" rx="8" ry="7" fill="url(#pet-volume)" />
      <path d="M-18 -7 L-16 -14 L-12 -8 Z" fill={p.coat} />
      <path d="M-12 -8 L-8 -14 L-6 -7 Z" fill={p.coat} />
      <path d="M-17 -7 L-15.5 -12 L-13 -8 Z" fill={p.inner} />
      <path d="M-11 -8 L-8.5 -12 L-7 -7 Z" fill={p.inner} />
      <path
        d="M-16 -2 Q-14.5 -4 -13 -2"
        stroke={p.line}
        strokeWidth="0.8"
        fill="none"
      />
      <path
        d="M-11 -3 Q-9.5 -5 -8 -3"
        stroke={p.line}
        strokeWidth="0.8"
        fill="none"
      />
      <ellipse cx="-12" cy="0" rx="1" ry="0.7" fill={p.nose} />
      <line
        x1="-18"
        y1="-1"
        x2="-23"
        y2="-3"
        stroke={p.line}
        strokeWidth="0.3"
      />
      <line x1="-18" y1="1" x2="-23" y2="1" stroke={p.line} strokeWidth="0.3" />
      <line x1="-6" y1="-1" x2="-1" y2="-3" stroke={p.line} strokeWidth="0.3" />
      <line x1="-6" y1="1" x2="-1" y2="1" stroke={p.line} strokeWidth="0.3" />
    </>
  );
}

function Dog({ p }: { p: PetPalette }) {
  return (
    <>
      {/* Tail. Rooted inside the body and drawn BEFORE it, so it comes out from
          behind rather than lying across the flank. One rotation about the root
          wags the whole thing, which is what lets it carry an underside, a
          highlight and a tuft without four separate animations. */}
      <g>
        <animateTransform
          attributeName="transform"
          type="rotate"
          values="-6 9 3;6 9 3;-6 9 3"
          dur="1.7s"
          repeatCount="indefinite"
        />
        {/* Shaded underside */}
        <path
          d="M9 3.4 Q23 5 25.6 -4 Q26.6 -10 22.2 -12.2"
          stroke={p.mark}
          strokeWidth="5.2"
          fill="none"
          strokeLinecap="round"
        />
        {/* Lit top */}
        <path
          d="M9 2 Q23 3.4 25 -5 Q26 -10.6 21.8 -12.6"
          stroke={p.coat}
          strokeWidth="4.2"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M13 1.2 Q22 2.2 24.2 -5"
          stroke="#FFFFFF"
          strokeOpacity="0.22"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
        />
        {/* Tuft at the tip */}
        <circle cx="21.8" cy="-12.6" r="2.9" fill={p.coat} />
        <circle cx="21" cy="-13.4" r="1.5" fill="#FFFFFF" opacity="0.18" />
      </g>
      <ellipse cx="0" cy="0" rx="17" ry="9.5" fill={p.coat}>
        <animate
          attributeName="ry"
          values="9.5;10.1;9.5"
          dur="3.4s"
          repeatCount="indefinite"
        />
      </ellipse>
      {/* Saddle patch and a hip spot, under the shading so the body stays one
          rounded mass instead of a pale blob sitting on top of it */}
      <path d="M-5 -8 Q4 -11 13 -5 Q4 -2 -5 -8 Z" fill={p.mark} opacity="0.9" />
      <ellipse cx="6" cy="3" rx="5" ry="2.6" fill={p.mark} opacity="0.5" />
      <ellipse cx="0" cy="0" rx="17" ry="9.5" fill="url(#pet-volume)" />
      {/* Head */}
      <ellipse cx="-14" cy="-3" rx="8.5" ry="7.5" fill={p.coat} />
      <ellipse cx="-14" cy="-3" rx="8.5" ry="7.5" fill="url(#pet-volume)" />
      {/* Muzzle, centred under the eyes rather than off to one side */}
      <ellipse cx="-14" cy="1.5" rx="5.6" ry="4" fill={p.inner} />
      <ellipse cx="-14" cy="1.5" rx="5.6" ry="4" fill="url(#pet-volume)" />
      {/* Both ears fall OVER the cheeks, at the outer edges of the head. Behind
          the head the near one vanished into the body, which is the same colour
          family; in front, each flap has an outline to separate it. */}
      <path
        d="M-19.5 -8.5 Q-27 -7.5 -26 3 Q-25 10.5 -20 8.5 Q-18 1.5 -19 -4.5 Z"
        fill={p.mark}
        stroke={p.line}
        strokeWidth="0.35"
        strokeOpacity="0.3"
      />
      <path
        d="M-8.5 -8.5 Q-1 -7.5 -2 3 Q-3 10.5 -8 8.5 Q-10 1.5 -9 -4.5 Z"
        fill={p.mark}
        stroke={p.line}
        strokeWidth="0.35"
        strokeOpacity="0.3"
      />
      {/* Closed eyes, level and symmetric about the muzzle */}
      <path
        d="M-18.6 -4.4 Q-17 -6.6 -15.4 -4.4"
        stroke={p.line}
        strokeWidth="0.9"
        fill="none"
      />
      <path
        d="M-12.6 -4.4 Q-11 -6.6 -9.4 -4.4"
        stroke={p.line}
        strokeWidth="0.9"
        fill="none"
      />
      {/* Brow dots - the markings that make a dog read as a dog */}
      <circle cx="-17" cy="-7.8" r="0.9" fill={p.mark} opacity="0.7" />
      <circle cx="-11" cy="-7.8" r="0.9" fill={p.mark} opacity="0.7" />
      {/* Nose and muzzle line */}
      <ellipse cx="-14" cy="-0.4" rx="2.3" ry="1.7" fill={p.nose} />
      <path d="M-14 1.3 L-14 2.4" stroke={p.nose} strokeWidth="0.5" />
      {p.tongue ? (
        <>
          <path
            d="M-15 3 Q-15.3 6.5 -14 6.5 Q-12.7 6.5 -13 3 Z"
            fill="#C4838C"
          />
          <path d="M-14 4.1 L-14 5.9" stroke="#A66C76" strokeWidth="0.35" />
        </>
      ) : (
        <path
          d="M-16.6 3.4 Q-14 4.9 -11.4 3.4"
          stroke={p.line}
          strokeWidth="0.5"
          fill="none"
          opacity="0.75"
        />
      )}
    </>
  );
}

function Rabbit({ p }: { p: PetPalette }) {
  return (
    <>
      {/* Cotton tail - white on every coat, that is what makes it a cottontail */}
      <circle cx="14" cy="-2" r="4.2" fill="#F6F1E8" />
      <circle cx="12.6" cy="-3" r="2.2" fill="#FFFFFF" opacity="0.55" />
      <ellipse cx="0" cy="0" rx="15" ry="9.5" fill={p.coat}>
        <animate
          attributeName="ry"
          values="9.5;10.2;9.5"
          dur="2.6s"
          repeatCount="indefinite"
        />
      </ellipse>
      <ellipse cx="0" cy="0" rx="15" ry="9.5" fill="url(#pet-volume)" />
      <path d="M-2 -7 Q5 -9 11 -5 Q4 -3 -2 -7 Z" fill={p.mark} opacity="0.55" />
      {/* Far ear, laid back */}
      <path d="M-14 -8 Q-20 -18 -16 -24 Q-11 -21 -11 -9 Z" fill={p.coat} />
      <path
        d="M-14.5 -10 Q-18 -18 -15.5 -22 Q-13 -19 -12.5 -10 Z"
        fill={p.inner}
        opacity="0.7"
      />
      <ellipse cx="-11" cy="-3" rx="7" ry="6.5" fill={p.coat} />
      <ellipse cx="-11" cy="-3" rx="7" ry="6.5" fill="url(#pet-volume)" />
      {/* Near ear, with an occasional twitch */}
      <g>
        <animateTransform
          attributeName="transform"
          type="rotate"
          values="0 -9.5 -8;0 -9.5 -8;10 -9.5 -8;-3 -9.5 -8;0 -9.5 -8;0 -9.5 -8"
          keyTimes="0;0.72;0.79;0.85;0.91;1"
          dur="5s"
          repeatCount="indefinite"
        />
        <path d="M-8 -8 Q-2 -18 -6 -24 Q-11 -21 -11 -9 Z" fill={p.coat} />
        <path
          d="M-7.5 -10 Q-4 -18 -6.5 -22 Q-9 -19 -9.5 -10 Z"
          fill={p.inner}
          opacity="0.7"
        />
      </g>
      {/* The eyes sat at different heights and the nose and whiskers were off
          at the left edge of the skull, as if the head were in profile while
          the eyes faced forward. All of it is now level and symmetric about the
          head's centre. */}
      <path
        d="M-14.6 -3.4 Q-13.3 -5.3 -12 -3.4"
        stroke={p.line}
        strokeWidth="0.85"
        fill="none"
      />
      <path
        d="M-10 -3.4 Q-8.7 -5.3 -7.4 -3.4"
        stroke={p.line}
        strokeWidth="0.85"
        fill="none"
      />
      {/* Nose over a rabbit's split lip */}
      <path d="M-12.3 0.5 L-11 -0.9 L-9.7 0.5 Z" fill={p.nose} />
      <path d="M-11 0.5 L-11 1.7" stroke={p.nose} strokeWidth="0.45" />
      <path
        d="M-12.9 2.6 Q-11 1.5 -11 1.7 Q-11 1.5 -9.1 2.6"
        stroke={p.nose}
        strokeWidth="0.45"
        fill="none"
      />
      {/* Whiskers, both sides */}
      <g stroke={p.line} strokeWidth="0.4" strokeOpacity="0.8">
        <line x1="-13.4" y1="0.8" x2="-19.4" y2="-0.6" />
        <line x1="-13.4" y1="1.8" x2="-19.4" y2="2.2" />
        <line x1="-8.6" y1="0.8" x2="-2.6" y2="-0.6" />
        <line x1="-8.6" y1="1.8" x2="-2.6" y2="2.2" />
      </g>
    </>
  );
}

function Tortoise({ p }: { p: PetPalette }) {
  return (
    <>
      {/* Back leg, tucked */}
      <rect x="6" y="1" width="7" height="5.5" rx="2.6" fill={p.inner} />
      {/* Tail */}
      <path d="M15 -1 L20 0 L15 2 Z" fill={p.inner} />
      {/* Shell - a dome on a flat plastron rim */}
      <path d="M-16 1 A16 12 0 0 1 16 1 Z" fill={p.coat}>
        <animate
          attributeName="d"
          values="M-16 1 A16 12 0 0 1 16 1 Z;M-16 1 A16 12.8 0 0 1 16 1 Z;M-16 1 A16 12 0 0 1 16 1 Z"
          dur="4.2s"
          repeatCount="indefinite"
        />
      </path>
      <path d="M-16 1 A16 12 0 0 1 16 1 Z" fill="url(#pet-volume)">
        <animate
          attributeName="d"
          values="M-16 1 A16 12 0 0 1 16 1 Z;M-16 1 A16 12.8 0 0 1 16 1 Z;M-16 1 A16 12 0 0 1 16 1 Z"
          dur="4.2s"
          repeatCount="indefinite"
        />
      </path>
      {/* Scutes, drawn as the seams between them: a vertebral row along the
          top, a costal row below it and the marginals around the rim. A fan of
          seams from the apex read as a beach ball; the three-row grid is what a
          shell actually is. */}
      <g
        stroke={p.mark}
        strokeWidth="0.85"
        fill="none"
        strokeOpacity="0.9"
        strokeLinecap="round"
      >
        <path d="M-12.4 -2.6 Q0 -13.6 12.4 -2.6" />
        <path d="M-15.4 0.4 Q0 -7 15.4 0.4" />
        <path d="M-4.6 -10.4 L-4.6 -7.4" />
        <path d="M4.6 -10.4 L4.6 -7.4" />
        <path d="M-8.6 -5.5 L-8.9 -2.2" />
        <path d="M0 -8.1 L0 -3.3" />
        <path d="M8.6 -5.5 L8.9 -2.2" />
        <path d="M-12.4 -0.9 L-13 0.7" />
        <path d="M-6.4 -2.7 L-6.6 0.9" />
        <path d="M0 -3.3 L0 1" />
        <path d="M6.4 -2.7 L6.6 0.9" />
        <path d="M12.4 -0.9 L13 0.7" />
      </g>
      <ellipse cx="0" cy="1" rx="16.6" ry="2.6" fill={p.mark} />
      {/* Front leg */}
      <rect x="-13" y="1" width="7.5" height="5.5" rx="2.6" fill={p.inner} />
      {/* Head, resting on the sand */}
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0;0.8 0.5;0 0"
          dur="6s"
          repeatCount="indefinite"
        />
        <ellipse cx="-18.6" cy="1.4" rx="6.2" ry="4.8" fill={p.inner} />
        <ellipse
          cx="-18.6"
          cy="1.4"
          rx="6.2"
          ry="4.8"
          fill="url(#pet-volume)"
        />
        {/* Neck folds where the head meets the shell */}
        <path
          d="M-13.6 -0.6 Q-14.6 1.4 -13.6 3.4"
          stroke={p.nose}
          strokeWidth="0.5"
          fill="none"
          strokeOpacity="0.6"
        />
        {/* Closed eye */}
        <path
          d="M-21.4 0.2 Q-20 -1.6 -18.6 0.2"
          stroke={p.line}
          strokeWidth="0.85"
          fill="none"
        />
        {/* Beak line and nostril */}
        <path
          d="M-23.8 2.8 Q-21 4.6 -18.2 3.4"
          stroke={p.line}
          strokeWidth="0.55"
          fill="none"
          strokeOpacity="0.75"
        />
        <circle cx="-23" cy="1.2" r="0.5" fill={p.line} fillOpacity="0.6" />
      </g>
    </>
  );
}

interface Pet {
  Species: (props: { p: PetPalette }) => ReactElement;
  /** What the animal sleeps in. Defaults to the round wicker basket. */
  Bed?: () => ReactElement;
  /** Whether it gives off the drifting z glyphs. Tortoises do not snore. */
  snores?: boolean;
}

/** The gradients and the blur every pet drawing paints with. Exported because
 *  the picker draws the same animals outside the scene: SVG ids resolve across
 *  the whole document, so borrowing the scene's defs would work until the day
 *  the scene is not mounted. Each surface renders its own. */
export function PetDefs() {
  return (
    <defs>
      {/* Volume, not colour: white and black stops over whatever coat the
            room drew, lit from the upper left like the rest of the scene.
            Painted in objectBoundingBox units, so one gradient rounds every
            body, head and shell. */}
      <radialGradient id="pet-volume" cx="0.34" cy="0.24" r="0.86">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.34" />
        <stop offset="0.42" stopColor="#FFFFFF" stopOpacity="0.06" />
        <stop offset="0.74" stopColor="#000000" stopOpacity="0.08" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.3" />
      </radialGradient>
      <radialGradient id="pet-cushion" cx="0.4" cy="0.28" r="0.82">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.24" />
        <stop offset="0.58" stopColor="#000000" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.3" />
      </radialGradient>
      <filter id="pet-soft" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
    </defs>
  );
}

/** The round wicker basket, which is what most of them sleep in. */
function Basket() {
  return (
    <>
      {/* Bed base */}
      <ellipse cx="0" cy="10" rx="26" ry="14" fill="#8B6B4A" />
      <ellipse cx="0" cy="10" rx="26" ry="14" fill="url(#pet-cushion)" />
      {/* Bed inner cushion */}
      <ellipse cx="0" cy="8" rx="23" ry="12" fill="#A0785A" />
      {/* Bed rim highlight */}
      <ellipse
        cx="0"
        cy="6"
        rx="23"
        ry="12"
        fill="none"
        stroke="#96704E"
        strokeWidth="1.5"
      />
      {/* Cushion surface */}
      <ellipse cx="0" cy="6" rx="20" ry="10" fill="#C4976A" />
      <ellipse cx="0" cy="6" rx="20" ry="10" fill="url(#pet-cushion)" />
    </>
  );
}

/** A sand tray. Solid fills only, like the dog's pad. */
function SandBox() {
  return (
    <>
      {/* An open box on the 2:1 isometric grid the floor uses: the rim is a
          diamond, not a face-on rectangle, and the two front walls carry its
          depth. Drawn face-on it read as a picture frame lying flat. Its sand
          sits where the tortoise's feet are, or the animal stands behind the
          box rather than in it. */}
      <path d="M0 -10 L28 4 L0 18 L-28 4 Z" fill="#A2825C" />
      {/* Front walls, the left one toward the window */}
      <path d="M-28 4 L0 18 L0 23.5 L-28 9.5 Z" fill="#8A6C48" />
      <path d="M28 4 L0 18 L0 23.5 L28 9.5 Z" fill="#6B5335" />
      {/* Sand, inset so the rim reads as wall thickness */}
      <path d="M0 -6 L23 5 L0 16 L-23 5 Z" fill="#C8B183" />
      <path d="M0 -3.6 L19.5 6 L0 14.6 L-19.5 6 Z" fill="#E4D4A9" />
      {/* Grains */}
      <g fill="#BFA97F" fillOpacity="0.6">
        <ellipse cx="-9" cy="8.4" rx="1.1" ry="0.6" />
        <ellipse cx="3" cy="11" rx="0.9" ry="0.5" />
        <ellipse cx="11" cy="7.2" rx="1.2" ry="0.65" />
        <ellipse cx="-2" cy="5.6" rx="0.8" ry="0.45" />
      </g>
      {/* A pebble each side */}
      <ellipse cx="-14" cy="6.6" rx="3" ry="1.7" fill="#948A7E" />
      <ellipse cx="-14.6" cy="6" rx="1.9" ry="1" fill="#B0A69A" />
      <ellipse cx="14" cy="8.4" rx="2.3" ry="1.3" fill="#948A7E" />
      <ellipse cx="13.5" cy="7.9" rx="1.4" ry="0.8" fill="#B0A69A" />
    </>
  );
}

/** A bolstered fabric pad. Lower and squarer than the basket, and shaded with
 *  solid shapes rather than the gradients, so it draws the same either way. */
function DogBed() {
  return (
    <>
      {/* Bolster */}
      <path
        d="M-15 -4 L15 -4 Q30 -4 30 6 Q30 18 15 18 L-15 18 Q-30 18 -30 6 Q-30 -4 -15 -4 Z"
        fill="#3F5652"
      />
      {/* Lit top of the bolster */}
      <path
        d="M-15 -4 L15 -4 Q30 -4 30 6 Q30 9 27 10.5 Q26.5 1.5 15 0.5 L-15 0.5 Q-26.5 1.5 -27 10.5 Q-30 9 -30 6 Q-30 -4 -15 -4 Z"
        fill="#5A7772"
      />
      {/* Cushion */}
      <path
        d="M-14 0.5 L14 0.5 Q26 0.5 26 8 Q26 16 14 16 L-14 16 Q-26 16 -26 8 Q-26 0.5 -14 0.5 Z"
        fill="#A87F58"
      />
      {/* Lit surface of the cushion */}
      <path
        d="M-13 2.2 L13 2.2 Q24 2.2 24 8.6 Q24 14.6 13 14.6 L-13 14.6 Q-24 14.6 -24 8.6 Q-24 2.2 -13 2.2 Z"
        fill="#C4976A"
      />
    </>
  );
}

// Order is load-bearing: the room's position in the room list picks the entry,
// so appending a species keeps every earlier room's pet and adding one in the
// middle reshuffles them all.
/** How each species is drawn. The coats it is drawn IN live in shared/pets.ts,
 *  because the server validates a requested coat index against them. */
export const PETS: Record<PetSpecies, Pet> = {
  cat: { Species: Cat },
  dog: { Species: Dog, Bed: DogBed },
  rabbit: { Species: Rabbit },
  tortoise: { Species: Tortoise, Bed: SandBox, snores: false },
};

/** The coat a room actually draws in.
 *
 *  Total over its input on purpose. The server validates a coat index when it
 *  is written, but it cannot validate one already on disk, and coat lists here
 *  do get shorter - the duck and the black rabbit both went in this lane. A
 *  room persisted against a longer list would otherwise index past the end and
 *  draw the animal with undefined fills. Out of range falls back to the first
 *  coat, which is the same thing an unset pet draws. */
export function coatFor(pet: RoomPet): PetPalette {
  // Both lookups fall back, not just the coat. An unknown species makes
  // PET_PALETTES[species] undefined, and indexing THAT throws before the coat's
  // ?? can run - so a species this build does not know is a render-time crash
  // for everyone in the room, not a wrong-looking pet.
  const palettes =
    PET_PALETTES[pet.species] ?? PET_PALETTES[DEFAULT_ROOM_PET.species];
  return palettes[pet.coat] ?? palettes[0];
}

/** The pet bed in the south corner, with whichever animal this room keeps. */
export function PetCorner({
  pet,
  onClick,
}: {
  pet: RoomPet | null;
  onClick?: (x: number, y: number) => void;
}) {
  const chosen = pet ?? DEFAULT_ROOM_PET;
  const drawing = PETS[chosen.species] ?? PETS[DEFAULT_ROOM_PET.species];
  const palette = coatFor(chosen);
  const Species = drawing.Species;
  const Bed = drawing.Bed ?? Basket;
  const snores = drawing.snores ?? true;
  return (
    <g
      transform="translate(120, 460)"
      // The props svg sets pointerEvents none, so the pet opts back in on its
      // own. data-no-pan keeps the click off the viewport's pan handler, the
      // same marker the wall panels use; the desks never see it because they
      // are separate elements, not ancestors.
      data-no-pan
      onClick={onClick ? (e) => onClick(e.clientX, e.clientY) : undefined}
      style={onClick ? { pointerEvents: "auto", cursor: "pointer" } : undefined}
    >
      <PetDefs />
      {/* Shadow the bed drops on the floor */}
      <ellipse
        cx="2"
        cy="15"
        rx="27"
        ry="13.5"
        fill="#000"
        opacity="0.2"
        filter="url(#pet-soft)"
      />
      <Bed />
      {/* Where the sleeper presses into the cushion */}
      <ellipse
        cx="0"
        cy="5"
        rx="16"
        ry="5.5"
        fill="#000"
        opacity="0.24"
        filter="url(#pet-soft)"
      />
      <Species p={palette} />
      {snores && (
        <>
          {/* Zzz - clear of the tallest sleeper's ears */}
          <text
            x="4"
            y="-15"
            fontSize="6"
            fill="rgba(200,220,255,0.5)"
            fontFamily="monospace"
            fontWeight="bold"
          >
            <animate
              attributeName="y"
              values="-15;-19;-15"
              dur="2.5s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.3;0.7;0.3"
              dur="2.5s"
              repeatCount="indefinite"
            />
            z
          </text>
          <text
            x="10"
            y="-21"
            fontSize="5"
            fill="rgba(200,220,255,0.4)"
            fontFamily="monospace"
            fontWeight="bold"
          >
            <animate
              attributeName="y"
              values="-21;-25;-21"
              dur="3s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.2;0.6;0.2"
              dur="3s"
              repeatCount="indefinite"
            />
            z
          </text>
        </>
      )}
    </g>
  );
}

export function RoomProps() {
  const { currentRoomId, rooms } = useAppState();
  const room = rooms.find((r) => r.id === currentRoomId);
  const isLastRoom = rooms[rooms.length - 1]?.id === currentRoomId;
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const pet = room?.pet ?? null;

  // No optimistic write: the room projection broadcasts room_pet_updated to
  // every client, so the scene repaints from the same event everyone else gets.
  // PATCH carries no version handshake, so two people picking at once is
  // last-write-wins - accepted for a pet.
  function pick(next: RoomPet | null) {
    setPicker(null);
    if (!currentRoomId) return;
    const body: RoomRenameReq = { pet: next };
    apiFetch<void>("PATCH", `/api/rooms/${currentRoomId}`, body).catch(
      () => {},
    );
  }

  return (
    <>
      <PropsScene
        pet={pet}
        isLastRoom={isLastRoom}
        onPetClick={(x, y) => setPicker({ x, y })}
      />
      {picker && (
        <PetPicker
          x={picker.x}
          y={picker.y}
          pet={pet}
          onPick={pick}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

// useAppState is the whole-state context, so RoomProps re-renders on every
// action, log_entry included. Reducing to the two values the scene actually
// depends on before the memo boundary keeps that traffic from re-reconciling
// the prop SVG.
const PropsScene = memo(function PropsScene({
  pet,
  isLastRoom,
  onPetClick,
}: {
  pet: RoomPet | null;
  isLastRoom: boolean;
  onPetClick: (x: number, y: number) => void;
}) {
  return (
    <svg
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={`${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`}
      overflow="visible"
    >
      {/* Potted plant - west corner of office. Drawn in ui/office/plants.tsx,
          which the window plant and the desk plants also draw from. */}
      <g transform="translate(-245, 212) scale(1.5)">
        <CornerPlant />
      </g>

      {/* Water cooler - near right wall, only in last room (no right door) */}
      {isLastRoom && (
        <g transform="translate(540, 225) scale(1.5)">
          {/* Water jug (behind body) */}
          <rect
            x="-5"
            y="-12"
            width="10"
            height="14"
            rx="2"
            fill="var(--room-prop-accent)"
          />
          <ellipse
            cx="0"
            cy="-12"
            rx="6"
            ry="2"
            fill="var(--room-prop-accent)"
            opacity="0.8"
          />
          {/* Body */}
          <rect
            x="-9"
            y="0"
            width="18"
            height="30"
            rx="2"
            fill="var(--room-prop-body)"
            stroke="var(--border-subtle)"
            strokeWidth="0.5"
          />
          {/* Tap buttons */}
          <circle cx="-3" cy="18" r="2" fill="#5a9ada" />
          <circle cx="3" cy="18" r="2" fill="#e87090" />
          {/* Base */}
          <rect
            x="-7"
            y="30"
            width="14"
            height="4"
            rx="1"
            fill="var(--room-prop-base)"
          />
        </g>
      )}

      {/* Sleepy office pet - south corner of office */}
      <PetCorner pet={pet} onClick={onPetClick} />
    </svg>
  );
});

import type { ComponentType } from "react";
import type { AgentOutfit } from "../../../shared/types.ts";
import { EmployeePlaque } from "./props-plaque.tsx";
import {
  SofaBoxy,
  SofaLoveseat,
  SofaChesterfield,
  ArmchairClub,
  ArmchairEgg,
} from "./props-seating.tsx";
import {
  TableRound,
  TableGlass,
  FireplaceBrick,
  FireplaceModern,
  BookshelfTall,
  Credenza,
  FishTankStand,
  FishBowl,
  LampArc,
  LampTripod,
} from "./props-furniture.tsx";
import {
  RugOval,
  RugRect,
  RugRound,
  PlantCorner,
  PlantMonstera,
  Bunting,
  FramedPoster,
  CatCurled,
  CatSitting,
  DirectoryBoard,
  DirectorySign,
  ReceptionCounter,
  type DirectoryRoom,
} from "./props-decor.tsx";

// Registry of every prop and its variants. Layouts (slice 3) place variants
// by id; the contact sheet renders them all. Floor props anchor at their
// floor contact centre; wall props anchor at the wall contact point and are
// drawn in the wall plane.

export interface PropStar {
  name: string;
  outfit: AgentOutfit;
}

export interface PropContext {
  rooms: DirectoryRoom[];
  officeName: string;
  wall: "left" | "right";
  // Employee of the Minute, office-wide; null hides the plaque's portrait.
  star: PropStar | null;
  // "near" means the piece is seen from behind: its backrest stands between
  // the viewer and its seat. Only the upholstered pieces use it.
  back: "far" | "near";
}

export interface PropVariant {
  id: string;
  label: string;
  Component: ComponentType<PropContext>;
  // Contact shadow ellipse (screen units). Absent for wall pieces and rugs.
  shadow?: { rx: number; ry: number };
  wall?: boolean;
  // Carries text or an asymmetric design that must not be mirrored.
  noFlip?: boolean;
  // How many ways this prop can face. 4 means it has a drawn back, so it can
  // be turned around (the upholstered pieces and the counter); 2 means it can
  // only be mirrored left to right; 1 means it always looks the same. Default:
  // 2, or 1 when the prop must not be mirrored.
  facings?: 1 | 2 | 4;
  // Approximate screen height above the anchor, used by the sheet to frame.
  height: number;
}

export interface PropFamily {
  id: string;
  label: string;
  variants: PropVariant[];
}

const noCtx = (C: ComponentType) => {
  const Wrapped = () => <C />;
  Wrapped.displayName = C.name;
  return Wrapped as ComponentType<PropContext>;
};

export const LOBBY_PROPS: PropFamily[] = [
  {
    id: "sofa",
    label: "Sofa",
    variants: [
      {
        id: "boxy",
        facings: 4,
        label: "Boxy slate",
        Component: ({ back }) => <SofaBoxy back={back} />,
        shadow: { rx: 66, ry: 30 },
        height: 60,
      },
      {
        id: "loveseat",
        facings: 4,
        label: "Mustard loveseat",
        Component: ({ back }) => <SofaLoveseat back={back} />,
        shadow: { rx: 54, ry: 26 },
        height: 60,
      },
      {
        id: "chesterfield",
        facings: 4,
        label: "Oxblood chesterfield",
        Component: ({ back }) => <SofaChesterfield back={back} />,
        shadow: { rx: 70, ry: 32 },
        height: 62,
      },
    ],
  },
  {
    id: "armchair",
    label: "Armchair",
    variants: [
      {
        id: "club",
        facings: 4,
        label: "Leather club",
        Component: ({ back }) => <ArmchairClub back={back} />,
        shadow: { rx: 36, ry: 20 },
        height: 56,
      },
      {
        id: "egg",
        label: "Sage egg chair",
        Component: noCtx(ArmchairEgg),
        shadow: { rx: 22, ry: 11 },
        height: 70,
      },
    ],
  },
  {
    id: "table",
    label: "Coffee table",
    variants: [
      {
        id: "round",
        label: "Round wood",
        Component: noCtx(TableRound),
        shadow: { rx: 26, ry: 13 },
        height: 34,
      },
      {
        id: "glass",
        label: "Glass rectangle",
        Component: noCtx(TableGlass),
        shadow: { rx: 40, ry: 20 },
        height: 32,
      },
    ],
  },
  {
    id: "fireplace",
    label: "Fireplace",
    variants: [
      {
        id: "brick",
        label: "Brick with mantel",
        Component: noCtx(FireplaceBrick),
        shadow: { rx: 48, ry: 22 },
        height: 100,
      },
      {
        id: "modern",
        label: "Stone slab",
        Component: noCtx(FireplaceModern),
        shadow: { rx: 60, ry: 24 },
        height: 70,
      },
    ],
  },
  {
    id: "shelf",
    label: "Shelving",
    variants: [
      {
        id: "tall",
        label: "Tall bookcase",
        Component: noCtx(BookshelfTall),
        shadow: { rx: 32, ry: 16 },
        height: 90,
      },
      {
        id: "credenza",
        label: "Credenza",
        Component: noCtx(Credenza),
        shadow: { rx: 42, ry: 20 },
        height: 50,
      },
    ],
  },
  {
    id: "tank",
    label: "Fish",
    variants: [
      {
        id: "stand",
        label: "Tank on stand",
        Component: noCtx(FishTankStand),
        shadow: { rx: 32, ry: 16 },
        height: 68,
      },
      {
        id: "bowl",
        label: "Bowl on side table",
        Component: noCtx(FishBowl),
        shadow: { rx: 18, ry: 9 },
        height: 52,
      },
    ],
  },
  {
    id: "lamp",
    label: "Floor lamp",
    variants: [
      {
        id: "arc",
        label: "Arc lamp",
        Component: noCtx(LampArc),
        shadow: { rx: 13, ry: 6.5 },
        height: 118,
      },
      {
        id: "tripod",
        label: "Tripod drum",
        Component: noCtx(LampTripod),
        shadow: { rx: 16, ry: 8 },
        height: 84,
      },
    ],
  },
  {
    id: "rug",
    label: "Rug",
    variants: [
      {
        id: "oval",
        facings: 1,
        label: "Oval welcome",
        Component: noCtx(RugOval),
        noFlip: true,
        height: 26,
      },
      {
        id: "rect",
        facings: 1,
        label: "Striped kilim",
        Component: noCtx(RugRect),
        height: 40,
      },
      {
        id: "round",
        facings: 1,
        label: "Braided round",
        Component: noCtx(RugRound),
        height: 22,
      },
    ],
  },
  {
    id: "plant",
    label: "Plant",
    variants: [
      {
        id: "corner",
        label: "Office corner plant",
        Component: noCtx(PlantCorner),
        shadow: { rx: 25, ry: 12.5 },
        height: 90,
      },
      {
        id: "monstera",
        label: "Monstera",
        Component: noCtx(PlantMonstera),
        shadow: { rx: 18, ry: 9 },
        height: 70,
      },
    ],
  },
  {
    id: "wallart",
    label: "Wall piece",
    variants: [
      {
        id: "bunting",
        label: "Welcome bunting",
        Component: ({ wall }) => <Bunting wall={wall} />,
        wall: true,
        noFlip: true,
        height: 50,
      },
      {
        id: "poster",
        label: "Framed poster",
        Component: ({ wall }) => <FramedPoster wall={wall} />,
        wall: true,
        noFlip: true,
        height: 70,
      },
    ],
  },
  {
    id: "cat",
    label: "Cat",
    variants: [
      {
        id: "curled",
        label: "Curled tabby",
        Component: noCtx(CatCurled),
        shadow: { rx: 18, ry: 8 },
        height: 18,
      },
      {
        id: "sitting",
        label: "Sitting grey",
        Component: noCtx(CatSitting),
        shadow: { rx: 12, ry: 5 },
        height: 40,
      },
    ],
  },
  {
    id: "directory",
    label: "Directory",
    variants: [
      {
        id: "board",
        label: "Wall bulletin",
        Component: ({ wall, rooms, officeName }) => (
          <DirectoryBoard wall={wall} rooms={rooms} officeName={officeName} />
        ),
        wall: true,
        noFlip: true,
        height: 70,
      },
      {
        id: "sign",
        label: "A-frame chalkboard",
        Component: ({ rooms, officeName }) => (
          <DirectorySign rooms={rooms} officeName={officeName} />
        ),
        shadow: { rx: 20, ry: 9 },
        noFlip: true,
        height: 56,
      },
    ],
  },
  {
    id: "plaque",
    label: "Employee of the Minute",
    variants: [
      {
        id: "framed",
        label: "Framed portrait",
        Component: ({ wall, star }) =>
          star ? (
            <EmployeePlaque wall={wall} name={star.name} outfit={star.outfit} />
          ) : (
            <g />
          ),
        wall: true,
        noFlip: true,
        height: 70,
      },
    ],
  },
  {
    id: "counter",
    label: "Reception",
    variants: [
      {
        id: "counter",
        facings: 4,
        label: "Wood counter",
        Component: ({ back }) => <ReceptionCounter back={back} />,
        shadow: { rx: 66, ry: 30 },
        height: 60,
      },
    ],
  },
];

/** How many ways a prop can face: see PropVariant.facings. */
export function variantFacings(v: PropVariant): 1 | 2 | 4 {
  return v.facings ?? (v.noFlip ? 1 : 2);
}

export function findVariant(
  familyId: string,
  variantId: string,
): PropVariant | undefined {
  return LOBBY_PROPS.find((f) => f.id === familyId)?.variants.find(
    (v) => v.id === variantId,
  );
}

// Shared defs a scene or sheet must include once so props can reference them.
export function PropDefs() {
  return (
    <defs>
      <linearGradient id="lobby-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
        <stop offset="0.45" stopColor="#fff" stopOpacity="0.02" />
        <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
      </linearGradient>
    </defs>
  );
}

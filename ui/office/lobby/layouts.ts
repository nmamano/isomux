// Room layouts: where each prop stands. Floor placements are in FLOOR TILE
// units, `a` along COL (0 at the back corner, 10 at the right corner) and
// `b` along ROW (0 at the back corner, 10 at the left corner), so the right
// wall is the plane b = 0 and the left wall is the plane a = 0. Wall
// placements give the tile coordinate along their wall and a height `h`.
//
// `flip` mirrors a prop across the vertical screen axis, which swaps its
// a and b faces: a sofa that faces down-left faces down-right instead. Props
// with text are never flipped (the registry marks them noFlip).

export type LobbyLayoutId = "fireside" | "lounge" | "nook" | "nilo";

export interface Placement {
  family: string;
  variant: string;
  a: number;
  b: number;
  wall?: "left" | "right";
  h?: number;
  flip?: boolean;
  // Which way a piece faces. "SE" is the default: the front towards the
  // viewer's lower right. "SW" mirrors it left to right; "NE" and "NW" turn it
  // around so the piece is seen from behind. Props that have no back (a rug, a
  // cat) ignore it.
  facing?: "SE" | "SW" | "NE" | "NW";
  scale?: number;
  // Painter's order nudge. Floor props are drawn back to front by a + b, so a
  // prop that should pass in front of (or behind) its neighbour without moving
  // adds to that depth: positive draws it later, in front. Wall props ignore
  // it - they are drawn before every floor prop, in list order.
  z?: number;
}

export interface LayoutSpec {
  id: LobbyLayoutId;
  label: string;
  blurb: string;
  placements: Placement[];
  // Where the receptionist stands (floor tile units). The scene draws whatever
  // the mount passes for it at this spot, in painter's order with the props.
  receptionist: { a: number; b: number };
  // Saved positions for the ghost follow-up. No live consumer yet: rendering,
  // placement and movement ship together (PM ruling, 2026-09-08).
  ghostSpots: Array<{ a: number; b: number; what?: string }>;
}

export const LOBBY_LAYOUTS: Record<LobbyLayoutId, LayoutSpec> = {
  // Saved profile copied without rounding its coordinates.
  nilo: {
    id: "nilo",
    label: "nilo",
    blurb: "Nil's saved lobby layout.",
    receptionist: {
      a: 3.0752409282483546,
      b: 0.437621427837171,
    },
    ghostSpots: [
      {
        a: 0.15,
        b: 4.35,
        what: "blue sofa, left seat",
      },
      {
        a: 1.25,
        b: 4.35,
        what: "blue sofa, right seat",
      },
      {
        a: 7.36,
        b: 5.35,
        what: "armchair by the tripod lamp",
      },
      {
        a: 5.58,
        b: 7.3,
        what: "armchair facing SW",
      },
      {
        a: 9.12,
        b: 7.2,
        what: "armchair facing NW",
      },
      {
        a: 6.7,
        b: 9.15,
        what: "chesterfield, left seat",
      },
      {
        a: 7.9,
        b: 9.15,
        what: "chesterfield, right seat",
      },
      {
        a: 1.35,
        b: 1.35,
        what: "at the fish tank, under the cat",
      },
      {
        a: 1.25,
        b: 8.85,
        what: "in front of the bookshelf",
      },
      {
        a: 1.4,
        b: 6.55,
        what: "at the record player",
      },
    ],
    placements: [
      {
        family: "wallart",
        variant: "bunting",
        a: 5.7824565686677625,
        b: 0,
        wall: "right",
        h: 177.9259490966797,
      },
      {
        family: "rug",
        variant: "rect",
        a: 4.439374743009868,
        b: 2.3200760690789473,
        scale: 1.05,
      },
      {
        family: "shelf",
        variant: "credenza",
        a: 0.4020448383532077,
        b: 6.672318468595807,
        flip: true,
        scale: 1.15,
      },
      {
        family: "counter",
        variant: "counter",
        a: 4.465497789884868,
        b: 1.7617932771381581,
      },
      {
        family: "tank",
        variant: "stand",
        a: 0.4266087582236842,
        b: 0.8064324629934219,
        flip: true,
        scale: 1.15,
      },
      {
        family: "cat",
        variant: "sitting",
        a: -1.545809133429276,
        b: -1.6015605725740127,
        scale: 0.75,
        z: 5.5,
      },
      {
        family: "sofa",
        variant: "boxy",
        a: 0.6818719161184215,
        b: 4.014033588610198,
        flip: true,
        scale: 1,
      },
      {
        family: "table",
        variant: "glass",
        a: 2.4736861379523045,
        b: 4.25341218647204,
        scale: 1.1,
        flip: true,
      },
      {
        family: "lamp",
        variant: "arc",
        a: 0.5292393734580602,
        b: 1.9996103387129938,
        scale: 0.85,
      },
      {
        family: "plant",
        variant: "corner",
        a: 1.5693947239925983,
        b: 0.49512521844161306,
        scale: 0.85,
      },
      {
        family: "cat",
        variant: "curled",
        a: 0.04288426449424243,
        b: 3.450291844418175,
        flip: true,
        scale: 0.9,
        z: 3.5,
      },
      {
        family: "directory",
        variant: "board",
        a: 7.157894736842105,
        b: 0,
        wall: "right",
        h: 59.9259033203125,
        scale: 0.8,
      },
      {
        family: "plaque",
        variant: "framed",
        a: 0,
        b: 3.9157894736842107,
        wall: "left",
        h: 103.5,
      },
      {
        family: "rug",
        variant: "oval",
        a: 3.2,
        b: 7.726315789473685,
        scale: 1.1,
      },
      {
        family: "rug",
        variant: "round",
        a: 7.378947368421053,
        b: 6.91578947368421,
        scale: 1.65,
      },
      {
        family: "armchair",
        variant: "club",
        a: 7.3578947368421055,
        b: 5.08421052631579,
      },
      {
        family: "armchair",
        variant: "club",
        a: 5.578947368421052,
        b: 7,
        facing: "SW",
      },
      {
        family: "armchair",
        variant: "club",
        a: 9.115789473684211,
        b: 6.905263157894737,
        facing: "NW",
      },
      {
        family: "lamp",
        variant: "tripod",
        a: 8.65263157894737,
        b: 5.389473684210526,
      },
      {
        family: "table",
        variant: "round",
        a: 7.347368421052631,
        b: 6.905263157894737,
      },
      {
        family: "shelf",
        variant: "tall",
        a: 0.23157894736842088,
        b: 9.010526315789475,
        facing: "SW",
      },
      {
        family: "sofa",
        variant: "chesterfield",
        a: 7.336842105263158,
        b: 9.4,
        facing: "NE",
      },
      {
        family: "plant",
        variant: "monstera",
        a: -0.5473684210526313,
        b: 6.252631578947367,
        scale: 0.35,
        z: 5,
      },
    ],
  },
  fireside: {
    id: "fireside",
    label: "Fireside",
    blurb: "Brick fireplace, chesterfield, a rug and a cat.",
    // By the back wall between the bookcase and the fireplace, where nothing
    // in front of it paints over it.
    receptionist: { a: 3.8, b: 1.2 },
    ghostSpots: [
      { a: 2.6, b: 4.6 }, // standing at the end of the chesterfield
      { a: 5.6, b: 4.4 }, // by the coffee table, facing the fire
      { a: 7.2, b: 5.6 }, // beside the club armchair
      { a: 4.4, b: 7.4 }, // out on the open floor, front of the rug
      { a: 7.8, b: 2.6 }, // warming by the hearth
      { a: 1.7, b: 6.4 }, // near the bookcase end of the room
    ],
    placements: [
      {
        family: "wallart",
        variant: "bunting",
        a: 0,
        b: 2.2,
        wall: "left",
        h: 140,
      },
      {
        family: "directory",
        variant: "board",
        a: 7.2,
        b: 0,
        wall: "right",
        h: 56,
      },
      {
        family: "plaque",
        variant: "framed",
        a: 5.4,
        b: 0,
        wall: "right",
        h: 78,
      },
      { family: "rug", variant: "rect", a: 5.4, b: 5.6, scale: 1.1 },
      { family: "plant", variant: "corner", a: 0.75, b: 0.75 },
      { family: "shelf", variant: "tall", a: 0.4, b: 3.2, flip: true },
      { family: "fireplace", variant: "brick", a: 5.2, b: 0.42 },
      { family: "lamp", variant: "arc", a: 1.3, b: 3.9 },
      { family: "sofa", variant: "chesterfield", a: 2.4, b: 5.6, flip: true },
      { family: "table", variant: "round", a: 5.0, b: 5.4 },
      { family: "armchair", variant: "club", a: 7.4, b: 6.4 },
      { family: "cat", variant: "curled", a: 6.4, b: 4.6 },
      { family: "plant", variant: "monstera", a: 8.6, b: 3.4 },
    ],
  },
  lounge: {
    id: "lounge",
    label: "Lounge",
    blurb: "Reception counter, boxy sofa, fish tank and a record player.",
    // Behind the counter: a smaller depth than the counter's, so the counter
    // paints over the figure's legs.
    receptionist: { a: 3.6, b: 0.1 },
    ghostSpots: [
      { a: 4.6, b: 1.9 }, // at the counter, being served
      { a: 2.9, b: 5.2 }, // standing by the sofa arm
      { a: 6.2, b: 6.2 }, // beside the egg chair
      { a: 4.9, b: 7.6 }, // in front of the glass table
      { a: 1.5, b: 6.6 }, // by the fish tank
      { a: 7.8, b: 3.4 }, // near the directory sign
    ],
    placements: [
      {
        family: "wallart",
        variant: "poster",
        a: 0,
        b: 2.3,
        wall: "left",
        h: 70,
      },
      {
        family: "wallart",
        variant: "bunting",
        a: 5.0,
        b: 0,
        wall: "right",
        h: 118,
      },
      {
        family: "plaque",
        variant: "framed",
        a: 7.6,
        b: 0,
        wall: "right",
        h: 80,
      },
      { family: "rug", variant: "round", a: 5.0, b: 5.8, scale: 1.15 },
      { family: "shelf", variant: "credenza", a: 0.45, b: 2.3, flip: true },
      { family: "counter", variant: "counter", a: 3.6, b: 0.6 },
      { family: "tank", variant: "stand", a: 0.45, b: 4.9, flip: true },
      { family: "directory", variant: "sign", a: 5.6, b: 1.7 },
      { family: "cat", variant: "sitting", a: 8.2, b: 1.2 },
      { family: "sofa", variant: "boxy", a: 2.6, b: 6.4, flip: true },
      { family: "table", variant: "glass", a: 4.9, b: 6.0 },
      { family: "armchair", variant: "egg", a: 6.6, b: 5.2 },
      { family: "lamp", variant: "tripod", a: 8.3, b: 4.2 },
      { family: "plant", variant: "monstera", a: 0.9, b: 7.8 },
    ],
  },
  nook: {
    id: "nook",
    label: "Reading nook",
    blurb:
      "Loveseat under the window, egg chairs, stone fireplace, bookshelves.",
    receptionist: { a: 3.4, b: 1.2 },
    ghostSpots: [
      { a: 1.6, b: 6.2 }, // at the loveseat, by the window
      { a: 4.6, b: 5.0 }, // between the egg chairs
      { a: 6.2, b: 6.0 }, // behind the second egg chair
      { a: 5.4, b: 2.6 }, // by the stone fireplace
      { a: 3.0, b: 7.8 }, // on the welcome rug
      { a: 8.0, b: 4.0 }, // reading the directory
    ],
    placements: [
      {
        family: "wallart",
        variant: "bunting",
        a: 4.9,
        b: 0,
        wall: "right",
        h: 128,
      },
      {
        family: "directory",
        variant: "board",
        a: 7.3,
        b: 0,
        wall: "right",
        h: 56,
      },
      {
        family: "plaque",
        variant: "framed",
        a: 5.5,
        b: 0,
        wall: "right",
        h: 78,
      },
      { family: "rug", variant: "oval", a: 5.2, b: 7.4, scale: 1.05 },
      { family: "plant", variant: "corner", a: 0.75, b: 0.75 },
      { family: "shelf", variant: "tall", a: 0.4, b: 1.9, flip: true },
      { family: "shelf", variant: "credenza", a: 0.45, b: 3.7, flip: true },
      { family: "tank", variant: "bowl", a: 0.55, b: 5.4 },
      { family: "sofa", variant: "loveseat", a: 0.75, b: 7.3, flip: true },
      { family: "fireplace", variant: "modern", a: 4.9, b: 0.4 },
      { family: "cat", variant: "curled", a: 5.0, b: 1.9 },
      { family: "armchair", variant: "egg", a: 5.6, b: 4.2 },
      { family: "armchair", variant: "egg", a: 3.6, b: 6.2 },
      { family: "plant", variant: "monstera", a: 8.7, b: 3.6 },
    ],
  },
};

export const LOBBY_LAYOUT_IDS = Object.keys(LOBBY_LAYOUTS) as LobbyLayoutId[];

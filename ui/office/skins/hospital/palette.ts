import type { ThemeMode } from "../../../themes.ts";

// The colours of the hospital's own drawings: the wainscot, the first-aid
// cabinet, the beds, the IV stand and the curtain. They are not part of any
// theme, so only the mode matters: every theme in ui/themes.ts declares
// whether it is a dark or a light one. The walls and the floor are not here:
// the hospital's green is the "clinic" room tint (../tint.ts), the one path
// every room colour takes.

/** What the skin's OWN drawings are painted in: the wainscot on the walls, the
 *  first-aid cabinet, the beds, the IV stand and the curtain. */
export interface HospitalColors {
  wainscot: string;
  wainscotShade: string;
  rail: string;
  cross: string;
  crossPlate: string;
  crossPlateEdge: string;
  frame: string;
  frameShade: string;
  mattress: string;
  mattressShade: string;
  linen: string;
  linenShade: string;
  pillow: string;
  blanket: string;
  blanketShade: string;
  metal: string;
  metalShade: string;
  fluid: string;
  curtain: string;
  curtainShade: string;
  shadow: string;
}

const DAY_COLORS: HospitalColors = {
  wainscot: "#93b8ac",
  wainscotShade: "#82a99d",
  rail: "#4a786d",
  cross: "#d8453f",
  crossPlate: "#f2f7f5",
  crossPlateEdge: "#c3d3ce",
  frame: "#a3b2b6",
  frameShade: "#7c8c90",
  mattress: "#dde7e8",
  mattressShade: "#c2cfd0",
  linen: "#fdffff",
  linenShade: "#b3c3c4",
  pillow: "#ffffff",
  blanket: "#7aa8c2",
  blanketShade: "#5a8aa4",
  metal: "#a8b5ba",
  metalShade: "#7a898e",
  fluid: "#dceaf2",
  curtain: "#a9cfc6",
  curtainShade: "#8ab5ab",
  shadow: "rgba(20,50,44,0.18)",
};

const NIGHT_COLORS: HospitalColors = {
  wainscot: "#303446",
  wainscotShade: "#292d3d",
  rail: "#51566e",
  cross: "#9e3833",
  crossPlate: "#303739",
  crossPlateEdge: "#202628",
  frame: "#4a5a5e",
  frameShade: "#33403f",
  mattress: "#5b6a6c",
  mattressShade: "#44504f",
  linen: "#6d7c7c",
  linenShade: "#4f5c5b",
  pillow: "#7d8c8b",
  blanket: "#3f6274",
  blanketShade: "#2e4a58",
  metal: "#5a686c",
  metalShade: "#3d4948",
  fluid: "#4d6673",
  curtain: "#3a5a54",
  curtainShade: "#2b433f",
  shadow: "rgba(0,0,0,0.34)",
};

export function hospitalColors(mode: ThemeMode): HospitalColors {
  return mode === "light" ? DAY_COLORS : NIGHT_COLORS;
}

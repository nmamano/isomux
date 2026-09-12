import type { ThemeMode } from "../../../themes.ts";

// The hospital keeps one identity - clinical green-white by day, the same room
// with the lights down at night - under every theme, the way the lobby does
// (ui/office/lobby/palette.ts). Only the mode matters: every theme in
// ui/themes.ts declares whether it is a dark or a light one, and the skin
// follows that and nothing else.
//
// Two maps, because they are read in two different ways. `hospitalSceneVars`
// overrides theme variables the existing scene already paints itself from, so
// the floor and the walls change with no branch in Floor.tsx. `hospitalColors`
// is read by the skin's own drawings, which are not part of any theme.
//
// The derived faces keep the theme's own rule - caps face up and are brightest,
// the left cut and left slab sides face lower-left, their right counterparts
// lower-right and are darkest - and keep the theme's expressions verbatim, base
// colour aside. A var() inside a custom property resolves on the element that
// DECLARES it, and these are declared on the scene container next to the bases
// below, so they mix against the hospital's floor and walls, not the theme's.

const DAY: Record<string, string> = {
  "--floor-light": "#e7efea",
  "--floor-dark": "#dbe6e0",
  "--floor-edge-light-left":
    "color-mix(in srgb, var(--floor-light) 92%, black)",
  "--floor-edge-dark-left": "color-mix(in srgb, var(--floor-dark) 92%, black)",
  "--floor-edge-light-right":
    "color-mix(in srgb, var(--floor-light) 84%, black)",
  "--floor-edge-dark-right": "color-mix(in srgb, var(--floor-dark) 84%, black)",
  "--floor-stroke": "rgba(24,64,54,0.07)",
  "--wall-left": "#d7e5e0",
  "--wall-right": "#cbdbd5",
  "--wall-top-left": "color-mix(in srgb, var(--wall-left) 88%, white)",
  "--wall-top-right": "color-mix(in srgb, var(--wall-right) 88%, white)",
  "--wall-end-left": "color-mix(in srgb, var(--wall-left) 92%, black)",
  "--wall-end-right": "color-mix(in srgb, var(--wall-right) 84%, black)",
  "--wall-stroke": "rgba(24,64,54,0.09)",
  "--wall-decor": "#dfeae6",
  "--wall-decor-inner": "#eef5f2",
  "--wall-decor-stroke": "rgba(0,0,0,0.09)",
  "--clock-hand": "rgba(14,48,40,0.5)",
};

const NIGHT: Record<string, string> = {
  "--floor-light": "#1c2b29",
  "--floor-dark": "#182523",
  "--floor-edge-light-left":
    "color-mix(in srgb, var(--floor-light) 86%, white)",
  "--floor-edge-dark-left": "color-mix(in srgb, var(--floor-dark) 90%, white)",
  "--floor-edge-light-right":
    "color-mix(in srgb, var(--floor-light) 90%, white)",
  "--floor-edge-dark-right": "color-mix(in srgb, var(--floor-dark) 94%, white)",
  "--floor-stroke": "rgba(255,255,255,0.02)",
  "--wall-left": "#16231f",
  "--wall-right": "#131e1b",
  "--wall-top-left": "color-mix(in srgb, var(--wall-left) 84%, white)",
  "--wall-top-right": "color-mix(in srgb, var(--wall-right) 84%, white)",
  "--wall-end-left": "color-mix(in srgb, var(--wall-left) 90%, white)",
  "--wall-end-right": "color-mix(in srgb, var(--wall-right) 94%, white)",
  "--wall-stroke": "rgba(255,255,255,0.025)",
  "--wall-decor": "#1e2e2a",
  "--wall-decor-inner": "#17241f",
  "--wall-decor-stroke": "rgba(255,255,255,0.07)",
  "--clock-hand": "rgba(255,255,255,0.4)",
};

/** The theme variables the hospital repaints. Everything the office scene draws
 *  from these - floor tiles, slab sides, both walls, their cut faces, the wall
 *  plates and the clock hands - follows without a branch. */
export function hospitalSceneVars(mode: ThemeMode): Record<string, string> {
  return mode === "light" ? DAY : NIGHT;
}

/** What the skin's OWN drawings are painted in: the wainscot on the walls, the
 *  cross sign, the beds, the IV stand and the curtain. */
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
  wainscot: "#a6c3ba",
  wainscotShade: "#94b4aa",
  rail: "#5f8279",
  cross: "#d8453f",
  crossPlate: "#f2f7f5",
  crossPlateEdge: "#c3d3ce",
  frame: "#c9d3d6",
  frameShade: "#9fabaf",
  mattress: "#eef3f4",
  mattressShade: "#d3dcdd",
  linen: "#f7fbfb",
  linenShade: "#dde6e6",
  pillow: "#ffffff",
  blanket: "#8fb6c9",
  blanketShade: "#6f9aae",
  metal: "#b6c2c6",
  metalShade: "#8e9ba0",
  fluid: "#dceaf2",
  curtain: "#a9cfc6",
  curtainShade: "#8ab5ab",
  shadow: "rgba(20,50,44,0.18)",
};

const NIGHT_COLORS: HospitalColors = {
  wainscot: "#27403a",
  wainscotShade: "#1f332e",
  rail: "#3d5c54",
  cross: "#9e3833",
  crossPlate: "#25342f",
  crossPlateEdge: "#16211e",
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

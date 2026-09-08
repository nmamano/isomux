import type { ThemeMode } from "../../themes.ts";

// The lobby keeps one identity, warm wood and cream, in every theme (Nil,
// 2026-09-05: the theme-coloured alternative is gutted). Only the mode
// matters, and every theme in ui/themes.ts already declares whether it is a
// dark or a light one, so the lobby follows that and nothing else.

export interface LobbyColors {
  floorA: string;
  floorB: string;
  floorC: string;
  floorSeam: string;
  floorEdgeLeft: string;
  floorEdgeRight: string;
  wallLeftTop: string;
  wallLeftBot: string;
  wallRightTop: string;
  wallRightBot: string;
  wallTopLeft: string;
  wallTopRight: string;
  wallEndLeft: string;
  wallEndRight: string;
  wallStroke: string;
  baseboard: string;
  baseboardShade: string;
  // Window frame and clock chrome.
  frame: string;
  clockFace: string;
  clockInner: string;
  clockTick: string;
  clockHand: string;
}

const DAY: LobbyColors = {
  floorA: "#cfa97a",
  floorB: "#c39c6c",
  floorC: "#d8b586",
  floorSeam: "rgba(72, 42, 16, 0.32)",
  floorEdgeLeft: "#a67c52",
  floorEdgeRight: "#8f6a45",
  wallLeftTop: "#f5e6cf",
  wallLeftBot: "#e6cfae",
  wallRightTop: "#ecd9ba",
  wallRightBot: "#d9bf9a",
  wallTopLeft: "#f9efdf",
  wallTopRight: "#f2e3c9",
  wallEndLeft: "#d9bf9a",
  wallEndRight: "#c8ab84",
  wallStroke: "rgba(80, 50, 20, 0.12)",
  baseboard: "#8a6444",
  baseboardShade: "#6e4e34",
  frame: "#7a5a3a",
  clockFace: "#5a4030",
  clockInner: "#f5ecd6",
  clockTick: "#7a5a3a",
  clockHand: "#3a2818",
};

const NIGHT: LobbyColors = {
  floorA: "#7d5c3e",
  floorB: "#725337",
  floorC: "#876646",
  floorSeam: "rgba(20, 10, 4, 0.45)",
  floorEdgeLeft: "#5a4029",
  floorEdgeRight: "#4a3421",
  wallLeftTop: "#6a5240",
  wallLeftBot: "#4f3c2d",
  wallRightTop: "#5c4736",
  wallRightBot: "#443327",
  wallTopLeft: "#7a6250",
  wallTopRight: "#6c5544",
  wallEndLeft: "#4f3c2d",
  wallEndRight: "#3d2d21",
  wallStroke: "rgba(0, 0, 0, 0.25)",
  baseboard: "#3a2a1c",
  baseboardShade: "#2a1e14",
  frame: "#2e2118",
  clockFace: "#2e2118",
  clockInner: "#d9c9a8",
  clockTick: "#5a4030",
  clockHand: "#2a1e14",
};

export function lobbyColors(mode: ThemeMode): LobbyColors {
  return mode === "light" ? DAY : NIGHT;
}

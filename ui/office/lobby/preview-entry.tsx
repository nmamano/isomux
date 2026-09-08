// Standalone preview of the lobby scene, driven by URL params so a headless
// browser can screenshot every alternative. Built by scripts/lobby-preview.sh.
//   ?mode=dark|light      theme mode (default dark)
//   ?layout=<id>          room layout (default empty)
//   ?sheet=props          contact sheet of prop variants instead of a room
//   ?v=sofa:loveseat,rug:round   per-family variant overrides for a layout
//   ?ghosts=N             N mock boss ghosts on the layout's ghost spots
import { createRoot } from "react-dom/client";
import { CSS } from "../../styles.ts";
import { THEMES } from "../../themes.ts";
import { SCENE_W, SCENE_H } from "../grid.ts";
import { LobbyScene } from "./LobbyScene.tsx";
import { PropSheet } from "./PropSheet.tsx";
import { LobbyEditor } from "./LobbyEditor.tsx";
import {
  LOBBY_LAYOUTS,
  LOBBY_LAYOUT_IDS,
  type LobbyLayoutId,
  type Placement,
} from "./layouts.ts";
import { GhostBody, GhostTag, SVG_HEIGHT_RATIO } from "../Ghost.tsx";
import { VB_X, VB_Y } from "../grid.ts";
import { floorXY } from "./geometry.ts";

const q = new URLSearchParams(location.search);
// The lobby's own colours are warm wood whatever the theme is, but everything
// AROUND the room - the page backdrop - still follows the active theme, so
// ?theme= takes any registered theme id and ?mode= is the shorthand for the
// two plain ones.
const theme =
  THEMES.find((t) => t.id === q.get("theme")) ??
  THEMES.find((t) => t.id === (q.get("mode") === "light" ? "light" : "dark"))!;
const mode = theme.mode;
const layoutParam = q.get("layout") ?? "empty";
const layout: LobbyLayoutId | "empty" =
  layoutParam in LOBBY_LAYOUTS ? (layoutParam as LobbyLayoutId) : "empty";
const sheet = q.get("sheet");
const ghostParam = q.get("ghosts");
const ghostCount = ghostParam === null ? 0 : Number(ghostParam) || 1;
const edit = q.get("edit") === "1";
// ?p=<json array> draws an arbitrary placement list, which is how a screenshot
// of one arrangement is taken without saving it as a layout.
let placements: Placement[] | undefined;
try {
  const raw = q.get("p");
  if (raw) placements = JSON.parse(raw) as Placement[];
} catch {
  placements = undefined;
}

// Mock presences at the office's ghost size (OfficeView GHOST_SIZE = 40),
// hovering over the front third of the floor. Placement in the real app is
// useGhostTransitions' job once the lobby tab exists; this is for scale only.
const GHOST_SIZE = 40;
const MOCK_GHOSTS = [
  {
    variant: "classic" as const,
    color: "#7c9cf5",
    username: "Nil",
    device: null,
  },
  {
    variant: "nightcap" as const,
    color: "#f5a97c",
    username: "Nil",
    device: "Phone",
  },
  {
    variant: "big-eyes" as const,
    color: "#8fd3a0",
    username: "Marc",
    device: null,
  },
];
function ghostBox(a: number, b: number) {
  const { x, y } = floorXY(b, a);
  const bodyHeight = Math.round(GHOST_SIZE * SVG_HEIGHT_RATIO);
  return { left: x - VB_X - GHOST_SIZE / 2, top: y - VB_Y - bodyHeight + 8 };
}
// The mount will pick a spot per connection id; the preview takes them in
// order so a screenshot is stable. Ghosts past the last spot share one and
// step sideways, the way the office stacks them at a desk.
const GHOST_STACK_DX = 18;
const GHOST_STACK_DY = 4;

function ghostAt(index: number) {
  const spots = layout === "empty" ? [] : LOBBY_LAYOUTS[layout].ghostSpots;
  if (spots.length === 0) return { left: 480, top: 560 };
  const spot = spots[index % spots.length];
  const stack = Math.floor(index / spots.length);
  const box = ghostBox(spot.a, spot.b);
  return {
    left: box.left + stack * GHOST_STACK_DX,
    top: box.top + stack * GHOST_STACK_DY,
  };
}

const variants: Record<string, string> = {};
for (const pair of (q.get("v") ?? "").split(",")) {
  const [family, variant] = pair.split(":");
  if (family && variant) variants[family] = variant;
}

document.documentElement.setAttribute("data-theme", theme.id);
document.documentElement.setAttribute("data-theme-mode", mode);
const style = document.createElement("style");
// The app would carry this rule in ui/styles.ts once the lobby is wired in.
style.textContent = `${CSS}\n[data-theme-mode="light"] .lobby-dark-only { display: none; }`;
document.head.appendChild(style);

// Employee of the Minute for the preview: a made-up winner with the outfit
// shape Character.tsx draws. The app derives the real one (employee.ts).
const mockStar = {
  name: "Isomux PM",
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short" as const,
    skin: "#FFD5B8",
    beard: "none" as const,
    accessory: "headphones" as const,
    hat: "none" as const,
  },
};

const mockRooms = [
  { id: "00000001", name: "Isomux" },
  { id: "00000002", name: "Assistants" },
  { id: "00000003", name: "Projects" },
];

function Preview() {
  if (edit) {
    const initial = LOBBY_LAYOUT_IDS.includes(layout as never)
      ? (layout as (typeof LOBBY_LAYOUT_IDS)[number])
      : LOBBY_LAYOUT_IDS[0];
    return (
      <LobbyEditor
        initialLayout={initial}
        themeId={theme.id}
        rooms={mockRooms}
        officeName="Isomux"
        star={mockStar}
      />
    );
  }
  if (sheet === "props") {
    return (
      <PropSheet
        mode={mode}
        rooms={mockRooms}
        officeName="Isomux"
        star={mockStar}
      />
    );
  }
  if (sheet) {
    return (
      <div style={{ padding: 24, color: "var(--text-primary)" }}>
        No sheet named {sheet}.
      </div>
    );
  }
  return (
    <div
      style={{
        width: SCENE_W,
        height: SCENE_H,
        position: "relative",
        margin: "40px auto",
      }}
    >
      <LobbyScene
        rooms={mockRooms}
        officeName="Isomux"
        mode={mode}
        layout={layout}
        variants={variants}
        star={mockStar}
        placements={placements}
        rightDoor={{ label: mockRooms[0].name, onClick: () => {} }}
      />
      {Array.from({ length: ghostCount }, (_, i) => i).map((i) => {
        const g = MOCK_GHOSTS[i % MOCK_GHOSTS.length];
        const box = ghostAt(i);
        return (
          <GhostBody
            key={`b${i}`}
            {...box}
            size={GHOST_SIZE}
            variant={g.variant}
            color={g.color}
            username={g.username}
            device={g.device}
            userId={`mock-${i}`}
            dimmed={false}
          />
        );
      })}
      {Array.from({ length: ghostCount }, (_, i) => i).map((i) => {
        const g = MOCK_GHOSTS[i % MOCK_GHOSTS.length];
        const box = ghostAt(i);
        return (
          <GhostTag
            key={`t${i}`}
            {...box}
            size={GHOST_SIZE}
            variant={g.variant}
            color={g.color}
            username={g.username}
            device={g.device}
            userId={`mock-${i}`}
            dimmed={false}
          />
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);

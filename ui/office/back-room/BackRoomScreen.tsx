// The back room screen (task 5b503e32): the room's basement, a workroom of
// n long tables with n seats, a laptop at each agent's place, pendant lamps
// and plants (task a442aa4f). Each back agent is a seated figure with a
// nameplate (status light and name), a purple bubble when unread and an amber
// one when it waits on a prompt; a click or tap opens its log. The board on
// the left wall lists each agent's name and topic, and a click on a line
// opens that agent too (task a442aa4f). The figures do
// not animate: a hundred animated characters made the frame time 3 to 4 times
// the front view's (measured 2026-10-15), and static ones cost nothing over
// it. The room zooms and pans with the front's viewport code (task f0af4677).
// On a desktop, a figure dragged onto the ladder moves to the front, the
// mirror of the trap door (task c18ef3e8), and onto a room tab moves to that
// room (task 335384f8).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../../shared/types.ts";
import { backRoomSide, backSeatOf } from "../../../shared/desks.ts";
import { useI18n } from "../../i18n.tsx";
import { noTranslate } from "../../no-translate.ts";
import { Character } from "../Character.tsx";
import { StatusLight, statusColor } from "../StatusLight.tsx";
import { CornerPlant, PlantDefs } from "../plants.tsx";
import { styleForModel } from "../../model-styles.ts";
import { useViewport } from "../useViewport.ts";
import { ZoomControls } from "../ZoomControls.tsx";
import { getDraggedDesk, setDraggedDesk } from "../drag-state.ts";
import { Vignette } from "../Vignette.tsx";
import { Cloud } from "../Floor.tsx";
import { mobileSceneScale } from "../grid.ts";
import type { ViewportControls } from "../OfficeView.tsx";
import {
  FIGURE_SCALE,
  SLAB_H,
  TABLE_DEPTH,
  TABLE_H,
  TILE_A,
  TILE_B,
  WALL_H,
  WALL_T,
  backRoomLayout,
  type Point,
} from "./geometry.ts";

const BRICK = {
  left: "#b98472",
  right: "#a87563",
  topLeft: "#c99a89",
  topRight: "#b88a79",
  endLeft: "#8f5f50",
  endRight: "#7f5446",
  mortar: "rgba(60,30,20,0.18)",
};
// Warm wood parquet: blocks in two shades, planks across alternate blocks.
const FLOOR = ["#c39a6b", "#b88f61"];
const PLANK = "rgba(80,50,25,0.16)";
// The slab's two visible sides, in the floor's two shades.
const SLAB_LEFT = ["#94704b", "#8b6946"];
const SLAB_RIGHT = ["#7e5f3f", "#77593b"];
const TABLE = { top: "#b38c63", front: "#94714d", side: "#7d5e40" };
const LAPTOP = { base: "#9da3aa", lid: "#c8ccd2" };
const CHAIR = { seat: "#3f6470", back: "#355561", leg: "#4a4a4a" };
const SHADE = { outer: "#2f5446", rim: "#4d7a67" };
// A brick's length along a wall top.
const BRICK_LEN = 26;
const LONG_PRESS_MS = 500;
// A cord's length above its bulb: long enough to run off the top of the
// screen at any pan and zoom (Nil: "the lamp cables should always reach the
// very top of the screen").
const CORD_H = 20000;
// The lamps hang above the wall title and the board (Nil, 2026-10-15), at
// these steps up from that line, so that no two line up.
const BULB_STAGGER = [0, 34, 14, 46, 6, 26, 40, 18, 30, 10];
const BULB_GAP = 24;
const SIGN_FONT = 30;
// The stencil's height over the floor, under the window.
const SIGN_H = 96;
const SIGN_SPACING = 4;
// The ladder's foot, in tiles from the right wall's end: it stands at the
// right, under the trap door, which is on the right of the front floor.
const LADDER_FROM_END = 1.6;
const LADDER_SLOPE = TILE_B / TILE_A;
// The stencil's span on the right wall, in tiles: from near the back corner
// to short of the ladder.
const SIGN_C0 = 0.45;
const SIGN_LADDER_GAP = 0.35;
// The board on the left wall (task a442aa4f): its margins from the left and
// back corners in tiles, its top's height over the floor, and its slots. A
// slot holds one agent on two lines (name, then topic); the columns are as
// many as the wall holds at the smallest width, so a 3x3 room gets two
// columns of five, and its nine seats always fit.
const BOARD_MARGIN_LEFT = 0.45;
const BOARD_MARGIN_BACK = 0.7;
const BOARD_TOP_H = 162;
const BOARD_PAD = 8;
const BOARD_TITLE_H = 22;
const BOARD_TITLE_FONT = 11;
const BOARD_FONT = 9;
const BOARD_SLOT_H = 24;
const BOARD_ROWS = 5;
const BOARD_COL_MIN = 104;
// Where a slot's name and topic start: right of the status dot.
const BOARD_TEXT_X = 11;
// The window: a basement window high on the right wall, over the stencil,
// with its top level with the board's. The ground outside comes up to its
// lower part. Its width is in tiles; its pane sits WINDOW_SET in from the
// wall face, so the left reveal and the sill show.
const WINDOW_W = 1.8;
const WINDOW_H = 34;
const WINDOW_SET = 6;
const WINDOW_GROUND = 0.32;
const WINDOW_FRAME = "#6b5240";

/** About how wide a monospace line draws: CJK glyphs take a full em, the
 *  rest 0.6 em. */
function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += /[\u2e80-\uffff]/.test(ch) ? 1 : 0.6;
  return em * fontSize;
}

/** The text cut to fit maxW, with an ellipsis when cut. Cuts between code
 *  points, so an emoji or a CJK character is never split. */
function fitText(text: string, fontSize: number, maxW: number): string {
  if (textWidth(text, fontSize) <= maxW) return text;
  let out = "";
  const room = maxW - textWidth("…", fontSize);
  for (const ch of text) {
    if (textWidth(out + ch, fontSize) > room) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

const poly = (pts: Point[]) =>
  "M" + pts.map((p) => `${p.x} ${p.y}`).join(" L") + " Z";
const up = (p: Point, h: number) => ({ x: p.x, y: p.y - h });

function Bubble({ color, glyph }: { color: string; glyph: string }) {
  return (
    <svg width={18} height={16} viewBox="0 0 18 16" aria-hidden="true">
      <path
        d="M2 1 H16 Q17 1 17 2 V10 Q17 11 16 11 H8 L4 15 L5 11 H2 Q1 11 1 10 V2 Q1 1 2 1 Z"
        fill={color}
        stroke="rgba(0,0,0,0.25)"
        strokeWidth={0.8}
      />
      <text
        x={9}
        y={9}
        textAnchor="middle"
        fontSize={8.5}
        fontWeight={800}
        fill="#fff"
        fontFamily="sans-serif"
      >
        {glyph}
      </text>
    </svg>
  );
}

function Figure({
  agent,
  at,
  scale,
  z,
  unread,
  askCount,
  draggable,
  onOpen,
  onMenu,
  onDrag,
}: {
  agent: AgentInfo;
  at: Point;
  /** The seating's scale (layout.k): the figure, its hit box and its plate
   *  shrink with the tables. */
  scale: number;
  z: number;
  unread: boolean;
  // Open asks from this agent to the viewer: the count dot.
  askCount: number;
  draggable: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  /** The figure's drag starts (true) or ends (false). */
  onDrag: (dragging: boolean) => void;
}) {
  const { tn } = useI18n();
  const h = 68 * FIGURE_SCALE * scale;
  const w = 52 * FIGURE_SCALE * scale;
  const plate = styleForModel(agent.modelFamily);
  const press = useRef<number | null>(null);
  const pressed = useRef(false);
  const clearPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };
  // The seat this figure put in drag-state, while its drag runs. A figure
  // that unmounts mid-drag (its agent moved away) never gets dragend, so the
  // unmount clears it instead, as DeskUnit does.
  const dragStarted = useRef<number | null>(null);
  useEffect(
    () => () => {
      const seat = dragStarted.current;
      if (seat !== null && getDraggedDesk() === seat) setDraggedDesk(null);
    },
    [],
  );
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        // A mouse drag from a figure does not pan (the viewport would take the
        // click); a touch drag still does, as on the front's desks.
        data-no-pan
        data-back-figure={agent.id}
        aria-label={agent.name}
        title={agent.name}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", agent.id);
          e.dataTransfer.effectAllowed = "move";
          // The seat goes in drag-state, so the room tabs take this agent
          // as they take a desk (task 335384f8).
          dragStarted.current = agent.desk;
          setDraggedDesk(agent.desk);
          onDrag(true);
        }}
        onDragEnd={() => {
          dragStarted.current = null;
          setDraggedDesk(null);
          onDrag(false);
        }}
        onClick={() => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          onOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          pressed.current = false;
          press.current = window.setTimeout(() => {
            pressed.current = true;
            onMenu(t.clientX, t.clientY);
          }, LONG_PRESS_MS);
        }}
        onTouchMove={clearPress}
        onTouchEnd={clearPress}
        style={{
          position: "absolute",
          // The hit box is the figure plus the floor cell around its feet.
          left: at.x - 27 * scale,
          top: at.y - h - 6 * scale,
          width: 54 * scale,
          height: h + 22 * scale,
          zIndex: z,
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ width: w, height: h, pointerEvents: "none" }}>
          <Character state={agent.state} outfit={agent.outfit} height={h} />
        </div>
      </div>
      {/* The nameplate: the front's, smaller. Neighbours on a table sit a
          stool step lower, more than its height at any seating scale, so
          plates do not overlap. */}
      <div
        data-back-nameplate
        style={{
          position: "absolute",
          left: at.x,
          top: at.y - h - 15,
          transform: `translateX(-50%) scale(${scale})`,
          transformOrigin: "50% 100%",
          zIndex: 5000 + z,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 3,
          maxWidth: 96,
          padding: "1px 6px 1px 4px",
          // The front plate's tint and blur over a light base: a bit more
          // opaque than the front's, so the name reads on the brick (Nil).
          background: `linear-gradient(${plate.bg}, ${plate.bg}), color-mix(in srgb, var(--bg-base) 15%, transparent)`,
          backdropFilter: "blur(10px)",
          border: `1px solid ${plate.border}`,
          borderRadius: 10,
          whiteSpace: "nowrap",
        }}
      >
        {/* Larger than the plate's text needs, with a dark edge: at 6px with
            no edge the lights were too faint on the plates (task 634dbde6). */}
        <StatusLight state={agent.state} size={8} ring />
        {/* The front plate's count dot, sized to this plate and set past
            its right edge, clear of the name. It reaches 5 units above the
            plate; the nearest plate above is a table behind, about 34 units
            higher, so the dot stays clear of it. */}
        {askCount > 0 && (
          <span
            data-ask-dot=""
            role="img"
            aria-label={tn("asks.badge", askCount)}
            style={{
              position: "absolute",
              top: -5,
              right: -10,
              minWidth: 13,
              height: 13,
              padding: "0 3px",
              borderRadius: 7,
              background: "var(--orange-text)",
              color: "var(--bg-base)",
              fontSize: 8,
              fontWeight: 800,
              lineHeight: "13px",
              textAlign: "center",
              boxShadow: "0 0 0 1.5px var(--bg-base)",
            }}
          >
            {askCount}
          </span>
        )}
        <span
          {...noTranslate()}
          style={{
            fontSize: 9,
            fontWeight: 600,
            lineHeight: "11px",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {agent.name}
        </span>
      </div>
      {(agent.pendingPrompt || unread) && (
        <div
          style={{
            position: "absolute",
            left: at.x + 6 * scale,
            top: at.y - h - 32 * scale,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            zIndex: 5001 + z,
            pointerEvents: "none",
          }}
        >
          {agent.pendingPrompt ? (
            <Bubble color="var(--orange-text)" glyph="?" />
          ) : (
            <Bubble color="var(--purple-text)" glyph="•••" />
          )}
        </div>
      )}
    </>
  );
}

/** One agent's line on the board: a status dot, the name and the topic, each
 *  cut to the column, the whole text in the tooltip. */
function BoardLine({
  agent,
  at,
  width,
  onOpen,
  onKey,
}: {
  agent: AgentInfo;
  at: Point;
  width: number;
  onOpen: () => void;
  onKey: () => void;
}) {
  const textW = width - BOARD_TEXT_X - 4;
  const label = agent.topic ? `${agent.name}: ${agent.topic}` : agent.name;
  return (
    <g
      data-back-board-line={agent.id}
      data-no-pan
      role="button"
      tabIndex={0}
      aria-label={label}
      transform={`translate(${at.x} ${at.y})`}
      pointerEvents="all"
      cursor="pointer"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onKey();
        }
      }}
      {...noTranslate()}
    >
      <title>{label}</title>
      <rect width={width - 4} height={BOARD_SLOT_H - 2} fill="transparent" />
      <circle cx={4} cy={7} r={3} fill={statusColor(agent.state)} />
      <text
        x={BOARD_TEXT_X}
        y={10}
        fontSize={BOARD_FONT}
        fontWeight={700}
        fill="rgba(255,255,255,0.92)"
        fontFamily="'JetBrains Mono',monospace"
      >
        {fitText(agent.name, BOARD_FONT, textW)}
      </text>
      <text
        x={BOARD_TEXT_X}
        y={20}
        fontSize={BOARD_FONT}
        fill="rgba(255,255,255,0.7)"
        fontFamily="'JetBrains Mono',monospace"
      >
        {fitText(agent.topic || "", BOARD_FONT, textW)}
      </text>
    </g>
  );
}

export function BackRoomScreen({
  roomName,
  agents,
  needsAttention,
  askCounts,
  isMobile,
  onBack,
  onClimb = onBack,
  onSpawn,
  onOpenAgent,
  onContextMenu,
  frontFull,
  onDropToFront,
  vignette = true,
  viewportControlsRef,
}: {
  roomName: string;
  /** The room's back agents. */
  agents: AgentInfo[];
  needsAttention: Set<string>;
  /** Open asks per agent, for this member. */
  askCounts?: ReadonlyMap<string, number>;
  isMobile: boolean;
  onBack: () => void;
  /** The ladder's way up to the front; the Back button keeps onBack. */
  onClimb?: () => void;
  onSpawn: () => void;
  onOpenAgent: (agentId: string) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  /** No front desk is free: the ladder refuses a dropped figure. */
  frontFull: boolean;
  /** Moves the agent to a free front desk. */
  onDropToFront: (agent: AgentInfo) => void;
  vignette?: boolean;
  /** Where the 0, + and - keys find the view. */
  viewportControlsRef?: React.RefObject<ViewportControls | null>;
}) {
  const { t } = useI18n();
  const side = backRoomSide(agents.map((a) => a.desk));
  const layout = backRoomLayout(side);
  const roomRef = useRef<HTMLDivElement | null>(null);
  // The figure being dragged: the ladder shows itself as the drop target.
  const [dragged, setDragged] = useState<AgentInfo | null>(null);
  // The front's zoom and pan (task f0af4677), with its own saved view. The
  // building is the front's, so the rest view fits it as the front's does
  // (task dc9786a8); one finger always pans (there is no room swipe here).
  const sceneScale = isMobile ? mobileSceneScale() : 1;
  const viewport = useViewport(`${isMobile ? 1 : 0}|${sceneScale}`, true, {
    kind: "back",
    touchPanAtRest: true,
  });
  const { setContent } = viewport;
  const attachRoom = useCallback(
    (node: HTMLDivElement | null) => {
      roomRef.current = node;
      setContent(node);
    },
    [setContent],
  );
  // The 0, + and - keys reach this view while it shows.
  useEffect(() => {
    if (!viewportControlsRef) return;
    const controls = {
      resetView: viewport.resetView,
      zoomIn: viewport.zoomIn,
      zoomOut: viewport.zoomOut,
    };
    viewportControlsRef.current = controls;
    return () => {
      if (viewportControlsRef.current === controls)
        viewportControlsRef.current = null;
    };
  }, [
    viewportControlsRef,
    viewport.resetView,
    viewport.zoomIn,
    viewport.zoomOut,
  ]);

  // SVG animations do not stop for CSS: pause them, so every figure stays
  // still (the CSS rule below stops the rest).
  useEffect(() => {
    for (const svg of roomRef.current?.querySelectorAll("svg") ?? [])
      svg.pauseAnimations?.();
  });

  const back = layout.at(0, 0);
  const left = layout.at(0, layout.nr);
  const right = layout.at(layout.nc, 0);
  // The walls' outer corners: the wall is WALL_T thick, out from the floor.
  const outerLeft = { x: left.x - WALL_T, y: left.y - WALL_T / 2 };
  const outerRight = { x: right.x + WALL_T, y: right.y - WALL_T / 2 };
  // Joints across the wall tops, one per brick length along each wall, from
  // the inner edge to the outer one.
  const backOuter = { x: back.x, y: back.y - WALL_T };
  const topJoints: React.ReactNode[] = [];
  for (const [a, b, oa, ob] of [
    [left, back, outerLeft, backOuter],
    [back, right, backOuter, outerRight],
  ] as const) {
    const n = Math.round(Math.hypot(b.x - a.x, b.y - a.y) / BRICK_LEN);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const p = up(
        { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
        WALL_H,
      );
      const q = up(
        { x: oa.x + (ob.x - oa.x) * f, y: oa.y + (ob.y - oa.y) * f },
        WALL_H,
      );
      topJoints.push(
        <path
          key={`top-${a.x}-${k}`}
          d={`M${p.x} ${p.y} L${q.x} ${q.y}`}
          stroke={BRICK.mortar}
        />,
      );
    }
  }
  const walls = (
    <>
      <path
        d={poly([left, up(left, WALL_H), up(back, WALL_H), back])}
        fill={BRICK.left}
      />
      <path
        d={poly([back, up(back, WALL_H), up(right, WALL_H), right])}
        fill={BRICK.right}
      />
      {Array.from({ length: Math.floor(WALL_H / 11) }, (_, k) => {
        const y = (k + 1) * 11;
        return (
          <g key={k}>
            <path
              d={`M${left.x} ${left.y - y} L${back.x} ${back.y - y}`}
              stroke={BRICK.mortar}
            />
            <path
              d={`M${back.x} ${back.y - y} L${right.x} ${right.y - y}`}
              stroke={BRICK.mortar}
            />
          </g>
        );
      })}
      <path
        d={poly([
          up(left, WALL_H),
          up(back, WALL_H),
          up(backOuter, WALL_H),
          up(outerLeft, WALL_H),
        ])}
        fill={BRICK.topLeft}
      />
      <path
        d={poly([
          up(back, WALL_H),
          up(right, WALL_H),
          up(outerRight, WALL_H),
          up(backOuter, WALL_H),
        ])}
        fill={BRICK.topRight}
      />
      {/* The cut ends stand on the floor slab, which reaches out under
          them as in the front rooms. */}
      <path
        d={poly([left, up(left, WALL_H), up(outerLeft, WALL_H), outerLeft])}
        fill={BRICK.endLeft}
      />
      <path
        d={poly([right, up(right, WALL_H), up(outerRight, WALL_H), outerRight])}
        fill={BRICK.endRight}
      />
      {/* The brick wraps around the wall's thickness: the courses run on
          over the cut ends, and the tops show the bricks' joints. */}
      {Array.from({ length: Math.floor(WALL_H / 11) }, (_, k) => {
        const y = (k + 1) * 11;
        return (
          <g key={`end-${k}`}>
            <path
              d={`M${left.x} ${left.y - y} L${outerLeft.x} ${outerLeft.y - y}`}
              stroke={BRICK.mortar}
            />
            <path
              d={`M${right.x} ${right.y - y} L${outerRight.x} ${outerRight.y - y}`}
              stroke={BRICK.mortar}
            />
          </g>
        );
      })}
      {topJoints}
    </>
  );
  const floor: React.ReactNode[] = [];
  // The planks' seams, three planks a block, across c and r in turn: one path.
  let planks = "";
  for (let r = 0; r < layout.nr; r += 1.5)
    for (let c = 0; c < layout.nc; c += 1.5) {
      const r2 = Math.min(layout.nr, r + 1.5);
      const c2 = Math.min(layout.nc, c + 1.5);
      for (const f of [0.5, 1]) {
        const [a, b] =
          Math.round((r + c) / 1.5) % 2
            ? [layout.at(c + f, r), layout.at(c + f, r2)]
            : [layout.at(c, r + f), layout.at(c2, r + f)];
        if (Math.round((r + c) / 1.5) % 2 ? c + f < c2 : r + f < r2)
          planks += `M${a.x} ${a.y} L${b.x} ${b.y} `;
      }
      floor.push(
        <path
          key={`${r}-${c}`}
          d={poly([
            layout.at(c, r),
            layout.at(c2, r),
            layout.at(c2, r2),
            layout.at(c, r2),
          ])}
          fill={FLOOR[Math.round((r + c) / 1.5) % 2]}
          stroke="rgba(0,0,0,0.10)"
          strokeWidth={0.6}
        />,
      );
    }
  floor.push(<path key="planks" d={planks} stroke={PLANK} strokeWidth={0.6} />);
  // The slab's sides carry the floor's checkerboard down over its thickness,
  // one face per edge block, as in the front rooms. The first face on each
  // side reaches out under the wall to its outer corner.
  const slab = (a: Point, b: Point, fill: string, key: string) => (
    <path
      key={key}
      d={poly([a, b, { x: b.x, y: b.y + SLAB_H }, { x: a.x, y: a.y + SLAB_H }])}
      fill={fill}
      stroke="rgba(0,0,0,0.10)"
      strokeWidth={0.6}
    />
  );
  const lastR = Math.ceil(layout.nr / 1.5) * 1.5 - 1.5;
  const lastC = Math.ceil(layout.nc / 1.5) * 1.5 - 1.5;
  const parity = (r: number, c: number) => Math.round((r + c) / 1.5) % 2;
  const slabs: React.ReactNode[] = [];
  for (let c = 0; c < layout.nc; c += 1.5)
    slabs.push(
      slab(
        c === 0 ? outerLeft : layout.at(c, layout.nr),
        layout.at(Math.min(layout.nc, c + 1.5), layout.nr),
        SLAB_LEFT[parity(lastR, c)],
        `sl-${c}`,
      ),
    );
  for (let r = 0; r < layout.nr; r += 1.5)
    slabs.push(
      slab(
        r === 0 ? outerRight : layout.at(layout.nc, r),
        layout.at(layout.nc, Math.min(layout.nr, r + 1.5)),
        SLAB_RIGHT[parity(r, lastC)],
        `sr-${r}`,
      ),
    );
  const ladderFoot = layout.at(layout.nc - LADDER_FROM_END, 0.15);
  const ladderTop = { x: ladderFoot.x + 26, y: ladderFoot.y - WALL_H - 70 };
  // The "BACK ROOM" stencil hangs on the right wall between the back corner
  // and the ladder, centred, and shrinks to fit a small room's wall.
  const signText = t("office.backRoom.sign");
  const signW =
    textWidth(signText, SIGN_FONT) + SIGN_SPACING * [...signText].length;
  const signSpan =
    (layout.nc - LADDER_FROM_END - SIGN_LADDER_GAP - SIGN_C0) * TILE_A;
  const signScale = Math.min(1, signSpan / signW);
  const sign = up(layout.at(SIGN_C0 + signSpan / 2 / TILE_A, 0), SIGN_H);
  // The text slants down to its right: its left end is its highest point.
  const signTop = sign.y - (signScale * signW) / 4 - signScale * SIGN_FONT;
  // The window, centred over the stencil. The opening is on the wall face;
  // the pane is the same shape moved WINDOW_SET out through the wall.
  const windowW = Math.min(WINDOW_W, signSpan / TILE_A);
  const windowC = SIGN_C0 + signSpan / 2 / TILE_A;
  const winA = up(layout.at(windowC - windowW / 2, 0), BOARD_TOP_H - WINDOW_H);
  const winB = up(layout.at(windowC + windowW / 2, 0), BOARD_TOP_H - WINDOW_H);
  const opening = [winA, winB, up(winB, WINDOW_H), up(winA, WINDOW_H)];
  const set = (p: Point) => ({ x: p.x + WINDOW_SET, y: p.y - WINDOW_SET / 2 });
  const paneW = windowW * TILE_A;
  const pane = (
    <g
      transform={`matrix(1 ${LADDER_SLOPE} 0 1 ${set(winA).x} ${set(winA).y - WINDOW_H})`}
    >
      <g className="window-night">
        <rect width={paneW} height={WINDOW_H} fill="#0a0e1a" />
        {[
          [0.12, 0.25],
          [0.3, 0.5],
          [0.45, 0.18],
          [0.62, 0.42],
          [0.8, 0.2],
          [0.92, 0.48],
        ].map(([u, v], k) => (
          <circle
            key={k}
            cx={u * paneW}
            cy={v * WINDOW_H}
            r={0.7}
            fill="white"
            opacity={0.5 + (k % 3) * 0.2}
          />
        ))}
        <rect
          y={WINDOW_H * (1 - WINDOW_GROUND)}
          width={paneW}
          height={WINDOW_H * WINDOW_GROUND}
          fill="#1d2b1f"
        />
      </g>
      <g className="window-day">
        <rect width={paneW} height={WINDOW_H} fill="#87CEEB" />
        <Cloud x={paneW * 0.3} y={WINDOW_H * 0.45} scale={0.5} opacity={0.9} />
        <rect
          y={WINDOW_H * (1 - WINDOW_GROUND)}
          width={paneW}
          height={WINDOW_H * WINDOW_GROUND}
          fill="#6a9f4b"
        />
      </g>
      <path
        d={Array.from(
          { length: Math.round(paneW / 4) },
          (_, k) =>
            `M${k * 4 + 2} ${WINDOW_H * (1 - WINDOW_GROUND)} l${k % 2 ? 1 : -1} -${2 + (k % 3)}`,
        ).join(" ")}
        stroke="rgba(30,60,25,0.5)"
        strokeWidth={1}
      />
      <path
        d={`M${paneW / 2} 0 V${WINDOW_H}`}
        stroke={WINDOW_FRAME}
        strokeWidth={2}
      />
    </g>
  );

  // The board on the left wall, from near the left corner to short of the
  // back corner: as many columns as fit, then the slots fill down each column.
  const leftCorner = layout.at(0, layout.nr);
  const boardW = (layout.nr - BOARD_MARGIN_LEFT - BOARD_MARGIN_BACK) * TILE_A;
  const boardCols = Math.max(
    1,
    Math.floor((boardW - 2 * BOARD_PAD) / BOARD_COL_MIN),
  );
  const colW = (boardW - 2 * BOARD_PAD) / boardCols;
  const boardH = BOARD_TITLE_H + BOARD_ROWS * BOARD_SLOT_H + BOARD_PAD;
  const boardX = leftCorner.x + BOARD_MARGIN_LEFT * TILE_A;
  // The wall's foot falls TILE_B per TILE_A toward the left corner.
  const boardY =
    leftCorner.y - (BOARD_MARGIN_LEFT * TILE_A * TILE_B) / TILE_A - BOARD_TOP_H;
  // The board rises to its right: its top-right corner is its highest point.
  const boardTop = boardY - (boardW * TILE_B) / TILE_A;
  // Seated agents in seat order; past the slots, the last one counts the rest.
  const listed = agents
    .filter((a) => backSeatOf(a.desk))
    .sort((a, b) => a.desk - b.desk);
  const slots = boardCols * BOARD_ROWS;
  const shown = listed.length > slots ? listed.slice(0, slots - 1) : listed;
  const more = listed.length - shown.length;
  const slotAt = (i: number) => ({
    x: BOARD_PAD + Math.floor(i / BOARD_ROWS) * colW,
    y: BOARD_TITLE_H + (i % BOARD_ROWS) * BOARD_SLOT_H,
  });

  // Pendant lamps, two per two tables, spaced evenly from the floor's left
  // corner to the ladder and staggered in height above the stencil and the
  // board.
  const bulbLine = Math.min(signTop, boardTop) - BULB_GAP;
  const bulbCount = 2 * Math.ceil(side / 2);
  const bulbX0 = layout.at(0, layout.nr).x;
  const bulbStep = (ladderFoot.x - 30 - bulbX0) / bulbCount;
  const bulbs: Point[] = Array.from({ length: bulbCount }, (_, k) => ({
    x: bulbX0 + (k + 0.5) * bulbStep,
    y: bulbLine - BULB_STAGGER[k % BULB_STAGGER.length],
  }));
  // Plants: in the back corner, and in the front corner, clear of the seats.
  const backPlant = layout.at(0.32, 0.32);
  const frontPlant = layout.at(layout.nc - 0.4, layout.nr - 0.4);

  // Back to front: tables in order, each with its figures and empty stools
  // behind it.
  const seated = new Map<string, AgentInfo>();
  for (const a of agents) {
    const s = backSeatOf(a.desk);
    if (s) seated.set(`${s.table},${s.stool}`, a);
  }
  const rows: React.ReactNode[] = [];
  const { k } = layout;
  const tableH = k * TABLE_H;
  for (let j = 0; j < side; j++) {
    const tb = layout.table(j);
    const t0 = layout.at(tb.c0, tb.r);
    const t1 = layout.at(tb.c1, tb.r);
    const t2 = layout.at(tb.c1, tb.r + k * TABLE_DEPTH);
    const t3 = layout.at(tb.c0, tb.r + k * TABLE_DEPTH);
    rows.push(
      <svg
        key={`table-${j}`}
        width={layout.width}
        height={layout.height}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          zIndex: j * 10 + 6,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      >
        <path
          d={poly([
            up(t0, tableH),
            up(t1, tableH),
            up(t2, tableH),
            up(t3, tableH),
          ])}
          fill={TABLE.top}
          stroke="rgba(0,0,0,0.25)"
          strokeWidth={0.6}
        />
        <path
          d={poly([up(t3, tableH), up(t2, tableH), t2, t3])}
          fill={TABLE.front}
        />
        <path
          d={poly([up(t1, tableH), up(t2, tableH), t2, t1])}
          fill={TABLE.side}
        />
        {/* A laptop at each taken seat, its lid toward us: one path for
            the bases and one for the lids, to keep the element count low
            in a full room. */}
        {(() => {
          let bases = "";
          let lids = "";
          for (let i = 0; i < side; i++) {
            if (!seated.has(`${j},${i}`)) continue;
            const c = tb.c0 + k * (0.5 + i);
            const p = (dc: number, dr: number) =>
              up(layout.at(c + k * dc, tb.r + k * dr), tableH);
            // The base reaches toward the agent; the lid stands on its
            // front edge, its back to us.
            const [b0, b1, b2, b3] = [
              p(-0.15, 0.08),
              p(0.15, 0.08),
              p(0.15, 0.3),
              p(-0.15, 0.3),
            ];
            bases += poly([b0, b1, b2, b3]) + " ";
            lids += poly([b3, b2, up(b2, 9 * k), up(b3, 9 * k)]) + " ";
          }
          return (
            bases && (
              <>
                <path d={bases} fill={LAPTOP.base} />
                <path
                  d={lids}
                  fill={LAPTOP.lid}
                  stroke="rgba(0,0,0,0.3)"
                  strokeWidth={0.5}
                />
              </>
            )
          );
        })()}
      </svg>,
    );
    for (let i = 0; i < side; i++) {
      const at = layout.seat({ table: j, stool: i });
      const agent = seated.get(`${j},${i}`);
      if (agent) {
        rows.push(
          <Figure
            key={agent.id}
            agent={agent}
            at={at}
            scale={k}
            z={j * 10 + 3}
            unread={needsAttention.has(agent.id)}
            askCount={askCounts?.get(agent.id) ?? 0}
            // HTML5 drag is a mouse gesture, as on the front's desks.
            draggable={!isMobile}
            onDrag={(on) => setDragged(on ? agent : null)}
            // A touch pan that starts on a figure does not open it.
            onOpen={viewport.wrapClick(() => onOpenAgent(agent.id))}
            onMenu={(x, y) => onContextMenu(x, y, agent)}
          />,
        );
      } else {
        rows.push(
          <svg
            key={`stool-${j}-${i}`}
            data-back-stool
            width={layout.width}
            height={layout.height}
            style={{
              position: "absolute",
              inset: 0,
              overflow: "visible",
              zIndex: j * 10 + 2,
              pointerEvents: "none",
            }}
            aria-hidden="true"
          >
            {/* An empty chair facing the table: a post on a foot, the back
                on the seat's far edge, then the seat. */}
            <path
              d={`M${at.x} ${at.y} L${at.x} ${at.y - 12 * k} M${at.x - 6 * k} ${at.y - k} L${at.x + 6 * k} ${at.y + k}`}
              stroke={CHAIR.leg}
              strokeWidth={2 * k}
            />
            <path
              d={poly([
                { x: at.x, y: at.y - 18 * k },
                { x: at.x + 12 * k, y: at.y - 12 * k },
                { x: at.x + 12 * k, y: at.y - 28 * k },
                { x: at.x, y: at.y - 34 * k },
              ])}
              fill={CHAIR.back}
            />
            <path
              d={poly([
                { x: at.x - 12 * k, y: at.y - 12 * k },
                { x: at.x, y: at.y - 18 * k },
                { x: at.x + 12 * k, y: at.y - 12 * k },
                { x: at.x, y: at.y - 6 * k },
              ])}
              fill={CHAIR.seat}
            />
          </svg>,
        );
      }
    }
  }

  const boardLines: React.ReactNode[] = [];
  for (let i = 0; i < shown.length; i++) {
    const agent = shown[i];
    boardLines.push(
      <BoardLine
        key={agent.id}
        agent={agent}
        at={slotAt(i)}
        width={colW}
        // A pan that ends on a line does not open it.
        onOpen={viewport.wrapClick(() => onOpenAgent(agent.id))}
        onKey={() => onOpenAgent(agent.id)}
      />,
    );
  }

  const barButton: React.CSSProperties = {
    pointerEvents: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 11px",
    borderRadius: 8,
    border: "1px solid var(--border-medium)",
    background: "var(--bg-base)",
    color: "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div
      data-back-room
      data-floor-view
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        position: "relative",
      }}
    >
      {/* The bar floats over the room, so the room's view is the front's
          size and the building fits it as the front's does. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "6px 10px" : "8px 16px",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          title={t("office.backRoom.backToTitle", { room: roomName })}
          style={{
            ...barButton,
            maxWidth: isMobile ? "40%" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          {...noTranslate()}
        >
          {t("office.backRoom.backTo", { room: roomName })}
        </button>
        {/* A plate under the title, so it reads over the room too. */}
        <span
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            padding: "5px 11px",
            borderRadius: 8,
            background: "var(--bg-base)",
          }}
        >
          {t("office.backRoom.title")}
        </span>
        <button
          type="button"
          onClick={onSpawn}
          style={{
            ...barButton,
            marginLeft: "auto",
            borderStyle: "dashed",
            color: "var(--text-secondary)",
          }}
        >
          {t("office.backRoom.newAgent")}
        </button>
      </div>
      {/* touch-action: none hands every touch to the viewport, as on the
          front. */}
      <div
        ref={viewport.setContainer}
        style={{
          flex: 1,
          overflow: "hidden",
          position: "relative",
          touchAction: "none",
          background:
            "radial-gradient(ellipse at 50% 40%, var(--ambient-1) 0%, transparent 60%)",
        }}
      >
        <div
          ref={viewport.setScene}
          style={{ position: "absolute", inset: 0, transformOrigin: "0 0" }}
        >
          <div
            ref={attachRoom}
            className="back-room-still"
            // The front scene's centring and phone scale (OfficeView).
            style={{
              position: "absolute",
              left: "50%",
              top: isMobile ? "45%" : "50%",
              width: layout.width,
              height: layout.height,
              transform: `translate(-50%, -50%) scale(${sceneScale})`,
              transformOrigin: "center center",
            }}
          >
            <style>{`.back-room-still *, .back-room-still *::before, .back-room-still *::after { animation: none !important; transition: none !important; } .back-room-still [data-back-ladder]:focus:not(:focus-visible), .back-room-still [data-back-board-line]:focus:not(:focus-visible) { outline: none; }`}</style>
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute", inset: 0, overflow: "visible" }}
              aria-hidden="true"
            >
              {walls}
              {floor}
              {slabs}
              <defs>
                <clipPath id="back-window-clip">
                  <path d={poly(opening)} />
                </clipPath>
              </defs>
              {/* The opening shows its left reveal and its sill, as the
                  wall's cut end and top do. */}
              <g data-back-window clipPath="url(#back-window-clip)">
                <path d={poly(opening)} fill={BRICK.endRight} />
                <path
                  d={poly([winA, winB, set(winB), set(winA)])}
                  fill={BRICK.topRight}
                />
                {pane}
                <path
                  d={poly(opening.map(set))}
                  fill="none"
                  stroke={WINDOW_FRAME}
                  strokeWidth={3}
                />
              </g>
              <g
                data-back-sign
                transform={`matrix(${signScale} ${signScale * 0.5} 0 ${signScale} ${sign.x} ${sign.y})`}
              >
                <text
                  x={0}
                  y={0}
                  textAnchor="middle"
                  fontSize={SIGN_FONT}
                  fontWeight={800}
                  letterSpacing={SIGN_SPACING}
                  fill="rgba(255,245,230,0.75)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {signText}
                </text>
              </g>
              <defs>
                <PlantDefs />
              </defs>
            </svg>
            {/* The board: its own svg, out of the aria-hidden one, since its
                lines are buttons. */}
            <svg
              width={layout.width}
              height={layout.height}
              style={{
                position: "absolute",
                inset: 0,
                overflow: "visible",
                pointerEvents: "none",
              }}
            >
              <g
                data-back-board
                transform={`matrix(1 -0.5 0 1 ${boardX} ${boardY})`}
              >
                <rect
                  width={boardW}
                  height={boardH}
                  fill="#2f3a33"
                  stroke="#6b5240"
                  strokeWidth={4}
                  aria-hidden="true"
                />
                <text
                  x={boardW / 2}
                  y={15}
                  textAnchor="middle"
                  fontSize={BOARD_TITLE_FONT}
                  fontWeight={700}
                  letterSpacing={2}
                  fill="rgba(255,255,255,0.85)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {t("office.backRoom.boardTitle")}
                </text>
                {boardLines}
                {more > 0 && (
                  <text
                    data-back-board-more={more}
                    x={slotAt(shown.length).x + BOARD_TEXT_X}
                    y={slotAt(shown.length).y + 15}
                    fontSize={BOARD_FONT}
                    fill="rgba(255,255,255,0.7)"
                    fontFamily="'JetBrains Mono',monospace"
                  >
                    {t("office.backRoom.boardMore", { count: more })}
                  </text>
                )}
              </g>
            </svg>
            <svg
              width={layout.width}
              height={layout.height}
              style={{
                position: "absolute",
                inset: 0,
                overflow: "visible",
                zIndex: 1,
                pointerEvents: "none",
              }}
            >
              {/* Both rails stand on the floor along the right wall, which
                  falls TILE_B per TILE_A: the right rail sits lower. */}
              {[0, 22].map((dx) => (
                <path
                  key={dx}
                  d={`M${ladderFoot.x + dx} ${ladderFoot.y + dx * LADDER_SLOPE} L${ladderTop.x + dx} ${ladderTop.y + dx * LADDER_SLOPE}`}
                  stroke="#6b4a2f"
                  strokeWidth={4}
                />
              ))}
              {Array.from({ length: 11 }, (_, k) => {
                const f = (k + 1) / 12;
                const x = ladderFoot.x + (ladderTop.x - ladderFoot.x) * f;
                const y = ladderFoot.y + (ladderTop.y - ladderFoot.y) * f;
                return (
                  <path
                    key={k}
                    d={`M${x} ${y} L${x + 22} ${y + 22 * LADDER_SLOPE}`}
                    stroke="#7d5a3a"
                    strokeWidth={3}
                  />
                );
              })}
              {/* The ladder leads up to the front: a click on it goes there. */}
              <path
                data-back-ladder
                data-no-pan
                role="button"
                tabIndex={0}
                aria-label={t("office.backRoom.backToTitle", {
                  room: roomName,
                })}
                d={poly([
                  { x: ladderFoot.x - 8, y: ladderFoot.y + 6 },
                  { x: ladderTop.x - 8, y: ladderTop.y },
                  { x: ladderTop.x + 30, y: ladderTop.y + 22 * LADDER_SLOPE },
                  {
                    x: ladderFoot.x + 30,
                    y: ladderFoot.y + 6 + 22 * LADDER_SLOPE,
                  },
                ])}
                fill="transparent"
                pointerEvents="all"
                cursor="pointer"
                onClick={viewport.wrapClick(onClimb)}
                onDragOver={(e) => {
                  if (!dragged) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = frontFull ? "none" : "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const agent = dragged;
                  setDragged(null);
                  if (agent && !frontFull) onDropToFront(agent);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onClimb();
                  }
                }}
              >
                <title>
                  {t("office.backRoom.backToTitle", { room: roomName })}
                </title>
              </path>
              {dragged && (
                <path
                  data-back-ladder-target={frontFull ? "full" : "open"}
                  d={poly([
                    { x: ladderFoot.x - 16, y: ladderFoot.y + 12 },
                    { x: ladderTop.x - 16, y: ladderTop.y - 8 },
                    {
                      x: ladderTop.x + 38,
                      y: ladderTop.y - 8 + 22 * LADDER_SLOPE,
                    },
                    {
                      x: ladderFoot.x + 38,
                      y: ladderFoot.y + 12 + 22 * LADDER_SLOPE,
                    },
                  ])}
                  fill={
                    frontFull
                      ? "rgba(255,60,60,0.12)"
                      : "rgba(126,184,255,0.18)"
                  }
                  stroke={frontFull ? "var(--red)" : "var(--accent)"}
                  strokeWidth={2.5}
                  strokeDasharray="6 4"
                  pointerEvents="none"
                />
              )}
            </svg>
            {dragged && (
              <div
                style={{
                  position: "absolute",
                  left: ladderTop.x + 11,
                  top: ladderTop.y - 14,
                  transform: "translate(-50%, -100%)",
                  zIndex: 9000,
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  padding: "5px 10px",
                  borderRadius: 14,
                  background: frontFull ? "var(--red)" : "var(--accent-text)",
                  color: "var(--bg-base)",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {frontFull
                  ? t("contextMenu.moveToFrontFull")
                  : t("contextMenu.moveToFront")}
              </div>
            )}
            {rows}
            <svg
              width={layout.width}
              height={layout.height}
              style={{
                position: "absolute",
                inset: 0,
                overflow: "visible",
                zIndex: 4000,
                pointerEvents: "none",
              }}
              aria-hidden="true"
            >
              <defs>
                <radialGradient id="back-room-bulb">
                  <stop offset="0%" stopColor="rgba(255,230,150,0.55)" />
                  <stop offset="100%" stopColor="rgba(255,230,150,0)" />
                </radialGradient>
              </defs>
              {/* The plants stand in front of the walls; nothing stands in
                  front of them. */}
              <g
                transform={`translate(${backPlant.x} ${backPlant.y - 18}) scale(0.9)`}
              >
                <CornerPlant />
              </g>
              <g
                transform={`translate(${frontPlant.x} ${frontPlant.y - 20}) scale(1)`}
              >
                <CornerPlant />
              </g>
              {/* A lamp: the cord, a cone shade with a lit rim, the bulb
                  under it and its glow. */}
              {bulbs.map((p, k) => (
                <g key={k} data-back-bulb>
                  <path
                    d={`M${p.x} ${p.y - CORD_H} L${p.x} ${p.y}`}
                    stroke="#3b3b3b"
                    strokeWidth={1.4}
                  />
                  <circle
                    cx={p.x}
                    cy={p.y + 16}
                    r={26}
                    fill="url(#back-room-bulb)"
                  />
                  <path
                    d={poly([
                      { x: p.x - 3, y: p.y },
                      { x: p.x + 3, y: p.y },
                      { x: p.x + 11, y: p.y + 12 },
                      { x: p.x - 11, y: p.y + 12 },
                    ])}
                    fill={SHADE.outer}
                  />
                  <ellipse
                    cx={p.x}
                    cy={p.y + 12}
                    rx={11}
                    ry={2.5}
                    fill={SHADE.rim}
                  />
                  <ellipse
                    cx={p.x}
                    cy={p.y + 13}
                    rx={4}
                    ry={2.5}
                    fill="#fff0bd"
                  />
                </g>
              ))}
            </svg>
          </div>
        </div>
        <ZoomControls
          onZoomIn={viewport.zoomIn}
          onZoomOut={viewport.zoomOut}
          onReset={viewport.resetView}
        />
        {vignette && <Vignette strong />}
      </div>
    </div>
  );
}

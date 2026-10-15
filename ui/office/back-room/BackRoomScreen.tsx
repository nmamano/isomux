// The back room screen (task 5b503e32): the room's basement, a sweatshop of
// n long tables with n stools. Each back agent is a seated figure with a
// nameplate (status light and name), a purple bubble when unread and an amber
// one when it waits on a prompt; a click or tap opens its log. The figures do
// not animate: a hundred animated characters made the frame time 3 to 4 times
// the front view's (measured 2026-10-15), and static ones cost nothing over
// it. The room zooms and pans with the front's viewport code (task f0af4677).

import { useCallback, useEffect, useRef } from "react";
import type { AgentInfo } from "../../../shared/types.ts";
import { backRoomSide, backSeatOf } from "../../../shared/desks.ts";
import { useI18n } from "../../i18n.tsx";
import { noTranslate } from "../../no-translate.ts";
import { Character } from "../Character.tsx";
import { StatusLight } from "../StatusLight.tsx";
import { styleForModel } from "../../model-styles.ts";
import { useViewport } from "../useViewport.ts";
import { ZoomControls } from "../ZoomControls.tsx";
import type { ViewportControls } from "../OfficeView.tsx";
import {
  FIGURE_SCALE,
  SLAB_H,
  TABLE_DEPTH,
  TABLE_H,
  TILE_A,
  WALL_H,
  MIN_SCALE,
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
const FLOOR = ["#b1aea8", "#a9a6a0"];
// The slab's two visible sides, in the floor's two shades.
const SLAB_LEFT = ["#8e8b86", "#86837e"];
const SLAB_RIGHT = ["#7d7a75", "#76736e"];
// The walls' thickness, and a brick's length along a wall top.
const WALL_T = 8;
const BRICK_LEN = 26;
const LONG_PRESS_MS = 500;
// A cord's length above its bulb: long enough to run off the top of the
// screen at any pan and zoom (Nil: "the lamp cables should always reach the
// very top of the screen").
const CORD_H = 20000;
// The bulbs hang above the wall title and the board (Nil, 2026-10-15), at
// these steps up from that line, so that no two line up.
const BULB_STAGGER = [0, 34, 14, 46, 6, 26, 40, 18, 30, 10];
const BULB_GAP = 24;
const SIGN_FONT = 30;
const SIGN_SPACING = 4;
// The ladder's foot, in tiles from the right wall's end: it stands at the
// right, under the trap door, which is on the right of the front floor.
const LADDER_FROM_END = 1.6;
// The board: its smallest width, its fonts, and its span on the right wall in
// tiles (from near the back corner to short of the ladder).
const BOARD_W = 120;
const BOARD_TITLE_FONT = 10;
const BOARD_COUNT_FONT = 13;
const BOARD_C0 = 0.45;
const BOARD_LADDER_GAP = 0.35;

/** About how wide a monospace line draws: CJK glyphs take a full em, the
 *  rest 0.6 em. */
function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += /[\u2e80-\uffff]/.test(ch) ? 1 : 0.6;
  return em * fontSize;
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
  z,
  unread,
  onOpen,
  onMenu,
}: {
  agent: AgentInfo;
  at: Point;
  z: number;
  unread: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const h = 68 * FIGURE_SCALE;
  const w = 52 * FIGURE_SCALE;
  const plate = styleForModel(agent.modelFamily);
  const working =
    agent.state === "thinking" || agent.state === "tool_executing";
  const press = useRef<number | null>(null);
  const pressed = useRef(false);
  const clearPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };
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
          // 54 units is about 45 px at the smallest scale (a phone tap).
          left: at.x - 27,
          top: at.y - h - 6,
          width: 54,
          height: h + 22,
          zIndex: z,
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ width: w, height: h, pointerEvents: "none" }}>
          <Character
            state={agent.state}
            outfit={agent.outfit}
            height={h}
            sweating={working}
          />
        </div>
      </div>
      {/* The nameplate: the front's, smaller. Neighbours on a table sit a
          stool step (24 units) lower, more than its height, so plates do not
          overlap at any room size. */}
      <div
        data-back-nameplate
        style={{
          position: "absolute",
          left: at.x,
          top: at.y - h - 15,
          transform: "translateX(-50%)",
          zIndex: 5000 + z,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 3,
          maxWidth: 96,
          padding: "1px 6px 1px 4px",
          background: plate.bg,
          border: `1px solid ${plate.border}`,
          borderRadius: 10,
          whiteSpace: "nowrap",
        }}
      >
        <StatusLight state={agent.state} size={6} />
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
            left: at.x + 6,
            top: at.y - h - 32,
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

export function BackRoomScreen({
  roomName,
  agents,
  needsAttention,
  isMobile,
  onBack,
  onSpawn,
  onOpenAgent,
  onContextMenu,
  viewportControlsRef,
}: {
  roomName: string;
  /** The room's back agents. */
  agents: AgentInfo[];
  needsAttention: Set<string>;
  isMobile: boolean;
  onBack: () => void;
  onSpawn: () => void;
  onOpenAgent: (agentId: string) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  /** Where the 0, + and - keys find the view. */
  viewportControlsRef?: React.RefObject<ViewportControls | null>;
}) {
  const { t } = useI18n();
  const side = backRoomSide(agents.map((a) => a.desk));
  const layout = backRoomLayout(side);
  const roomRef = useRef<HTMLDivElement | null>(null);
  // The front's zoom and pan (task f0af4677), with its own saved view. The
  // rest view fits the whole room down to a readable scale and crops evenly
  // below it; zoom goes far enough out to show a full room on a phone, and
  // one finger always pans (there is no room swipe here).
  const viewport = useViewport(`${side}|${isMobile ? 1 : 0}`, true, {
    kind: "back",
    artBox: { left: 0, top: 0, right: 1, bottom: 1 },
    fitWidth: true,
    minScale: 0.25,
    restMinScale: MIN_SCALE,
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
  for (let r = 0; r < layout.nr; r += 1.5)
    for (let c = 0; c < layout.nc; c += 1.5) {
      const r2 = Math.min(layout.nr, r + 1.5);
      const c2 = Math.min(layout.nc, c + 1.5);
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
  const sign = layout.at(0, layout.nr * 0.62);
  const ladderFoot = layout.at(layout.nc - LADDER_FROM_END, 0.15);
  const ladderTop = { x: ladderFoot.x + 26, y: ladderFoot.y - WALL_H - 70 };
  // The board hangs on the right wall between the back corner and the
  // ladder, centred, and shrinks to fit a small room's wall.
  const boardCount = t("office.backRoom.boardCount", { count: agents.length });
  const boardTitle = t("office.backRoom.boardTitle");
  const boardW = Math.max(
    BOARD_W,
    textWidth(boardCount, BOARD_COUNT_FONT) + 24,
    textWidth(boardTitle, BOARD_TITLE_FONT) + 24,
  );
  const boardSpan =
    (layout.nc - LADDER_FROM_END - BOARD_LADDER_GAP - BOARD_C0) * TILE_A;
  const boardScale = Math.min(1, boardSpan / boardW);
  const board = layout.at(
    BOARD_C0 + (boardSpan - boardW * boardScale) / 2 / TILE_A,
    0,
  );
  // Bare bulbs on cords, two per two tables, spaced evenly from the floor's
  // left corner to the ladder and staggered in height above the title and
  // the board. The title slants up to its right end.
  const signText = t("office.backRoom.sign");
  const signW =
    textWidth(signText, SIGN_FONT) + SIGN_SPACING * [...signText].length;
  const signTop = sign.y - WALL_H * 0.6 - signW / 4 - SIGN_FONT;
  const boardTop = board.y - WALL_H * 0.78 - 4;
  const bulbLine = Math.min(signTop, boardTop) - BULB_GAP;
  const bulbCount = 2 * Math.ceil(side / 2);
  const bulbX0 = layout.at(0, layout.nr).x;
  const bulbStep = (ladderFoot.x - 30 - bulbX0) / bulbCount;
  const bulbs: Point[] = Array.from({ length: bulbCount }, (_, k) => ({
    x: bulbX0 + (k + 0.5) * bulbStep,
    y: bulbLine - BULB_STAGGER[k % BULB_STAGGER.length],
  }));

  // Back to front: tables in order, each with its figures and empty stools
  // behind it.
  const seated = new Map<string, AgentInfo>();
  for (const a of agents) {
    const s = backSeatOf(a.desk);
    if (s) seated.set(`${s.table},${s.stool}`, a);
  }
  const rows: React.ReactNode[] = [];
  for (let j = 0; j < side; j++) {
    const tb = layout.table(j);
    const t0 = layout.at(tb.c0, tb.r);
    const t1 = layout.at(tb.c1, tb.r);
    const t2 = layout.at(tb.c1, tb.r + TABLE_DEPTH);
    const t3 = layout.at(tb.c0, tb.r + TABLE_DEPTH);
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
            up(t0, TABLE_H),
            up(t1, TABLE_H),
            up(t2, TABLE_H),
            up(t3, TABLE_H),
          ])}
          fill="#8b6a4c"
          stroke="rgba(0,0,0,0.25)"
          strokeWidth={0.6}
        />
        <path
          d={poly([up(t3, TABLE_H), up(t2, TABLE_H), t2, t3])}
          fill="#6e5239"
        />
        <path
          d={poly([up(t1, TABLE_H), up(t2, TABLE_H), t2, t1])}
          fill="#5a4330"
        />
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
            z={j * 10 + 3}
            unread={needsAttention.has(agent.id)}
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
            <ellipse cx={at.x} cy={at.y - 12} rx={8} ry={4} fill="#5d5d5d" />
            <path
              d={`M${at.x - 6} ${at.y - 12} L${at.x - 6} ${at.y} M${at.x + 6} ${at.y - 12} L${at.x + 6} ${at.y}`}
              stroke="#4a4a4a"
              strokeWidth={2}
            />
          </svg>,
        );
      }
    }
  }

  const barButton: React.CSSProperties = {
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
      style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "6px 10px" : "8px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-hud)",
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
        <span
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
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
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: layout.width,
              height: layout.height,
              transform: "translate(-50%, -50%)",
            }}
          >
            <style>{`.back-room-still *, .back-room-still *::before, .back-room-still *::after { animation: none !important; transition: none !important; } .back-room-still [data-back-ladder]:focus:not(:focus-visible) { outline: none; }`}</style>
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute", inset: 0, overflow: "visible" }}
              aria-hidden="true"
            >
              {walls}
              {floor}
              {slabs}
              <g
                data-back-sign
                transform={`matrix(1 -0.5 0 1 ${sign.x} ${sign.y - WALL_H * 0.6})`}
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
              <g
                data-back-board
                transform={`matrix(${boardScale} ${boardScale * 0.5} 0 ${boardScale} ${board.x} ${board.y - WALL_H * 0.78})`}
              >
                <rect
                  width={boardW}
                  height={64}
                  fill="#2f3a33"
                  stroke="#6b5240"
                  strokeWidth={4}
                />
                <text
                  x={boardW / 2}
                  y={25}
                  textAnchor="middle"
                  fontSize={BOARD_TITLE_FONT}
                  fill="rgba(255,255,255,0.85)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {boardTitle}
                </text>
                <text
                  x={boardW / 2}
                  y={45}
                  textAnchor="middle"
                  fontSize={BOARD_COUNT_FONT}
                  fontWeight={700}
                  fill="rgba(255,255,255,0.9)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {boardCount}
                </text>
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
              {[0, 22].map((dx) => (
                <path
                  key={dx}
                  d={`M${ladderFoot.x + dx} ${ladderFoot.y} L${ladderTop.x + dx} ${ladderTop.y}`}
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
                    d={`M${x} ${y} L${x + 22} ${y}`}
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
                  { x: ladderTop.x + 30, y: ladderTop.y },
                  { x: ladderFoot.x + 30, y: ladderFoot.y + 6 },
                ])}
                fill="transparent"
                pointerEvents="all"
                cursor="pointer"
                onClick={viewport.wrapClick(onBack)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onBack();
                  }
                }}
              >
                <title>
                  {t("office.backRoom.backToTitle", { room: roomName })}
                </title>
              </path>
            </svg>
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
              {bulbs.map((p, k) => (
                <g key={k} data-back-bulb>
                  <path
                    d={`M${p.x} ${p.y - CORD_H} L${p.x} ${p.y}`}
                    stroke="#3b3b3b"
                    strokeWidth={1.4}
                  />
                  <circle
                    cx={p.x}
                    cy={p.y + 6}
                    r={26}
                    fill="url(#back-room-bulb)"
                  />
                  <circle cx={p.x} cy={p.y + 9} r={6} fill="#ffe9a8" />
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
      </div>
    </div>
  );
}

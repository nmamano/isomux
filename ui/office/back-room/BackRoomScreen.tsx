// The back room screen (task 5b503e32): the room's basement, a sweatshop of
// n long tables with n stools. Each back agent is a seated figure with a
// status light, a purple bubble when unread and an amber one when it waits on
// a prompt; a click or tap opens its log. The figures do not animate: a
// hundred animated characters made the frame time 3 to 4 times the front
// view's (measured 2026-10-15), and static ones cost nothing over it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../../shared/types.ts";
import { backRoomSide, backSeatOf } from "../../../shared/desks.ts";
import { useI18n } from "../../i18n.tsx";
import { noTranslate } from "../../no-translate.ts";
import { Character } from "../Character.tsx";
import { StatusLight } from "../StatusLight.tsx";
import {
  FIGURE_SCALE,
  SLAB_H,
  TABLE_DEPTH,
  TABLE_H,
  WALL_H,
  backRoomLayout,
  fitScale,
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
const LONG_PRESS_MS = 500;

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
      <div
        style={{
          position: "absolute",
          left: at.x - 5,
          top: at.y - h - 19,
          zIndex: 5000 + z,
          pointerEvents: "none",
          display: "flex",
        }}
      >
        <StatusLight state={agent.state} size={11} />
      </div>
      {(agent.pendingPrompt || unread) && (
        <div
          style={{
            position: "absolute",
            left: at.x + 4,
            top: at.y - h - 35,
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
}) {
  const { t } = useI18n();
  const side = backRoomSide(agents.map((a) => a.desk));
  const layout = backRoomLayout(side);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const scale = fitScale(layout, box);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setBox({ width: el.clientWidth - 16, height: el.clientHeight - 16 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // SVG animations do not stop for CSS: pause them, so every figure stays
  // still (the CSS rule below stops the rest).
  useEffect(() => {
    for (const svg of roomRef.current?.querySelectorAll("svg") ?? [])
      svg.pauseAnimations?.();
  });

  // When the room is wider or taller than the screen, open it centred on the
  // seated figures.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || box.width === 0) return;
    const seats = agents
      .map((a) => backSeatOf(a.desk))
      .filter((s) => s !== null)
      .map((s) => layout.seat(s));
    const cx = seats.length
      ? (Math.min(...seats.map((p) => p.x)) +
          Math.max(...seats.map((p) => p.x))) /
        2
      : layout.width / 2;
    const cy = seats.length
      ? (Math.min(...seats.map((p) => p.y)) +
          Math.max(...seats.map((p) => p.y))) /
        2
      : layout.height / 2;
    el.scrollLeft = cx * scale - el.clientWidth / 2;
    el.scrollTop = cy * scale - el.clientHeight / 2;
    // Only on open and when the room's size changes, not on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.width, box.height, side]);

  // A mouse drag pans the room; touch pans it natively.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(
    null,
  );

  const back = layout.at(0, 0);
  const left = layout.at(0, layout.nr);
  const right = layout.at(layout.nc, 0);
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
          up(back, WALL_H + 8),
          { x: left.x - 8, y: left.y - WALL_H - 4 },
        ])}
        fill={BRICK.topLeft}
      />
      <path
        d={poly([
          up(back, WALL_H),
          up(right, WALL_H),
          { x: right.x + 8, y: right.y - WALL_H - 4 },
          up(back, WALL_H + 8),
        ])}
        fill={BRICK.topRight}
      />
      <path
        d={poly([
          left,
          up(left, WALL_H),
          { x: left.x - 8, y: left.y - WALL_H - 4 },
          { x: left.x - 8, y: left.y - 4 },
        ])}
        fill={BRICK.endLeft}
      />
      <path
        d={poly([
          right,
          up(right, WALL_H),
          { x: right.x + 8, y: right.y - WALL_H - 4 },
          { x: right.x + 8, y: right.y - 4 },
        ])}
        fill={BRICK.endRight}
      />
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
  const slab = (a: Point, b: Point, fill: string) => (
    <path
      d={poly([a, b, { x: b.x, y: b.y + SLAB_H }, { x: a.x, y: a.y + SLAB_H }])}
      fill={fill}
    />
  );
  const sign = layout.at(0, layout.nr * 0.62);
  const ladderFoot = layout.at(1.2, 0.15);
  const ladderTop = { x: ladderFoot.x + 26, y: ladderFoot.y - WALL_H - 70 };
  const board = layout.at(layout.nc * 0.55, 0);
  // Bare bulbs on cords over the aisles, one per two tables on each side.
  const bulbs: Point[] = [];
  for (let j = 0; j < side; j += 2)
    for (const c of [layout.nc * 0.25, layout.nc * 0.75]) {
      const p = layout.at(c, layout.table(j).r + 0.9);
      bulbs.push({ x: p.x, y: p.y - 150 });
    }

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
            onOpen={() => onOpenAgent(agent.id)}
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
      <div
        ref={scrollRef}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse" || e.button !== 0) return;
          if ((e.target as HTMLElement).closest("[data-back-figure]")) return;
          const el = scrollRef.current!;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            l: el.scrollLeft,
            t: el.scrollTop,
          };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = scrollRef.current;
          if (!d || !el) return;
          el.scrollLeft = d.l - (e.clientX - d.x);
          el.scrollTop = d.t - (e.clientY - d.y);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
          padding: 8,
          background:
            "radial-gradient(ellipse at 50% 40%, var(--ambient-1) 0%, transparent 60%)",
        }}
      >
        <div
          style={{
            width: layout.width * scale,
            height: layout.height * scale,
            margin: "0 auto",
            position: "relative",
          }}
        >
          <div
            ref={roomRef}
            className="back-room-still"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            <style>{`.back-room-still *, .back-room-still *::before, .back-room-still *::after { animation: none !important; transition: none !important; }`}</style>
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute", inset: 0, overflow: "visible" }}
              aria-hidden="true"
            >
              {walls}
              {floor}
              {slab(
                layout.at(0, layout.nr),
                layout.at(layout.nc, layout.nr),
                "#8e8b86",
              )}
              {slab(
                layout.at(layout.nc, 0),
                layout.at(layout.nc, layout.nr),
                "#7d7a75",
              )}
              <g
                transform={`matrix(1 -0.5 0 1 ${sign.x} ${sign.y - WALL_H * 0.6})`}
              >
                <text
                  x={0}
                  y={0}
                  textAnchor="middle"
                  fontSize={30}
                  fontWeight={800}
                  letterSpacing={4}
                  fill="rgba(255,245,230,0.75)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {t("office.backRoom.sign")}
                </text>
              </g>
              <g
                transform={`matrix(1 0.5 0 1 ${board.x} ${board.y - WALL_H * 0.78})`}
              >
                <rect
                  width={120}
                  height={64}
                  fill="#2f3a33"
                  stroke="#6b5240"
                  strokeWidth={4}
                />
                <text
                  x={60}
                  y={22}
                  textAnchor="middle"
                  fontSize={13}
                  fill="rgba(255,255,255,0.85)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {t("office.backRoom.boardTitle")}
                </text>
                <text
                  x={60}
                  y={48}
                  textAnchor="middle"
                  fontSize={18}
                  fontWeight={700}
                  fill="rgba(255,255,255,0.9)"
                  fontFamily="'JetBrains Mono',monospace"
                >
                  {t("office.backRoom.boardCount", { count: agents.length })}
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
              aria-hidden="true"
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
                <g key={k}>
                  <path
                    d={`M${p.x} ${p.y - 260} L${p.x} ${p.y}`}
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
      </div>
    </div>
  );
}

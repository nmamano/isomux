// The trap door to the back room (task 5b503e32): a wooden hatch on the front
// floor of every ordinary room, so a click or a dropped desk reaches the back
// room at any time (task f0af4677). Light comes through the planks while a
// back agent works. The lamp on it is red while a back agent is in error,
// else yellow while one waits on a permission prompt, else green while one
// works, and off otherwise; it shows no count (Nil, task 7e325e1b). An empty back room leaves it closed and quiet.

import { useState } from "react";
import { useI18n } from "../i18n.tsx";
import { useDeskDrag } from "./useDeskDrag.ts";
import { VB_X, VB_Y } from "./grid.ts";

// The hatch's centre on the floor, in scene SVG units. One spot in every skin:
// clear of the desk slots, the right door's drop zone and the hospital props
// (ui/office/skins/hospital/layout.test.ts holds the check).
export const TRAP_DOOR_CENTER = { x: 445, y: 310 };
// Half-axes of the hatch along the two floor directions, in SVG units.
export const TRAP_DOOR_U = { x: 25.2, y: 12.6 };
export const TRAP_DOOR_V = { x: -20.4, y: 10.2 };
// The hit box: wider than the drawing so a phone tap (the scene is drawn at
// about half size there) still gets about 60 x 44 px.
const TRAP_DOOR_HIT = { w: 120, h: 86 };

export interface BackRoomAttention {
  agents: number;
  working: number;
  asking: number;
  error: number;
}

const pt = (a: number, b: number) => ({
  x: TRAP_DOOR_HIT.w / 2 + TRAP_DOOR_U.x * a + TRAP_DOOR_V.x * b,
  y: TRAP_DOOR_HIT.h / 2 + TRAP_DOOR_U.y * a + TRAP_DOOR_V.y * b,
});
const poly = (s: number) =>
  "M" +
  [pt(-s, -s), pt(s, -s), pt(s, s), pt(-s, s)]
    .map((p) => `${p.x} ${p.y}`)
    .join(" L") +
  " Z";
// Where the lamp stands: the far corner, across from the ring handle.
const LAMP = pt(-0.62, -0.55);
const LAMP_COLORS: Record<string, string | null> = {
  error: "#ff5a5a",
  asking: "#ffc93c",
  working: "#4fdc7c",
  off: null,
};

export function TrapDoor({
  attention,
  backFull,
  onOpen,
  onDropDesk,
}: {
  attention: BackRoomAttention;
  backFull: boolean;
  onOpen: () => void;
  /** Moves the dragged desk's agent to the back room. */
  onDropDesk: (desk: number) => void;
}) {
  const { t, tn } = useI18n();
  const dragging = useDeskDrag();
  const [over, setOver] = useState(false);
  if (!dragging && over) setOver(false);
  const lit = attention.working > 0;
  const lamp =
    attention.error > 0
      ? "error"
      : attention.asking > 0
        ? "asking"
        : lit
          ? "working"
          : "off";
  const lampColor = LAMP_COLORS[lamp];
  const left = TRAP_DOOR_CENTER.x - VB_X - TRAP_DOOR_HIT.w / 2;
  const top = TRAP_DOOR_CENTER.y - VB_Y - TRAP_DOOR_HIT.h / 2;

  return (
    <>
      <div
        data-no-pan
        data-trap-door
        role="button"
        tabIndex={0}
        aria-label={tn("office.backRoom.tooltip", attention.agents)}
        title={tn("office.backRoom.tooltip", attention.agents)}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = backFull ? "none" : "move";
        }}
        onDragEnter={() => setOver(true)}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const desk = parseInt(e.dataTransfer.getData("text/plain"), 10);
          if (!isNaN(desk) && !backFull) onDropDesk(desk);
        }}
        style={{
          position: "absolute",
          left,
          top,
          width: TRAP_DOOR_HIT.w,
          height: TRAP_DOOR_HIT.h,
          // On the floor: above the floor drawing, below every desk unit.
          zIndex: 5,
          cursor: "pointer",
        }}
      >
        <svg
          width={TRAP_DOOR_HIT.w}
          height={TRAP_DOOR_HIT.h}
          // Not a drag target itself: a drag moving onto the drawing would
          // leave the hatch and clear the over state.
          style={{
            position: "absolute",
            inset: 0,
            overflow: "visible",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          <defs>
            <filter
              id="trap-door-glow"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
          </defs>
          <path d={poly(1.12)} fill="rgba(0,0,0,0.10)" />
          <path d={poly(1)} fill="#4a3527" />
          <path d={poly(0.86)} fill="#8b6a4c" />
          {[-0.43, 0, 0.43].map((b) => {
            const a0 = pt(-0.86, b);
            const a1 = pt(0.86, b);
            const d = `M${a0.x} ${a0.y} L${a1.x} ${a1.y}`;
            return (
              <g key={b}>
                {lit && (
                  <path
                    d={d}
                    stroke="#ffcf6b"
                    strokeWidth={3}
                    filter="url(#trap-door-glow)"
                    opacity={0.9}
                  />
                )}
                <path
                  d={d}
                  stroke={lit ? "#ffe2a0" : "#5a4330"}
                  strokeWidth={1.2}
                />
              </g>
            );
          })}
          {/* The lamp on the far corner (task 7e325e1b). */}
          <g data-trap-door-lamp={lamp}>
            {lampColor && (
              <circle
                cx={LAMP.x}
                cy={LAMP.y - 3}
                r={11}
                fill={lampColor}
                opacity={0.75}
                filter="url(#trap-door-glow)"
              />
            )}
            <ellipse cx={LAMP.x} cy={LAMP.y} rx={6.5} ry={3.2} fill="#2b2622" />
            <path
              d={`M${LAMP.x - 5} ${LAMP.y} A5 5.5 0 0 1 ${LAMP.x + 5} ${LAMP.y} Z`}
              fill={lampColor ?? "#5a5f66"}
              stroke={lampColor ? "#ffffff" : "#3a3d42"}
              strokeWidth={0.8}
            />
            <ellipse
              cx={LAMP.x - 1.8}
              cy={LAMP.y - 3.4}
              rx={1.4}
              ry={1}
              fill="#fff"
              opacity={lampColor ? 0.9 : 0.35}
            />
          </g>
          <ellipse
            cx={pt(0.62, 0.55).x}
            cy={pt(0.62, 0.55).y}
            rx={5}
            ry={2.6}
            fill="none"
            stroke="#3a3a3a"
            strokeWidth={1.6}
          />
          {/* Quiet while a desk is dragged, so the other drop targets still
              read as options; strong only while the drag is over the hatch
              (task 318df699). */}
          {dragging && (
            <path
              d={poly(1.35)}
              fill={
                backFull
                  ? "rgba(255,60,60,0.12)"
                  : over
                    ? "rgba(126,184,255,0.18)"
                    : "none"
              }
              stroke={backFull ? "var(--red)" : "var(--accent)"}
              strokeWidth={backFull || over ? 2 : 1}
              strokeDasharray={over && !backFull ? "none" : "6 4"}
              opacity={backFull || over ? 1 : 0.6}
            />
          )}
        </svg>
      </div>
      {dragging && (
        // A sibling of the hatch, not a child: the hatch sits under the desks,
        // and the drop badge must sit above them.
        <div
          style={{
            position: "absolute",
            left: left + TRAP_DOOR_HIT.w / 2 + 44,
            top: top + 16,
            transform: "translate(-100%, -100%)",
            display: "flex",
            gap: 4,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 9000,
          }}
        >
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 600,
              ...(backFull
                ? {
                    border: "1px solid var(--red)",
                    background: "var(--red)",
                    color: "var(--bg-base)",
                  }
                : over
                  ? {
                      border: "1px solid var(--accent)",
                      background: "var(--bg-tag)",
                      color: "var(--accent-text)",
                    }
                  : {
                      border: "1px dashed var(--accent)",
                      background: "var(--bg-tag)",
                      color: "var(--text-dim)",
                    }),
            }}
          >
            {backFull
              ? t("office.backRoom.fullBadge")
              : t("office.backRoom.dropBadge")}
          </span>
        </div>
      )}
    </>
  );
}

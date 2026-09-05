// Live-avatars ghost rendering, split into two independent components
// so each contributes ONE DOM child to the scene container - no Fragment.
// A Fragment of body + tag would shuffle as a unit when the children
// array reorders (e.g. a ghost arriving / leaving), and Fragment-
// contributed DOM nodes can get re-attached on reorder, retriggering
// the ghostFadeIn keyframe on unrelated ghosts. Two individually-keyed
// siblings at the parent level avoid that.
//
// The two components share placement props but render at different
// z-indices: body sits below desk nametag chips (so the chips' text
// is never occluded by ghost art) while the name tag sits above
// everything (it's the readable element).

import { useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { GhostGraphic } from "./ghostVariants.tsx";
import type { GhostVariant } from "../../shared/avatar.ts";

// Z-ordering contract:
//   body  (this layer) :        above floor / walls / desks / agents,
//                               BELOW the desk nametag chips that DeskUnit
//                               renders at z = z_desk + 10000.
//   tag   (this layer) :        above everything, including those nametags.
export const GHOST_BODY_Z = 200;
export const GHOST_TAG_Z = 20000;

// SVG viewBox is "-15 -30 130 170". The visible head top (viewBox y=0)
// sits at vertical offset size * 30/130 inside the rendered SVG box,
// and the rendered height comes out as size * 170/130.
export const SVG_HEIGHT_RATIO = 170 / 130;
export const SVG_HEAD_TOP_RATIO = 30 / 130;
export function ghostBodyBottomOffset(size: number): number {
  return Math.round(size * (SVG_HEIGHT_RATIO - SVG_HEAD_TOP_RATIO - 100 / 130));
}
const TAG_GAP_ABOVE_HEAD = 4;
const TAG_HEIGHT_PX = 16;

interface SharedGhostProps {
  left: number;
  top: number;
  // Pixel width of the ghost graphic (height scales proportionally).
  size: number;
  variant: GhostVariant;
  color: string;
  username: string;
  // Optional device label ("Phone", "Laptop", ...).
  device: string | null;
  // userId is forwarded to the click handler so the parent can open
  // the user-edit modal preopened to the right user.
  userId: string;
  // True when the ghost is in "away" mode (boss is in TaskView /
  // CronjobsView / Settings). The body fades; the bob continues so
  // it doesn't look fully frozen.
  dimmed: boolean;
  onClick?: (userId: string) => void;
}

// Movement properties shared by body and tag so they stay perfectly
// synced during tab-cycle / room-relocate slides. No CSS fade-in
// keyframe here: browsers can restart CSS animations when React
// moves a DOM node during reorder, which manifested as unrelated
// ghosts flashing whenever someone else's anchor changed. The
// opacity transition handles the dim/undim smoothly; new ghosts
// just appear (acceptable v1 cost - imperative ref.animate() on
// mount is the planned upgrade if we want the fade back).
function motionStyle(
  dimmed: boolean,
  onClick: unknown,
  pointerEvents: CSSProperties["pointerEvents"],
): CSSProperties {
  return {
    transition: "left 220ms ease-out, top 220ms ease-out, opacity 220ms",
    opacity: dimmed ? 0.4 : 1,
    cursor: onClick ? "pointer" : "default",
    pointerEvents,
  };
}

function tagText(username: string, device: string | null): string {
  return device ? `${username} (${device})` : username;
}

function makeClickHandler(
  userId: string,
  onClick: ((userId: string) => void) | undefined,
) {
  return (e: ReactMouseEvent<HTMLDivElement>) => {
    // Don't bubble to an underlying desk - a ghost rendered SE of a
    // desk overlaps the desk's hit area in some isometric configurations,
    // and the boss expects clicking a ghost to open user settings, not
    // also focus the agent.
    e.stopPropagation();
    e.preventDefault();
    if (onClick) onClick(userId);
  };
}


// ---------------------------------------------------------------------
// Movement trail
// ---------------------------------------------------------------------
// A ghost only ever moves through the CSS `left`/`top` transition in
// motionStyle, so the trail rides the same 220ms window: one keyed
// element per move, a pure CSS animation inside it, and nothing at all
// while the ghost is still. No timers, no per-frame React state - the
// component re-renders once per move, when the placement props change.
//
// The marks are floor dust and small sparkles: dust reads as motion,
// sparkles give it the charm. Both stay quiet - the effect should be
// noticed after the ghost, not before it.

// Moves shorter than this leave nothing behind: a stack reshuffle of a
// few pixels (a second boss joining the same desk) should not puff.
const TRAIL_MIN_DISTANCE_PX = 12;

// Each mark is dropped `back` of the way along the tail, measured back
// from where the ghost lands. The tail runs along the travel vector but
// its length is capped at TRAIL_SPAN_PX, so a hop across the room leaves
// the same short tail behind the ghost as a step between two desks -
// uncapped, a long move spreads the marks over the whole path.
interface TrailMark {
  // "puff" is a soft ellipse of floor dust, "spark" a four-point twinkle.
  kind: "puff" | "spark";
  back: number;
  // Peak opacity, reached early in the mark's own animation.
  peak: number;
  // Scale at the start, at the travel stop, and at the end of the
  // mark's animation. `mid` defaults to a point between the other two;
  // a spark sets it above both, which is what makes it pop and shrink.
  from: number;
  to: number;
  mid?: number;
  // Head start, so the marks appear in sequence rather than together.
  delayMs: number;
  // Mark width as a fraction of the ghost width.
  width: number;
  // Offset from the path, square to the travel direction, in pixels.
  // Sparks sit off the line so they do not stack on the dust.
  side?: number;
  // Offset above the floor line, in pixels. Sparks float around the
  // ghost, dust stays down.
  lift?: number;
}

const TRAIL_MARKS: TrailMark[] = [
  { kind: "puff", back: 0.3, peak: 0.3, from: 0.35, to: 1.1, delayMs: 0, width: 0.66 },
  { kind: "puff", back: 0.58, peak: 0.23, from: 0.35, to: 1.3, delayMs: 55, width: 0.8 },
  { kind: "puff", back: 0.88, peak: 0.15, from: 0.35, to: 1.5, delayMs: 110, width: 0.95 },
  { kind: "spark", back: 0.24, peak: 0.85, from: 0.35, to: 0.5, mid: 1.15, delayMs: 30, width: 0.3, side: 8, lift: -13 },
  { kind: "spark", back: 0.52, peak: 0.7, from: 0.35, to: 0.5, mid: 1.1, delayMs: 95, width: 0.24, side: -10, lift: -4 },
  { kind: "spark", back: 0.8, peak: 0.55, from: 0.35, to: 0.5, mid: 1.05, delayMs: 160, width: 0.19, side: 5, lift: -20 },
];

// A four-point twinkle in a 24x24 box. Warm gold, which stays visible on
// both the dark and the light floor and matches the desk lamps.
const SPARK_PATH =
  "M12,1.5 C13,8.4 15.6,11 22.5,12 C15.6,13 13,15.6 12,22.5 C11,15.6 8.4,13 1.5,12 C8.4,11 11,8.4 12,1.5 Z";
const SPARK_COLOR = "#eec25c";

// Longest tail, in pixels behind the ghost.
const TRAIL_SPAN_PX = 105;

const TRAIL_DURATION_MS = 560;

// Fraction of a mark's animation spent travelling. It matches the 220ms
// left/top transition the ghost itself rides, so a mark reaches the spot
// it was dropped at just as the ghost lands, and only fades after that.
const TRAIL_TRAVEL_STOP = "40%";

// Marks lift a little as they disperse.
const TRAIL_LIFT_PX = -4;

const TRAIL_CSS = `
@keyframes isomuxGhostTrail {
  0% { opacity: 0; transform: translate(0px, 0px) scale(var(--gt-from));
       animation-timing-function: cubic-bezier(0, 0, 0.2, 1); }
  16% { opacity: var(--gt-peak); }
  ${TRAIL_TRAVEL_STOP} { transform: translate(var(--gt-dx), var(--gt-dy)) scale(var(--gt-mid)); }
  100% { opacity: 0; transform: translate(var(--gt-dx), var(--gt-dy)) scale(var(--gt-to)); }
}
`;

// One trail, mounted for the length of a single move. The parent keys it
// by move counter, so React remounts it per move and the CSS animation
// restarts from 0% - the same restart-on-remount trick the door ajar
// animation uses.
function GhostTrail({
  dx,
  dy,
  size,
}: {
  dx: number;
  dy: number;
  size: number;
}) {
  // Travel direction, scaled to the capped tail length, and the unit
  // square to it, which sparks step off along.
  const distance = Math.hypot(dx, dy) || 1;
  const tail = Math.min(distance, TRAIL_SPAN_PX);
  const tailX = (dx / distance) * tail;
  const tailY = (dy / distance) * tail;
  const sideX = -dy / distance;
  const sideY = dx / distance;
  // The marks hang off the bottom of the ghost body.
  const anchorX = size / 2;
  const anchorY = size * 0.99;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        pointerEvents: "none",
        // Behind the ghost art, which is in-flow in the same
        // (already isolated) stacking context.
        zIndex: -1,
      }}
    >
      {TRAIL_MARKS.map((m, i) => {
        const markW = size * m.width;
        const markH = m.kind === "puff" ? markW / 2 : markW;
        const off = m.side ?? 0;
        const style: CSSProperties & Record<string, string | number> = {
          position: "absolute",
          left: anchorX - markW / 2 + sideX * off,
          top: anchorY - markH / 2 + sideY * off + (m.lift ?? 0),
          width: markW,
          height: markH,
          opacity: 0,
          "--gt-dx": `${(-tailX * m.back).toFixed(2)}px`,
          "--gt-dy": `${(-tailY * m.back + TRAIL_LIFT_PX).toFixed(2)}px`,
          "--gt-from": m.from,
          "--gt-mid": (m.mid ?? m.from + (m.to - m.from) * 0.45).toFixed(3),
          "--gt-to": m.to,
          "--gt-peak": m.peak,
          animation: `isomuxGhostTrail ${TRAIL_DURATION_MS}ms ease-out ${m.delayMs}ms both`,
        };
        if (m.kind === "puff") {
          return (
            <div
              key={i}
              style={{
                ...style,
                borderRadius: "50%",
                // A solid core out to 40%, then a soft edge - a plain
                // two-stop gradient averages out almost invisible over
                // the floor.
                background:
                  "radial-gradient(closest-side, var(--text-dim) 0%, var(--text-dim) 40%, transparent 100%)",
              }}
            />
          );
        }
        return (
          <svg key={i} style={style} viewBox="0 0 24 24">
            <path d={SPARK_PATH} fill={SPARK_COLOR} />
          </svg>
        );
      })}
    </div>
  );
}

export function GhostBody({
  left,
  top,
  size,
  variant,
  color,
  username,
  device,
  userId,
  dimmed,
  onClick,
}: SharedGhostProps) {
  const bodyHeight = Math.round(size * SVG_HEIGHT_RATIO);
  // Render-phase derived state, the same pattern useGhostTransitions
  // uses: the render that first sees new coords records the step it
  // just took, React discards that render and re-renders with the new
  // state, so the paint that starts the slide already carries the
  // trail. `pass` is 0 until the first move, so a ghost that has just
  // mounted never trails.
  const [move, setMove] = useState({ left, top, dx: 0, dy: 0, pass: 0 });
  if (move.left !== left || move.top !== top) {
    setMove({
      left,
      top,
      dx: left - move.left,
      dy: top - move.top,
      pass: move.pass + 1,
    });
  }
  const trailing =
    move.pass > 0 && Math.hypot(move.dx, move.dy) >= TRAIL_MIN_DISTANCE_PX;
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: size,
        height: bodyHeight,
        zIndex: GHOST_BODY_Z,
        ...motionStyle(dimmed, onClick, "none"),
        // Let transparent parts of the SVG box fall through to the desk.
        // Painted SVG pixels opt back into hit testing below.
      }}
      onClick={makeClickHandler(userId, onClick)}
      data-no-pan
      title={tagText(username, device)}
    >
      <style>{TRAIL_CSS}</style>
      {trailing && (
        <GhostTrail key={move.pass} dx={move.dx} dy={move.dy} size={size} />
      )}
      <GhostGraphic
        variant={variant}
        color={color}
        size={size}
        hitTestPainted
      />
    </div>
  );
}

export function GhostTag({
  left,
  top,
  size,
  username,
  device,
  userId,
  dimmed,
  onClick,
}: SharedGhostProps) {
  // Tag floats just above the SVG head-top with a small gap. Centered
  // horizontally on the body's midline via translateX(-50%) - the
  // ghostFadeIn keyframe intentionally animates opacity only so this
  // centering transform isn't clobbered during the 300ms fade-in.
  const headTopPx = Math.round(size * SVG_HEAD_TOP_RATIO);
  const tagTop = top + headTopPx - TAG_HEIGHT_PX - TAG_GAP_ABOVE_HEAD;
  const tagCenterX = left + size / 2;
  const text = tagText(username, device);
  return (
    <div
      style={{
        position: "absolute",
        left: tagCenterX,
        top: tagTop,
        transform: "translateX(-50%)",
        zIndex: GHOST_TAG_Z,
        ...motionStyle(dimmed, onClick, "auto"),
      }}
      onClick={makeClickHandler(userId, onClick)}
      data-no-pan
      title={text}
    >
      <span
        style={{
          background: "rgba(0,0,0,0.7)",
          color: "white",
          fontSize: 10,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          padding: "1px 7px",
          borderRadius: 8,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          // Wider cap to accommodate "username (device)"; still
          // truncates with ellipsis at the limit.
          maxWidth: 140,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "inline-block",
          lineHeight: "14px",
        }}
      >
        {text}
      </span>
    </div>
  );
}

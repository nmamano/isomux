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
const SVG_HEIGHT_RATIO = 170 / 130;
const SVG_HEAD_TOP_RATIO = 30 / 130;
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
function motionStyle(dimmed: boolean, onClick?: unknown): CSSProperties {
  return {
    transition: "left 220ms ease-out, top 220ms ease-out, opacity 220ms",
    opacity: dimmed ? 0.4 : 1,
    cursor: onClick ? "pointer" : "default",
    pointerEvents: "auto",
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

// --- Body (SVG only) -----------------------------------------------------

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
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: size,
        height: bodyHeight,
        zIndex: GHOST_BODY_Z,
        ...motionStyle(dimmed, onClick),
      }}
      onClick={makeClickHandler(userId, onClick)}
      data-no-pan
      title={tagText(username, device)}
    >
      <GhostGraphic variant={variant} color={color} size={size} />
    </div>
  );
}

// --- Tag (label chip) ----------------------------------------------------

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
        ...motionStyle(dimmed, onClick),
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

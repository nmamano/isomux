// Absolutely-positioned ghost avatar for a single PresenceInfo.
// The parent (OfficeView) computes (left, top) in pixel space and
// passes them as props; this component handles the always-on name
// tag, the off-scene dim, click-to-open-user-settings, and the
// CSS transition that produces the tab-cycle slide.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { GhostGraphic } from "./ghostVariants.tsx";
import type { GhostVariant } from "../../shared/avatar.ts";

interface GhostProps {
  left: number;
  top: number;
  // Pixel width of the ghost graphic (height scales proportionally).
  // ~50% of agent character size, so ~30 reads as a small floating
  // figure next to a desk.
  size: number;
  variant: GhostVariant;
  color: string;
  username: string;
  // userId is forwarded to the click handler so the parent can open
  // the user-edit modal preopened to the right user.
  userId: string;
  // True when the ghost is in "away" mode (boss is in TaskView /
  // CronjobsView / Settings). The body fades; the bob continues so
  // it doesn't look fully frozen.
  dimmed: boolean;
  // Z-order: render above every other scene element. Floor tiles are
  // SVG (no z-index); walls, desks, and characters use z-indices in
  // the 0..80 range, so 200 lands every ghost on top.
  zIndex?: number;
  onClick?: (userId: string) => void;
}

export function Ghost({
  left,
  top,
  size,
  variant,
  color,
  username,
  userId,
  dimmed,
  zIndex = 200,
  onClick,
}: GhostProps) {
  const containerStyle: CSSProperties = {
    position: "absolute",
    left,
    top,
    zIndex,
    pointerEvents: "auto",
    cursor: onClick ? "pointer" : "default",
    opacity: dimmed ? 0.4 : 1,
    // Slide for tab-cycle / room-relocate within the same room: the
    // browser tweens left/top when the parent passes a new value with
    // the same React key. Cross-room and connect/disconnect transitions
    // come from unmount/remount + the keyframe fade defined in styles.ts.
    transition: "left 220ms ease-out, top 220ms ease-out, opacity 220ms",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    // Skip the fade-in keyframe when dimmed: the keyframe fades opacity
    // 0→1 and a subsequent inline opacity:0.4 would snap at the end of
    // the animation. Dimmed ghosts appear immediately at their faded
    // value; the visual cost of skipping the fade is small since they
    // already read as "ambient / not-present-here."
    animation: dimmed ? undefined : "ghostFadeIn 300ms ease-out",
  };

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    // Don't bubble to the underlying desk — a ghost rendered SE of a
    // desk overlaps the desk's hit area in some isometric configurations,
    // and the boss expects clicking a ghost to open user settings, not
    // also focus the agent.
    e.stopPropagation();
    e.preventDefault();
    if (onClick) onClick(userId);
  }

  return (
    <div
      style={containerStyle}
      onClick={handleClick}
      data-no-pan
      title={username}
    >
      <GhostGraphic variant={variant} color={color} size={size} />
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
          maxWidth: 96,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {username}
      </span>
    </div>
  );
}

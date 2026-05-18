// Absolutely-positioned ghost avatar for a single PresenceInfo.
// The parent (OfficeView) computes (left, top) in pixel space and
// passes them as props; this component renders TWO positioned
// siblings — a low-z body and a high-z name tag — so the body sits
// underneath the desk nametag chips (their text needs to read above
// the ghost art) while the tag itself stays above everything.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { GhostGraphic } from "./ghostVariants.tsx";
import type { GhostVariant } from "../../shared/avatar.ts";

interface GhostProps {
  left: number;
  top: number;
  // Pixel width of the ghost graphic (height scales proportionally).
  // ~50% of agent character size, so ~40 reads as a small floating
  // figure next to a desk.
  size: number;
  variant: GhostVariant;
  color: string;
  username: string;
  // Optional device label ("Phone", "Laptop", ...) — when present, the
  // name tag reads "username (device)" so other bosses can distinguish
  // a user's multiple connected devices.
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

// Body sits behind desk nametags (z + 10000 in DeskUnit) but above the
// raw desk visuals (z 10-80). Tag sits above everything — it carries
// the readable username/device pair and shouldn't be occluded.
const GHOST_BODY_Z = 200;
const GHOST_TAG_Z = 20000;

// SVG viewBox is "-15 -30 130 170". At a rendered width of `size`, the
// pixel height comes to size * 170/130 and the head's top (viewBox y=0)
// sits at vertical offset size * 30/130 inside the SVG box. The tag is
// pinned just above that head-top so it reads like a speech-bubble cap.
const SVG_HEIGHT_RATIO = 170 / 130;
const SVG_HEAD_TOP_RATIO = 30 / 130;
const TAG_GAP_ABOVE_HEAD = 4;
const TAG_HEIGHT_PX = 16;

export function Ghost({
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
}: GhostProps) {
  const opacity = dimmed ? 0.4 : 1;
  // Slide for tab-cycle / room-relocate within the same room: the
  // browser tweens left/top when the parent passes a new value with
  // the same React key. Cross-room and connect/disconnect transitions
  // come from unmount/remount + the keyframe fade defined in styles.ts.
  // Skip the fade-in keyframe when dimmed: the keyframe fades opacity
  // 0→1 and a subsequent inline opacity:0.4 would snap at the end of
  // the animation.
  const sharedMotion: CSSProperties = {
    transition: "left 220ms ease-out, top 220ms ease-out, opacity 220ms",
    animation: dimmed ? undefined : "ghostFadeIn 300ms ease-out",
    opacity,
    cursor: onClick ? "pointer" : "default",
    pointerEvents: "auto",
  };

  // "username" or "username (device)" — truncated via CSS so a long
  // user/device combo doesn't blow out the floor layout. Hover/title
  // still shows the full string.
  const tagText = device ? `${username} (${device})` : username;

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    // Don't bubble to the underlying desk — a ghost rendered SE of a
    // desk overlaps the desk's hit area in some isometric configurations,
    // and the boss expects clicking a ghost to open user settings, not
    // also focus the agent.
    e.stopPropagation();
    e.preventDefault();
    if (onClick) onClick(userId);
  }

  // Body anchor matches the parent's (left, top) directly so existing
  // placement math (deskPixelPos + offset, lobby coords) keeps working.
  // The tag floats just above the head, centered horizontally on the
  // body's midline.
  const headTopPx = Math.round(size * SVG_HEAD_TOP_RATIO);
  const tagTop = top + headTopPx - TAG_HEIGHT_PX - TAG_GAP_ABOVE_HEAD;
  const tagCenterX = left + size / 2;

  const bodyHeight = Math.round(size * SVG_HEIGHT_RATIO);

  return (
    <>
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: size,
          height: bodyHeight,
          zIndex: GHOST_BODY_Z,
          ...sharedMotion,
        }}
        onClick={handleClick}
        data-no-pan
        title={tagText}
      >
        <GhostGraphic variant={variant} color={color} size={size} />
      </div>
      <div
        style={{
          position: "absolute",
          left: tagCenterX,
          top: tagTop,
          transform: "translateX(-50%)",
          zIndex: GHOST_TAG_Z,
          ...sharedMotion,
        }}
        onClick={handleClick}
        data-no-pan
        title={tagText}
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
            // truncates with ellipsis if both strings are at the limit.
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "inline-block",
            lineHeight: "14px",
          }}
        >
          {tagText}
        </span>
      </div>
    </>
  );
}

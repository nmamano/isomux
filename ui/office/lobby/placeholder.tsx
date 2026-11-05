import { useId, type ReactNode } from "react";
import type { AgentOutfit } from "../../../shared/types.ts";

// Unloaded placeholders: while the office state loads, a lobby object drawn
// from it takes its loaded shape in one flat tone, so nothing snaps in.

// Any outfit: a silhouette shows only its shape.
export const PLACEHOLDER_OUTFIT: AgentOutfit = {
  hat: "none",
  color: "#000",
  hair: "#000",
  hairStyle: "short",
  skin: "#000",
  beard: "none",
  accessory: null,
};

// Its children in one flat tone. Faint pixels (a drop shadow) drop out, so
// the edge stays hard.
export function Silhouette({
  color,
  opacity,
  children,
}: {
  color: string;
  opacity: number;
  children: ReactNode;
}) {
  const id = `lobby-silhouette-${useId().replace(/:/g, "")}`;
  return (
    <g>
      <defs>
        <filter id={id}>
          <feComponentTransfer in="SourceAlpha" result="shape">
            <feFuncA type="discrete" tableValues="0 1" />
          </feComponentTransfer>
          <feFlood floodColor={color} floodOpacity={opacity} />
          <feComposite in2="shape" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>{children}</g>
    </g>
  );
}

// A line of text not loaded yet: a rounded bar on its baseline. The text is
// about `size` high; anchor follows the text's textAnchor.
export function TextBar({
  x,
  y,
  width,
  size,
  anchor = "start",
  color,
  opacity,
}: {
  x: number;
  y: number;
  width: number;
  size: number;
  anchor?: "start" | "middle";
  color: string;
  opacity: number;
}) {
  const height = size * 0.7;
  return (
    <rect
      x={anchor === "middle" ? x - width / 2 : x}
      y={y - height}
      width={width}
      height={height}
      rx={height / 2}
      fill={color}
      opacity={opacity}
    />
  );
}

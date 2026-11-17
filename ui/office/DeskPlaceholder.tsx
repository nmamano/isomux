import { DESK_SLOTS } from "../../shared/desks.ts";
import type { OfficeShapeDesk } from "../office-shape.ts";
import { Character } from "./Character.tsx";
import { DeskSprite } from "./DeskSprite.tsx";
import { deskPixelPos } from "./grid.ts";
import { PLACEHOLDER_OUTFIT, Silhouette } from "./lobby/placeholder.tsx";

// The flat tone of every placeholder in the scene, as the lobby's.
const TONE = "#000";
const OPACITY = 0.22;
// A name tag with a topic line is taller; it starts higher (DeskUnit).
const TOPIC_TAG_H = 26;

// A desk whose agent is not loaded yet (task ea29a8e2): the desk and a
// seated figure in one flat tone and its name tag's box, at the place and
// size this device last drew them; nothing to click.
export function DeskPlaceholder({ desk }: { desk: OfficeShapeDesk }) {
  const pos = DESK_SLOTS[desk.desk];
  if (!pos) return null;
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;
  return (
    <div
      data-desk-placeholder={desk.desk}
      aria-hidden="true"
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          position: "absolute",
          left: pxLeft,
          top: pxTop,
          width: 180,
          zIndex: z,
        }}
      >
        {/* Where DeskUnit draws an idle agent. */}
        <div style={{ position: "absolute", left: 84, top: -16, zIndex: 1 }}>
          <svg overflow="visible" width={1} height={1}>
            <Silhouette color={TONE} opacity={OPACITY}>
              <Character state="idle" outfit={PLACEHOLDER_OUTFIT} />
            </Silhouette>
          </svg>
        </div>
        <div style={{ position: "relative", zIndex: 2 }}>
          <svg width="180" height="140" overflow="visible">
            <Silhouette color={TONE} opacity={OPACITY}>
              <DeskSprite state="idle" deskIndex={desk.desk} />
            </Silhouette>
          </svg>
        </div>
      </div>
      <div
        data-desk-placeholder-tag=""
        style={{
          position: "absolute",
          top: pxTop + (desk.h > TOPIC_TAG_H ? -58 : -48),
          left: pxLeft + 90,
          transform: "translateX(-50%)",
          zIndex: z + 10000,
          width: `${desk.w}px`,
          height: `${desk.h}px`,
          borderRadius: 10,
          background: TONE,
          opacity: OPACITY,
        }}
      />
    </div>
  );
}

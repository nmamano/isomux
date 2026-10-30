import { useI18n } from "../../i18n.tsx";
import { wallTransform } from "./iso.tsx";

// The lobby elevator: brushed steel doors in a frame, a floor indicator above
// and a call panel beside them, drawn in the wall plane with its sill at the
// anchor. In the live lobby (`onOpen`) a click opens the floors dialog.
const FRAME_W = 50;
const FRAME_H = 82;
const DOOR_W = 21;
const DOOR_H = 76;
const PANEL_X = FRAME_W / 2 + 4;
const PANEL_W = 8;
const INDICATOR_H = 11;

// The drawn extent in the wall plane: frame, indicator and call panel.
export const ELEVATOR_BOX = {
  x: -FRAME_W / 2,
  y: -FRAME_H - INDICATOR_H,
  width: FRAME_W / 2 + PANEL_X + PANEL_W,
  height: FRAME_H + INDICATOR_H,
};

export function Elevator({
  wall,
  onOpen,
}: {
  wall: "left" | "right";
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  return (
    <g
      transform={wallTransform(wall, 0, 0)}
      {...(onOpen && {
        "data-no-pan": true,
        onClick: onOpen,
        onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
        style: { cursor: "pointer", pointerEvents: "auto" },
      })}
    >
      {onOpen && <title>{t("lobby.elevator.open")}</title>}
      <defs>
        <linearGradient id="lobby-elevator-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#aeb5bc" />
          <stop offset="0.5" stopColor="#d6dbe0" />
          <stop offset="1" stopColor="#9aa2aa" />
        </linearGradient>
      </defs>
      {/* Frame */}
      <rect
        x={-FRAME_W / 2}
        y={-FRAME_H}
        width={FRAME_W}
        height={FRAME_H}
        rx="1.5"
        fill="#6f7780"
        stroke="#454b52"
        strokeWidth="0.8"
      />
      {/* Doors, meeting at a centre seam */}
      <rect
        x={-DOOR_W}
        y={-DOOR_H}
        width={DOOR_W}
        height={DOOR_H}
        fill="url(#lobby-elevator-steel)"
        stroke="#7c848c"
        strokeWidth="0.5"
      />
      <rect
        x={0}
        y={-DOOR_H}
        width={DOOR_W}
        height={DOOR_H}
        fill="url(#lobby-elevator-steel)"
        stroke="#7c848c"
        strokeWidth="0.5"
      />
      <line x1="0" y1={-DOOR_H} x2="0" y2="0" stroke="#5c636b" />
      {/* Floor indicator over the frame */}
      <rect
        x="-13"
        y={-FRAME_H - INDICATOR_H}
        width="26"
        height="9"
        rx="2"
        fill="#1d1f22"
        stroke="#454b52"
        strokeWidth="0.6"
      />
      <path
        d={`M-6 ${-FRAME_H - 4.5} L-3 ${-FRAME_H - 8.5} L0 ${-FRAME_H - 4.5} Z`}
        fill="#f5b041"
      />
      <path
        d={`M2 ${-FRAME_H - 8.5} L5 ${-FRAME_H - 4.5} L8 ${-FRAME_H - 8.5} Z`}
        fill="#5a4a2a"
      />
      {/* Call panel */}
      <rect
        x={PANEL_X}
        y="-48"
        width={PANEL_W}
        height="17"
        rx="1.5"
        fill="#8a929a"
        stroke="#454b52"
        strokeWidth="0.6"
      />
      <circle cx={PANEL_X + PANEL_W / 2} cy="-43" r="2" fill="#f5b041" />
      <circle cx={PANEL_X + PANEL_W / 2} cy="-36" r="2" fill="#d6dbe0" />
    </g>
  );
}

// The receptionist as it stands in the lobby scene: the agent's Character with
// its feet at the group's origin, a nametag pill above its head, and the same
// click and right-click affordances a desk has. Rendered INSIDE the lobby's
// props SVG. The HTML pill uses the browser’s text layout to centre the
// full label, as desk tags do. The group opts back into pointer events.
import { useI18n } from "../i18n.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import { Character, CHARACTER_GEOMETRY } from "./Character.tsx";
import { styleForModel } from "../model-styles.ts";

const STATE_COLORS: Record<string, string> = {
  thinking: "var(--green)",
  tool_executing: "var(--green)",
  waiting_for_response: "var(--purple)",
  error: "var(--red)",
};

// Keep the sprite modestly larger than a desk agent, anchored at its feet.
const SCALE = 1.2;
const FEET_Y = CHARACTER_GEOMETRY.feetY;
const HALF_W = CHARACTER_GEOMETRY.width / 2;
const FIGURE_TOP = FEET_Y * SCALE;
const PILL_Y = -FIGURE_TOP;

export function ReceptionistFigure({
  agent,
  needsAttention = false,
  onClick,
  onContextMenu,
}: {
  agent: AgentInfo;
  needsAttention?: boolean;
  onClick?: (e: React.MouseEvent<SVGGElement>) => void;
  onContextMenu?: (e: React.MouseEvent<SVGGElement>) => void;
}) {
  const { t } = useI18n();
  const dot = STATE_COLORS[agent.state] ?? "var(--text-muted)";
  const style = styleForModel(agent.modelFamily);
  return (
    <g
      data-receptionist={agent.id}
      // Like a desk: the viewport must not capture the pointer here, or the
      // click lands on the pan surface instead of the figure.
      data-no-pan=""
      style={{ pointerEvents: "all", cursor: "pointer" }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <title>{t("lobby.openChat", { name: agent.name })}</title>
      {/* The sprite column stays clickable through the gap below the tag.
          The pill handles clicks across its own full width. */}
      <rect
        x={-HALF_W * SCALE - 4}
        y={PILL_Y - 12}
        width={HALF_W * 2 * SCALE + 8}
        height={-PILL_Y + 14}
        fill="transparent"
      />
      <g
        transform={`translate(${-HALF_W * SCALE} ${-FEET_Y * SCALE}) scale(${SCALE})`}
      >
        <Character state={agent.state} outfit={agent.outfit} />
      </g>
      <foreignObject
        x={-200}
        y={PILL_Y - 20}
        width={400}
        height={40}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          height: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}>
        <div style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px 3px 7px",
          borderRadius: 20,
          background: style.bg,
          border: `1px solid ${style.border}`,
          whiteSpace: "nowrap",
          userSelect: "none",
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
            {agent.name}
          </span>
          {needsAttention && (
            <span style={{
              padding: "1px 4px", borderRadius: 7, background: "var(--purple)",
              fontSize: 9, fontWeight: 700, color: "#fff",
            }}>
              {t("common.unread")}
            </span>
          )}
        </div>
        </div>
      </foreignObject>
    </g>
  );
}

// The receptionist as it stands in the lobby scene: the agent's Character with
// its feet at the group's origin, a nametag pill above its head, and the same
// click and right-click affordances a desk has. Rendered INSIDE the lobby's
// props SVG (the scene passes it through its receptionist slot), so it is SVG,
// not HTML, and it opts back into pointer events the scene's layers switch off.
import { useI18n } from "../i18n.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import { Character } from "./Character.tsx";
import { styleForModel } from "../model-styles.ts";

const STATE_COLORS: Record<string, string> = {
  thinking: "var(--green)",
  tool_executing: "var(--green)",
  waiting_for_response: "var(--purple)",
  error: "var(--red)",
};

// The Character element is 40x68 px with a 52x68 viewBox, so its drawing is
// scaled 0.77 and centred: the feet (viewBox y 60) land at y 54.2, the figure's
// top near y 23. Drawn at SCALE so it matches the lobby's furniture (props are
// at 1.5) rather than the office's desk-sized characters.
const SCALE = 2;
const FEET_Y = 54.2;
const HALF_W = 20;
const FIGURE_TOP = 31 * SCALE; // above the feet
const PILL_Y = -(FIGURE_TOP + 16);

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
  const badge = needsAttention
    ? Math.max(46, t("common.unread").length * 5.8 + 12)
    : 0;
  const width = Math.round(agent.name.length * 6.4) + 30 + badge;
  const left = -width / 2;
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
      {/* One solid hit area from the nametag to the feet, so a click in the
          gap between the pill and the head still opens the chat. */}
      <rect
        x={-Math.max(HALF_W * SCALE, width / 2) - 4}
        y={PILL_Y - 12}
        width={Math.max(HALF_W * 2 * SCALE, width) + 8}
        height={-PILL_Y + 14}
        fill="transparent"
      />
      <g
        transform={`translate(${-HALF_W * SCALE} ${-FEET_Y * SCALE}) scale(${SCALE})`}
      >
        <Character state={agent.state} outfit={agent.outfit} />
      </g>
      <g transform={`translate(0 ${PILL_Y})`}>
        <rect
          x={left}
          y={-10}
          width={width}
          height={20}
          rx={10}
          fill={style.bg}
          stroke={style.border}
        />
        <circle cx={left + 11} cy={0} r={3.5} fill={dot} />
        <text
          x={left + 19}
          y={4}
          fontSize={11}
          fontWeight={600}
          fill="var(--text-primary)"
        >
          {agent.name}
        </text>
        {needsAttention && (
          <>
            <rect
              x={left + width - badge - 4}
              y={-7}
              width={badge - 2}
              height={14}
              rx={7}
              fill="var(--purple)"
            />
            <text
              x={left + width - badge / 2 - 5}
              y={3.5}
              fontSize={9}
              fontWeight={700}
              fill="#fff"
              textAnchor="middle"
            >
              {t("common.unread")}
            </text>
          </>
        )}
      </g>
    </g>
  );
}

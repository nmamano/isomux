// The strip under a back agent's log header (task 5b503e32): it says that the
// agent works in the back room and names the front agents, the ones people
// usually talk to. Each chip opens that agent's log. With no front agent the
// strip does not show. It points the way; the composer stays open.

import type { AgentInfo, RoomWire } from "../../shared/types.ts";
import { isBackSeat } from "../../shared/desks.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { styleForModel } from "../model-styles.ts";
import { StatusLight } from "../office/StatusLight.tsx";

export function BackRoomStrip({
  agent,
  agents,
  rooms,
  onOpenAgent,
}: {
  agent: AgentInfo;
  agents: AgentInfo[];
  rooms: RoomWire[];
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useI18n();
  if (!isBackSeat(agent.desk)) return null;
  const front = agents
    .filter((a) => a.roomId === agent.roomId && !isBackSeat(a.desk))
    .sort((a, b) => a.desk - b.desk);
  if (front.length === 0) return null;
  const room = rooms.find((r) => r.id === agent.roomId)?.name ?? "";
  return (
    <div
      data-back-room-strip
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "7px 16px",
        fontSize: 12,
        color: "var(--text-secondary)",
        background: "var(--bg-tag)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
      }}
    >
      <span {...noTranslate()}>{t("logView.backRoomStrip", { room })}</span>
      {front.map((a) => {
        const ms = styleForModel(a.modelFamily);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpenAgent(a.id)}
            {...noTranslate()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 9px",
              borderRadius: 12,
              border: `1px solid ${ms.border}`,
              background: ms.bg,
              color: "var(--text-primary)",
              fontWeight: 600,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <StatusLight state={a.state} size={7} />
            {a.name}
          </button>
        );
      })}
    </div>
  );
}

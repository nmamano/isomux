// The Inbox's Asks tab: the member's open asks from every agent they can see,
// grouped by agent, the longest wait first. Each ask is the AskCard the chat's
// stack draws, so its answers work the same here, except that an answer waits
// ASK_UNDO_MS for an Undo before it is sent; the agent's name opens its chat.
// The list is the store's asks slice (ui/asks-sync.ts), less the answers being
// sent: an answer in its Undo time stays as its Undo line, and goes when it
// is sent. InboxView draws the header and the tabs around it.

import { useMemo } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { asksFor } from "../asks-sync.ts";
import { AskCard } from "../log-view/AskCard.tsx";
import type { AgentInfo, AskMemberWire } from "../../shared/types.ts";

interface AskGroup {
  agent: AgentInfo;
  entries: AskMemberWire[];
}

/**
 * The open asks per agent: cards oldest first, groups by their oldest ask.
 * Only agents in the agents slice get a group, so an ask whose agent the
 * client does not have stays out, as `visibleAsks` leaves it out of the count.
 */
function askGroups(
  asks: readonly AskMemberWire[],
  agents: readonly AgentInfo[],
): AskGroup[] {
  const groups: AskGroup[] = [];
  for (const agent of agents) {
    const entries = asksFor(asks, agent.id);
    if (entries.length > 0) groups.push({ agent, entries });
  }
  return groups.sort(
    (a, b) =>
      a.entries[0].createdAt - b.entries[0].createdAt ||
      (a.agent.id < b.agent.id ? -1 : 1),
  );
}

// How long an answer waits before it is sent, so the member can undo it.
export const ASK_UNDO_MS = 5000;

export function AsksView({
  onFocusAgent,
}: {
  onFocusAgent: (agentId: string) => void;
}) {
  const { asks, answeredAsks, agents, rooms, isMobile } = useAppState();
  const { t } = useI18n();
  const groups = useMemo(
    () =>
      askGroups(
        asks.filter((e) => answeredAsks.get(e.id) !== "sending"),
        agents,
      ),
    [asks, answeredAsks, agents],
  );
  const roomNameById = useMemo(
    () => new Map(rooms.map((r) => [r.id, r.name])),
    [rooms],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? "10px 12px" : "16px 20px",
        }}
      >
        <div data-asks-list="" style={{ maxWidth: 760, margin: "0 auto" }}>
          {groups.length === 0 ? (
            <div
              data-asks-empty=""
              style={{
                padding: "40px 0",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 13,
                fontFamily: "var(--font-ui)",
              }}
            >
              {t("asks.empty")}
            </div>
          ) : (
            groups.map(({ agent, entries }) => (
              <section
                key={agent.id}
                data-asks-group={agent.id}
                style={{ marginBottom: isMobile ? 16 : 20 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    margin: "0 0 6px 2px",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <button
                    type="button"
                    {...noTranslate()}
                    data-asks-agent={agent.id}
                    onClick={() => onFocusAgent(agent.id)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--accent-text)",
                      fontSize: isMobile ? 15 : 14,
                      fontWeight: 600,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {agent.name}
                  </button>
                  <span
                    {...noTranslate()}
                    style={{
                      color: "var(--text-muted)",
                      fontSize: isMobile ? 12 : 11,
                    }}
                  >
                    {roomNameById.get(agent.roomId) ?? ""}
                  </span>
                </div>
                {entries.map((entry) => (
                  <AskCard
                    key={entry.id}
                    entry={entry}
                    isMobile={isMobile}
                    onFocusAgent={onFocusAgent}
                    undoMs={ASK_UNDO_MS}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

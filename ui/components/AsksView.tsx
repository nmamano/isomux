// The Inbox's Asks tab: the member's open asks from every agent they can see,
// grouped by agent. A filter row filters them by the agent's room and by the
// ask's priority, and sorts them by agent (the longest wait first), room or
// priority (task 995fc76a). Each ask is the AskCard the chat's
// stack draws, so its answers work the same here, except that an answer waits
// ASK_UNDO_MS for an Undo before it is sent. The agent's name, and a card's
// "Discuss in chat", open the chat panel over the Inbox (AgentChatPanel).
// The list is the store's asks slice (ui/asks-sync.ts), less the answers being
// sent: an answer in its Undo time stays as its Undo line, and goes when it
// is sent. InboxView draws the header and the tabs around it.

import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { asksFor } from "../asks-sync.ts";
import { AskCard } from "../log-view/AskCard.tsx";
import {
  ASKS_SORTS,
  getAsksSort,
  setAsksSort,
  type AsksSort,
} from "../device-settings.ts";
import {
  effectiveRoomFilter,
  ROOM_FILTER_ALL,
  roomFilterMatches,
  type RoomFilter,
} from "../room-filter.ts";
import { comparePriority } from "../task-priority.ts";
import {
  ordinaryRooms,
  type AgentInfo,
  type AskMemberWire,
  type TaskPriority,
} from "../../shared/types.ts";

interface AskGroup {
  agent: AgentInfo;
  entries: AskMemberWire[];
}

type PriorityFilter = "all" | TaskPriority | "none";
const PRIORITY_FILTERS: readonly PriorityFilter[] = [
  "all",
  "P0",
  "P1",
  "P2",
  "P3",
  "P4",
  "none",
];

const SORT_LABELS = {
  agent: "asks.sortAgent",
  room: "asks.sortRoom",
  priority: "asks.sortPriority",
} as const satisfies Record<AsksSort, string>;

/**
 * The open asks per agent that the filters let through. One comparator per
 * sort orders the cards in a group, and the groups by their first card, then
 * by agent id: oldest first; or the room's place in `rooms`, then oldest; or
 * the priority, no priority last, then oldest. Only agents in the agents
 * slice get a group, so an ask whose agent the client does not have stays
 * out, as `visibleAsks` leaves it out of the count.
 */
function askGroups(
  asks: readonly AskMemberWire[],
  agents: readonly AgentInfo[],
  rooms: readonly { id: string }[],
  filter: { room: RoomFilter; priority: PriorityFilter },
  sort: AsksSort,
): AskGroup[] {
  const roomPlace = (roomId: string) => {
    const at = rooms.findIndex((room) => room.id === roomId);
    return at < 0 ? rooms.length : at;
  };
  const compare = (
    a: { entry: AskMemberWire; agent: AgentInfo },
    b: { entry: AskMemberWire; agent: AgentInfo },
  ) =>
    (sort === "room"
      ? roomPlace(a.agent.roomId) - roomPlace(b.agent.roomId)
      : sort === "priority"
        ? comparePriority(a.entry.priority, b.entry.priority)
        : 0) || a.entry.createdAt - b.entry.createdAt;
  const groups: AskGroup[] = [];
  for (const agent of agents) {
    if (!roomFilterMatches(filter.room, agent.roomId)) continue;
    const entries = asksFor(asks, agent.id)
      .filter(
        (e) =>
          filter.priority === "all" ||
          (e.priority ?? "none") === filter.priority,
      )
      .sort((a, b) => compare({ entry: a, agent }, { entry: b, agent }));
    if (entries.length > 0) groups.push({ agent, entries });
  }
  return groups.sort(
    (a, b) =>
      compare(
        { entry: a.entries[0], agent: a.agent },
        { entry: b.entries[0], agent: b.agent },
      ) || (a.agent.id < b.agent.id ? -1 : 1),
  );
}

// How long an answer waits before it is sent, so the member can undo it.
export const ASK_UNDO_MS = 5000;

export function AsksView({
  onFocusAgent,
  onChatAgent,
}: {
  onFocusAgent: (agentId: string) => void;
  // Opens the chat panel over the Inbox on an agent (AgentChatPanel); without
  // it the name opens the agent's chat.
  onChatAgent?: (agentId: string) => void;
}) {
  const { asks, answeredAsks, agents, rooms, isMobile } = useAppState();
  const { t } = useI18n();
  // The filters open on all every time, unlike the Pager's room filter: the
  // Inbox badge counts every open ask, so the tab it opens shows them all.
  // The sort is remembered on this device.
  const [roomChoice, setRoomFilter] = useState<RoomFilter>(ROOM_FILTER_ALL);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [sort, setSort] = useState<AsksSort>(getAsksSort);
  const filterRooms = useMemo(() => ordinaryRooms(rooms), [rooms]);
  const roomFilter = effectiveRoomFilter(roomChoice, filterRooms);
  const open = useMemo(
    () => asks.filter((e) => answeredAsks.get(e.id) !== "sending"),
    [asks, answeredAsks],
  );
  const groups = useMemo(
    () =>
      askGroups(
        open,
        agents,
        filterRooms,
        { room: roomFilter, priority: priorityFilter },
        sort,
      ),
    [open, agents, filterRooms, roomFilter, priorityFilter, sort],
  );
  // Whether any ask would show with both filters on all, so an empty list
  // can tell "no open asks" from "the filters hide them".
  const anyOpen = useMemo(
    () => agents.some((agent) => open.some((e) => e.agentId === agent.id)),
    [open, agents],
  );
  const roomNameById = useMemo(
    () => new Map(rooms.map((r) => [r.id, r.name])),
    [rooms],
  );
  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 12,
    outline: "none",
    flex: isMobile ? 1 : undefined,
    minWidth: 0,
  };
  const emptyStyle: React.CSSProperties = {
    padding: "40px 0",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: 13,
    fontFamily: "var(--font-ui)",
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Filters, in the list's column */}
      <div
        style={{
          padding: isMobile ? "10px 12px" : "10px 20px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div
          style={{ display: "flex", gap: 8, maxWidth: 760, margin: "0 auto" }}
        >
          <select
            data-asks-room-filter=""
            aria-label={t("roomFilter.title")}
            value={roomFilter}
            onChange={(e) => setRoomFilter(e.target.value)}
            style={selectStyle}
          >
            <option value={ROOM_FILTER_ALL}>{t("roomFilter.all")}</option>
            {filterRooms.map((r) => (
              <option key={r.id} {...noTranslate()} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            data-asks-priority-filter=""
            aria-label={t("asks.priorityFilter")}
            value={priorityFilter}
            onChange={(e) =>
              setPriorityFilter(e.target.value as PriorityFilter)
            }
            style={selectStyle}
          >
            {PRIORITY_FILTERS.map((p) => (
              <option key={p} value={p}>
                {p === "all"
                  ? t("tasks.filterAllPriorities")
                  : p === "none"
                    ? t("tasks.filterPriorityNone")
                    : p}
              </option>
            ))}
          </select>
          <select
            data-asks-sort=""
            aria-label={t("asks.sort")}
            value={sort}
            onChange={(e) => {
              const next = e.target.value as AsksSort;
              setSort(next);
              setAsksSort(next);
            }}
            style={{ ...selectStyle, marginLeft: isMobile ? 0 : "auto" }}
          >
            {ASKS_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(SORT_LABELS[s])}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? "10px 12px" : "16px 20px",
        }}
      >
        <div data-asks-list="" style={{ maxWidth: 760, margin: "0 auto" }}>
          {groups.length === 0 && !anyOpen ? (
            <div data-asks-empty="" style={emptyStyle}>
              {t("asks.empty")}
            </div>
          ) : groups.length === 0 ? (
            <div data-asks-filtered-empty="" style={emptyStyle}>
              <div>{t("asks.filteredEmpty")}</div>
              <button
                type="button"
                data-asks-show-all=""
                onClick={() => {
                  setRoomFilter(ROOM_FILTER_ALL);
                  setPriorityFilter("all");
                }}
                style={{
                  marginTop: 10,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {t("asks.showAll")}
              </button>
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
                    onClick={() => (onChatAgent ?? onFocusAgent)(agent.id)}
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
                    onChatAgent={onChatAgent}
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

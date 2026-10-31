// The Inbox's Asks tab: the member's open asks from every agent they can see,
// grouped by agent. A filter row filters them by the agent's room and by the
// ask's priority, in the Tasks page's checkbox lists with a count per choice
// (task 2bbc5021), and sorts them by agent (the longest wait first), room or
// priority (task 995fc76a), or by age: one list, the longest wait first, with
// the agent's name over each run of its asks (task 66532fa7). Each ask is the
// AskCard the chat's
// stack draws, so its answers work the same here, except that an answer waits
// ASK_UNDO_MS for an Undo before it is sent. The agent's name, and a card's
// "Discuss in chat", open the chat panel over the Inbox (AgentChatPanel).
// The list is the store's asks slice (ui/asks-sync.ts), less the answers being
// sent: an answer in its Undo time stays as its Undo line, and goes when it
// is sent. InboxView draws the header and the tabs around it.

import { useEffect, useMemo, useState } from "react";
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
import { comparePriority } from "../task-priority.ts";
import {
  CheckboxFilter,
  FILTER_PRIORITIES,
  prioritySummary,
  toggled,
  type PriorityFilterValue,
} from "./CheckboxFilter.tsx";
import {
  ordinaryRooms,
  type AgentInfo,
  type AskMemberWire,
} from "../../shared/types.ts";

interface AskGroup {
  agent: AgentInfo;
  entries: AskMemberWire[];
}

// The filters: the rooms whose agents' asks are hidden (unchecked rooms that
// the list still offers, so an agent in any other room always shows), and the
// checked priorities.
interface AskFilter {
  hiddenRooms: ReadonlySet<string>;
  priorities: readonly PriorityFilterValue[];
}

const passesRoom = (filter: AskFilter, agent: AgentInfo) =>
  !filter.hiddenRooms.has(agent.roomId);
const passesPriority = (filter: AskFilter, entry: AskMemberWire) =>
  filter.priorities.includes(entry.priority ?? "none");

/**
 * Each filter choice's count, as on the Tasks page: the open asks it would
 * show given the other filter. Only asks of agents in the agents slice count,
 * as only they get a run.
 */
function filterCounts(
  asks: readonly AskMemberWire[],
  agents: readonly AgentInfo[],
  filter: AskFilter,
): { rooms: Map<string, number>; priorities: Map<string, number> } {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const rooms = new Map<string, number>();
  const priorities = new Map<string, number>();
  for (const entry of asks) {
    const agent = agentById.get(entry.agentId);
    if (!agent) continue;
    if (passesPriority(filter, entry))
      rooms.set(agent.roomId, (rooms.get(agent.roomId) ?? 0) + 1);
    if (passesRoom(filter, agent)) {
      const level = entry.priority ?? "none";
      priorities.set(level, (priorities.get(level) ?? 0) + 1);
    }
  }
  return { rooms, priorities };
}

const SORT_LABELS = {
  agent: "asks.sortAgent",
  room: "asks.sortRoom",
  priority: "asks.sortPriority",
  age: "asks.sortAge",
} as const satisfies Record<AsksSort, string>;

/**
 * The open asks that the filters let through, as runs of one agent's asks in
 * page order. Under "agent", "room" and "priority" each agent has one run, and
 * one comparator orders the cards in a run and the runs by their first card,
 * then by agent id: oldest first; or the room's place in `rooms`, then oldest;
 * or the priority, no priority last, then oldest. Under "age" all the asks are
 * one list, oldest first, then by ask id, and a run ends where the agent
 * changes, so an agent can head more than one run. Only agents in the agents
 * slice get a run, so an ask whose agent the client does not have stays out,
 * as `visibleAsks` leaves it out of the count.
 */
function askGroups(
  asks: readonly AskMemberWire[],
  agents: readonly AgentInfo[],
  rooms: readonly { id: string }[],
  filter: AskFilter,
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
    if (!passesRoom(filter, agent)) continue;
    const entries = asksFor(asks, agent.id)
      .filter((e) => passesPriority(filter, e))
      .sort((a, b) => compare({ entry: a, agent }, { entry: b, agent }));
    if (entries.length > 0) groups.push({ agent, entries });
  }
  if (sort === "age") {
    const flat = groups
      .flatMap(({ agent, entries }) =>
        entries.map((entry) => ({ agent, entry })),
      )
      .sort(
        (a, b) =>
          a.entry.createdAt - b.entry.createdAt ||
          (a.entry.id < b.entry.id ? -1 : 1),
      );
    const runs: AskGroup[] = [];
    for (const { agent, entry } of flat) {
      const last = runs[runs.length - 1];
      if (last?.agent.id === agent.id) last.entries.push(entry);
      else runs.push({ agent, entries: [entry] });
    }
    return runs;
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
  // The rooms keep their unchecked ids, so a room that appears shows checked.
  const [uncheckedRooms, setUncheckedRooms] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<PriorityFilterValue[]>([
    ...FILTER_PRIORITIES,
  ]);
  const [openFilter, setOpenFilter] = useState<"room" | "priority" | null>(
    null,
  );
  const [sort, setSort] = useState<AsksSort>(getAsksSort);
  const filterRooms = useMemo(() => ordinaryRooms(rooms), [rooms]);
  // An unchecked room that went away hides nothing and does not count.
  const hiddenRooms = useMemo(
    () =>
      new Set(
        filterRooms
          .filter((room) => uncheckedRooms.includes(room.id))
          .map((room) => room.id),
      ),
    [filterRooms, uncheckedRooms],
  );
  const filter = useMemo<AskFilter>(
    () => ({ hiddenRooms, priorities }),
    [hiddenRooms, priorities],
  );
  const open = useMemo(
    () => asks.filter((e) => answeredAsks.get(e.id) !== "sending"),
    [asks, answeredAsks],
  );
  const groups = useMemo(
    () => askGroups(open, agents, filterRooms, filter, sort),
    [open, agents, filterRooms, filter, sort],
  );
  const counts = useMemo(
    () => filterCounts(open, agents, filter),
    [open, agents, filter],
  );
  const showAll = () => {
    setUncheckedRooms([]);
    setPriorities([...FILTER_PRIORITIES]);
  };
  // Escape with a list open closes the list, focus back on its button, and
  // does not reach App's window listener that closes the Inbox. A capture
  // listener on window, as focus can be on the page (Safari does not focus a
  // clicked button).
  useEffect(() => {
    if (!openFilter) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      document
        .querySelector<HTMLButtonElement>(
          `[data-checkbox-filter="${openFilter}"] button`,
        )
        ?.focus();
      setOpenFilter(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openFilter]);
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
  const checkedRooms = filterRooms.filter((room) => !hiddenRooms.has(room.id));
  const roomSummary =
    hiddenRooms.size === 0
      ? t("roomFilter.all")
      : checkedRooms.length === 0
        ? t("tasks.filterNone")
        : checkedRooms.map((room) => room.name).join(", ");
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
        {/* On a phone the sort takes its own line: a third of the row clips
            its label. */}
        <div
          style={{
            display: "flex",
            flexWrap: isMobile ? "wrap" : undefined,
            gap: 8,
            maxWidth: 760,
            margin: "0 auto",
          }}
        >
          <CheckboxFilter
            name="room"
            label={t("tasks.field.room")}
            summary={roomSummary}
            summaryNoTranslate={hiddenRooms.size > 0 && checkedRooms.length > 0}
            options={filterRooms.map((room) => ({
              value: room.id,
              label: room.name,
              count: counts.rooms.get(room.id) ?? 0,
              noTranslate: true,
            }))}
            checked={checkedRooms.map((room) => room.id)}
            onToggle={(id) =>
              setUncheckedRooms((prev) =>
                hiddenRooms.has(id)
                  ? prev.filter((v) => v !== id)
                  : [...prev, id],
              )
            }
            open={openFilter === "room"}
            onOpenChange={(o) => setOpenFilter(o ? "room" : null)}
            buttonStyle={selectStyle}
          />
          <CheckboxFilter
            name="priority"
            label={t("tasks.field.priority")}
            summary={prioritySummary(priorities, t)}
            options={FILTER_PRIORITIES.map((p) => ({
              value: p,
              label: p === "none" ? t("tasks.filterPriorityNone") : p,
              count: counts.priorities.get(p) ?? 0,
            }))}
            checked={priorities}
            onToggle={(p) => setPriorities((prev) => toggled(prev, p))}
            open={openFilter === "priority"}
            onOpenChange={(o) => setOpenFilter(o ? "priority" : null)}
            buttonStyle={selectStyle}
          />
          <select
            data-asks-sort=""
            aria-label={t("asks.sort")}
            value={sort}
            onChange={(e) => {
              const next = e.target.value as AsksSort;
              setSort(next);
              setAsksSort(next);
            }}
            style={{
              ...selectStyle,
              ...(isMobile ? { flexBasis: "100%" } : { marginLeft: "auto" }),
            }}
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
                onClick={showAll}
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
            // One flat list: each run's header is a sibling before its cards,
            // and a card's key is its ask id, so a card that moves to another
            // run, or whose run's first card leaves, is not remounted (a
            // remount would send its held answer at once).
            groups.flatMap(({ agent, entries }, i) => [
              <div
                key={`group:${entries[0].id}`}
                data-asks-group={agent.id}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  margin: `${i === 0 ? 0 : isMobile ? 16 : 20}px 0 6px 2px`,
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
              </div>,
              ...entries.map((entry) => (
                <AskCard
                  key={entry.id}
                  entry={entry}
                  isMobile={isMobile}
                  onFocusAgent={onFocusAgent}
                  onChatAgent={onChatAgent}
                  undoMs={ASK_UNDO_MS}
                />
              )),
            ])
          )}
        </div>
      </div>
    </div>
  );
}

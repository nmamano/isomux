// An owner sets up another member's sidebar Pinned list (task 35596be5): the
// list in the member's order, with Move up, Move down and Remove, and a
// picker to pin one more agent or member. A draft of the edit panel: the
// panel's Save writes it through PUT /api/users/:username/pinned.

import { useMemo } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { movePinned, pinnedRows } from "../chat-sidebar.ts";
import { memberPinKey } from "../../shared/sidebar-pins.ts";
import { AgentOptions } from "./AgentOptions.tsx";
import { Chevron, Cross, iconBtn } from "./RowIcons.tsx";
import { dialogInput } from "./dialog-styles.ts";

export function MemberPinnedAgents({
  pinned,
  targetUserId,
  reachableRoomIds,
  onChange,
  disabled = false,
  headingStyle,
}: {
  // The drafted list: agent ids and member:<userId> keys, in order.
  pinned: readonly string[];
  // The member whose list this is: their own key is never offered.
  targetUserId: string;
  // The rooms the drafted access reaches; null: every room (an owner).
  reachableRoomIds: ReadonlySet<string> | null;
  onChange: (next: string[]) => void;
  disabled?: boolean;
  headingStyle: React.CSSProperties;
}): React.ReactElement {
  const { t } = useI18n();
  const { agents, users, rooms, allRooms } = useAppState();
  const roomList = allRooms.length > 0 ? allRooms : rooms;
  const roomName = useMemo(
    () => new Map(roomList.map((r) => [r.id, r.name])),
    [roomList],
  );
  // The other members, as the sidebar's member rows: the sidebar never
  // offers a member their own key, and the store drops it.
  const members = useMemo(
    () =>
      [...users.values()]
        .filter((u) => u.id !== targetUserId)
        .map((u) => ({ id: u.id, name: u.name, removed: false })),
    [users, targetUserId],
  );
  // The rows the client can name. A key it cannot name stays in the list in
  // its place, and the server drops it when it is dead.
  const rows = pinnedRows(pinned, agents, members);
  const pinnedSet = new Set(pinned);
  const agentChoices = agents.filter(
    (a) =>
      !pinnedSet.has(a.id) &&
      (reachableRoomIds === null || reachableRoomIds.has(a.roomId)),
  );
  const memberChoices = members.filter(
    (m) => !pinnedSet.has(memberPinKey(m.id)),
  );

  // Move a row past its neighbour on screen.
  const move = (index: number, by: -1 | 1) => {
    const neighbour = rows[index + by];
    if (!neighbour) return;
    onChange(movePinned(pinned, rows[index].key, neighbour.key, by === -1));
  };

  return (
    <section data-member-pins="">
      <h5 style={headingStyle}>{t("settings.memberPins.title")}</h5>
      <div
        data-member-pins-list=""
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginTop: 8,
        }}
      >
        {rows.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("settings.memberPins.empty")}
          </span>
        )}
        {rows.map((row, i) => (
          <div
            key={row.key}
            data-member-pin-row=""
            data-pin-key={row.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "var(--text-primary)",
            }}
          >
            <span
              {...noTranslate()}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.kind === "agent" ? row.agent.name : row.member.name}
              <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                {row.kind === "agent"
                  ? (roomName.get(row.agent.roomId) ?? "")
                  : t("settings.memberPins.memberTag")}
              </span>
            </span>
            <button
              type="button"
              data-pin-up=""
              title={t("settings.memberPins.moveUp")}
              aria-label={t("settings.memberPins.moveUp")}
              disabled={disabled || i === 0}
              onClick={() => move(i, -1)}
              style={iconBtn(i === 0)}
            >
              <Chevron up />
            </button>
            <button
              type="button"
              data-pin-down=""
              title={t("settings.memberPins.moveDown")}
              aria-label={t("settings.memberPins.moveDown")}
              disabled={disabled || i === rows.length - 1}
              onClick={() => move(i, 1)}
              style={iconBtn(i === rows.length - 1)}
            >
              <Chevron />
            </button>
            <button
              type="button"
              data-pin-remove=""
              title={t("settings.memberPins.remove")}
              aria-label={t("settings.memberPins.remove")}
              disabled={disabled}
              onClick={() => onChange(pinned.filter((k) => k !== row.key))}
              style={iconBtn(false)}
            >
              <Cross />
            </button>
          </div>
        ))}
      </div>
      <select
        data-member-pins-picker=""
        value=""
        disabled={
          disabled || (agentChoices.length === 0 && memberChoices.length === 0)
        }
        onChange={(e) => {
          const key = e.target.value;
          if (key) onChange([...pinned, key]);
        }}
        style={{ ...dialogInput, maxWidth: 340, marginTop: 8 }}
      >
        <option value="">{t("settings.memberPins.add")}</option>
        <AgentOptions agents={agentChoices} rooms={roomList} />
        {memberChoices.length > 0 && (
          <optgroup label={t("sidebar.members")}>
            {memberChoices.map((m) => (
              <option key={m.id} value={memberPinKey(m.id)} {...noTranslate()}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </section>
  );
}

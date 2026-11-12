// The desktop sidebar (task c61316be): beside the office view, an agent's
// chat and every page, a Codex-style list of the office's rooms and agents.
// The phone and the site embed never show it. No click in it closes it; only
// its own hide button does. Its decisions live in ui/chat-sidebar.ts.
// Task 5dac6b9b added Pinned and Recent, the folded room summary and the
// drag to reorder and tuck rooms; App draws the slot around it (its width,
// the resize edge and the slide). Task c921308f: a room, agent or member row
// opens its settings with one sliders button, the first of its hover actions.

import { MEMBERS_CHAT, type HumanChatKey } from "../human-chat.ts";
import {
  useMemberChatRows,
  type MemberChatRow,
} from "../members-chat/member-rows.ts";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type RoomWire,
} from "../../shared/types.ts";
import { hasBackRoom, isBackSeat } from "../../shared/desks.ts";
import type { Page } from "../routes.ts";
import { useAppState, useRoomList } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { useInboxCounts } from "../inbox.ts";
import { askCounts, openAsks } from "../asks-sync.ts";
import { useCan } from "../hooks/useCan.ts";
import { apiFetch } from "../api.ts";
import type {
  TuckedRoomsReq,
  ViewOrderReq,
} from "../../shared/contract-shapes.ts";
import {
  agentAttention,
  CHAT_SIDEBAR_SECTIONS_DEFAULT,
  moveRoom,
  movePinned,
  newAgentSeat,
  pinnedRows,
  recentAgentsList,
  roomAgents,
  roomSummary,
  sidebarRooms,
  sidebarSectionsForAnchor,
  type ChatSidebarSections,
} from "../chat-sidebar.ts";
import { memberPinKey } from "../../shared/sidebar-pins.ts";
import {
  getChatSidebarSections,
  setChatSidebarSections,
} from "../device-settings.ts";
import type { SidebarPins } from "../sidebar-pins.ts";
import { Character } from "../office/Character.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import {
  AppsIcon,
  BuildingIcon,
  ClockIcon,
  InboxIcon,
  PlugIcon,
  SettingsIcon,
  SidebarIcon,
  SkillsIcon,
  TasksIcon,
} from "./NavIcons.tsx";

/** The pages the sidebar's nav rows open. */
export type SidebarPage = Exclude<Page, "settings">;

export interface ChatSidebarProps {
  // The agent whose chat is open, or null (a page with no chat under it).
  openAgentId: string | null;
  // The page on top, or null for the chat or the office view.
  page: Page | null;
  // The office view shows (no page, no chat): the Office row is current.
  officeShown: boolean;
  // The office shows a room's back room screen.
  backRoomOpen: boolean;
  // App has restored the saved view (or has none to restore): until then the
  // anchor is not the one the member left, so it opens nothing.
  viewReady: boolean;
  onCollapse: () => void;
  // The Office row: back to the room view the open agent sits in.
  onOffice: () => void;
  // A room header's "+": a new agent in that room. Null when the member may
  // not spawn.
  onNewAgent: ((roomId: string) => void) | null;
  onOpenPage: (page: SidebarPage) => void;
  onOpenAgent: (agentId: string) => void;
  onAgentContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  // An agent row's sliders: the agent dialog.
  onAgentSettings: (agent: AgentInfo) => void;
  // A row of the Members section: Members chat or a 1:1 chat.
  onOpenHumanChat: (chat: HumanChatKey) => void;
  // An owner's sliders on a member row: Settings on that member.
  onOpenMemberSettings: (userId: string) => void;
  onOpenSettings: () => void;
  // A room header's sliders: Settings on that room.
  onRoomSettings: (roomId: string) => void;
  // The member's Pinned (agents and members) and Recent agents
  // (ui/sidebar-pins.ts).
  pins: SidebarPins;
  // The sidebar slides out (App's slot): inert until it leaves.
  closing?: boolean;
}

const HEAD_SIZE = 26;

// Drag payload types, so a room never drops on the pinned list or back.
const ROOM_DRAG = "application/x-isomux-sidebar-room";
const PIN_DRAG = "application/x-isomux-sidebar-pin";

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
    style={{ display: "block" }}
  >
    <path d="M6 2.5h4l-.5 4 2.5 2.5H4l2.5-2.5zM8 9v4.5" />
  </svg>
);

const PlusIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    style={{ display: "block" }}
  >
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

const ChatIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
    style={{ display: "block" }}
  >
    <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 10 10"
    fill="currentColor"
    aria-hidden
    style={{
      display: "block",
      flexShrink: 0,
      transform: open ? "rotate(90deg)" : undefined,
      transition: "transform 0.12s",
    }}
  >
    <path d="M3 1.5l4 3.5-4 3.5z" />
  </svg>
);

function Badge({ n, tone }: { n: number; tone: "red" | "orange" }) {
  if (n <= 0) return null;
  return (
    <span
      data-sidebar-badge=""
      style={{
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 8,
        background: tone === "red" ? "var(--red)" : "var(--orange)",
        color: "#fff",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "16px",
        textAlign: "center",
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}

// A working agent's light ticks each second, so it turns amber and then red
// while a turn runs long (the hung warning). The clock lives here, so the
// tick redraws only the light.
function RowLight({
  agent,
  changedAt,
}: {
  agent: AgentInfo;
  changedAt: number | undefined;
}) {
  const working =
    agent.state === "thinking" || agent.state === "tool_executing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [working]);
  return (
    <StatusLight
      state={agent.state}
      size={8}
      ring
      elapsedMs={working && changedAt ? now - changedAt : undefined}
    />
  );
}

function Head({ outfit }: { outfit: AgentInfo["outfit"] }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: HEAD_SIZE,
        height: HEAD_SIZE,
        borderRadius: "50%",
        overflow: "hidden",
        background: "var(--bg-code)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <Character state="idle" outfit={outfit} portrait headCrop={HEAD_SIZE} />
    </span>
  );
}

const rowBase: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  border: "none",
  borderRadius: 7,
  color: "var(--text-primary)",
  font: "inherit",
  fontSize: 13,
  textAlign: "left",
  cursor: "pointer",
};

function NavRow({
  icon,
  label,
  current = false,
  badge = 0,
  onClick,
  attr,
}: {
  icon: ReactNode;
  label: string;
  current?: boolean;
  badge?: number;
  onClick: () => void;
  attr: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="chat-sidebar-row"
      data-sidebar-nav={attr}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      style={{ ...rowBase, padding: "6px 10px" }}
    >
      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <Badge n={badge} tone="red" />
    </button>
  );
}

function AgentRow({
  agent,
  current,
  attention,
  unread,
  changedAt,
  pinned,
  pinnedInRoom,
  pinLabel,
  onOpen,
  onContextMenu,
  onSettings,
  onTogglePin,
  drag,
}: {
  agent: AgentInfo;
  current: boolean;
  // agentAttention: its open asks, plus one for a permission prompt.
  attention: number;
  unread: boolean;
  changedAt: number | undefined;
  pinned: boolean;
  // A pinned agent's row in its room (task 3cf03055): muted, with a pin
  // marker, so the eye skips it.
  pinnedInRoom: boolean;
  pinLabel: string;
  onOpen: (agentId: string) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  onSettings: (agent: AgentInfo) => void;
  onTogglePin: (agentId: string) => void;
  // A row of the Pinned list: drag to reorder.
  drag?: DragBindings;
}) {
  const { t } = useI18n();
  const settingsLabel = t("sidebar.agentSettings");
  return (
    <div className="chat-sidebar-agent" {...drag?.attrs} data-drop={drag?.drop}>
      <button
        type="button"
        tabIndex={-1}
        className="chat-sidebar-row"
        data-sidebar-agent={agent.id}
        aria-current={current ? "page" : undefined}
        data-sidebar-muted={pinnedInRoom ? "" : undefined}
        onClick={() => onOpen(agent.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY, agent);
        }}
        style={{ ...rowBase, padding: "5px 10px" }}
      >
        <span style={{ position: "relative", flexShrink: 0, display: "flex" }}>
          <span
            style={{
              display: "flex",
              opacity: pinnedInRoom ? 0.55 : undefined,
            }}
          >
            <Head outfit={agent.outfit} />
          </span>
          <span style={{ position: "absolute", right: -2, bottom: -2 }}>
            <RowLight agent={agent} changedAt={changedAt} />
          </span>
        </span>
        <span
          {...noTranslate()}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.25,
            color: pinnedInRoom ? "var(--text-dim)" : undefined,
          }}
        >
          <span
            style={{
              fontWeight: current || (unread && !pinnedInRoom) ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </span>
          {agent.topic && (
            <span
              style={{
                fontSize: 11.5,
                color: "var(--text-dim)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {agent.topic}
            </span>
          )}
        </span>
        {attention > 0 ? (
          <Badge n={attention} tone="orange" />
        ) : unread ? (
          <span
            data-sidebar-unread=""
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              flexShrink: 0,
            }}
          />
        ) : null}
        {pinnedInRoom && (
          <span
            data-sidebar-pinned-mark=""
            style={{ color: "var(--text-dim)", flexShrink: 0 }}
          >
            <PinIcon filled />
          </span>
        )}
      </button>
      {/* Siblings of the row, not inside it: no button in a button. They
          show on hover over the row's right end. */}
      <span className="chat-sidebar-row-actions">
        <button
          type="button"
          tabIndex={-1}
          className="chat-sidebar-row-action"
          data-sidebar-agent-settings={agent.id}
          title={settingsLabel}
          aria-label={settingsLabel}
          onClick={() => onSettings(agent)}
        >
          {SettingsIcon}
        </button>
        <button
          type="button"
          tabIndex={-1}
          className="chat-sidebar-row-action chat-sidebar-pin"
          data-sidebar-pin={agent.id}
          aria-pressed={pinned}
          title={pinLabel}
          aria-label={pinLabel}
          onClick={() => onTogglePin(agent.id)}
        >
          <PinIcon filled={pinned} />
        </button>
      </span>
    </div>
  );
}

// The summary on a folded room or back room (ui/chat-sidebar.ts
// roomSummary): one green dot with the working count, and the orange badge
// with the sum of the row badges. Nothing when both are 0.
function Summary({
  working,
  attention,
  attr,
  workingLabel,
}: {
  working: number;
  attention: number;
  attr: Record<string, string>;
  workingLabel: string;
}) {
  return (
    <span
      {...attr}
      style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
    >
      {working > 0 && (
        <span
          data-sidebar-room-working={working}
          title={workingLabel}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--green-text)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--green-text)",
            }}
          />
          {working}
        </span>
      )}
      <Badge n={attention} tone="orange" />
    </span>
  );
}

// A member row of the Members section, and of Pinned (task b2889127): ghost
// with online dot, name, unread badge. Over the row's right end on hover, as
// on an agent row: an owner's sliders to that member's settings, then a pin
// button. A removed member's row is muted and has neither.
function MemberRow({
  row,
  current,
  pinned,
  onOpen,
  onSettings,
  onTogglePin,
  drag,
}: {
  row: MemberChatRow;
  current: boolean;
  pinned: boolean;
  onOpen: (userId: string) => void;
  onSettings: ((userId: string) => void) | null;
  // Null on a removed member's row.
  onTogglePin: ((key: string) => void) | null;
  // A row of the Pinned list: drag to reorder.
  drag?: DragBindings;
}) {
  const { t } = useI18n();
  const settingsLabel = t("humanChat.memberSettings", { name: row.name });
  const pinLabel = t(pinned ? "sidebar.unpin" : "sidebar.pin");
  const pinKey = memberPinKey(row.id);
  return (
    <div
      className="chat-sidebar-member"
      {...drag?.attrs}
      data-drop={drag?.drop}
    >
      <button
        type="button"
        tabIndex={-1}
        className="chat-sidebar-row"
        data-sidebar-member={row.id}
        {...(row.removed ? { "data-removed": "" } : {})}
        {...(row.online ? { "data-online": "" } : {})}
        aria-current={current ? "page" : undefined}
        title={
          row.removed ? `${row.name} (${t("humanChat.removed")})` : undefined
        }
        onClick={() => onOpen(row.id)}
        style={{
          ...rowBase,
          padding: "5px 10px",
          opacity: row.removed ? 0.55 : 1,
        }}
      >
        <span
          style={{
            position: "relative",
            flexShrink: 0,
            display: "flex",
            width: HEAD_SIZE,
            justifyContent: "center",
          }}
        >
          <GhostGraphic
            variant={row.avatarVariant as never}
            color={row.avatarColor}
            size={22}
            animated={false}
            shadow={false}
          />
          {!row.removed && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                right: 0,
                bottom: -1,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: row.online ? "var(--green)" : "var(--text-dim)",
                border: "2px solid var(--bg-surface)",
              }}
            />
          )}
        </span>
        <span
          {...noTranslate()}
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: row.unread > 0 ? 600 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.name}
        </span>
        <Badge n={row.unread} tone="red" />
      </button>
      {(onTogglePin || onSettings) && (
        <span className="chat-sidebar-row-actions">
          {onSettings && (
            <button
              type="button"
              className="chat-sidebar-row-action"
              data-sidebar-member-settings={row.id}
              title={settingsLabel}
              aria-label={settingsLabel}
              onClick={() => onSettings(row.id)}
            >
              {SettingsIcon}
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              tabIndex={-1}
              className="chat-sidebar-row-action chat-sidebar-pin"
              data-sidebar-pin={pinKey}
              aria-pressed={pinned}
              title={pinLabel}
              aria-label={pinLabel}
              onClick={() => onTogglePin(pinKey)}
            >
              <PinIcon filled={pinned} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  right,
  attr,
  strong = true,
  list = false,
}: {
  label: ReactNode;
  open: boolean;
  onToggle: () => void;
  right?: ReactNode;
  attr: Record<string, string>;
  strong?: boolean;
  // A list label (Pinned, Recent, Members; tasks 7f93306a, b2889127): small,
  // muted capitals, so it does not read as a room.
  list?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="chat-sidebar-row"
      aria-expanded={open}
      onClick={onToggle}
      {...attr}
      style={{
        ...rowBase,
        gap: 7,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: strong ? 700 : 400,
        color: "var(--text-secondary)",
        ...(list && {
          fontSize: 10.5,
          fontWeight: 600,
          color: "var(--text-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }),
      }}
    >
      <Chevron open={open} />
      <span
        {...noTranslate()}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1 }} />
      {right}
    </button>
  );
}

// An element's drag hooks: what it carries and where a drop goes.
type DragBindings = {
  attrs: {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  // Where the blue drop line shows (styles.ts [data-drop]).
  drop: "before" | "after" | undefined;
};

// Where a dragged room or pin would land: before or after `id`, or into
// Tucked rooms (id null). It holds until the next target, the drop or the
// drag's end: a dragleave's relatedTarget is not reliable enough to clear it.
type DropAt = { id: string | null; before: boolean };

// The blue line a drop target shows, above or below it.
const dropLine = (
  at: DropAt | null,
  id: string,
): "before" | "after" | undefined =>
  at?.id === id ? (at.before ? "before" : "after") : undefined;

const pointerHalf = (e: React.DragEvent) => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
};

export function ChatSidebar({
  openAgentId,
  page,
  officeShown,
  backRoomOpen,
  viewReady,
  onCollapse,
  onOffice,
  onNewAgent,
  onOpenPage,
  onOpenAgent,
  onAgentContextMenu,
  onAgentSettings,
  onOpenHumanChat,
  onOpenMemberSettings,
  onOpenSettings,
  onRoomSettings,
  pins,
  closing = false,
}: ChatSidebarProps): React.ReactElement {
  const {
    agents,
    office,
    asks,
    answeredAsks,
    needsAttention,
    stateChangedAt,
    membersChat,
    openHumanChat,
    currentRoomId,
    lobbyOpen: lobbyInView,
    sessionContext,
  } = useAppState();
  const memberRows = useMemberChatRows();
  const amOwner = sessionContext?.role === "owner";
  // The open human chat's row is current while no page covers it.
  const humanChatShown = page === null ? openHumanChat : null;
  const { t } = useI18n();
  // A member with a permission pack sees only the pages of its areas, as in
  // the office bar.
  const canTasks = useCan("tasks", "read");
  const canSchedules = useCan("schedules", "read");
  const canWebhooks = useCan("webhooks", "read");
  const canAutomations = canSchedules || canWebhooks;
  const canApps = useCan("apps", "read");
  const canSkills = useCan("skills", "read");
  const list = useRoomList();
  // The chat's header pill leaves out the open agent's asks, which its chat
  // already shows; with the chat in view, so does this badge.
  const inbox = useInboxCounts(
    page === null ? (openAgentId ?? undefined) : undefined,
  );
  const askCountByAgent = useMemo(
    () => askCounts(openAsks(asks, answeredAsks)),
    [asks, answeredAsks],
  );
  const openAgent = openAgentId
    ? (agents.find((a) => a.id === openAgentId) ?? null)
    : null;
  const openRoomId = openAgent?.roomId ?? null;
  const { shown, more } = sidebarRooms(list, openRoomId);
  const working = agents.filter(
    (a) => a.state === "thinking" || a.state === "tool_executing",
  ).length;
  const receptionist = agents.find((a) => a.roomId === LOBBY_ROOM_ID);
  const pinnedSet = useMemo(() => new Set(pins.pinned), [pins.pinned]);
  const pinned = pinnedRows(pins.pinned, agents, memberRows);
  const recentAgents = recentAgentsList(pins.recent, pins.pinned, agents);

  // Which sections are open, kept on this device. The open agent's room (and
  // its back room, for a back agent) opens each time the open agent changes;
  // with no open agent, the room in view does. The member's toggles hold
  // until then, also across a reload to the same spot.
  const [sections, setSections] = useState<ChatSidebarSections>(
    () => getChatSidebarSections() ?? CHAT_SIDEBAR_SECTIONS_DEFAULT,
  );
  useEffect(() => setChatSidebarSections(sections), [sections]);
  const anchorRoom = openRoomId ?? currentRoomId;
  const anchorBack = openAgent
    ? isBackSeat(openAgent.desk)
    : backRoomOpen && !lobbyInView;
  // The room in view: on a touch screen, with no hover, its open header
  // always shows its buttons.
  const roomInView = openAgent
    ? openRoomId
    : lobbyInView
      ? null
      : currentRoomId;
  const anchored = sidebarSectionsForAnchor(
    sections,
    {
      key: `${openAgentId ?? ""}|${anchorRoom ?? ""}|${anchorBack ? 1 : 0}`,
      room: anchorRoom,
      back: anchorBack,
      tucked: more.some((r) => r.id === anchorRoom),
    },
    viewReady,
  );
  if (anchored !== sections) setSections(anchored);
  const toggle = (field: "rooms" | "back", id: string) =>
    setSections((s) => ({
      ...s,
      [field]: s[field].includes(id)
        ? s[field].filter((x) => x !== id)
        : [...s[field], id],
    }));
  const flip = (field: "more" | "lobby" | "pinned" | "recent") =>
    setSections((s) => ({ ...s, [field]: !s[field] }));
  const membersOpen = sections.members !== false;
  // The agents an open Pinned or Recent section shows: a folded room leaves
  // them out of its summary, so each unread shows once (task 3cf03055).
  const shownElsewhere = new Set([
    ...(sections.pinned
      ? pinned.flatMap((row) => (row.kind === "agent" ? [row.agent.id] : []))
      : []),
    ...(sections.recent ? recentAgents.map((a) => a.id) : []),
  ]);

  // The room order and the tucked list, written through the same calls as
  // the room tab bar (useRoomList), so the two always agree.
  const tuckedSet = useMemo(() => new Set(list.tucked), [list.tucked]);
  const writeOrder = (order: string[]) => {
    const body: ViewOrderReq = { order };
    list.writeOrder(order, () =>
      apiFetch<void>("PUT", "/api/me/view/order", body),
    );
  };
  const writeTucked = (tucked: string[]) => {
    const body: TuckedRoomsReq = { tucked };
    list.writeTucked(tucked, () =>
      apiFetch<void>("PUT", "/api/me/view/tucked", body),
    );
  };
  const setTucked = (roomId: string, tuck: boolean) => {
    if (tuck === tuckedSet.has(roomId)) return;
    writeTucked(
      tuck
        ? [...list.tucked, roomId]
        : list.tucked.filter((id) => id !== roomId),
    );
  };
  // A drag in progress: a room or a pinned row, and where it would land.
  const [dragging, setDragging] = useState<{
    kind: "room" | "pin";
    id: string;
  } | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const dragBindings = (
    kind: "room" | "pin",
    id: string,
    onDrop: (dragged: string, before: boolean) => void,
  ): DragBindings => {
    const type = kind === "room" ? ROOM_DRAG : PIN_DRAG;
    // Enter as well as over: the line shows from the first event on the row.
    const over = (e: React.DragEvent) => {
      if (dragging?.kind !== kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const before = pointerHalf(e);
      if (dropAt?.id !== id || dropAt.before !== before)
        setDropAt({ id, before });
    };
    return {
      attrs: {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.setData(type, id);
          e.dataTransfer.effectAllowed = "move";
          setDragging({ kind, id });
        },
        onDragEnd: endDrag,
        onDragEnter: over,
        onDragOver: over,
        onDrop: (e) => {
          if (dragging?.kind !== kind) return;
          e.preventDefault();
          const before = pointerHalf(e);
          const dragged = dragging.id;
          endDrag();
          if (dragged !== id) onDrop(dragged, before);
        },
      },
      drop: dragging?.kind === kind ? dropLine(dropAt, id) : undefined,
    };
  };
  // A room dropped on a room takes its place and its kind: dropped among the
  // tucked rooms it tucks, dragged out of them it untucks.
  const dropRoom = (targetId: string) => (dragged: string, before: boolean) => {
    writeOrder(
      moveRoom(
        list.rooms.map((r) => r.id),
        dragged,
        targetId,
        before,
      ),
    );
    setTucked(dragged, tuckedSet.has(targetId));
  };
  // "Tucked rooms" itself takes a dropped room into the tucked list.
  const overTucked = (e: React.DragEvent) => {
    if (dragging?.kind !== "room") return;
    e.preventDefault();
    if (dropAt?.id !== null) setDropAt({ id: null, before: false });
  };
  const tuckDrop = {
    onDragEnter: overTucked,
    onDragOver: overTucked,
    onDrop: (e: React.DragEvent) => {
      if (dragging?.kind !== "room") return;
      e.preventDefault();
      const dragged = dragging.id;
      endDrag();
      setTucked(dragged, true);
    },
  };

  // Pinned and Recent list their agents; every other row is a room row (a
  // room, a back room, the Lobby). A pinned agent's room row is muted, and
  // while Pinned is open its Pinned row carries its badge and unread dot.
  const agentRow = (
    agent: AgentInfo,
    place: "room" | "list",
    drag?: DragBindings,
  ) => {
    const pinned = pinnedSet.has(agent.id);
    const pinnedInRoom = place === "room" && pinned;
    const marksElsewhere = pinnedInRoom && sections.pinned;
    return (
      <AgentRow
        key={agent.id}
        agent={agent}
        current={agent.id === openAgentId}
        attention={
          marksElsewhere
            ? 0
            : agentAttention(agent, askCountByAgent.get(agent.id) ?? 0)
        }
        unread={!marksElsewhere && needsAttention.has(agent.id)}
        changedAt={stateChangedAt.get(agent.id)}
        pinned={pinned}
        pinnedInRoom={pinnedInRoom}
        pinLabel={t(pinned ? "sidebar.unpin" : "sidebar.pin")}
        onOpen={onOpenAgent}
        onContextMenu={onAgentContextMenu}
        onSettings={onAgentSettings}
        onTogglePin={pins.togglePin}
        drag={drag}
      />
    );
  };
  const workingLabel = t("office.status.working");

  const roomSection = (room: RoomWire) => {
    const { front, back } = roomAgents(agents, room.id);
    const open = sections.rooms.includes(room.id);
    const backOpen = sections.back.includes(room.id);
    const summary = open
      ? null
      : roomSummary([...front, ...back], askCountByAgent, shownElsewhere);
    const backSummary = backOpen
      ? null
      : roomSummary(back, askCountByAgent, shownElsewhere);
    // A full front room seats the new agent in the back room.
    const plusLabel =
      newAgentSeat(agents, room.id) === null
        ? t("sidebar.newAgentInBack", { room: room.name })
        : t("sidebar.newAgentIn", { room: room.name });
    const drag = dragBindings("room", room.id, dropRoom(room.id));
    return (
      <div key={room.id}>
        <div
          className="chat-sidebar-room-row"
          {...drag.attrs}
          data-drop={drag.drop}
        >
          <SectionHeader
            label={room.name}
            open={open}
            onToggle={() => toggle("rooms", room.id)}
            attr={{ "data-sidebar-room": room.id }}
            right={
              summary && (
                <Summary
                  {...summary}
                  workingLabel={workingLabel}
                  attr={{ "data-sidebar-room-summary": room.id }}
                />
              )
            }
          />
          {/* Over the header's right end, on hover: they take no room in the
              row, so the summary keeps the same right edge as a back room's. */}
          <span
            className="chat-sidebar-row-actions"
            data-in-view={room.id === roomInView && open ? "" : undefined}
          >
            <button
              type="button"
              tabIndex={-1}
              className="chat-sidebar-row-action"
              data-sidebar-room-settings={room.id}
              title={t("sidebar.roomSettings")}
              aria-label={t("sidebar.roomSettings")}
              onClick={() => onRoomSettings(room.id)}
            >
              {SettingsIcon}
            </button>
            {onNewAgent && (
              <button
                type="button"
                tabIndex={-1}
                className="chat-sidebar-row-action"
                data-sidebar-new-agent={room.id}
                title={plusLabel}
                aria-label={plusLabel}
                onClick={() => onNewAgent(room.id)}
              >
                {PlusIcon}
              </button>
            )}
          </span>
        </div>
        {open && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {front.map((a) => agentRow(a, "room"))}
            {hasBackRoom(room) && back.length > 0 && (
              <div style={{ paddingLeft: 14 }}>
                <SectionHeader
                  label={t("office.backRoom.title")}
                  open={backOpen}
                  strong={false}
                  onToggle={() => toggle("back", room.id)}
                  attr={{ "data-sidebar-back-room": room.id }}
                  right={
                    backSummary && (
                      <Summary
                        {...backSummary}
                        workingLabel={workingLabel}
                        attr={{ "data-sidebar-back-room-summary": room.id }}
                      />
                    )
                  }
                />
                {backOpen && (
                  <div
                    data-sidebar-back-room-agents=""
                    style={{
                      marginLeft: 14,
                      paddingLeft: 4,
                      borderLeft: "1px solid var(--border-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 1,
                    }}
                  >
                    {back.map((a) => agentRow(a, "room"))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // A member row, in Members or in Pinned (with drag).
  const memberRow = (row: MemberChatRow, drag?: DragBindings) => (
    <MemberRow
      key={row.id}
      row={row}
      current={
        humanChatShown?.kind === "dm" && humanChatShown.peerId === row.id
      }
      pinned={pinnedSet.has(memberPinKey(row.id))}
      onOpen={(peerId) => onOpenHumanChat({ kind: "dm", peerId })}
      onSettings={amOwner && !row.removed ? onOpenMemberSettings : null}
      onTogglePin={row.removed ? null : pins.togglePin}
      drag={drag}
    />
  );

  // Pinned and Recent: lists of agents (and, in Pinned, members) that also
  // stay in their rooms and in Members.
  const listSection = (
    name: "pinned" | "recent",
    label: string,
    rows: ReactNode[],
  ) =>
    rows.length > 0 && (
      <div>
        <SectionHeader
          label={label}
          open={sections[name]}
          list
          onToggle={() => flip(name)}
          attr={{ "data-sidebar-section": name }}
        />
        {sections[name] && (
          <div
            data-sidebar-section-agents={name}
            style={{ display: "flex", flexDirection: "column", gap: 1 }}
          >
            {rows}
          </div>
        )}
      </div>
    );
  const pinDrag = (key: string) =>
    dragBindings("pin", key, (dragged, before) =>
      pins.setPinned(movePinned(pins.pinned, dragged, key, before)),
    );

  return (
    <nav
      data-chat-sidebar=""
      data-sidebar-closing={closing ? "" : undefined}
      inert={closing || undefined}
      aria-label={t("sidebar.label")}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: "var(--chat-sidebar-w)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-strong)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 48,
          padding: "0 8px 0 14px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        <span
          {...noTranslate()}
          style={{
            fontWeight: 700,
            fontSize: 14,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {office.name ?? ""}
        </span>
        {working > 0 && (
          <span
            data-sidebar-working=""
            style={{
              fontSize: 11,
              color: "var(--green-text)",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {working} {t("office.status.working")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-sidebar-collapse=""
          className="chat-sidebar-row"
          title={t("sidebar.hide")}
          aria-label={t("sidebar.hide")}
          onClick={onCollapse}
          style={{
            ...rowBase,
            width: "auto",
            padding: 6,
            background: "var(--btn-surface)",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          {SidebarIcon}
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "8px 6px",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {canApps && (
          <NavRow
            attr="apps"
            icon={AppsIcon}
            label={t("common.apps")}
            current={page === "apps"}
            onClick={() => onOpenPage("apps")}
          />
        )}
        <NavRow
          attr="asks"
          icon={InboxIcon}
          label={t("nav.inbox")}
          badge={inbox.newAsks}
          current={page === "asks"}
          onClick={() => onOpenPage("asks")}
        />
        {canTasks && (
          <NavRow
            attr="tasks"
            icon={TasksIcon}
            label={t("common.tasks")}
            current={page === "tasks"}
            onClick={() => onOpenPage("tasks")}
          />
        )}
        {canAutomations && (
          <NavRow
            attr="cronjobs"
            icon={ClockIcon}
            label={t("common.automations")}
            current={page === "cronjobs"}
            onClick={() => onOpenPage("cronjobs")}
          />
        )}
        {canSkills && (
          <NavRow
            attr="skills"
            icon={SkillsIcon}
            label={t("common.skills")}
            current={page === "skills"}
            onClick={() => onOpenPage("skills")}
          />
        )}
        <NavRow
          attr="integrations"
          icon={PlugIcon}
          label={t("common.integrations")}
          current={page === "integrations"}
          onClick={() => onOpenPage("integrations")}
        />
        <NavRow
          attr="settings"
          icon={SettingsIcon}
          label={t("common.settings")}
          current={page === "settings"}
          onClick={onOpenSettings}
        />
        <NavRow
          attr="office"
          icon={BuildingIcon}
          label={t("sidebar.office")}
          current={officeShown}
          onClick={onOffice}
        />
        <div
          style={{
            height: 1,
            background: "var(--border-subtle)",
            margin: "8px 4px",
            flexShrink: 0,
          }}
        />
        {listSection(
          "pinned",
          t("sidebar.pinned"),
          pinned.map((row) =>
            row.kind === "agent"
              ? agentRow(row.agent, "list", pinDrag(row.key))
              : memberRow(row.member, pinDrag(row.key)),
          ),
        )}
        {listSection(
          "recent",
          t("sidebar.recent"),
          recentAgents.map((a) => agentRow(a, "list")),
        )}
        <div>
          <SectionHeader
            label={t("sidebar.members")}
            open={membersOpen}
            list
            onToggle={() =>
              setSections((s) => ({ ...s, members: s.members === false }))
            }
            attr={{ "data-sidebar-members": "" }}
          />
          {membersOpen && (
            <>
              <NavRow
                attr="members-chat"
                icon={
                  <span
                    style={{
                      display: "flex",
                      width: HEAD_SIZE,
                      justifyContent: "center",
                    }}
                  >
                    {ChatIcon}
                  </span>
                }
                label={t("membersChat.title")}
                current={humanChatShown?.kind === "members"}
                badge={membersChat.unread}
                onClick={() => onOpenHumanChat(MEMBERS_CHAT)}
              />
              {memberRows.map((row) => memberRow(row))}
            </>
          )}
        </div>
        {shown.map(roomSection)}
        <div>
          <SectionHeader
            label={t("common.lobby")}
            open={sections.lobby}
            onToggle={() => flip("lobby")}
            attr={{ "data-sidebar-room": LOBBY_ROOM_ID }}
          />
          {sections.lobby && receptionist && agentRow(receptionist, "room")}
        </div>
        {more.length > 0 && (
          <>
            <div
              {...tuckDrop}
              className="chat-sidebar-drop-into"
              data-drop={
                dragging?.kind === "room" && dropAt?.id === null
                  ? "into"
                  : undefined
              }
            >
              <SectionHeader
                label={t("office.tabs.tuckedRooms")}
                open={sections.more}
                strong={false}
                onToggle={() => flip("more")}
                attr={{ "data-sidebar-more-rooms": "" }}
                right={
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {more.length}
                  </span>
                }
              />
            </div>
            {sections.more && (
              <div data-sidebar-tucked-rooms="" style={{ paddingLeft: 8 }}>
                {more.map(roomSection)}
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  );
}

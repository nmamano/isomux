// The desktop sidebar (task c61316be): beside the office view, an agent's
// chat and every page, a Codex-style list of the office's rooms and agents.
// The phone and the site embed never show it. No click in it closes it; only
// its own hide button does. Its decisions live in ui/chat-sidebar.ts.
// Task 5dac6b9b added Pinned and Recent, the folded room summary, the room
// menu and the drag to reorder and tuck rooms; App draws the slot around it
// (its width, the resize edge and the slide).

import { MEMBERS_CHAT, type HumanChatKey } from "../human-chat.ts";
import {
  useMemberChatRows,
  type MemberChatRow,
} from "../members-chat/member-rows.ts";
import { GearIcon } from "../members-chat/icons.tsx";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
  pinnedAgentsList,
  recentAgentsList,
  roomAgents,
  roomSummary,
  sidebarRooms,
  sidebarSectionsForAnchor,
  type ChatSidebarSections,
} from "../chat-sidebar.ts";
import {
  getChatSidebarSections,
  setChatSidebarSections,
} from "../device-settings.ts";
import type { SidebarPins } from "../sidebar-pins.ts";
import { Character } from "../office/Character.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import { MenuItem } from "./ContextMenu.tsx";
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
  // A row of the Members section: Members chat or a 1:1 chat.
  onOpenHumanChat: (chat: HumanChatKey) => void;
  // An owner's gear on a member row: Settings on that member.
  onOpenMemberSettings: (userId: string) => void;
  onOpenSettings: () => void;
  // A room menu's Room settings.
  onRoomSettings: (roomId: string) => void;
  // The member's Pinned and Recent agents (ui/sidebar-pins.ts).
  pins: SidebarPins;
  // The sidebar slides out (App's slot): inert until it leaves.
  closing?: boolean;
}

const HEAD_SIZE = 26;

// Drag payload types, so a room never drops on the pinned list or back.
const ROOM_DRAG = "application/x-isomux-sidebar-room";
const PIN_DRAG = "application/x-isomux-sidebar-pin";

const MoreIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="currentColor"
    style={{ display: "block" }}
  >
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);

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
  pinLabel,
  onOpen,
  onContextMenu,
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
  pinLabel: string;
  onOpen: (agentId: string) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  onTogglePin: (agentId: string) => void;
  // A row of the Pinned list: drag to reorder.
  drag?: DragBindings;
}) {
  return (
    <div className="chat-sidebar-agent" {...drag?.attrs} data-drop={drag?.drop}>
      <button
        type="button"
        tabIndex={-1}
        className="chat-sidebar-row"
        data-sidebar-agent={agent.id}
        aria-current={current ? "page" : undefined}
        onClick={() => onOpen(agent.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY, agent);
        }}
        style={{ ...rowBase, padding: "5px 10px" }}
      >
        <span style={{ position: "relative", flexShrink: 0, display: "flex" }}>
          <Head outfit={agent.outfit} />
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
          }}
        >
          <span
            style={{
              fontWeight: current || unread ? 600 : 400,
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
      </button>
      {/* A sibling of the row, not inside it: no button in a button. It
          shows on hover over the row's right end. */}
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

// A member row of the Members section: ghost with online dot, name, unread
// badge. An owner gets a gear to that member's settings, over the row's right
// end on hover, as an agent row's pin; a removed member's row is muted and
// has none.
function MemberRow({
  row,
  current,
  onOpen,
  onSettings,
}: {
  row: MemberChatRow;
  current: boolean;
  onOpen: (userId: string) => void;
  onSettings: ((userId: string) => void) | null;
}) {
  const { t } = useI18n();
  const settingsLabel = t("humanChat.memberSettings", { name: row.name });
  return (
    <div className="chat-sidebar-member">
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
      {onSettings && (
        <button
          type="button"
          className="chat-sidebar-row-action chat-sidebar-member-gear"
          data-sidebar-member-settings={row.id}
          title={settingsLabel}
          aria-label={settingsLabel}
          onClick={() => onSettings(row.id)}
        >
          {GearIcon}
        </button>
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
  onContextMenu,
}: {
  label: ReactNode;
  open: boolean;
  onToggle: () => void;
  right?: ReactNode;
  attr: Record<string, string>;
  strong?: boolean;
  // A list label (Pinned, Recent; task 7f93306a): small, muted capitals, so
  // it does not read as a room.
  list?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="chat-sidebar-row"
      aria-expanded={open}
      onClick={onToggle}
      onContextMenu={onContextMenu}
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

// The room menu (task 5dac6b9b): Room settings, Tuck or Untuck, Move up and
// Move down. Outside the nav, at the pointer or under the "..." button.
function RoomMenu({
  at,
  tucked,
  canUp,
  canDown,
  onSettings,
  onTuck,
  onUp,
  onDown,
  onClose,
}: {
  at: { x: number; y: number };
  tucked: boolean;
  canUp: boolean;
  canDown: boolean;
  onSettings: () => void;
  onTuck: () => void;
  onUp: () => void;
  onDown: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // Near the window's bottom or right edge, the menu moves in so all of it
  // shows; measured before the first paint, so it never jumps.
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    // offset sizes: the open animation scales the menu, its layout box not.
    const rect = { width: el.offsetWidth, height: el.offsetHeight };
    const next = {
      x: Math.max(
        margin,
        Math.min(at.x, window.innerWidth - rect.width - margin),
      ),
      y: Math.max(
        margin,
        Math.min(at.y, window.innerHeight - rect.height - margin),
      ),
    };
    // The clamp needs the menu's own size, known only once it is laid out,
    // and applies before the paint.
    if (next.x !== pos.x || next.y !== pos.y) setPos(next);
  }, [at, pos]);
  useEffect(() => {
    const close = (e: Event) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target)) return;
      // The "..." buttons open and switch the menu themselves.
      if (target?.closest?.("[data-sidebar-room-menu]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", close);
    // Capture: a page under the menu (Tasks) takes Escape first and stops
    // it; the menu still closes, with the page.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  const item = (
    id: string,
    label: string,
    run: () => void,
    disabled = false,
  ) => (
    <MenuItem
      key={id}
      role="menuitem"
      attrs={{ "data-room-menu": id }}
      label={label}
      disabled={disabled}
      onClick={() => {
        run();
        onClose();
      }}
    />
  );
  // Straight into the body (no Portal mount pass), so the layout effect
  // above measures the menu on its first render.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 1000,
        background: "var(--bg-overlay)",
        backdropFilter: "blur(16px)",
        border: "1px solid var(--border-light)",
        borderRadius: 12,
        padding: 5,
        minWidth: 180,
        boxShadow: "0 12px 40px var(--shadow-heavy)",
        animation: "hudIn 0.12s ease-out",
      }}
    >
      {item("settings", t("sidebar.roomSettings"), onSettings)}
      {tucked
        ? item("untuck", t("sidebar.untuckRoom"), onTuck)
        : item("tuck", t("sidebar.tuckRoom"), onTuck)}
      {item("up", t("sidebar.moveUp"), onUp, !canUp)}
      {item("down", t("sidebar.moveDown"), onDown, !canDown)}
    </div>,
    document.body,
  );
}

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
  const pinnedAgents = pinnedAgentsList(pins.pinned, agents);
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
  // The room in view: its header always shows its "+" while it is open.
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
  // Move up and Move down step past the next room of the same kind: a shown
  // room among the shown ones, a tucked one among the tucked.
  const neighbour = (roomId: string, step: -1 | 1): string | null => {
    const group = list.rooms
      .map((r) => r.id)
      .filter((id) => tuckedSet.has(id) === tuckedSet.has(roomId));
    return group[group.indexOf(roomId) + step] ?? null;
  };
  const moveStep = (roomId: string, step: -1 | 1) => {
    const target = neighbour(roomId, step);
    if (!target) return;
    writeOrder(
      moveRoom(
        list.rooms.map((r) => r.id),
        roomId,
        target,
        step === -1,
      ),
    );
  };

  // One room menu at a time.
  const [roomMenu, setRoomMenu] = useState<{
    roomId: string;
    x: number;
    y: number;
  } | null>(null);
  const closeRoomMenu = useMemo(() => () => setRoomMenu(null), []);
  const menuRoom = roomMenu
    ? (list.rooms.find((r) => r.id === roomMenu.roomId) ?? null)
    : null;

  // A drag in progress: a room or a pinned agent, and where it would land.
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

  const agentRow = (agent: AgentInfo, drag?: DragBindings) => {
    const pinned = pinnedSet.has(agent.id);
    return (
      <AgentRow
        key={agent.id}
        agent={agent}
        current={agent.id === openAgentId}
        attention={agentAttention(agent, askCountByAgent.get(agent.id) ?? 0)}
        unread={needsAttention.has(agent.id)}
        changedAt={stateChangedAt.get(agent.id)}
        pinned={pinned}
        pinLabel={t(pinned ? "sidebar.unpin" : "sidebar.pin")}
        onOpen={onOpenAgent}
        onContextMenu={onAgentContextMenu}
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
      : roomSummary([...front, ...back], askCountByAgent);
    const backSummary = backOpen ? null : roomSummary(back, askCountByAgent);
    // A full front room seats the new agent in the back room.
    const plusLabel =
      newAgentSeat(agents, room.id) === null
        ? t("sidebar.newAgentInBack", { room: room.name })
        : t("sidebar.newAgentIn", { room: room.name });
    const openMenu = (x: number, y: number) =>
      setRoomMenu({ roomId: room.id, x, y });
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
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY);
            }}
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
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY);
            }}
            className="chat-sidebar-room-actions"
            data-in-view={room.id === roomInView && open ? "" : undefined}
          >
            <button
              type="button"
              tabIndex={-1}
              className="chat-sidebar-row-action"
              data-sidebar-room-menu={room.id}
              title={t("sidebar.roomOptions")}
              aria-label={t("sidebar.roomOptions")}
              aria-haspopup="menu"
              aria-expanded={roomMenu?.roomId === room.id}
              onClick={(e) => {
                if (roomMenu?.roomId === room.id) {
                  setRoomMenu(null);
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                openMenu(rect.left, rect.bottom + 4);
              }}
            >
              {MoreIcon}
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
            {front.map((a) => agentRow(a))}
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
                    {back.map((a) => agentRow(a))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Pinned and Recent: lists of agents that also stay in their rooms.
  const agentSection = (
    name: "pinned" | "recent",
    label: string,
    rows: AgentInfo[],
    pinDrag: boolean,
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
            {rows.map((a) =>
              agentRow(
                a,
                pinDrag
                  ? dragBindings("pin", a.id, (dragged, before) =>
                      pins.setPinned(
                        movePinned(pins.pinned, dragged, a.id, before),
                      ),
                    )
                  : undefined,
              ),
            )}
          </div>
        )}
      </div>
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
        {agentSection("pinned", t("sidebar.pinned"), pinnedAgents, true)}
        {agentSection("recent", t("sidebar.recent"), recentAgents, false)}
        <div>
          <SectionHeader
            label={t("common.lobby")}
            open={sections.lobby}
            onToggle={() => flip("lobby")}
            attr={{ "data-sidebar-room": LOBBY_ROOM_ID }}
          />
          {sections.lobby && receptionist && agentRow(receptionist)}
        </div>
        <div>
          <SectionHeader
            label={t("sidebar.members")}
            open={membersOpen}
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
              {memberRows.map((row) => (
                <MemberRow
                  key={row.id}
                  row={row}
                  current={
                    humanChatShown?.kind === "dm" &&
                    humanChatShown.peerId === row.id
                  }
                  onOpen={(peerId) => onOpenHumanChat({ kind: "dm", peerId })}
                  onSettings={
                    amOwner && !row.removed ? onOpenMemberSettings : null
                  }
                />
              ))}
            </>
          )}
        </div>
        {shown.map(roomSection)}
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
      {roomMenu && menuRoom && (
        <RoomMenu
          // A new place (another room, another click) starts a new clamp.
          key={`${roomMenu.roomId}:${roomMenu.x}:${roomMenu.y}`}
          at={roomMenu}
          tucked={tuckedSet.has(menuRoom.id)}
          canUp={neighbour(menuRoom.id, -1) !== null}
          canDown={neighbour(menuRoom.id, 1) !== null}
          onSettings={() => onRoomSettings(menuRoom.id)}
          onTuck={() => setTucked(menuRoom.id, !tuckedSet.has(menuRoom.id))}
          onUp={() => moveStep(menuRoom.id, -1)}
          onDown={() => moveStep(menuRoom.id, 1)}
          onClose={closeRoomMenu}
        />
      )}
    </nav>
  );
}

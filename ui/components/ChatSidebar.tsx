// The desktop sidebar (task c61316be): beside the office view, an agent's
// chat and every page, a Codex-style list of the office's rooms and agents.
// The phone and the site embed never show it. No click in it closes it; only
// its own hide button does. Its decisions live in ui/chat-sidebar.ts.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type RoomWire,
} from "../../shared/types.ts";
import { hasBackRoom, isBackSeat } from "../../shared/desks.ts";
import { defaultGhostColorForUserId } from "../../shared/avatar.ts";
import type { Page } from "../routes.ts";
import { useAppState, useRoomList } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { useInboxCounts } from "../inbox.ts";
import { askCounts, openAsks } from "../asks-sync.ts";
import { useSelfUser } from "../hooks/useSelfUser.ts";
import { useCan } from "../hooks/useCan.ts";
import { newAgentSeat, roomAgents, sidebarRooms } from "../chat-sidebar.ts";
import { Character } from "../office/Character.tsx";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { StatusLight, statusColor } from "../office/StatusLight.tsx";
import { roomActivityDotColor } from "../office/room-activity.ts";
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
  onCollapse: () => void;
  // The Office row: back to the room view the open agent sits in.
  onOffice: () => void;
  // A room header's "+": a new agent in that room. Null when the member may
  // not spawn.
  onNewAgent: ((roomId: string) => void) | null;
  onOpenPage: (page: SidebarPage) => void;
  onOpenAgent: (agentId: string) => void;
  onAgentContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  onMembersChat: () => void;
  onOpenSettings: () => void;
}

export const CHAT_SIDEBAR_WIDTH = 260;
const HEAD_SIZE = 26;

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
  asks,
  unread,
  changedAt,
  onOpen,
  onContextMenu,
}: {
  agent: AgentInfo;
  current: boolean;
  asks: number;
  unread: boolean;
  changedAt: number | undefined;
  onOpen: (agentId: string) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
}) {
  return (
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
      {asks > 0 ? (
        <Badge n={asks} tone="orange" />
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
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  dot,
  right,
  attr,
  strong = true,
}: {
  label: ReactNode;
  open: boolean;
  onToggle: () => void;
  dot?: string | null;
  right?: ReactNode;
  attr: Record<string, string>;
  strong?: boolean;
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
      {dot && (
        <span
          data-sidebar-room-dot=""
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dot,
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ flex: 1 }} />
      {right}
    </button>
  );
}

export function ChatSidebar({
  openAgentId,
  page,
  officeShown,
  backRoomOpen,
  onCollapse,
  onOffice,
  onNewAgent,
  onOpenPage,
  onOpenAgent,
  onAgentContextMenu,
  onMembersChat,
  onOpenSettings,
}: ChatSidebarProps): React.ReactElement {
  const {
    agents,
    office,
    asks,
    answeredAsks,
    needsAttention,
    stateChangedAt,
    membersChat,
    currentRoomId,
    lobbyOpen: lobbyInView,
    sessionContext,
  } = useAppState();
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
  const self = useSelfUser();
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

  // Which sections are open. The open agent's room (and its back room, for a
  // back agent) opens each time the open agent changes; with no open agent,
  // the room in view does. The member's toggles hold until then.
  const [openRooms, setOpenRooms] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [openBack, setOpenBack] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [lobbyOpen, setLobbyOpen] = useState(true);
  const anchorRoom = openRoomId ?? currentRoomId;
  const anchorBack = openAgent
    ? isBackSeat(openAgent.desk)
    : backRoomOpen && !lobbyInView;
  // The room in view: its header always shows its "+".
  const roomInView = openAgent
    ? openRoomId
    : lobbyInView
      ? null
      : currentRoomId;
  const anchorKey = `${openAgentId ?? ""}|${anchorRoom ?? ""}|${anchorBack ? 1 : 0}`;
  const [seenAnchor, setSeenAnchor] = useState<string | null>(null);
  if (seenAnchor !== anchorKey) {
    setSeenAnchor(anchorKey);
    if (anchorRoom && !openRooms.has(anchorRoom))
      setOpenRooms(new Set([...openRooms, anchorRoom]));
    if (anchorRoom && anchorBack && !openBack.has(anchorRoom))
      setOpenBack(new Set([...openBack, anchorRoom]));
    if (anchorRoom && more.some((r) => r.id === anchorRoom)) setMoreOpen(true);
  }
  const toggle = (
    set: ReadonlySet<string>,
    write: (s: ReadonlySet<string>) => void,
    id: string,
  ) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    write(next);
  };

  const agentRow = (agent: AgentInfo) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      current={agent.id === openAgentId}
      asks={askCountByAgent.get(agent.id) ?? 0}
      unread={needsAttention.has(agent.id)}
      changedAt={stateChangedAt.get(agent.id)}
      onOpen={onOpenAgent}
      onContextMenu={onAgentContextMenu}
    />
  );

  const roomSection = (room: RoomWire) => {
    const { front, back } = roomAgents(agents, room.id);
    const open = openRooms.has(room.id);
    const backOpen = openBack.has(room.id);
    // A full front room seats the new agent in the back room.
    const plusLabel =
      newAgentSeat(agents, room.id) === null
        ? t("sidebar.newAgentInBack", { room: room.name })
        : t("sidebar.newAgentIn", { room: room.name });
    return (
      <div key={room.id}>
        <div
          className="chat-sidebar-room-row"
          style={{ display: "flex", alignItems: "center", gap: 2 }}
        >
          <SectionHeader
            label={room.name}
            open={open}
            onToggle={() => toggle(openRooms, setOpenRooms, room.id)}
            dot={open ? null : roomActivityDotColor([...front, ...back], false)}
            attr={{ "data-sidebar-room": room.id }}
          />
          {onNewAgent && (
            <button
              type="button"
              tabIndex={-1}
              className="chat-sidebar-row chat-sidebar-new-agent"
              data-sidebar-new-agent={room.id}
              data-in-view={room.id === roomInView ? "" : undefined}
              title={plusLabel}
              aria-label={plusLabel}
              onClick={() => onNewAgent(room.id)}
              style={{
                ...rowBase,
                width: "auto",
                padding: 5,
                color: "var(--text-dim)",
                flexShrink: 0,
              }}
            >
              {PlusIcon}
            </button>
          )}
        </div>
        {open && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {front.map(agentRow)}
            {hasBackRoom(room) && back.length > 0 && (
              <>
                <SectionHeader
                  label={t("office.backRoom.title")}
                  open={backOpen}
                  strong={false}
                  onToggle={() => toggle(openBack, setOpenBack, room.id)}
                  attr={{ "data-sidebar-back-room": room.id }}
                  right={
                    <span
                      style={{ display: "flex", alignItems: "center", gap: 3 }}
                    >
                      {!backOpen &&
                        back.slice(0, 6).map((a) => (
                          <span
                            key={a.id}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: statusColor(a.state),
                            }}
                          />
                        ))}
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: 11,
                          color: "var(--text-dim)",
                        }}
                      >
                        {back.length}
                      </span>
                    </span>
                  }
                />
                {backOpen && (
                  <div style={{ paddingLeft: 10 }}>{back.map(agentRow)}</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const selfName = self?.name ?? sessionContext?.username ?? "";

  return (
    <nav
      data-chat-sidebar=""
      aria-label={t("sidebar.label")}
      style={{
        width: CHAT_SIDEBAR_WIDTH,
        flexShrink: 0,
        height: "100%",
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
        <div>
          <SectionHeader
            label={t("common.lobby")}
            open={lobbyOpen}
            onToggle={() => setLobbyOpen(!lobbyOpen)}
            attr={{ "data-sidebar-room": LOBBY_ROOM_ID }}
          />
          {lobbyOpen && (
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
                badge={membersChat.unread}
                onClick={onMembersChat}
              />
              {receptionist && agentRow(receptionist)}
            </>
          )}
        </div>
        {shown.map(roomSection)}
        {more.length > 0 && (
          <>
            <SectionHeader
              label={t("office.tabs.tuckedRooms")}
              open={moreOpen}
              strong={false}
              onToggle={() => setMoreOpen(!moreOpen)}
              attr={{ "data-sidebar-more-rooms": "" }}
              right={
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {more.length}
                </span>
              }
            />
            {moreOpen && (
              <div style={{ paddingLeft: 8 }}>{more.map(roomSection)}</div>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        tabIndex={-1}
        className="chat-sidebar-row"
        data-sidebar-self=""
        onClick={onOpenSettings}
        style={{
          ...rowBase,
          borderRadius: 0,
          padding: "10px 14px",
          borderTop: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        {self && (
          <GhostGraphic
            variant={self.avatarVariant ?? "classic"}
            color={self.avatarColor ?? defaultGhostColorForUserId(self.id)}
            size={24}
            animated={false}
            shadow={false}
          />
        )}
        <span
          {...noTranslate()}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 600,
          }}
        >
          {selfName}
        </span>
      </button>
    </nav>
  );
}

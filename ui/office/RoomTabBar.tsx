import { useState, useMemo } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch } from "../api.ts";
import type { ViewOrderReq } from "../../shared/contract-shapes.ts";
import { RoomSettingsModal } from "../components/RoomSettingsModal.tsx";
import { GhostGraphic } from "./ghostVariants.tsx";
import type { PresenceInfo } from "../../shared/types.ts";

// Per-tab mini-ghost cluster sizing. Kept small so the bar height
// stays at 32px (the tabs' existing height) — mini ghosts must read as
// subordinate to the room name.
const MINI_GHOST_SIZE = 12;
const MAX_MINI_GHOSTS = 3;
// Heavy stack — each additional ghost contributes only ~4px of visible
// width past the previous one, keeping the cluster narrow. Color is
// enough to distinguish individual ghosts.
const MINI_GHOST_OVERLAP = -8;

function MiniGhostCluster({
  presences,
  selfConnectionId,
}: {
  presences: PresenceInfo[];
  selfConnectionId: string | null;
}) {
  // Same rules as the in-scene ghost layer: one mini-ghost per WS
  // connection (no user-level dedupe — a single user on phone + laptop
  // is two ghosts), and the viewer only hides their OWN connection;
  // other tabs/devices of the same user remain visible as their own
  // mini-ghosts. Mini-ghosts in the tab bar are non-interactive — the
  // scene ghost is the click target for opening a user.
  const others = selfConnectionId
    ? presences.filter((p) => p.connectionId !== selfConnectionId)
    : presences;
  const visible = others.slice(0, MAX_MINI_GHOSTS);
  // Collapse the cluster entirely when there's no one to show — a
  // zero-width span would leave hidden hover/focus regions. Tabs shift
  // laterally as ghosts arrive/leave; the pills themselves keep a
  // constant width either way.
  if (visible.length === 0) return null;
  // No "+K" overflow indicator: three visible ghosts is enough signal
  // that a room is populated; the total online count at the right end
  // of the bar carries the global figure.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        verticalAlign: "middle",
      }}
    >
      {visible.map((p, idx) => {
        const title = p.device ? `${p.username} (${p.device})` : p.username;
        return (
          <span
            key={p.connectionId}
            title={title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginLeft: idx === 0 ? 0 : MINI_GHOST_OVERLAP,
              // Dim away-mode ghosts at the same ~40% the in-scene
              // layer uses (viewer is in TaskView/CronjobsView/Settings).
              opacity: p.viewMode === "away" ? 0.4 : 1,
              // Nudge down by 1px — the SVG body sits slightly above
              // the geometric center of its bounding box, which reads
              // as the ghost floating high vs. text x-height. 1px puts
              // the body visually aligned with the room-name letters.
              transform: "translateY(1px)",
            }}
          >
            <GhostGraphic
              variant={p.avatarVariant}
              color={p.avatarColor}
              size={MINI_GHOST_SIZE}
              animated={false}
              shadow={false}
            />
          </span>
        );
      })}
    </span>
  );
}

function TotalOnlineChip({ count }: { count: number }) {
  if (count <= 0) return null;
  // Text + green "online" dot — the conventional online-status visual
  // language (Discord/Slack/Teams). The count is distinct users
  // (server dedupes by userId), hence "users" — a ghost represents a
  // device/connection, not a user. Italic and right-aligned via
  // marginLeft:auto so the chip reads as ambient annotation, not a tab.
  const label = count === 1 ? "1 online user" : `${count} online users`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginLeft: "auto",
        paddingLeft: 12,
        color: "var(--text-dim)",
        fontStyle: "italic",
        fontSize: 11,
        flexShrink: 0,
        lineHeight: 1,
      }}
      title={label}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--green)",
          boxShadow: "0 0 4px var(--green)",
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export function RoomTabBar() {
  const {
    agents,
    currentRoomId,
    rooms,
    needsAttention,
    presences,
    totalOnlineUsers,
    sessionContext,
  } = useAppState();
  const selfConnectionId = sessionContext?.connectionId ?? null;
  const roomCount = rooms.length;
  const dispatch = useDispatch();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);

  // Bucket presences by global room id, then look each tab up by its
  // room.id. The server already filters by allowedRooms; off-scene entries
  // (currentRoomId null) are absent from the wire. No user-level dedupe:
  // one mini-ghost per connection, matching the in-scene ghost layer.
  const presencesByRoom = useMemo(() => {
    const buckets = new Map<string, PresenceInfo[]>();
    for (const p of presences) {
      if (p.currentRoomId === null) continue;
      const list = buckets.get(p.currentRoomId);
      if (list) list.push(p);
      else buckets.set(p.currentRoomId, [p]);
    }
    return buckets;
  }, [presences]);

  function handleDragStart(e: React.DragEvent, i: number) {
    setDragFrom(i);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  }

  function handleDragOver(e: React.DragEvent, i: number) {
    if (dragFrom === null || dragFrom === i) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(i);
  }

  function handleDragLeave() {
    setDragOver(null);
  }

  function handleDrop(e: React.DragEvent, dropIdx: number) {
    e.preventDefault();
    setDragOver(null);
    if (dragFrom === null || dragFrom === dropIdx) {
      setDragFrom(null);
      return;
    }

    // Build new order as roomId[] — remove dragFrom, insert at dropIdx
    const order = rooms.map((r) => r.id);
    const [removed] = order.splice(dragFrom, 1);
    order.splice(dropIdx, 0, removed);
    // Per-user view order; fire-and-forget (the projected full_state re-renders
    // the tabs). Parity with the old WS reorder_rooms, which carried no ack.
    const body: ViewOrderReq = { order };
    apiFetch<void>("PUT", "/api/me/view/order", body).catch(() => {});
    setDragFrom(null);
  }

  function handleDragEnd() {
    setDragFrom(null);
    setDragOver(null);
  }

  return (
    <div
      className="hide-scrollbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 12px",
        height: 32,
        background: "var(--bg-hud)",
        borderBottom: "1px solid var(--border-subtle)",
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        flexShrink: 0,
        zIndex: 500,
      }}
    >
      {rooms.map((room, i) => {
        const isActive = room.id === currentRoomId;
        const roomAgents = agents.filter((a) => a.roomId === room.id);
        const hasAttention = roomAgents.some((a) => needsAttention.has(a.id));
        const isEmpty = roomAgents.length === 0;
        const displayName = room.name;
        const isDragging = dragFrom === i;
        const isDropTarget = dragOver === i;
        const roomPresences = presencesByRoom.get(room.id) ?? [];

        return (
          <div
            key={i}
            draggable={roomCount > 1}
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              position: "relative",
              // Don't let a narrow viewport (mobile) squeeze the tab —
              // without this, the flex parent's overflowX:auto wouldn't
              // stop browsers from shrinking the tab and wrapping the
              // room name across two lines, which makes the active
              // border render around a taller pill than other tabs.
              flexShrink: 0,
              opacity: isDragging ? 0.4 : 1,
              borderLeft:
                isDropTarget && dragFrom !== null && dragFrom > i
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
              borderRight:
                isDropTarget && dragFrom !== null && dragFrom < i
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
              transition: "opacity 0.15s",
            }}
          >
            {/* Tab pill: room name + agent count + attention dot. The
                active background hugs the room label; the presence
                cluster sits OUTSIDE the pill as a sibling so an empty
                cluster reads as inter-tab spacing instead of broken
                trailing padding inside the selected tab. */}
            <button
              onClick={(e) => {
                (e.target as HTMLElement).blur();
                dispatch({ type: "set_current_room", roomId: room.id });
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                setSettingsRoomId(room.id);
              }}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: isActive
                  ? "1px solid var(--accent)"
                  : "1px solid transparent",
                background: isActive ? "var(--accent-bg)" : "transparent",
                color: isActive ? "var(--accent)" : "var(--text-dim)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "grab",
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: "0.02em",
                outline: "none",
                position: "relative",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                display: "inline-flex",
                alignItems: "center",
                // Keep multi-word room names on a single line so the
                // active border surrounds a fixed-height pill regardless
                // of name length. Without this, names that didn't fit
                // wrapped to two lines and the selected-tab border
                // looked taller than on tabs whose names fit.
                whiteSpace: "nowrap",
              }}
              title="Double-click for room settings"
            >
              {displayName}
              <span
                style={{
                  color: "var(--text-hint)",
                  fontSize: 9,
                  marginLeft: 4,
                }}
              >
                {roomAgents.length}/8
              </span>
              {hasAttention && !isActive && (
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--purple)",
                    boxShadow: "0 0 4px var(--purple)",
                  }}
                />
              )}
            </button>
            <MiniGhostCluster
              presences={roomPresences}
              selfConnectionId={selfConnectionId}
            />
            {/* Close button: closeable-when-empty rooms only.
                room.canCloseWhenEmpty is the server-authoritative
                protected-first-room signal (false only for the canonical first
                room, derived from canonical order — correct even under a custom
                view order). Emptiness stays a client-side reactive check. */}
            {room.canCloseWhenEmpty && isEmpty && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  apiFetch<void>("DELETE", `/api/rooms/${room.id}`).catch(
                    () => {},
                  );
                }}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: "none",
                  background: "transparent",
                  color: "var(--text-hint)",
                  fontSize: 10,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  lineHeight: 1,
                }}
                title="Close empty room"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {/* Add room button */}
      <button
        onClick={() => {
          // Fire-and-forget; the room_created broadcast adds the tab (parity
          // with the old WS create_room, which carried no name and no ack).
          apiFetch<void>("POST", "/api/rooms", {}).catch(() => {});
        }}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px dashed var(--border)",
          background: "transparent",
          color: "var(--text-hint)",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          marginLeft: 4,
          flexShrink: 0,
        }}
        title="Create new room"
      >
        +
      </button>

      {/* Total online users chip — answers "who is online anywhere"
          (counts distinct userIds across the WHOLE office, including
          off-scene sessions). Per-tab clusters above answer "who is
          in this room". */}
      <TotalOnlineChip count={totalOnlineUsers} />

      {settingsRoomId && (
        <RoomSettingsModal
          roomId={settingsRoomId}
          onClose={() => setSettingsRoomId(null)}
        />
      )}
    </div>
  );
}

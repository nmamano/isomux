import { MembersChatUnread } from "../members-chat/MembersChatUnread.tsx";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useAppState, useDispatch, useRoomList } from "../store.tsx";
import { apiFetch } from "../api.ts";
import type {
  TuckedRoomsReq,
  ViewOrderReq,
} from "../../shared/contract-shapes.ts";
import {
  MiniGhostCluster,
  miniGhostClusterWidth,
  selectMiniGhosts,
} from "./MiniGhostCluster.tsx";
import type { PresenceInfo } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { roomActivityDotColor, roomHasUnread } from "./room-activity.ts";
import { TuckedRoomsChip } from "./TuckedRoomsChip.tsx";
import { useDraggedDesk } from "./useDeskDrag.ts";
import { getDraggedDesk } from "./drag-state.ts";
import {
  BACK_ROOM_SEATS,
  DESK_COUNT,
  hasBackRoom,
  isBackSeat,
} from "../../shared/desks.ts";
import type { MoveAgentReq } from "../../shared/contract-shapes.ts";

// Per-tab mini ghosts sit on the tab like stickers (Nil, task 90f655b0):
// centered on the pill's bottom edge, over the bottom of the room name and
// out below the bar. A tab is at least as wide as its stickers, so the
// stickers of two short tabs side by side do not run into each other.
const MINI_GHOST_SIZE = 20;
const MAX_MINI_GHOSTS = 5;
// Each ghost after the first shows 14px past the previous one.
const MINI_GHOST_OVERLAP = -6;
// How far the scroller reaches below the bar, so the stickers that stick out
// below it are not clipped by its overflow.
const GHOST_STICK_OUT = 14;

// Edge affordance for an overflowing tab bar: a gradient fade signals
// "more rooms this way" on both platforms; on desktop a chevron button
// sits at the very edge so mouse users can click to scroll (touch users
// swipe, so the button would only steal edge taps on mobile). Rendered
// as a sibling AFTER the scroller inside the position:relative wrapper,
// so it overlays the clipped tabs without scrolling with them.
function EdgeScrollHint({
  side,
  onScroll,
}: {
  side: "left" | "right";
  onScroll: (() => void) | null;
}) {
  const { t } = useI18n();
  const fade = (
    <span
      aria-hidden
      style={{
        width: 20,
        background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--bg-hud), transparent)`,
      }}
    />
  );
  const scrollLabel = t(
    side === "left" ? "office.tabs.scrollLeft" : "office.tabs.scrollRight",
  );
  const chevron = onScroll && (
    <button
      onClick={onScroll}
      aria-label={scrollLabel}
      title={scrollLabel}
      style={{
        pointerEvents: "auto",
        width: 22,
        border: "none",
        background: "var(--bg-hud)",
        color: "var(--text-dim)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {/* Inline SVG, not a unicode arrow glyph - iOS Safari emoji-renders
          some arrow codepoints, overriding CSS color. */}
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path
          d={side === "left" ? "M6.5 1.5 3 5l3.5 3.5" : "M3.5 1.5 7 5 3.5 8.5"}
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        display: "flex",
        alignItems: "stretch",
        // The fade must not block clicks on the tab edges showing
        // through it; only the chevron button re-enables pointer events.
        pointerEvents: "none",
      }}
    >
      {side === "left" ? (
        <>
          {chevron}
          {fade}
        </>
      ) : (
        <>
          {fade}
          {chevron}
        </>
      )}
    </div>
  );
}

function TotalOnlineChip({ count }: { count: number }) {
  const { tn } = useI18n();
  if (count <= 0) return null;
  // Text + green "online" dot - the conventional online-status visual
  // language (Discord/Slack/Teams). The count is distinct users
  // (server dedupes by userId), hence "users" - a ghost represents a
  // device/connection, not a user. Italic and right-aligned via
  // marginLeft:auto so the chip reads as ambient annotation, not a tab.
  const label = tn("office.tabs.onlineUsers", count);
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

// The double-click on a tab opens that room's settings. App owns the dialog
// (it already renders one from editingRoomSettings); this bar used to render a
// SECOND copy from its own state, so the office had two of them.
export function RoomTabBar({
  onOpenRoomSettings,
  onSelectRoom,
}: {
  onOpenRoomSettings?: (roomId: string) => void;
  /** Runs after every tab click, the open room's included: the back screen
   *  closes, so the click lands on that room's front (task f0af4677). */
  onSelectRoom?: () => void;
}) {
  const {
    agents,
    currentRoomId,
    needsAttention,
    presences,
    totalOnlineUsers,
    sessionContext,
    isMobile,
    lobbyOpen,
  } = useAppState();
  const { t } = useI18n();
  const mobileLobby = isMobile && lobbyOpen;
  const selfConnectionId = sessionContext?.connectionId ?? null;
  // The room list the doors and swipes read too. A drop or a tuck shows at
  // once; the server's state confirms it (ui/office/room-list.tsx).
  const {
    rooms,
    tucked,
    tabs: tabRooms,
    writeOrder,
    writeTucked,
  } = useRoomList();
  const tuckedSet = useMemo(() => new Set(tucked), [tucked]);
  // The bar holds the shown rooms that are not tucked; the chip, the rest.
  const barRooms = useMemo(
    () => rooms.filter((r) => !tuckedSet.has(r.id)),
    [rooms, tuckedSet],
  );
  const tuckedRooms = useMemo(
    () => rooms.filter((r) => tuckedSet.has(r.id)),
    [rooms, tuckedSet],
  );
  const activeTucked = tabRooms.find((r) => tuckedSet.has(r.id)) ?? null;
  const dispatch = useDispatch();
  // Drag state holds room ids, so a drop is correct even when tucked rooms
  // sit between two tabs in the member's order.
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  // A desk dragged from the scene (task f0af4677), or a figure from the back
  // screen (task 335384f8): every tab takes it to that room's front, and a
  // "Back room" target beside the tab takes it to that room's back room,
  // where its setting is on (task b16f1e6a). The agent's own room offers
  // only the area the agent is not in.
  const draggedDesk = useDraggedDesk();
  const deskDrag = draggedDesk !== null;
  const [deskOver, setDeskOver] = useState<string | null>(null);
  if (!deskDrag && deskOver !== null) setDeskOver(null);
  const fromArea = deskDrag && isBackSeat(draggedDesk) ? "back" : "front";
  const deskTarget = (roomId: string, area: "front" | "back") => {
    if (roomId === currentRoomId && area === fromArea) return null;
    const inRoom = agents.filter((a) => a.roomId === roomId);
    if (area === "back")
      return inRoom.filter((a) => isBackSeat(a.desk)).length < BACK_ROOM_SEATS
        ? { desk: null }
        : null;
    const taken = new Set(inRoom.map((a) => a.desk));
    const desk = Array.from({ length: DESK_COUNT }, (_, d) => d).find(
      (d) => !taken.has(d),
    );
    return desk === undefined ? null : { desk };
  };
  const deskDropProps = (roomId: string, area: "front" | "back") => {
    const key = `${roomId}:${area}`;
    const target = deskTarget(roomId, area);
    return {
      "data-desk-drop": key,
      onDragOver: (e: React.DragEvent) => {
        if (getDraggedDesk() === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = target ? "move" : "none";
        setDeskOver(key);
      },
      onDragLeave: () => setDeskOver((k) => (k === key ? null : k)),
      onDrop: (e: React.DragEvent) => {
        const desk = getDraggedDesk();
        if (desk === null) return;
        e.preventDefault();
        setDeskOver(null);
        const agent = agents.find(
          (a) => a.roomId === currentRoomId && a.desk === desk,
        );
        if (!agent || !target) return;
        apiFetch("POST", `/api/agents/${agent.id}/move`, {
          targetRoomId: roomId,
          desk: target.desk,
        } satisfies MoveAgentReq).catch(() => {});
      },
    };
  };
  const deskDropStyle = (
    roomId: string,
    area: "front" | "back",
  ): React.CSSProperties => {
    const ok = deskTarget(roomId, area) !== null;
    const over = deskOver === `${roomId}:${area}`;
    if (over && ok)
      return {
        border: "1px solid var(--accent)",
        background: "var(--accent-bg)",
        color: "var(--accent-text)",
      };
    return {
      border: `1px dashed ${ok ? "var(--accent)" : "var(--border)"}`,
      opacity: ok ? 1 : 0.45,
    };
  };
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Overflow state for the scroll affordances. Tracked per direction so
  // each edge hint appears only when there is actually content hidden on
  // that side (both false when all tabs fit - the common case).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 1px tolerance: scrollLeft/scrollWidth can disagree by subpixel
    // rounding at the extremes, which would leave a phantom hint.
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateOverflow();
    el.addEventListener("scroll", updateOverflow, { passive: true });
    // Container resizes (window resize, side panel open/close) change
    // clientWidth; content-width changes are covered by the state-driven
    // effect below.
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    // Translate vertical wheel to horizontal scroll - mouse users have no
    // other way to scroll the bar (the scrollbar is hidden and there is
    // no vertical axis to begin with). Native listener with passive:false
    // because React 17+ delegates wheel as passive, which would make
    // preventDefault (needed to stop ancestor scrolling) a no-op.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.deltaX !== 0) return; // horizontal pan already works natively
      if (el.scrollWidth <= el.clientWidth) return;
      // Firefox mouse wheels report lines (deltaMode 1), not pixels.
      const scale =
        e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? el.clientWidth : 1;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY * scale;
      // Only consume the event if the bar actually moved. When clamped at
      // an edge, wheel in that direction must chain to ancestors -
      // otherwise the bar becomes a vertical-scroll trap for whatever
      // scrollable view sits around it.
      if (el.scrollLeft !== before) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", updateOverflow);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [updateOverflow]);

  // Content width changes without a scroll/resize event: rooms added,
  // removed, or renamed; mini-ghost clusters growing/shrinking; agent
  // counts shifting tab widths.
  useEffect(() => {
    updateOverflow();
  }, [
    barRooms,
    activeTucked,
    agents,
    presences,
    totalOnlineUsers,
    mobileLobby,
    updateOverflow,
  ]);

  // Keep the active tab visible: on mount (deep room in a long list),
  // whenever the current room changes (e.g. selected via a partially
  // clipped tab), and when a tuck or untuck moves the active tab to or from
  // its pinned place at the end. block:'nearest' prevents any vertical
  // ancestor jump.
  const activePinned = activeTucked !== null;
  useEffect(() => {
    scrollerRef.current
      ?.querySelector('[data-active-room-tab="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentRoomId, activePinned]);

  function scrollByPage(dir: 1 | -1) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: "smooth" });
  }

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

  function handleDragStart(e: React.DragEvent, roomId: string) {
    setDragFrom(roomId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", roomId);
  }

  function handleDragOver(e: React.DragEvent, roomId: string) {
    if (dragFrom === null || dragFrom === roomId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(roomId);
  }

  function handleDragLeave() {
    setDragOver(null);
  }

  function handleDrop(e: React.DragEvent, dropId: string) {
    e.preventDefault();
    setDragOver(null);
    if (dragFrom === null || dragFrom === dropId) {
      setDragFrom(null);
      return;
    }

    // Build new order as roomId[] over every shown room, tucked ones
    // included: remove the dragged room, insert it at the drop target.
    const order = rooms.map((r) => r.id);
    const to = order.indexOf(dropId);
    order.splice(order.indexOf(dragFrom), 1);
    order.splice(to, 0, dragFrom);
    // Per-user view order. A failed write drops the overlay, so the bar
    // returns to the order the server holds.
    const body: ViewOrderReq = { order };
    writeOrder(order, () => apiFetch<void>("PUT", "/api/me/view/order", body));
    setDragFrom(null);
  }

  function handleDragEnd() {
    setDragFrom(null);
    setDragOver(null);
  }

  function writeTuckedList(next: string[]) {
    const body: TuckedRoomsReq = { tucked: next };
    writeTucked(next, () => apiFetch<void>("PUT", "/api/me/view/tucked", body));
  }

  function tuckDragged() {
    if (dragFrom !== null && !tuckedSet.has(dragFrom)) {
      writeTuckedList([...tucked, dragFrom]);
    }
    setDragFrom(null);
    setDragOver(null);
  }

  return (
    // Wrapper/scroller split: the edge hints (and the settings modal)
    // must NOT live inside the scroll container - absolutely positioned
    // children of a scroller travel with the content. The wrapper owns
    // the chrome (background, border, height); the scroller only scrolls.
    // The tucked-rooms chip sits after the scroll box, so it stays at the
    // right end and the edge hints never cover it.
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        height: 32,
        background: "var(--bg-hud)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        zIndex: 500,
      }}
    >
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <div
          ref={scrollerRef}
          // room-tab-scroller (ui/styles.ts) passes clicks through the
          // scroller except on iOS, where the scroller must keep its pointer
          // events to scroll (WebKit bug 183870, task 17537680).
          className="hide-scrollbar room-tab-scroller"
          style={{
            // The scroller reaches GHOST_STICK_OUT below the bar, so the
            // stickers scroll with their tabs as part of the content. Only
            // its track takes pointer events, so that strip of the office
            // under the bar still takes clicks (task d4f9210e).
            paddingBottom: GHOST_STICK_OUT,
            height: `calc(100% + ${GHOST_STICK_OUT}px)`,
            overflowX: "auto",
            overflowY: "hidden",
            scrollbarWidth: "none",
            // Keep scrollIntoView targets (the active tab) clear of the edge
            // overlays: 42px = chevron button (22) + fade (20). Only affects
            // programmatic scrolling, not manual scroll positions.
            scrollPadding: "0 42px",
            // A swipe on the bar scrolls only the bar: no vertical pan and
            // no overscroll chained to the page (an unproven suspect for
            // rough scrolling on iOS, task 17537680).
            touchAction: "pan-x",
            overscrollBehaviorX: "contain",
          }}
        >
          {/* The track fills the bar, gaps and padding included, so a swipe
            that starts anywhere on the bar scrolls it (task 17537680). */}
          <div
            data-room-tab-track
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "0 12px",
              height: "100%",
              width: "max-content",
              minWidth: "100%",
              pointerEvents: "auto",
            }}
          >
            {/* The Lobby tab: client state, not a room. First, never draggable,
            never reordered. The dot carries members chat attention;
            room tabs stand down while the lobby is open. */}
            <div
              data-lobby-tab
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                flexShrink: 0,
                borderLeft: "2px solid transparent",
                borderRight: "2px solid transparent",
              }}
            >
              <button
                onClick={(e) => {
                  (e.target as HTMLElement).blur();
                  dispatch({ type: "set_lobby_open", open: true });
                  onSelectRoom?.();
                }}
                onContextMenu={(e) => e.preventDefault()}
                style={{
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: lobbyOpen
                    ? "1px solid var(--accent)"
                    : "1px solid transparent",
                  background: lobbyOpen ? "var(--accent-bg)" : "transparent",
                  color: lobbyOpen ? "var(--accent-text)" : "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                  letterSpacing: "0.02em",
                  outline: "none",
                  position: "relative",
                  userSelect: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {t("common.lobby")}
                {!mobileLobby && <MembersChatUnread />}
              </button>
            </div>
            {tabRooms.map((room, i) => {
              // The active tucked room's tab: shown while it is open, never
              // dragged (its place in the order is in the chip).
              const pinned = room === activeTucked;
              const isActive = !lobbyOpen && room.id === currentRoomId;
              const roomAgents = agents.filter((a) => a.roomId === room.id);
              const hasAttention = roomHasUnread(roomAgents, needsAttention);
              const activityDotColor = roomActivityDotColor(
                roomAgents,
                hasAttention,
                isActive,
              );
              const isEmpty = roomAgents.length === 0;
              const displayName = room.name;
              const isDragging = dragFrom === room.id;
              const isDropTarget = dragOver === room.id;
              const fromIdx = barRooms.findIndex((r) => r.id === dragFrom);
              const roomPresences = presencesByRoom.get(room.id) ?? [];
              const stickerWidth = miniGhostClusterWidth(
                selectMiniGhosts(
                  roomPresences,
                  selfConnectionId,
                  MAX_MINI_GHOSTS,
                ).length,
                MINI_GHOST_SIZE,
                MINI_GHOST_OVERLAP,
              );

              return (
                <div
                  key={room.id}
                  data-active-room-tab={isActive || undefined}
                  data-tucked-room-tab={pinned || undefined}
                  // A lone tab still drags: the chip takes it as a tuck.
                  draggable={!pinned}
                  {...(pinned
                    ? {}
                    : {
                        onDragStart: (e: React.DragEvent) =>
                          handleDragStart(e, room.id),
                        onDragOver: (e: React.DragEvent) =>
                          handleDragOver(e, room.id),
                        onDragLeave: handleDragLeave,
                        onDrop: (e: React.DragEvent) => handleDrop(e, room.id),
                        onDragEnd: handleDragEnd,
                      })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    position: "relative",
                    // Don't let a narrow viewport (mobile) squeeze the tab -
                    // without this, the scroller's overflowX:auto wouldn't
                    // stop browsers from shrinking the tab and wrapping the
                    // room name across two lines, which makes the active
                    // border render around a taller pill than other tabs.
                    flexShrink: 0,
                    opacity: isDragging ? 0.4 : 1,
                    borderLeft:
                      isDropTarget && fromIdx > i
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    borderRight:
                      isDropTarget && fromIdx !== -1 && fromIdx < i
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    transition: "opacity 0.15s",
                  }}
                >
                  {/* Tab pill: room name, attention dot and the presence
                stickers. */}
                  <button
                    {...noTranslate()}
                    data-room-tab-button={room.id}
                    onClick={(e) => {
                      (e.target as HTMLElement).blur();
                      dispatch({ type: "set_current_room", roomId: room.id });
                      onSelectRoom?.();
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      onOpenRoomSettings?.(room.id);
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{
                      padding: "4px 12px",
                      borderRadius: 6,
                      border: isActive
                        ? "1px solid var(--accent)"
                        : "1px solid transparent",
                      background: isActive ? "var(--accent-bg)" : "transparent",
                      color: isActive
                        ? "var(--accent-text)"
                        : "var(--text-dim)",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "grab",
                      fontFamily: "var(--font-ui)",
                      letterSpacing: "0.02em",
                      outline: "none",
                      position: "relative",
                      userSelect: "none",
                      WebkitUserSelect: "none",
                      WebkitTouchCallout: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: stickerWidth,
                      // Keep multi-word room names on a single line so the
                      // active border surrounds a fixed-height pill regardless
                      // of name length. Without this, names that didn't fit
                      // wrapped to two lines and the selected-tab border
                      // looked taller than on tabs whose names fit.
                      whiteSpace: "nowrap",
                      ...(deskDrag && deskDropStyle(room.id, "front")),
                    }}
                    title={t("office.tabs.roomSettings")}
                    {...(deskDrag && deskDropProps(room.id, "front"))}
                  >
                    {displayName}
                    <span
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "100%",
                        transform: "translate(-50%, -33%)",
                        display: "flex",
                        zIndex: 1,
                      }}
                    >
                      <MiniGhostCluster
                        presences={roomPresences}
                        selfConnectionId={selfConnectionId}
                        size={MINI_GHOST_SIZE}
                        max={MAX_MINI_GHOSTS}
                        overlap={MINI_GHOST_OVERLAP}
                        // A soft shadow lifts each ghost off the tab.
                        ghostStyle={{
                          filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.35))",
                        }}
                      />
                    </span>
                    {activityDotColor && (
                      <span
                        style={{
                          position: "absolute",
                          top: 2,
                          right: 2,
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          background: activityDotColor,
                          boxShadow: `0 0 4px ${activityDotColor}`,
                        }}
                      />
                    )}
                  </button>
                  {deskDrag && hasBackRoom(room) && (
                    <span
                      {...deskDropProps(room.id, "back")}
                      style={{
                        padding: "3px 8px",
                        borderRadius: 6,
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        whiteSpace: "nowrap",
                        fontFamily: "var(--font-ui)",
                        ...deskDropStyle(room.id, "back"),
                      }}
                    >
                      {t("office.backRoom.title")}
                    </span>
                  )}
                  {/* Close button: closeable-when-empty rooms only.
                room.canCloseWhenEmpty is the server-authoritative
                protected-first-room signal (false only for the canonical first
                room, derived from canonical order - correct even under a custom
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
                        width: 20,
                        height: 20,
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "var(--bg-code)",
                        color: "var(--text-secondary)",
                        fontSize: 14,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                        lineHeight: 1,
                      }}
                      title={t("office.tabs.closeEmptyRoom")}
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
                fontFamily: "var(--font-ui)",
                marginLeft: 4,
                flexShrink: 0,
              }}
              title={t("office.tabs.newRoom")}
            >
              +
            </button>

            {/* Total online users chip - answers "who is online anywhere"
          (counts distinct userIds across the WHOLE office, including
          off-scene sessions). Per-tab clusters above answer "who is
          in this room". */}
            <TotalOnlineChip count={totalOnlineUsers} />
          </div>
        </div>

        {canScrollLeft && (
          <EdgeScrollHint
            side="left"
            onScroll={isMobile ? null : () => scrollByPage(-1)}
          />
        )}
        {canScrollRight && (
          <EdgeScrollHint
            side="right"
            onScroll={isMobile ? null : () => scrollByPage(1)}
          />
        )}
      </div>
      <TuckedRoomsChip
        tuckedRooms={tuckedRooms}
        activeRoomId={activeTucked?.id ?? null}
        agents={agents}
        needsAttention={needsAttention}
        presencesByRoom={presencesByRoom}
        selfConnectionId={selfConnectionId}
        dragging={dragFrom !== null}
        onTuckDrop={tuckDragged}
        onSelect={(roomId) => {
          dispatch({ type: "set_current_room", roomId });
          onSelectRoom?.();
        }}
      />
    </div>
  );
}

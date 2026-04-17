import { useState, useRef, useEffect } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { send } from "../ws.ts";
import { RoomSettingsModal } from "../components/RoomSettingsModal.tsx";

export function RoomTabBar() {
  const { agents, currentRoom, rooms, needsAttention } = useAppState();
  const roomCount = rooms.length;
  const roomNames = rooms.map((r) => r.name);
  const dispatch = useDispatch();
  const [editingRoom, setEditingRoom] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ roomIdx: number; x: number; y: number } | null>(null);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  // Focus input when editing starts — must be before any early returns (rules of hooks)
  useEffect(() => {
    if (editingRoom !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingRoom]);

  // Dismiss context menu on any outside click / scroll / resize
  useEffect(() => {
    if (!ctxMenu) return;
    function dismiss() { setCtxMenu(null); }
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [ctxMenu]);

  // Auto-show: visible when roomCount > 1 OR Room 1 is full (8 agents)
  const room0Full = agents.filter((a) => a.room === 0).length >= 8;
  if (roomCount <= 1 && !room0Full) return null;

  function startEditing(i: number) {
    setEditingRoom(i);
    setEditValue(roomNames[i] ?? `Room ${i + 1}`);
  }

  function commitEdit() {
    if (editingRoom === null) return;
    const trimmed = editValue.trim();
    const roomId = rooms[editingRoom]?.id;
    if (trimmed && roomId && trimmed !== roomNames[editingRoom]) {
      send({ type: "rename_room", roomId, name: trimmed });
    }
    setEditingRoom(null);
  }

  function openCtxMenu(roomIdx: number, x: number, y: number) {
    setCtxMenu({ roomIdx, x, y });
  }

  function handleTouchStart(e: React.TouchEvent, i: number) {
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      openCtxMenu(i, x, y);
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function cancelEdit() {
    setEditingRoom(null);
  }

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
    if (dragFrom === null || dragFrom === dropIdx) { setDragFrom(null); return; }

    // Build new order as roomId[] — remove dragFrom, insert at dropIdx
    const order = rooms.map((r) => r.id);
    const [removed] = order.splice(dragFrom, 1);
    order.splice(dropIdx, 0, removed);
    send({ type: "reorder_rooms", order });
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
      {Array.from({ length: roomCount }, (_, i) => {
        const isActive = i === currentRoom;
        const roomAgents = agents.filter((a) => a.room === i);
        const hasAttention = roomAgents.some((a) => needsAttention.has(a.id));
        const isEmpty = roomAgents.length === 0;
        const displayName = roomNames[i] ?? `Room ${i + 1}`;
        const isDragging = dragFrom === i;
        const isDropTarget = dragOver === i;

        return (
          <div
            key={i}
            draggable={editingRoom !== i && roomCount > 1}
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
              opacity: isDragging ? 0.4 : 1,
              borderLeft: isDropTarget && dragFrom !== null && dragFrom > i ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: isDropTarget && dragFrom !== null && dragFrom < i ? "2px solid var(--accent)" : "2px solid transparent",
              transition: "opacity 0.15s",
            }}
          >
            {/* Right-click / long-press opens context menu (doesn't switch rooms) */}
            {editingRoom === i ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") cancelEdit();
                }}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--accent)",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: "0.02em",
                  outline: "none",
                  width: 100,
                }}
              />
            ) : (
              <button
                onClick={(e) => {
                  if (longPressFired.current) { longPressFired.current = false; return; }
                  (e.target as HTMLElement).blur();
                  dispatch({ type: "set_current_room", room: i });
                }}
                onDoubleClick={(e) => { e.preventDefault(); startEditing(i); }}
                onContextMenu={(e) => { e.preventDefault(); openCtxMenu(i, e.clientX, e.clientY); }}
                onTouchStart={(e) => handleTouchStart(e, i)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
                onTouchCancel={cancelLongPress}
                style={{
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: isActive ? "1px solid var(--accent)" : "1px solid transparent",
                  background: isActive ? "var(--accent-bg)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "grab",
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: "0.02em",
                  outline: "none",
                  position: "relative",
                }}
              >
                {displayName}
                <span style={{
                  color: "var(--text-hint)",
                  fontSize: 9,
                  marginLeft: 4
                }}>
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
            )}
            {/* Close button: only for empty rooms that aren't Room 1 */}
            {i > 0 && isEmpty && editingRoom !== i && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rid = rooms[i]?.id;
                  if (rid) send({ type: "close_room", roomId: rid });
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
        onClick={() => send({ type: "create_room" })}
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

      {ctxMenu && (() => {
        const room = rooms[ctxMenu.roomIdx];
        if (!room) return null;
        const roomAgents = agents.filter((a) => a.room === ctxMenu.roomIdx);
        const canClose = ctxMenu.roomIdx > 0 && roomAgents.length === 0;
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: Math.min(ctxMenu.x, window.innerWidth - 180),
              top: Math.min(ctxMenu.y, window.innerHeight - 140),
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-light)",
              borderRadius: 8,
              boxShadow: "0 10px 30px var(--shadow-heavy)",
              padding: 4,
              minWidth: 160,
              zIndex: 950,
              fontFamily: "'DM Sans',sans-serif",
              fontSize: 12,
            }}
          >
            <button style={ctxItemStyle} onClick={() => { setCtxMenu(null); startEditing(ctxMenu.roomIdx); }}>Rename</button>
            <button style={ctxItemStyle} onClick={() => { setCtxMenu(null); setSettingsRoomId(room.id); }}>Room settings…</button>
            <button
              style={{ ...ctxItemStyle, color: canClose ? "var(--text-dim)" : "var(--text-ghost)", cursor: canClose ? "pointer" : "not-allowed" }}
              disabled={!canClose}
              onClick={() => { setCtxMenu(null); if (canClose) send({ type: "close_room", roomId: room.id }); }}
            >
              Close room
            </button>
          </div>
        );
      })()}

      {settingsRoomId && (
        <RoomSettingsModal roomId={settingsRoomId} onClose={() => setSettingsRoomId(null)} />
      )}
    </div>
  );
}

const ctxItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "7px 12px",
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
  borderRadius: 4,
};

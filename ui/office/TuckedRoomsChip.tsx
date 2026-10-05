import { useEffect, useRef, useState } from "react";
import type { AgentInfo, PresenceInfo, RoomWire } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { MiniGhostCluster } from "./MiniGhostCluster.tsx";
import { roomActivityDotColor } from "./room-activity.ts";

const MINI_GHOST_SIZE = 12;
const MAX_MINI_GHOSTS = 3;
const MINI_GHOST_OVERLAP = -8;

// The chip stands for every tucked room except the active one, which has its
// own tab in the bar: its presence and activity show there.
export function tuckedChipSummary(
  tuckedRooms: readonly RoomWire[],
  activeRoomId: string | null,
  agents: readonly AgentInfo[],
  needsAttention: ReadonlySet<string>,
  presencesByRoom: ReadonlyMap<string, PresenceInfo[]>,
): {
  presences: PresenceInfo[];
  dotColor: ReturnType<typeof roomActivityDotColor>;
} {
  const ids = new Set(
    tuckedRooms.map((r) => r.id).filter((id) => id !== activeRoomId),
  );
  const roomAgents = agents.filter((a) => ids.has(a.roomId));
  return {
    presences: [...ids].flatMap((id) => presencesByRoom.get(id) ?? []),
    dotColor: roomActivityDotColor(
      roomAgents,
      roomAgents.some((a) => needsAttention.has(a.id)),
      false,
    ),
  };
}

// Display names of the members present in a room, one per member.
export function presentMemberNames(presences: readonly PresenceInfo[]) {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of presences) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    names.push(p.username);
  }
  return names;
}

function ActivityDot({ color }: { color: string | null }) {
  if (!color) return null;
  return (
    <span
      aria-hidden
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 4px ${color}`,
        flexShrink: 0,
      }}
    />
  );
}

// The +N chip at the right end of the room tab bar. A tab dropped on it is
// tucked; a click opens the list of tucked rooms.
export function TuckedRoomsChip({
  tuckedRooms,
  activeRoomId,
  agents,
  needsAttention,
  presencesByRoom,
  selfConnectionId,
  dragging,
  onTuckDrop,
  onSelect,
  onUntuck,
}: {
  tuckedRooms: RoomWire[];
  activeRoomId: string | null;
  agents: AgentInfo[];
  needsAttention: ReadonlySet<string>;
  presencesByRoom: ReadonlyMap<string, PresenceInfo[]>;
  selfConnectionId: string | null;
  dragging: boolean;
  onTuckDrop: () => void;
  onSelect: (roomId: string) => void;
  onUntuck: (roomId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing tucked: the chip shows only as a drop target during a tab drag.
  const count = tuckedRooms.length;
  const isOpen = open && count > 0;
  if (count === 0 && !dragging) return null;

  const summary = tuckedChipSummary(
    tuckedRooms,
    activeRoomId,
    agents,
    needsAttention,
    presencesByRoom,
  );
  const label = t("office.tabs.tuckedRooms");

  return (
    <div
      ref={rootRef}
      data-tucked-chip
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        padding: "0 8px 0 4px",
      }}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        onTuckDrop();
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={isOpen}
        title={dragging ? t("office.tabs.tuck") : label}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border:
            dragging || dropOver
              ? "1px dashed var(--accent)"
              : "1px solid var(--border)",
          background: dropOver || isOpen ? "var(--accent-bg)" : "transparent",
          color: "var(--text-dim)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          position: "relative",
          whiteSpace: "nowrap",
        }}
      >
        {count === 0 ? t("office.tabs.tuck") : `+${count}`}
        {summary.dotColor && (
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: summary.dotColor,
              boxShadow: `0 0 4px ${summary.dotColor}`,
            }}
          />
        )}
      </button>
      <MiniGhostCluster
        presences={summary.presences}
        selfConnectionId={selfConnectionId}
        size={MINI_GHOST_SIZE}
        max={MAX_MINI_GHOSTS}
        overlap={MINI_GHOST_OVERLAP}
        ghostStyle={{ transform: "translateY(1px)" }}
      />
      {isOpen && (
        <div
          role="dialog"
          aria-label={label}
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            right: 4,
            width: "min(300px, calc(100vw - 16px))",
            maxHeight: "60vh",
            overflowY: "auto",
            background: "var(--bg-hud)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            padding: 4,
            zIndex: 600,
          }}
        >
          {tuckedRooms.map((room) => {
            const isActive = room.id === activeRoomId;
            const roomAgents = agents.filter((a) => a.roomId === room.id);
            const dot = roomActivityDotColor(
              roomAgents,
              roomAgents.some((a) => needsAttention.has(a.id)),
              isActive,
            );
            const presences = presencesByRoom.get(room.id) ?? [];
            const names = presentMemberNames(presences);
            return (
              <div
                key={room.id}
                data-tucked-room={room.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: isActive
                    ? "1px solid var(--accent)"
                    : "1px solid transparent",
                  background: isActive ? "var(--accent-bg)" : "transparent",
                }}
              >
                <button
                  {...noTranslate()}
                  onClick={() => {
                    setOpen(false);
                    onSelect(room.id);
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 2,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      color: isActive
                        ? "var(--accent-text)"
                        : "var(--text-secondary)",
                    }}
                  >
                    {room.name}
                    <span style={{ color: "var(--text-hint)", fontSize: 10 }}>
                      {roomAgents.length}/8
                    </span>
                    <ActivityDot color={dot} />
                  </span>
                  {names.length > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--text-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "100%",
                      }}
                    >
                      {names.join(", ")}
                    </span>
                  )}
                </button>
                <MiniGhostCluster
                  presences={presences}
                  selfConnectionId={selfConnectionId}
                  size={MINI_GHOST_SIZE}
                  max={MAX_MINI_GHOSTS}
                  overlap={MINI_GHOST_OVERLAP}
                />
                <button
                  onClick={() => onUntuck(room.id)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-code)",
                    color: "var(--text-secondary)",
                    fontSize: 10,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {t("office.tabs.untuck")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

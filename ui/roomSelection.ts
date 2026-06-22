import type { RoomWire } from "../shared/types.ts";

// Pure room-selection helpers for the client store. Kept dependency-free
// (RoomWire type only) so they're unit-testable without importing the React
// store module. Phase 3c slice 3: the view selection is tracked by stable
// room id, not a dense index.

// Resolve which room id should be selected after the rooms list changes
// (full_state / reconnect). `preferred` (e.g. a user's default room on first
// hydration) wins when present in the new list; otherwise the current
// selection is kept if it still exists; otherwise we fall back to the first
// room (null when there are no rooms). Stable ids mean a reorder never
// changes the selection.
export function resolveSelectedRoomId(
  rooms: RoomWire[],
  current: string | null,
  preferred: string | null = null,
): string | null {
  if (preferred && rooms.some((r) => r.id === preferred)) return preferred;
  if (current && rooms.some((r) => r.id === current)) return current;
  return rooms[0]?.id ?? null;
}

// Apply a room close to the rooms list + current selection. Returns null when
// the closed id isn't present (caller should no-op). Because room ids are
// stable, closing a room OTHER than the selected one never moves the
// selection. Closing the selected room picks the room that takes its slot,
// else the new last room, else null (no rooms left).
export function applyRoomClose(
  rooms: RoomWire[],
  closedId: string,
  current: string | null,
): { rooms: RoomWire[]; currentRoomId: string | null } | null {
  const idx = rooms.findIndex((r) => r.id === closedId);
  if (idx < 0) return null;
  const next = rooms.slice();
  next.splice(idx, 1);
  const currentRoomId =
    current === closedId
      ? (next[Math.min(idx, next.length - 1)]?.id ?? null)
      : current;
  return { rooms: next, currentRoomId };
}

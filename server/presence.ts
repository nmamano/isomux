// In-memory presence map for the live-avatars feature. One PresenceState
// per active WS CONNECTION whose ghost is renderable — not per auth
// session: a single auth session (cookie) can back many concurrent tabs
// and each tab is its own ghost, so the key is the per-WS connectionId
// generated in server/isomux-office.ts at upgrade time. Off-scene sessions
// (viewMode "away" with no currentRoomId) are kept here for cleanup
// bookkeeping but excluded from the wire by the per-WS broadcast helper
// in server/isomux-office.ts.
//
// Lifecycle:
//   - WS open: nothing yet — wait for the client to send presence_update.
//     The client emits one immediately after session_context arrives.
//   - presence_update: the client sends a global currentRoomId; the server
//     validates it against the sender's room access (live room + canAccess,
//     else null), then setPresence().
//   - WS close: removePresence(); broadcast only if the entry existed.
//   - heartbeat timeout: same as close.
//
// State is NOT persisted. A server restart wipes the map; clients re-send
// presence_update on their reconnect path (no server-side rehydrate).

import type { GhostVariant } from "../shared/avatar.ts";

export interface PresenceState {
  connectionId: string;
  userId: string;
  username: string;
  // Per-device label sent by the client (DeviceSettings localStorage).
  // Null when the device hasn't named itself yet.
  device: string | null;
  avatarColor: string;
  avatarVariant: GhostVariant;
  // GLOBAL room id — the SOLE presence room reference. Per-recipient broadcast
  // filters by each recipient's visible rooms but emits this SAME id (no dense
  // remap post-cut). null when the session hasn't sent its first presence_update
  // yet or when the sender's claimed room was rejected by the access sanitizer.
  currentRoomId: string | null;
  focusedAgentId: string | null;
  viewMode: "office" | "log" | "away";
  lastSeenAt: number;
}

const presences = new Map<string, PresenceState>();

// Test-only: drop all presence so a fresh in-process harness boot starts with
// no ghosts from a prior boot's sockets. Not a production path.
export function _testClearPresence(): void {
  presences.clear();
}

// Upsert. Returns true if the visible-to-clients state actually changed
// (so callers can avoid a no-op broadcast on a repeated identical
// update — e.g. focus-change handlers that fire from multiple effect
// dependencies on the same dispatch).
export function setPresence(state: PresenceState): boolean {
  const existing = presences.get(state.connectionId);
  presences.set(state.connectionId, state);
  if (!existing) return true;
  return (
    existing.username !== state.username ||
    existing.device !== state.device ||
    existing.avatarColor !== state.avatarColor ||
    existing.avatarVariant !== state.avatarVariant ||
    existing.currentRoomId !== state.currentRoomId ||
    existing.focusedAgentId !== state.focusedAgentId ||
    existing.viewMode !== state.viewMode
  );
}

// Remove. Idempotent: returns true only if an entry actually existed.
// Used by the close handler so reconnect churn doesn't spam
// presence_list to every other client.
export function removePresence(connectionId: string): boolean {
  return presences.delete(connectionId);
}

export function getPresence(connectionId: string): PresenceState | undefined {
  return presences.get(connectionId);
}

// Snapshot of all current presence rows. Per-recipient VISIBILITY filtering
// happens in the broadcast helper (server/isomux-office.ts) — entries carry the stable
// currentRoomId unchanged (no remap) — so this module stays free of
// room-projection dependencies.
export function listAllPresence(): PresenceState[] {
  return Array.from(presences.values());
}

// Re-denormalize a user's inline display fields across every presence
// entry that belongs to them. Called after update_user succeeds so
// other clients see the rename / color change / variant change on
// their existing ghosts without waiting for the next presence_update
// from the user themselves. Optionally also clamps currentRoomId
// against a new allowedRooms snapshot (covers the access-revoke race
// where a member's tab still thinks it can see a room the owner just
// removed). Returns true if any visible state changed so callers can
// broadcast conditionally.
export function refreshPresenceForUser(
  userId: string,
  display: { name: string; avatarColor: string; avatarVariant: GhostVariant },
  allowedRoomIds?: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const [connectionId, p] of presences) {
    if (p.userId !== userId) continue;
    let next: PresenceState = p;
    if (
      p.username !== display.name ||
      p.avatarColor !== display.avatarColor ||
      p.avatarVariant !== display.avatarVariant
    ) {
      next = {
        ...next,
        username: display.name,
        avatarColor: display.avatarColor,
        avatarVariant: display.avatarVariant,
      };
      changed = true;
    }
    if (
      allowedRoomIds !== undefined &&
      next.currentRoomId !== null &&
      !allowedRoomIds.has(next.currentRoomId)
    ) {
      next = { ...next, currentRoomId: null, lastSeenAt: Date.now() };
      changed = true;
    }
    if (next !== p) {
      presences.set(connectionId, next);
    }
  }
  return changed;
}

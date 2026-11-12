// The desktop sidebar's Pinned and Recent lists (task 5dac6b9b), from the
// member's own record, so they follow the member across devices. Pinned holds
// agent ids and member:<userId> keys (task b2889127, shared/sidebar-pins.ts).
// A pin or unpin shows at once as a pending list over the record, and builds on the
// list on screen, so two quick writes do not undo each other; a failed write
// drops it, and the list returns to what the server holds.

import { useCallback, useMemo } from "react";
import { apiFetch } from "./api.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";
import { usePendingView } from "./office/pending-view.ts";
import type { PinnedReq } from "../shared/contract-shapes.ts";

const NONE: readonly string[] = [];

const sameList = (server: readonly string[], value: readonly string[]) =>
  server.length === value.length && server.every((id, i) => id === value[i]);

export interface SidebarPins {
  pinned: readonly string[];
  recent: readonly string[];
  setPinned: (next: string[]) => void;
  // An agent id or a member's pin key (memberPinKey).
  togglePin: (key: string) => void;
}

export function useSidebarPins(): SidebarPins {
  const self = useSelfUser();
  const serverPinned = self?.pinnedAgents ?? NONE;
  const recent = self?.recentAgents ?? NONE;
  const [pending, write] = usePendingView(serverPinned, sameList);
  const pinned = pending ?? serverPinned;
  const setPinned = useCallback(
    (next: string[]) => {
      const body: PinnedReq = { pinned: next };
      write(next, () => apiFetch<void>("PUT", "/api/me/view/pinned", body));
    },
    [write],
  );
  // A pin goes at the end; an unpin keeps the others in their order.
  const togglePin = useCallback(
    (key: string) =>
      setPinned(
        pinned.includes(key)
          ? pinned.filter((k) => k !== key)
          : [...pinned, key],
      ),
    [pinned, setPinned],
  );
  return useMemo(
    () => ({ pinned, recent, setPinned, togglePin }),
    [pinned, recent, setPinned, togglePin],
  );
}

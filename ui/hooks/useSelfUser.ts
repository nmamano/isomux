// The signed-in user's OWN full record, or null before it has arrived.
//
// The store keys users by lowercased display name, but identity is the stable
// id, so the lookup goes through sessionContext.userId - a rename can't make
// this miss. The record is narrowed through isFullUserView because the store
// map also holds public-only views of OTHER users; only our own record (via
// the self channel) and, for owners, everyone's (via the admin channel) carry
// the private fields like preferences.
//
// This is how per-user preferences reach the UI: they ride the user record, so
// a change made on the phone repaints the laptop through the same
// user_self_updated event that already existed - no extra fetch, no polling.

import { useMemo } from "react";
import { useAppState } from "../store.tsx";
import { isFullUserView } from "../user-merge.ts";
import type { UserRecord } from "../../shared/types.ts";

export function useSelfUser(): UserRecord | null {
  const { users, sessionContext } = useAppState();
  const userId = sessionContext?.userId ?? null;
  return useMemo(() => {
    if (!userId) return null;
    for (const u of users.values()) {
      if (u.id === userId) return isFullUserView(u) ? u : null;
    }
    return null;
  }, [users, userId]);
}

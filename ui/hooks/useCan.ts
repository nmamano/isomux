// Whether the signed-in member may use an area at a level (task 134b8f77): an
// owner and a member with no permission pack may use every area; a pack holder
// only the areas the pack gives at that level or above. UI only: the server
// enforces the pack on every route and push.

import type {
  ApiTokenAccess,
  ApiTokenArea,
} from "../../shared/api-token-limits.ts";
import type { UserRecord } from "../../shared/types.ts";
import { useAppState } from "../store.tsx";
import { useSelfUser } from "./useSelfUser.ts";

export function canUse(
  self: Pick<UserRecord, "role" | "pack"> | null,
  area: ApiTokenArea,
  level: ApiTokenAccess,
): boolean {
  const pack = self?.role === "member" ? self.pack : undefined;
  if (!pack) return true;
  const own = pack.areas[area];
  return own === "write" || (own === "read" && level === "read");
}

export function useCan(area: ApiTokenArea, level: ApiTokenAccess): boolean {
  return canUse(useSelfUser(), area, level);
}

// Whether the signed-in member has a permission pack.
export function useHasPack(): boolean {
  const self = useSelfUser();
  const { sessionContext } = useAppState();
  return sessionContext?.role === "member" && !!self?.pack;
}

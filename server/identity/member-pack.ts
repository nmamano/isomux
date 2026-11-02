// Member permission packs (task 134b8f77): every identity of a member with a
// pack is capped to the pack's areas, read live from the user record.

import {
  intersectAreas,
  type ApiTokenLimits,
} from "../../shared/api-token-limits.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { UserRecord } from "../../shared/types.ts";
import type { Identity } from "./index.ts";

// The limits of an identity of a member with `pack`: `limits` with each area
// cut to the pack's level (no limits = the pack's areas). Rooms and
// repliesOnly stay. Undefined pack = `limits` unchanged.
export function memberPackLimits(
  limits: ApiTokenLimits | undefined,
  pack: MemberPack | undefined,
): ApiTokenLimits | undefined {
  if (!pack) return limits;
  // No areas on the limits is every area: the pack's areas then.
  const areas = limits?.areas
    ? intersectAreas(limits.areas, pack.areas)
    : pack.areas;
  return { ...limits, areas };
}

// `identity` capped by the pack of its member (identity.userId), read live
// from the user record; unchanged for an owner, a full member or no user.
// Applied wherever an identity is made (server/auth-middleware.ts).
export function withMemberPack(
  identity: Identity,
  getUser: (id: string) => UserRecord | undefined,
): Identity {
  const user = identity.userId ? getUser(identity.userId) : undefined;
  if (!user?.pack || user.role !== "member") return identity;
  return {
    ...identity,
    apiTokenLimits: memberPackLimits(identity.apiTokenLimits, user.pack),
    memberPack: { pack: user.pack, rooms: user.allowedRooms },
  };
}

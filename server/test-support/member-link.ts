// Test helper: an owner-created member plus a sign-in link for them - the two
// steps of the invite flow (users.create, then invites.mint), done in-process.

import { setSystemTime } from "bun:test";
import { INVITE_TTL_MS, mintInvite } from "../auth.ts";
import { createMember, getUserByName } from "../users.ts";
import type { UserRole } from "../../shared/types.ts";

export async function mintMemberLink(
  name: string,
  role: UserRole = "member",
  ttlMs: number = INVITE_TTL_MS,
): Promise<{ rawToken: string; userId: string; tokenPrefix: string }> {
  let user = getUserByName(name);
  if (!user) {
    const created = createMember(name, { role });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);
    user = created.user;
  }
  const minted = await mintInvite({
    userId: user.id,
    createdBy: "Morgan",
    ttlMs,
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return {
    rawToken: minted.rawToken,
    userId: user.id,
    tokenPrefix: minted.invite.tokenPrefix,
  };
}

// Run `make` with the clock set `ago` ms in the past, then put the clock back.
// A link minted this way has the real shape of a link that ran out: its
// window (expiresAt - createdAt) is the TTL it was issued with (task
// 1492af52, where only a link issued with the owner window can be extended).
export async function inThePast<T>(
  ago: number,
  make: () => Promise<T>,
): Promise<T> {
  setSystemTime(new Date(Date.now() - ago));
  try {
    return await make();
  } finally {
    setSystemTime();
  }
}

// An existing member's sign-in link that ran out a second ago, issued with
// `ttlMs` (the owner window by default) by `createdBy`.
export async function mintExpiredLink(
  name: string,
  {
    createdBy = "Morgan",
    ttlMs = INVITE_TTL_MS,
    role = "member",
  }: { createdBy?: string; ttlMs?: number; role?: UserRole } = {},
): Promise<{ rawToken: string; userId: string; tokenPrefix: string }> {
  let user = getUserByName(name);
  if (!user) {
    const created = createMember(name, { role });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);
    user = created.user;
  }
  const userId = user.id;
  const minted = await inThePast(ttlMs + 1000, () =>
    mintInvite({ userId, createdBy, ttlMs }),
  );
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return {
    rawToken: minted.rawToken,
    userId,
    tokenPrefix: minted.invite.tokenPrefix,
  };
}

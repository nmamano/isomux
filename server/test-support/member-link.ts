// Test helper: an owner-created member plus a sign-in link for them - the two
// steps of the invite flow (users.create, then invites.mint), done in-process.

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
    createdBy: "Boss",
    ttlMs,
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return {
    rawToken: minted.rawToken,
    userId: user.id,
    tokenPrefix: minted.invite.tokenPrefix,
  };
}

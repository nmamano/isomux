// A guest who opens an owner's sign-in link after it expired (task 1492af52)
// asks, from the expired-link page, to have the SAME link re-enabled. The
// office opens a ringing page for the owner who made the link (else for every
// owner), with no agent. The card's Re-enable button extends the link
// (POST /api/invites/:prefix/extend); the button is derived on the member
// wire from the page key (askMemberWire), never stored, so an older server
// still loads the ask.
//
// The request carries no sign-in: whoever holds the link's URL can press it.
// The page says so, and the owner's tap is the only check.

import {
  expiredInviteRenewal,
  inviteRenewableByPrefix,
  type InviteRenewal,
} from "./auth.ts";
import type { AskStore } from "./asks.ts";
import { getUserByName, listUsers } from "./users.ts";
import {
  pageKey,
  renewalPrefixOf,
  SIGN_IN_LINKS_OFFICE,
} from "./sign-in-link-key.ts";

// Who gets the page: the member who made the link when they are an office
// owner now, else every owner. createdBy is a display name (an agent's or an
// app's for a link they made), so it may name no owner.
function recipientsFor(renewal: InviteRenewal): string[] {
  const maker = renewal.createdBy ? getUserByName(renewal.createdBy) : null;
  if (maker?.role === "owner") return [maker.id];
  return listUsers()
    .filter((u) => u.role === "owner")
    .map((u) => u.id);
}

// Opens the page for each recipient that has none open for this link. A
// repeat tap rings nobody again. Never throws: the guest's reply page does
// not depend on it.
export function requestSignInLinkRenewal(
  store: AskStore | undefined,
  rawToken: string,
): boolean {
  const renewal = expiredInviteRenewal(rawToken);
  if (!renewal || !store) return false;
  const key = pageKey(renewal.tokenPrefix);
  const member = renewal.memberName;
  const prompt =
    `Re-enable ${member}'s sign-in link?\n\n` +
    `Someone opened it after it expired. Re-enable gives it 3 more days: ` +
    `anyone with the link can then sign in as ${member}.`;
  for (const userId of recipientsFor(renewal)) {
    try {
      const source = {
        kind: "office" as const,
        feature: SIGN_IN_LINKS_OFFICE.feature,
        memberUserId: userId,
      };
      if (store.openPaged(source, key)) continue;
      const made = store.create({
        agentId: "",
        memberUserId: userId,
        office: { ...SIGN_IN_LINKS_OFFICE },
        prompt,
        priority: "P1",
        page: { recipients: [userId], key },
      });
      if (!made.ok)
        console.error(`[asks] sign-in link page not opened: ${made.code}`);
    } catch {
      console.error("[asks] sign-in link page could not be opened");
    }
  }
  return true;
}

// Closes each open sign-in-links page whose link is no longer an expired
// link an owner can extend: extended, replaced, revoked, used, or its member
// gone. Runs after every invites change. Never throws.
export function reconcileSignInLinkPages(store: AskStore | undefined): void {
  if (!store) return;
  try {
    for (const entry of store.listAll()) {
      const prefix = renewalPrefixOf(entry);
      if (prefix === null || inviteRenewableByPrefix(prefix)) continue;
      store.remove(entry.id, { outcome: "done" });
    }
  } catch {
    console.error("[asks] sign-in link pages could not be reconciled");
  }
}

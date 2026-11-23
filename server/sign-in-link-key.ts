// The office source and page key of a sign-in link renewal page (task
// 1492af52). A leaf: server/asks.ts reads it for the member wire.
import type { AskEntry } from "../shared/types.ts";

export const SIGN_IN_LINKS_OFFICE = {
  feature: "sign-in-links",
  name: "Sign-in links",
} as const;

const KEY_PREFIX = "sign-in-link:";

export function pageKey(tokenPrefix: string): string {
  return `${KEY_PREFIX}${tokenPrefix}`;
}

// The link a sign-in-links page asks to re-enable, or null for any other ask.
export function renewalPrefixOf(
  entry: Pick<AskEntry, "office" | "page">,
): string | null {
  if (entry.office?.feature !== SIGN_IN_LINKS_OFFICE.feature) return null;
  const key = entry.page?.key;
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const prefix = key.slice(KEY_PREFIX.length);
  return prefix === "" ? null : prefix;
}

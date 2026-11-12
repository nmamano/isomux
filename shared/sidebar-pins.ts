// The desktop sidebar's Pinned list holds agents and members (tasks 5dac6b9b,
// b2889127) in one order: an agent entry is its id, a member entry the key
// below. Agent ids never start with the prefix.

const MEMBER_PIN_PREFIX = "member:";

/** The Pinned list's key for member `userId`. */
export function memberPinKey(userId: string): string {
  return MEMBER_PIN_PREFIX + userId;
}

/** The user id a member key names, or null for an agent id (or "member:"). */
export function pinnedMemberId(key: string): string | null {
  if (!key.startsWith(MEMBER_PIN_PREFIX)) return null;
  const id = key.slice(MEMBER_PIN_PREFIX.length);
  return id === "" ? null : id;
}

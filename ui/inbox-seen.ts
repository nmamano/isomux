// The Inbox seen marks (task 64d3950a): the ask ids and agent item keys the
// member's Asks tab showed, on any of their devices. They live on the
// member's record (UserRecord.inboxSeen), which user_self_updated keeps
// current on every device, so a mark on one device clears the badge on the
// others. A device sends only the marks the record lacks
// (view.markInboxSeen), and the server only adds them.
//
// A mark this device sent counts at once (the in-flight set), so the badge
// clears before the record comes back; a failed send drops it, so the badge
// lights again and the next showing sends it again.

import { useMemo, useSyncExternalStore } from "react";
import { useAppState } from "./store.tsx";
import { isFullUserView } from "./user-merge.ts";
import { apiFetch } from "./api.ts";
import { resetBetweenTestFiles } from "./test-file-resets.ts";
import {
  INBOX_SEEN_MAX,
  type InboxSeenReq,
} from "../shared/contract-shapes.ts";

const NO_KEYS: readonly string[] = [];
const NONE: ReadonlySet<string> = new Set();

// The marks sent and not yet on the record, by member id. Replaced on each
// change, so a reader gets the same map until it changes.
let inFlight: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const listeners = new Set<() => void>();

function setInFlight(memberId: string, keys: ReadonlySet<string>): void {
  const next = new Map(inFlight);
  if (keys.size > 0) next.set(memberId, keys);
  else next.delete(memberId);
  inFlight = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}
const getInFlight = () => inFlight;

export interface InboxSeenRecord {
  memberId: string;
  // The marks on the member's record.
  recorded: ReadonlySet<string>;
}

/**
 * The session member's id and the marks on their record. Null until the
 * member's full record is in: a public users_list entry carries no marks, so
 * there an absent list means unknown, not none.
 */
export function useInboxSeenRecord(): InboxSeenRecord | null {
  const { sessionContext, users } = useAppState();
  const me = sessionContext?.userId ?? null;
  let keys: readonly string[] | null = null;
  if (me !== null) {
    for (const user of users.values()) {
      if (user.id === me) {
        if (isFullUserView(user)) keys = user.inboxSeen ?? NO_KEYS;
        break;
      }
    }
  }
  return useMemo(
    () =>
      me === null || keys === null
        ? null
        : { memberId: me, recorded: keys.length ? new Set(keys) : NONE },
    [me, keys],
  );
}

/**
 * The marks the Inbox badge leaves out: the member's record and the marks
 * this device sent for them that are still in flight. Null until the
 * member's full record is in.
 */
export function useInboxSeen(): ReadonlySet<string> | null {
  const record = useInboxSeenRecord();
  const flights = useSyncExternalStore(subscribe, getInFlight, getInFlight);
  const sent = record ? flights.get(record.memberId) : undefined;
  return useMemo(() => {
    if (!record) return null;
    if (!sent || sent.size === 0) return record.recorded;
    return new Set([...record.recorded, ...sent]);
  }, [record, sent]);
}

/**
 * Sends the keys of `keys` that neither `recorded` (the member's record) nor
 * a send in flight holds (the newest INBOX_SEEN_MAX if more). They count as
 * seen at once; a failed send drops them again.
 */
export function markInboxSeen(
  memberId: string,
  keys: readonly string[],
  recorded: ReadonlySet<string>,
): void {
  const before = inFlight.get(memberId) ?? NONE;
  // What the record now carries is no longer in flight.
  const flying = new Set([...before].filter((k) => !recorded.has(k)));
  const missing = [
    ...new Set(keys.filter((k) => !recorded.has(k) && !flying.has(k))),
  ].slice(-INBOX_SEEN_MAX);
  if (missing.length === 0) {
    if (flying.size !== before.size) setInFlight(memberId, flying);
    return;
  }
  setInFlight(memberId, new Set([...flying, ...missing]));
  const body: InboxSeenReq = { keys: missing };
  apiFetch<void>("POST", "/api/me/view/inbox-seen", body).catch(() => {
    const now = inFlight.get(memberId);
    if (!now) return;
    setInFlight(
      memberId,
      new Set([...now].filter((k) => !missing.includes(k))),
    );
  });
}

export function resetInboxSeenForTests(): void {
  inFlight = new Map();
  for (const listener of listeners) listener();
}

// A send left in flight by one DOM test file must not count in the next.
resetBetweenTestFiles(resetInboxSeenForTests);

// 1:1 chats between two members (task 019e4d7c). Each pair has its own members
// chat store (server/members-chat.ts) under <root>/<lowId>-<highId>, the two
// user ids in sorted order. The directory name is never parsed: a user id may
// hold "-", so meta.json, written when the pair directory is made, carries the
// two ids and the last names seen for them (a peer whose removed record
// expired still has a name). A member's own messages never count in their
// unread, so a post reads nothing.
//
// A read never makes a pair directory: "a chat exists" means its directory
// holds the pair's meta.json, and only the first post or upload makes it. Access is the route
// layer's job (server/routes/handlers/member-dms.ts); this module only keeps
// the pairs.

import { mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import type { MemberDmSummary } from "../shared/types.ts";
import {
  createMembersChatStore,
  type MembersChatStore,
} from "./members-chat.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { getUserById } from "./users.ts";
import { getRemovedMember } from "./removed-members.ts";

// What the office knows about a member now: a live user, a removed member, or
// nothing (null) once the removed record expired.
export type MemberNameOf = (
  userId: string,
) => { name: string; removed: boolean } | null;

// The office's answer: the live record, else the removed one.
export const officeMemberNameOf: MemberNameOf = (userId) => {
  const live = getUserById(userId);
  if (live) return { name: live.name, removed: false };
  const removed = getRemovedMember(userId);
  return removed ? { name: removed.user.name, removed: true } : null;
};

export interface MemberDmsStore {
  // The pair's store when the chat exists, else null. Never writes.
  existing(aId: string, bId: string): MembersChatStore | null;
  // The pair's store, made with its meta.json on first use. Records the two
  // names (from the user records, never from a message author).
  open(
    a: { id: string; name: string },
    b: { id: string; name: string },
  ): MembersChatStore;
  // The name meta.json keeps for peerId, when a chat of callerId with peerId
  // exists; else null.
  storedName(callerId: string, peerId: string): string | null;
  // Every chat the member is in, with the peer's name: live name, else the
  // removed record, else meta.json. Newest first.
  conversationsOf(userId: string, nameOf: MemberNameOf): MemberDmSummary[];
}

// The user-id alphabet (server/removed-members.ts). Anything else never
// reaches a path.
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;
const META_FILE = "meta.json";

interface Meta {
  ids: [string, string];
  names: Record<string, string>;
}

function parseMeta(text: string): Meta | null {
  try {
    const raw = JSON.parse(text) as Partial<Meta>;
    if (
      !Array.isArray(raw.ids) ||
      raw.ids.length !== 2 ||
      !raw.ids.every((id) => typeof id === "string" && SAFE_USER_ID.test(id))
    )
      return null;
    const names: Record<string, string> = {};
    if (raw.names && typeof raw.names === "object")
      for (const [id, name] of Object.entries(raw.names))
        if (typeof name === "string") names[id] = name;
    return { ids: [raw.ids[0], raw.ids[1]], names };
  } catch {
    return null;
  }
}

export function createMemberDms(
  rootDir: string,
  opts: { now?: () => number } = {},
): MemberDmsStore {
  const stores = new Map<string, MembersChatStore>();
  // dir name -> meta.json. Only this process writes meta.json.
  const metas = new Map<string, Meta>();

  // The pair's sorted ids and directory, or null for a self pair or an id
  // outside the alphabet. The name is never parsed back (an id may hold "-");
  // meta.json says whose pair a directory is.
  function pairOf(aId: string, bId: string) {
    if (aId === bId || !SAFE_USER_ID.test(aId) || !SAFE_USER_ID.test(bId))
      return null;
    const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
    return { low, high, name: `${low}-${high}` };
  }

  function metaOf(name: string): Meta | null {
    const cached = metas.get(name);
    if (cached) return cached;
    let text: string;
    try {
      text = readFileSync(join(rootDir, name, META_FILE), "utf-8");
    } catch {
      return null;
    }
    const meta = parseMeta(text);
    if (meta) metas.set(name, meta);
    return meta;
  }

  function storeAt(name: string): MembersChatStore {
    let store = stores.get(name);
    if (!store) {
      store = createMembersChatStore(join(rootDir, name), {
        ...opts,
        ownMessagesUnread: false,
      });
      stores.set(name, store);
    }
    return store;
  }

  // The pair's meta when its chat exists and the directory is really this
  // pair's (two legacy ids holding "-" could share a name: fail closed).
  function existingMeta(aId: string, bId: string) {
    const pair = pairOf(aId, bId);
    if (!pair) return null;
    const meta = metaOf(pair.name);
    if (!meta || meta.ids[0] !== pair.low || meta.ids[1] !== pair.high)
      return null;
    return { pair, meta };
  }

  return {
    existing(aId, bId) {
      const found = existingMeta(aId, bId);
      return found ? storeAt(found.pair.name) : null;
    },

    open(a, b) {
      const pair = pairOf(a.id, b.id);
      if (!pair) throw new Error("not a pair of two members");
      const meta = metaOf(pair.name);
      if (meta && (meta.ids[0] !== pair.low || meta.ids[1] !== pair.high))
        throw new Error("pair directory belongs to another pair");
      const names = { ...meta?.names, [a.id]: a.name, [b.id]: b.name };
      if (!meta || meta.names[a.id] !== a.name || meta.names[b.id] !== b.name) {
        const dir = join(rootDir, pair.name);
        mkdirSync(dir, { recursive: true });
        const next: Meta = { ids: [pair.low, pair.high], names };
        atomicWriteFileSync(
          join(dir, META_FILE),
          JSON.stringify(next, null, 2) + "\n",
        );
        metas.set(pair.name, next);
      }
      return storeAt(pair.name);
    },

    storedName(callerId, peerId) {
      return existingMeta(callerId, peerId)?.meta.names[peerId] ?? null;
    },

    conversationsOf(userId, nameOf) {
      let names: string[];
      try {
        names = readdirSync(rootDir);
      } catch {
        return [];
      }
      const out: MemberDmSummary[] = [];
      for (const name of names) {
        const meta = metaOf(name);
        if (!meta || !meta.ids.includes(userId)) continue;
        const peerId = meta.ids[0] === userId ? meta.ids[1] : meta.ids[0];
        // A directory under a name that is not its pair's is skipped.
        if (pairOf(userId, peerId)?.name !== name) continue;
        const store = storeAt(name);
        const now = nameOf(peerId);
        out.push({
          peerId,
          peerName: now?.name ?? meta.names[peerId] ?? peerId,
          removed: now === null || now.removed,
          ...store.summary(userId),
          lastAt: store.newestAt(),
        });
      }
      return out.sort(
        (x, y) =>
          (y.lastAt ?? 0) - (x.lastAt ?? 0) ||
          x.peerName.localeCompare(y.peerName),
      );
    },
  };
}

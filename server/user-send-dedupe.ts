// Duplicate check for member sends that carry a clientMessageId (task
// 51de8814). The composer resends a failed attempt with its original id; when
// the first attempt had in fact been accepted (only the response was lost), the
// resend must not deliver the message twice.
//
// Per agent, in memory, bounded by count and age. It does NOT survive a server
// restart: a resend after a restart can double-send in the rare case where the
// first attempt was accepted just before the restart. Isomux PM ruling, task
// 51de8814 (Q3).

import type { UserSendAcceptance } from "./internal-types.ts";

export const USER_SEND_DEDUPE_MAX_PER_AGENT = 500;
export const USER_SEND_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

type Slot =
  | { kind: "accepted"; at: number }
  | {
      kind: "in_flight";
      at: number;
      waiters: ((result: UserSendAcceptance) => void)[];
    };

// The outcome of claiming a key. "new": this request owns the attempt and must
// call settle() exactly once (later calls are ignored). "accepted": an earlier
// request with this key was accepted; answer success without sending again.
// "in_flight": an earlier request with this key has no outcome yet; `wait`
// resolves with that outcome.
export type DedupeClaim =
  | { kind: "new"; settle: (result: UserSendAcceptance) => void }
  | { kind: "accepted" }
  | { kind: "in_flight"; wait: Promise<UserSendAcceptance> };

export interface UserSendDedupe {
  claim(agentId: string, key: string): DedupeClaim;
  forgetAgent(agentId: string): void;
}

export function createUserSendDedupe(
  opts: { maxPerAgent?: number; ttlMs?: number; now?: () => number } = {},
): UserSendDedupe {
  const maxPerAgent = opts.maxPerAgent ?? USER_SEND_DEDUPE_MAX_PER_AGENT;
  const ttlMs = opts.ttlMs ?? USER_SEND_DEDUPE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Map iteration order is insertion order, so the first key is the oldest.
  const byAgent = new Map<string, Map<string, Slot>>();

  function prune(slots: Map<string, Slot>) {
    const cutoff = now() - ttlMs;
    for (const [key, slot] of slots) {
      if (slots.size <= maxPerAgent && slot.at >= cutoff) break;
      // An in-flight slot has waiters that need its outcome; it leaves when it
      // settles.
      if (slot.kind === "accepted") slots.delete(key);
    }
  }

  return {
    claim(agentId, key) {
      let slots = byAgent.get(agentId);
      if (!slots) {
        slots = new Map();
        byAgent.set(agentId, slots);
      }
      prune(slots);
      const prior = slots.get(key);
      if (prior?.kind === "accepted") return { kind: "accepted" };
      if (prior?.kind === "in_flight") {
        const waiters = prior.waiters;
        return {
          kind: "in_flight",
          wait: new Promise((resolve) => waiters.push(resolve)),
        };
      }
      const slot: Slot = { kind: "in_flight", at: now(), waiters: [] };
      slots.set(key, slot);
      let settled = false;
      const owner = slots;
      return {
        kind: "new",
        settle(result) {
          if (settled) return;
          settled = true;
          // A refused attempt is forgotten so the member can resend it.
          if (owner.get(key) === slot) {
            if (result.ok) owner.set(key, { kind: "accepted", at: now() });
            else owner.delete(key);
          }
          for (const resolve of slot.waiters) resolve(result);
        },
      };
    },
    forgetAgent(agentId) {
      byAgent.delete(agentId);
    },
  };
}

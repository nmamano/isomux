// The pages about the Claude token of members with their own OS user
// (claude-member-token.ts): one to each office owner when it expires within
// 14 days, and one at once when Claude rejects it on a fallback turn. One
// key each: a second raise updates the open page, it never opens another.
// Only while a member has their own OS user: no one else uses the token.
// Each owner gets each phase of a token once (expiry: soon, then expired;
// rejected), so a page they closed does not come back every hour or every
// turn. The memory is in-process: a restart may page once more.

import type { MemberTokenStore } from "./claude-member-token.ts";

export const EXPIRY_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 60 * 1000;
export const KEY_EXPIRY = "claude-member-token:expiry";
export const KEY_REJECTED = "claude-member-token:rejected";

const WHERE =
  "Make a new one with `claude setup-token` and set it in Integrations › Model providers.";

export interface MemberTokenPagerDeps {
  tokens: () => MemberTokenStore;
  pager: {
    raise(userId: string, key: string, title: string, body: string): void;
    close(userId: string, key: string): void;
  };
  owners: () => string[];
  anyIsolated: () => boolean;
  now?: () => number;
}

export function createMemberTokenPager(deps: MemberTokenPagerDeps) {
  const now = deps.now ?? (() => Date.now());
  const each = (fn: (userId: string) => void) => {
    for (const userId of deps.owners()) fn(userId);
  };
  // `${userId} ${key}` -> the phase last paged, `${setAt} ${phase}`.
  const paged = new Map<string, string>();
  const pageOnce = (
    userId: string,
    key: string,
    phase: string,
    title: string,
    body: string,
  ) => {
    if (paged.get(`${userId} ${key}`) === phase) return;
    paged.set(`${userId} ${key}`, phase);
    deps.pager.raise(userId, key, title, body);
  };
  const closeAll = (key: string) =>
    each((userId) => {
      paged.delete(`${userId} ${key}`);
      deps.pager.close(userId, key);
    });
  return {
    // At boot, hourly and at each set or clear.
    check(): void {
      const status = deps.tokens().status();
      const due =
        deps.anyIsolated() &&
        status.expiresAt !== undefined &&
        status.expiresAt - now() <= EXPIRY_NOTICE_MS;
      if (!due) {
        closeAll(KEY_EXPIRY);
        return;
      }
      const day = new Date(status.expiresAt!).toISOString().slice(0, 10);
      const expired = status.expiresAt! <= now();
      const title = expired
        ? `The Claude token for members with their own OS user expired on ${day}`
        : `The Claude token for members with their own OS user expires on ${day}`;
      const phase = `${deps.tokens().generation()} ${expired ? "expired" : "soon"}`;
      each((userId) => pageOnce(userId, KEY_EXPIRY, phase, title, WHERE));
    },
    // Claude rejected the token on a fallback turn.
    rejected(): void {
      const record = deps.tokens().get();
      if (!record) return;
      each((userId) =>
        pageOnce(
          userId,
          KEY_REJECTED,
          `${record.setAt}`,
          "Claude rejected the token for members with their own OS user",
          `Their agents cannot continue on the office sign-in until it is replaced. ${WHERE}`,
        ),
      );
    },
    // A new token, or none: the rejection is over.
    changed(): void {
      closeAll(KEY_REJECTED);
      this.check();
    },
  };
}

export type MemberTokenPager = ReturnType<typeof createMemberTokenPager>;

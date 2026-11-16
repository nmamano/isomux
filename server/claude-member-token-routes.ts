// The routes of the Claude token for members with their own OS user (opIds
// office.memberToken.*, server/claude-member-token.ts). Owner-only by the
// route table. No route returns or logs the token.

import type { MemberTokenViewRes } from "../shared/contract-shapes.ts";
import {
  madeAtFrom,
  memberTokenRefusal,
  type MemberTokenStore,
} from "./claude-member-token.ts";
import { fail, ok, type RouteHandler } from "./routes/executor.ts";

export interface MemberTokenRouteDeps {
  tokens: () => MemberTokenStore;
  anyIsolated: () => boolean;
  now?: () => number;
}

export function memberTokenHandlers(
  deps: MemberTokenRouteDeps,
): Record<string, RouteHandler> {
  const now = deps.now ?? (() => Date.now());
  const view = (tokens: MemberTokenStore): MemberTokenViewRes => {
    const status = tokens.status();
    return {
      set: status.set,
      inUse: deps.anyIsolated(),
      madeAt: status.madeAt ?? null,
      expiresAt: status.expiresAt ?? null,
    };
  };
  return {
    "office.memberToken.get": () => ok(view(deps.tokens())),

    "office.memberToken.set": (ctx) => {
      const body = ctx.body as
        { token?: unknown; madeOn?: unknown } | undefined;
      const refusal = memberTokenRefusal(body?.token);
      if (refusal) return fail(400, "invalid_token", refusal);
      const at = now();
      const madeAt = madeAtFrom(body?.madeOn, at);
      if (typeof madeAt === "string") return fail(400, "invalid_date", madeAt);
      const tokens = deps.tokens();
      tokens.set(body!.token as string, madeAt, at);
      return ok(view(tokens));
    },

    "office.memberToken.clear": () => {
      const tokens = deps.tokens();
      tokens.clear();
      return ok(view(tokens));
    },
  };
}

import {
  created,
  fail,
  noContent,
  ok,
  type RouteHandler,
} from "../executor.ts";
import type {
  ApiTokenCreateReq,
  ApiTokenCreateRes,
  ApiTokenInboxDrainReq,
  ApiTokenInboxDrainRes,
  ApiTokenInboxSendReq,
  ApiTokenInboxSendRes,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../../shared/contract-shapes.ts";
import { API_TOKEN_EXPIRY_DAYS } from "../../api-tokens.ts";
import {
  parseApiTokenLimits,
  type ApiTokenLimits,
} from "../../../shared/api-token-limits.ts";
import { APP_MESSAGE_MAX_CHARS } from "../../app-message-limits.ts";

export interface ApiTokenDeps {
  list(userId: string): ApiTokenWire[];
  mint(input: {
    userId: string;
    name: string;
    expiresInDays: number | null;
    limits?: ApiTokenLimits;
  }): Promise<ApiTokenCreateRes>;
  revoke(userId: string, id: string): Promise<boolean>;
  // The ordinary rooms the member can access now: the rooms a token may be
  // limited to.
  limitableRoomIds(userId: string): ReadonlySet<string>;
  userIdForUsername(username: string): string | null;
  sendToInbox(input: {
    tokenId: string;
    userId: string;
    text: string;
    senderAgentId: string;
    senderAgentName: string;
    senderRoomName: string;
  }): Promise<
    | {
        ok: true;
        messageId: string;
        lastDrainedAt: number | null;
        tokenName: string;
      }
    | { ok: false; reason: "unavailable" }
  >;
  drainInbox(
    tokenId: string,
    after?: number,
  ): Promise<ApiTokenInboxDrainRes | null>;
  agentDisplay(agentId: string): { name: string; roomName: string } | null;
  agentManagerUserId(agentId: string): string | null;
  echoToAgent(agentId: string, tokenName: string, text: string): void;
}

// A token mint's body, checked: the name trimmed, an offered expiry, and the
// limits with rooms the member may limit a token to (read only when the
// limits name rooms). apiTokens.mint and the api-token action ask
// (server/step-asks.ts) both take a body through it.
export function parseApiTokenCreate(
  raw: unknown,
  limitableRoomIds: () => ReadonlySet<string>,
):
  | {
      ok: true;
      req: {
        name: string;
        expiresInDays: ApiTokenCreateReq["expiresInDays"];
        limits?: ApiTokenLimits;
      };
    }
  | {
      ok: false;
      code: "invalid_name" | "invalid_expiry" | "invalid_limits";
      message: string;
    } {
  const body = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Partial<ApiTokenCreateReq>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64)
    return {
      ok: false,
      code: "invalid_name",
      message: "name must be between 1 and 64 characters",
    };
  if (
    body.expiresInDays === undefined ||
    !(API_TOKEN_EXPIRY_DAYS as readonly (number | null)[]).includes(
      body.expiresInDays,
    )
  )
    return {
      ok: false,
      code: "invalid_expiry",
      message:
        "expiresInDays must be 30, 365, or null for a token that does not expire",
    };
  // Absent = full access. Fixed at mint.
  let limits: ApiTokenLimits | undefined;
  if (body.limits !== undefined) {
    const parsed = parseApiTokenLimits(body.limits);
    const limitable = parsed?.rooms ? limitableRoomIds() : null;
    if (
      !parsed ||
      (limitable && !parsed.rooms!.every((id) => limitable.has(id)))
    )
      return {
        ok: false,
        code: "invalid_limits",
        message:
          'limits must be {areas?: {<area>: "read" | "write"}, rooms?: [<room id>]} with at least one of them, known areas, and rooms you can access',
      };
    limits = parsed;
  }
  return {
    ok: true,
    req: {
      name,
      expiresInDays: body.expiresInDays,
      ...(limits ? { limits } : {}),
    },
  };
}

// The same 404 the sibling /api/users/:username routes give.
function memberNotFound(username: string) {
  return fail(404, "not_found", `User ${username} not found`);
}

export function apiTokenHandlers(
  deps: ApiTokenDeps,
): Record<string, RouteHandler> {
  return {
    "apiTokens.list": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user");
      return ok({ apiTokens: deps.list(userId) } satisfies ApiTokenListRes);
    },
    "apiTokens.mint": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user");
      const parsed = parseApiTokenCreate(ctx.body, () =>
        deps.limitableRoomIds(userId),
      );
      if (!parsed.ok) return fail(422, parsed.code, parsed.message);
      return created(await deps.mint({ userId, ...parsed.req }));
    },
    "apiTokens.revoke": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user");
      if (!(await deps.revoke(userId, ctx.params.id))) {
        return fail(404, "api_token_not_found", "API token not found");
      }
      return noContent();
    },
    // An office owner's view of one member's tokens. Revoke runs the member's
    // own revoke, so the token stops on its next request and its socket closes.
    "apiTokens.adminList": (ctx) => {
      const userId = deps.userIdForUsername(ctx.params.username);
      if (!userId) return memberNotFound(ctx.params.username);
      return ok({ apiTokens: deps.list(userId) } satisfies ApiTokenListRes);
    },
    "apiTokens.adminRevoke": async (ctx) => {
      const userId = deps.userIdForUsername(ctx.params.username);
      if (!userId) return memberNotFound(ctx.params.username);
      if (!(await deps.revoke(userId, ctx.params.id))) {
        return fail(404, "api_token_not_found", "API token not found");
      }
      return noContent();
    },
    "apiTokenInbox.send": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<ApiTokenInboxSendReq>;
      if (typeof body.text !== "string" || body.text.length === 0) {
        return fail(400, "invalid_text", "text is required");
      }
      if (body.text.length > APP_MESSAGE_MAX_CHARS) {
        return fail(
          400,
          "text_too_long",
          `text must be at most ${APP_MESSAGE_MAX_CHARS} characters`,
        );
      }
      const senderAgentId = ctx.identity.agentId ?? "";
      const userId = deps.agentManagerUserId(senderAgentId);
      const display = deps.agentDisplay(senderAgentId);
      if (!userId || !display) return fail(403, "forbidden");
      const result = await deps.sendToInbox({
        tokenId: ctx.params.tokenId,
        userId,
        text: body.text,
        senderAgentId,
        senderAgentName: display.name,
        senderRoomName: display.roomName,
      });
      if (!result.ok) {
        return fail(404, "api_token_unavailable", "API token unavailable.");
      }
      deps.echoToAgent(senderAgentId, result.tokenName, body.text);
      return ok({
        messageId: result.messageId,
        lastDrainedAt: result.lastDrainedAt,
      } satisfies ApiTokenInboxSendRes);
    },
    "apiTokenInbox.drain": async (ctx) => {
      const tokenId = ctx.identity.apiTokenId ?? "";
      const body = (ctx.body ?? {}) as ApiTokenInboxDrainReq;
      if (
        body.after !== undefined &&
        (!Number.isSafeInteger(body.after) || body.after < 0)
      ) {
        return fail(
          400,
          "invalid_after",
          "after must be a nonnegative safe integer.",
        );
      }
      const result = await deps.drainInbox(tokenId, body.after);
      return result
        ? ok(result satisfies ApiTokenInboxDrainRes)
        : fail(404, "api_token_unavailable", "API token unavailable.");
    },
  };
}

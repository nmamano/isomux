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
  ApiTokenInboxDrainRes,
  ApiTokenInboxSendReq,
  ApiTokenInboxSendRes,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../../shared/contract-shapes.ts";
import { API_TOKEN_EXPIRY_DAYS } from "../../api-tokens.ts";
import { APP_MESSAGE_MAX_CHARS } from "../../app-message-limits.ts";

export interface ApiTokenDeps {
  list(userId: string): ApiTokenWire[];
  mint(input: {
    userId: string;
    name: string;
    expiresInDays: number | null;
  }): Promise<ApiTokenCreateRes>;
  revoke(userId: string, id: string): Promise<boolean>;
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
    | { ok: false; reason: "unavailable" | "full" }
  >;
  drainInbox(tokenId: string): Promise<ApiTokenInboxDrainRes | null>;
  agentDisplay(agentId: string): { name: string; roomName: string } | null;
  agentManagerUserId(agentId: string): string | null;
  echoToAgent(agentId: string, tokenName: string, text: string): void;
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
      const body = (ctx.body ?? {}) as Partial<ApiTokenCreateReq>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 64) {
        return fail(
          422,
          "invalid_name",
          "name must be between 1 and 64 characters",
        );
      }
      if (
        body.expiresInDays === undefined ||
        !(API_TOKEN_EXPIRY_DAYS as readonly (number | null)[]).includes(
          body.expiresInDays,
        )
      ) {
        return fail(
          422,
          "invalid_expiry",
          "expiresInDays must be 30, 365, or null for a token that does not expire",
        );
      }
      return created(
        await deps.mint({
          userId,
          name,
          expiresInDays: body.expiresInDays,
        }),
      );
    },
    "apiTokens.revoke": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user");
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
        if (result.reason === "full") {
          return fail(
            429,
            "inbox_full",
            "The API token inbox is full because it has not been drained.",
          );
        }
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
      const result = await deps.drainInbox(tokenId);
      return result
        ? ok(result satisfies ApiTokenInboxDrainRes)
        : fail(404, "api_token_unavailable", "API token unavailable.");
    },
  };
}

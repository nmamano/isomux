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
  ApiTokenListRes,
  ApiTokenWire,
} from "../../../shared/contract-shapes.ts";
import { API_TOKEN_EXPIRY_DAYS } from "../../api-tokens.ts";

export interface ApiTokenDeps {
  list(userId: string): ApiTokenWire[];
  mint(input: {
    userId: string;
    name: string;
    expiresInDays: number | null;
  }): Promise<ApiTokenCreateRes>;
  revoke(userId: string, id: string): Promise<boolean>;
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
  };
}

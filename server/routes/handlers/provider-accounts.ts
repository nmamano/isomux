import {
  fail,
  ok,
  type HandlerErrorStatus,
  type RouteHandler,
} from "../executor.ts";
import type { ProviderAccountWire } from "../../../shared/types.ts";

export interface ProviderAccountsDeps {
  list(userId: string): Promise<ProviderAccountWire[]>;
  refresh(userId: string): Promise<ProviderAccountWire[]>;
  start(
    userId: string,
    method: "browser" | "device",
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; status: HandlerErrorStatus; code: string; message: string }
  >;
  cancel(userId: string): Promise<boolean>;
}

export function providerAccountsHandlers(
  deps: ProviderAccountsDeps,
): Record<string, RouteHandler> {
  const userId = (ctx: Parameters<RouteHandler>[0]): string | null =>
    ctx.identity.scope === "user" ? ctx.identity.userId : null;
  return {
    "providerAccounts.list": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      return ok({ accounts: await deps.list(id) });
    },
    "providerAccounts.start": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      if (ctx.params.provider !== "codex")
        return fail(
          422,
          "browser_login_unavailable",
          "Claude browser sign-in is not available yet.",
        );
      const body = (ctx.body ?? {}) as { method?: unknown };
      if (
        body.method !== undefined &&
        body.method !== "browser" &&
        body.method !== "device"
      )
        return fail(422, "invalid_method", "method must be browser or device");
      const result = await deps.start(
        id,
        body.method === "device" ? "device" : "browser",
      );
      return result.ok
        ? ok(result.value)
        : fail(result.status, result.code, result.message);
    },
    "providerAccounts.refresh": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      return ok({ accounts: await deps.refresh(id) });
    },
    "providerAccounts.cancel": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      if (ctx.params.provider !== "codex")
        return fail(422, "browser_login_unavailable");
      return (await deps.cancel(id))
        ? ok({ canceled: true })
        : fail(409, "no_login_in_progress");
    },
  };
}

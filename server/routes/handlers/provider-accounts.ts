import {
  fail,
  ok,
  type HandlerErrorStatus,
  type RouteHandler,
} from "../executor.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
} from "../../../shared/types.ts";

type Result =
  | { ok: true; value: unknown }
  | { ok: false; status: HandlerErrorStatus; code: string; message: string };

export interface ProviderAccountsDeps {
  list(userId: string): Promise<ProviderAccountWire[]>;
  refresh(userId: string): Promise<ProviderAccountWire[]>;
  start(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    method: "browser" | "device",
  ): Promise<Result>;
  callback(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    code: string,
  ): Promise<Result>;
  cancel(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ): Promise<boolean>;
}

function provider(value: string): ProviderAccountProvider | null {
  return value === "codex" || value === "claude" ? value : null;
}

function scope(value: unknown): ProviderAccountScope | null {
  return value === "office" || value === "personal" ? value : null;
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
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      const body = (ctx.body ?? {}) as { method?: unknown; scope?: unknown };
      const selectedScope = scope(body.scope);
      if (!selectedScope) return fail(422, "invalid_scope");
      if (
        body.method !== undefined &&
        body.method !== "browser" &&
        body.method !== "device"
      )
        return fail(422, "invalid_method", "method must be browser or device");
      const result = await deps.start(
        id,
        selectedProvider,
        selectedScope,
        body.method === "device" ? "device" : "browser",
      );
      return result.ok
        ? ok(result.value)
        : fail(result.status, result.code, result.message);
    },
    "providerAccounts.callback": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      const body = (ctx.body ?? {}) as { scope?: unknown; code?: unknown };
      const selectedScope = scope(body.scope);
      if (!selectedScope || typeof body.code !== "string" || !body.code.trim())
        return fail(422, "invalid_callback");
      const result = await deps.callback(
        id,
        selectedProvider,
        selectedScope,
        body.code,
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
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      const selectedScope = scope(
        (ctx.body as { scope?: unknown } | undefined)?.scope,
      );
      if (!selectedScope) return fail(422, "invalid_scope");
      return (await deps.cancel(id, selectedProvider, selectedScope))
        ? ok({ canceled: true })
        : fail(409, "no_login_in_progress");
    },
  };
}

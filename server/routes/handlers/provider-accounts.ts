import {
  fail,
  ok,
  type HandlerErrorStatus,
  type RouteHandler,
} from "../executor.ts";
import {
  isOfficeOwnerIdentity,
  type GuardDeps,
} from "../../identity/guards.ts";
import { memberSubject } from "./member-subject.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
} from "../../../shared/types.ts";

type Result =
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: HandlerErrorStatus;
      code: string;
      message?: string;
      detail?: Record<string, unknown>;
    };

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
    allowForeign: boolean,
  ): Promise<boolean>;
  disconnect(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ): Promise<Result>;
}

function provider(value: string): ProviderAccountProvider | null {
  return value === "codex" || value === "claude" ? value : null;
}

function scope(value: unknown): ProviderAccountScope | null {
  return value === "office" || value === "personal" ? value : null;
}

// A member route acts on the member's personal sign-in only: the body may
// leave the scope out or name "personal", never the office.
function personalOnly(body: unknown): boolean {
  const value = (body as { scope?: unknown } | undefined)?.scope;
  return value === undefined || value === "personal";
}

function method(value: unknown): "browser" | "device" | null {
  return value === undefined || value === "browser"
    ? "browser"
    : value === "device"
      ? "device"
      : null;
}

function answer(result: Result) {
  return result.ok
    ? ok(result.value)
    : fail(result.status, result.code, result.message, result.detail);
}

export function providerAccountsHandlers(
  deps: ProviderAccountsDeps,
): Record<string, RouteHandler> {
  const userId = (ctx: Parameters<RouteHandler>[0]): string | null =>
    ctx.identity.scope === "user" ? ctx.identity.userId : null;
  // Only an owner signs the office account in or out (Nil, 2026-10-14).
  const officeDenied = (
    ctx: Parameters<RouteHandler>[0],
    selected: ProviderAccountScope,
  ): boolean => selected === "office" && !isOfficeOwnerIdentity(ctx.identity);
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
      if (officeDenied(ctx, selectedScope)) return fail(403, "forbidden");
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
        : fail(result.status, result.code, result.message, result.detail);
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
      if (officeDenied(ctx, selectedScope)) return fail(403, "forbidden");
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
      return (await deps.cancel(
        id,
        selectedProvider,
        selectedScope,
        ctx.identity.role === "owner",
      ))
        ? ok({ canceled: true })
        : fail(409, "no_login_in_progress");
    },
    "providerAccounts.disconnect": async (ctx) => {
      const id = userId(ctx);
      if (!id) return fail(403, "forbidden");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      const selectedScope = scope(
        (ctx.body as { scope?: unknown } | undefined)?.scope,
      );
      if (!selectedScope) return fail(422, "invalid_scope");
      if (officeDenied(ctx, selectedScope)) return fail(403, "forbidden");
      const result = await deps.disconnect(id, selectedProvider, selectedScope);
      return result.ok
        ? ok(result.value)
        : fail(result.status, result.code, result.message);
    },
  };
}

// A member's own sign-ins, for an office owner who sets them up (task
// f183fac3). The guard admits an owner's browser session only. Every call
// takes the MEMBER's user id, so the sign-in runs in the member's personal
// home with the member's environment, exactly as if the member started it:
// the member's own card shows it too and can finish or cancel it. The scope
// is always personal.
export function memberProviderAccountsHandlers(
  deps: ProviderAccountsDeps & {
    userIdForUsername: GuardDeps["userIdForUsername"];
  },
): Record<string, RouteHandler> {
  // The member a route acts on; its audit row names the member and the
  // provider, for the member's "changed for you" list.
  const subject = memberSubject(deps.userIdForUsername);
  return {
    "memberProviderAccounts.list": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      return ok({ accounts: await deps.list(member.userId) });
    },
    "memberProviderAccounts.refresh": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      return ok({ accounts: await deps.refresh(member.userId) });
    },
    "memberProviderAccounts.start": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      if (!personalOnly(ctx.body)) return fail(422, "invalid_scope");
      const selectedMethod = method(
        (ctx.body as { method?: unknown } | undefined)?.method,
      );
      if (!selectedMethod)
        return fail(422, "invalid_method", "method must be browser or device");
      return answer(
        await deps.start(
          member.userId,
          selectedProvider,
          "personal",
          selectedMethod,
        ),
      );
    },
    "memberProviderAccounts.callback": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      const code = (ctx.body as { code?: unknown } | undefined)?.code;
      if (!personalOnly(ctx.body) || typeof code !== "string" || !code.trim())
        return fail(422, "invalid_callback");
      return answer(
        await deps.callback(member.userId, selectedProvider, "personal", code),
      );
    },
    // allowForeign stays false: the member's id matches a sign-in the member
    // started, and an office sign-in is out of reach here.
    "memberProviderAccounts.cancel": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      if (!personalOnly(ctx.body)) return fail(422, "invalid_scope");
      return (await deps.cancel(
        member.userId,
        selectedProvider,
        "personal",
        false,
      ))
        ? ok({ canceled: true })
        : fail(409, "no_login_in_progress");
    },
    "memberProviderAccounts.disconnect": async (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      const selectedProvider = provider(ctx.params.provider);
      if (!selectedProvider) return fail(404, "provider_not_found");
      if (!personalOnly(ctx.body)) return fail(422, "invalid_scope");
      return answer(
        await deps.disconnect(member.userId, selectedProvider, "personal"),
      );
    },
  };
}

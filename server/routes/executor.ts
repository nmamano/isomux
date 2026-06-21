// HTTP executor — Phase 3a. The single pipeline that consumes the typed route
// table for the migrated /api surface. Given a matched route + a resolved
// identity, it runs:
//
//   authorize(route.auth) -> route preconditions -> idempotency.run(handler) -> render
//
// ORDER MATTERS (locked with Reviewer1): authorize + preconditions run on EVERY
// call and are NEVER cached, so a transient permission / last-owner / invite-
// ownership change re-evaluates on a retry. Idempotency wraps ONLY the handler,
// and only for a MUTATING method carrying an Idempotency-Key; GETs and keyless
// requests run uncached. Error results are surfaced as a throw inside the
// idempotency wrapper so failures are never cached (a retry re-runs).
//
// SEPARATION: the executor is ignorant of managers / auth internals. It depends
// only on the slim ExecutorDeps (guardDeps, idempotency, the opId->handler map,
// the precondition enforcer map). Resource handlers receive a RouteHandlerContext
// and return a typed HandlerResult; the executor owns the wire envelope, status
// codes, and idempotency-response storage. See
// internal-docs/generic-runtime-refactor.md -> Conventions (Error envelope,
// Idempotency, Two-stage authorization, Double-signal).

import type { RouteAuth, RoutePrecondition } from "./table.ts";
import type { RouteMatch } from "./match.ts";
import type { Identity } from "../identity/index.ts";
import { authorize } from "../identity/dispatch.ts";
import {
  ALLOW,
  type AuthzOutcome,
  type GuardDeps,
} from "../identity/guards.ts";
import type { IdempotencyCache } from "../transport/idempotency.ts";

// --- Handler result model ---------------------------------------------------
// A typed union so resource handlers never construct a Response directly; the
// executor renders it (status, envelope, idempotency storage). `file` is for
// byte/stream responses (agents.getFile); everything else is JSON / no-content /
// an error envelope.
export type HandlerErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 422 | 500;
export type HandlerResult =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "noContent" }
  | {
      kind: "file";
      path: string;
      contentType: string;
      headers?: Record<string, string>;
    }
  | {
      kind: "error";
      status: HandlerErrorStatus;
      code: string;
      message?: string;
    };

// Convenience constructors so handlers stay terse and never hand-roll an
// envelope shape.
export const ok = (body: unknown, status?: number): HandlerResult => ({
  kind: "json",
  body,
  status,
});
export const created = (body: unknown): HandlerResult => ({
  kind: "json",
  body,
  status: 201,
});
export const noContent = (): HandlerResult => ({ kind: "noContent" });
// Byte/stream response (agents.getFile). The executor renders it via Bun.file();
// the handler stays out of the Response-building business, same as the JSON ones.
export const file = (
  path: string,
  contentType: string,
  headers?: Record<string, string>,
): HandlerResult => ({ kind: "file", path, contentType, headers });
export const fail = (
  status: HandlerErrorStatus,
  code: string,
  message?: string,
): HandlerResult => ({ kind: "error", status, code, message });

// What every resource handler / precondition sees. `body` is the parsed JSON
// body (undefined for GET / multipart / empty); `rawBody` is the exact received
// bytes (hashed for idempotency); `req` is passed through for the multipart
// (upload) and file-streaming edges that need it directly.
export interface RouteHandlerContext {
  identity: Identity;
  params: Record<string, string>;
  body: unknown;
  rawBody: string;
  query: URLSearchParams;
  req: Request;
}

export type RouteHandler = (
  ctx: RouteHandlerContext,
) => HandlerResult | Promise<HandlerResult>;

// A precondition returns an error HandlerResult to REJECT, or null to PASS. It
// is a live-state semantic check (not pure authz) and runs after authorize.
export type PreconditionFn = (
  ctx: RouteHandlerContext,
) => HandlerResult | null | Promise<HandlerResult | null>;

export interface ExecutorDeps {
  guardDeps: GuardDeps;
  idempotency: IdempotencyCache;
  handlers: ReadonlyMap<string, RouteHandler>;
  preconditions: ReadonlyMap<RoutePrecondition, PreconditionFn>;
}

// Internal control-flow signal: a handler that returns an error result is thrown
// as this inside the idempotency wrapper so the cache treats it as a failure
// (evict, don't store) and a retry re-runs. Caught by executeRoute and rendered.
class HandlerErrorSignal extends Error {
  constructor(
    public readonly result: Extract<HandlerResult, { kind: "error" }>,
  ) {
    super(result.code);
    this.name = "HandlerErrorSignal";
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// Render a HandlerResult to a Response. The ONLY place a /api Response is built.
function render(result: HandlerResult): Response {
  switch (result.kind) {
    case "json":
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: JSON_HEADERS,
      });
    case "noContent":
      return new Response(null, { status: 204 });
    case "error":
      return new Response(
        JSON.stringify({
          error: { code: result.code, message: result.message ?? result.code },
        }),
        { status: result.status, headers: JSON_HEADERS },
      );
    case "file":
      return new Response(Bun.file(result.path), {
        status: 200,
        headers: {
          "Content-Type": result.contentType,
          ...(result.headers ?? {}),
        },
      });
  }
}

// Build a standalone error Response in the /api envelope, for dispatch-entry
// rejections (auth failures, an uncaught executor throw) that never reach a
// handler. Keeps the {error:{code,message}} envelope defined in exactly ONE
// place (render) so the entrypoint and the handlers can't drift.
export function errorResponse(
  status: HandlerErrorStatus,
  code: string,
  message?: string,
): Response {
  return render(fail(status, code, message));
}

// Map a route's declared auth to an AuthzOutcome. `capability` runs the full
// two-stage authorize(); `authenticated` skips stage 1 (no capability gate) and
// runs only the resource guard against the already-non-null identity; `public`
// is unreachable here (served around the dispatcher) but kept total.
function runAuthorize(
  auth: RouteAuth,
  identity: Identity,
  params: Record<string, string>,
  body: unknown,
  guardDeps: GuardDeps,
): AuthzOutcome {
  switch (auth.kind) {
    case "public":
      return ALLOW;
    case "authenticated":
      return auth.resourceGuard({ identity, params, body, deps: guardDeps });
    case "capability":
      return authorize(
        {
          requiredCapability: auth.requiredCapability,
          resourceGuard: auth.resourceGuard,
        },
        { identity, params, body, deps: guardDeps },
      );
  }
}

// Execute a matched route for a resolved (non-null) identity. The caller
// (server/index.ts fetch handler) is responsible for resolving identity and for
// only dispatching routes that have a registered handler.
export async function executeRoute(
  match: RouteMatch,
  req: Request,
  identity: Identity,
  deps: ExecutorDeps,
): Promise<Response> {
  const { route, params } = match;
  const method = req.method;
  const url = new URL(req.url);

  // Public routes are the cookie-minting login/static surface and are served
  // AROUND the dispatcher; if one is ever matched here, 404 rather than allow an
  // unintended auth bypass.
  if (route.auth.kind === "public") {
    return render(fail(404, "not_found"));
  }

  // Read the body exactly once (skip GET/HEAD and multipart — multipart is
  // consumed by the handler via req.formData()). A present-but-unparseable JSON
  // body is a 400 before any auth, matching today's handlers.
  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");
  const isGet = method === "GET" || method === "HEAD";
  let rawBody = "";
  let body: unknown = undefined;
  if (!isGet && !isMultipart) {
    rawBody = await req.text();
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return render(
          fail(400, "invalid_json", "Request body is not valid JSON"),
        );
      }
    }
  }

  const ctx: RouteHandlerContext = {
    identity,
    params,
    body,
    rawBody,
    query: url.searchParams,
    req,
  };

  // Stage 1 + 2 authorization.
  const authz = runAuthorize(
    route.auth,
    identity,
    params,
    body,
    deps.guardDeps,
  );
  if (!authz.ok) return render(fail(authz.status, authz.code));

  // Preconditions: live-state semantic checks, never cached.
  for (const pid of route.preconditions ?? []) {
    const fn = deps.preconditions.get(pid);
    if (!fn) {
      // A declared precondition with no registered enforcer is a wiring gap, not
      // a silent pass — fail closed so a contract test surfaces it.
      throw new Error(
        `executeRoute: no enforcer registered for precondition "${pid}" (route ${route.opId})`,
      );
    }
    const outcome = await fn(ctx);
    if (outcome) return render(outcome);
  }

  const handler = deps.handlers.get(route.opId);
  if (!handler) return render(fail(404, "not_found"));

  // Idempotency wraps ONLY the handler, for a mutating method with a key.
  const idempotencyKey =
    !isGet && !isMultipart ? req.headers.get("Idempotency-Key") : null;

  try {
    const outcome = await deps.idempotency.run<HandlerResult>(
      { identity, method, opId: route.opId, idempotencyKey, rawBody },
      async () => {
        const result = await handler(ctx);
        if (result.kind === "error") throw new HandlerErrorSignal(result);
        return result;
      },
    );
    if (outcome.kind === "conflict") {
      return render(
        fail(
          409,
          "idempotency_conflict",
          "Idempotency-Key reused with a different request body",
        ),
      );
    }
    return render(outcome.response);
  } catch (err) {
    if (err instanceof HandlerErrorSignal) return render(err.result);
    console.error(`[executeRoute] ${route.opId} threw:`, err);
    return render(fail(500, "internal"));
  }
}

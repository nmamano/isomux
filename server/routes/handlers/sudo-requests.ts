// Sudo request handlers (task 43a28eed; server/sudo-requests.ts).
// agents.sudoRequest is the agent's ask, on its own chat only (the route
// checks agentParamMustEqualTokenAgent). sudoRequests.run and .decline are an
// office owner's answer: the core checks that the owner is the member the ask
// is for. No answer, error or log line carries the body.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { SudoRequestFailure, SudoRequests } from "../../sudo-requests.ts";
import type { Identity } from "../../identity/index.ts";
import type { AskAudienceDeps } from "../../asks.ts";

function failed(result: SudoRequestFailure) {
  return fail(result.status, result.code, result.message, result.detail);
}

// `audienceFor`: the caller's ask audience (askAudienceFor), so a room-limited
// API token never answers as an office owner.
export function sudoRequestHandlers(
  requests: SudoRequests,
  audienceFor: (identity: Identity) => AskAudienceDeps,
): Record<string, RouteHandler> {
  return {
    "agents.sudoRequest": async (ctx) => {
      try {
        const result = await requests.open(ctx.params.id, ctx.body);
        return result.ok ? ok({ requestId: result.requestId }) : failed(result);
      } catch {
        console.error("[sudo-requests] a request failed");
        return fail(500, "sudo_failed");
      }
    },
    "sudoRequests.run": async (ctx) => {
      try {
        const result = await requests.run(
          ctx.identity.userId ?? null,
          ctx.params.id,
          ctx.params.requestId,
          ctx.body,
          audienceFor(ctx.identity),
        );
        return result.ok ? ok({ requestId: result.requestId }) : failed(result);
      } catch {
        console.error("[sudo-requests] a run failed");
        return fail(500, "sudo_failed");
      }
    },
    "sudoRequests.decline": (ctx) => {
      try {
        const result = requests.decline(
          ctx.identity.userId ?? null,
          ctx.params.id,
          ctx.params.requestId,
          audienceFor(ctx.identity),
        );
        return result.ok ? ok({ requestId: result.requestId }) : failed(result);
      } catch {
        console.error("[sudo-requests] a decline failed");
        return fail(500, "sudo_failed");
      }
    },
  };
}

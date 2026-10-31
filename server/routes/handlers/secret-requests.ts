// Secret request handlers (secrets loop, slice B4; server/secret-requests.ts).
// agents.secretRequest is the agent's ask, on its own chat only (the route
// checks agentParamMustEqualTokenAgent). secretRequests.save and .decline are
// the member's answer: the core checks that the member is the agent's manager
// (personal) or an office owner (office). No answer carries a value, and no
// error echoes the input.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type {
  SecretRequestFailure,
  SecretRequests,
} from "../../secret-requests.ts";
import type { Identity } from "../../identity/index.ts";
import type { AskAudienceDeps } from "../../asks.ts";

function failed(result: SecretRequestFailure) {
  return fail(result.status, result.code, result.message, result.detail);
}

// `audienceFor`: the caller's ask audience (askAudienceFor), so a room-limited
// API token answers only in its rooms and never as an office owner.
export function secretRequestHandlers(
  requests: SecretRequests,
  audienceFor: (identity: Identity) => AskAudienceDeps,
): Record<string, RouteHandler> {
  return {
    "agents.secretRequest": (ctx) => {
      const result = requests.open(ctx.params.id, ctx.body);
      return result.ok ? ok({ requestId: result.requestId }) : failed(result);
    },
    "secretRequests.save": async (ctx) => {
      try {
        const result = await requests.save(
          ctx.identity.userId ?? null,
          ctx.params.id,
          ctx.params.requestId,
          ctx.body,
          audienceFor(ctx.identity),
        );
        return result.ok ? ok({ name: result.name }) : failed(result);
      } catch {
        console.error("[secret-requests] a save failed");
        return fail(500, "secrets_failed");
      }
    },
    "secretRequests.decline": (ctx) => {
      const result = requests.decline(
        ctx.identity.userId ?? null,
        ctx.params.id,
        ctx.params.requestId,
        audienceFor(ctx.identity),
      );
      return result.ok ? ok({ name: result.name }) : failed(result);
    },
  };
}

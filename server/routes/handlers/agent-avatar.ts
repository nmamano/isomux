// GET /api/agents/:id/avatar.svg (opId agents.avatar). Access is the route's
// guard: the identities GET /agents serves, for an agent in a room they reach.
//
// Unlike agents.discovery there is no Origin check. An <img> GET sends no
// Origin, and the body is a picture, not the roster. A cross-site page gets
// no office cookie (SameSite=Lax); an app page on the office's site gets the
// member's, which is the use this route is for.
import { bytes, fail, type RouteHandler } from "../executor.ts";
import { agentAvatarEtag, agentAvatarSvg } from "../../agent-avatar.ts";
import { etagMatches } from "../../etag.ts";
import type { AgentOutfit } from "../../../shared/types.ts";

export interface AgentAvatarDeps {
  // The live agent's outfit; null for a killed or unknown id.
  outfitOf(agentId: string): AgentOutfit | null;
}

export function agentAvatarHandlers(
  deps: AgentAvatarDeps,
): Record<string, RouteHandler> {
  return {
    "agents.avatar": ({ params, req }) => {
      const outfit = deps.outfitOf(params.id ?? "");
      // The guard refuses a killed or unknown id first; this is a fallback for
      // an agent killed between the guard and here.
      if (!outfit) return fail(403, "forbidden");
      const svg = agentAvatarSvg(outfit);
      const etag = agentAvatarEtag(svg);
      const headers = {
        ETag: etag,
        // Outfits change: revalidate every time, a match is a cheap 304.
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
        // An SVG opened as a page can run script. This one has none, and
        // React escapes the outfit's strings; the policy is a second fence.
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      };
      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        return {
          kind: "response",
          response: new Response(null, { status: 304, headers }),
        };
      }
      return bytes(new TextEncoder().encode(svg), "image/svg+xml", headers);
    },
  };
}

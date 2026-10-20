// GET /agents, the office directory (opId agents.discovery). The live roster
// is projected to the rooms of the caller's user, plus the lobby; ?back=1
// lists back room agents one by one; ?killed=1 serves the killed roster.
//
// The path stays outside /api because every agent, skill and prompt calls
// /agents. Access is the route's guard (agentDirectoryReader); the handler
// only shapes the answer.

import { ok, fail, type RouteHandler } from "../executor.ts";
import { actsForAgent, type Identity } from "../../identity/index.ts";
import type { KilledAgentSummary } from "../../../shared/types.ts";
import {
  projectBackRooms,
  type ManifestLike,
} from "../../discovery-back-room.ts";
import { parseKilledPageQuery, pageKilledAgents } from "../../killed-roster.ts";
import { buildKilledManifest } from "../../persistence.ts";

export interface AgentDirectoryDeps<T extends ManifestLike = ManifestLike> {
  // The request's Origin is this office's own (auth-middleware checkOrigin).
  originAllowed(req: Request): boolean;
  // The rooms the caller's user may access; an identity with no live user
  // has none.
  roomIdsFor(identity: Identity): ReadonlySet<string>;
  isLobbyRoom(roomId: string): boolean;
  liveManifest(): readonly T[];
  killedAgents(): readonly KilledAgentSummary[];
  killedAgentsForManager(userId: string): readonly KilledAgentSummary[];
}

export function agentDirectoryHandlers<T extends ManifestLike>(
  deps: AgentDirectoryDeps<T>,
): Record<string, RouteHandler> {
  return {
    "agents.discovery": ({ identity, query, req }) => {
      // GETs skip the CSRF origin check, so a hostile page whose request
      // carries a valid cookie would otherwise be served. Agent curl sends no
      // Origin; a browser always attaches one cross-origin. No
      // Access-Control-Allow-Origin is sent either, so a cross-origin body
      // stays unreadable even without this check.
      if (req.headers.get("origin") !== null && !deps.originAllowed(req)) {
        return fail(403, "bad_origin", "bad origin");
      }
      // ?back=1 and ?killed=1 take EXACTLY "1": `?killed=0` reads as "no" to
      // a human, and a quiet fall-through to the other roster is the wrong
      // answer this surface is hardened against. back is for the live list
      // only.
      const backParam = query.get("back");
      if (backParam !== null && (backParam !== "1" || query.has("killed"))) {
        return fail(
          400,
          "invalid_request",
          "back must be 1, and only without killed (omit it for front agents and one entry per back room)",
        );
      }
      const killedParam = query.get("killed");
      if (killedParam !== null) {
        if (killedParam !== "1") {
          return fail(
            400,
            "invalid_request",
            "killed must be 1 (omit it for the live roster)",
          );
        }
        const page = parseKilledPageQuery(query);
        if (!page.ok) return fail(400, "invalid_request", page.error);
        // Scoped like the killed-agent log rule (killedAgentLogAccess in
        // identity/guards.ts), NOT like the live roster: the agent's own
        // member plus office owners, never a cron run. Room grants move after
        // a kill, so a room projection would hand out ids the log route then
        // refuses. A cron run carries its creator's userId, so without this
        // branch it would out-reach that log route.
        if (identity.scope === "cron-run") return fail(403, "forbidden");
        const killed =
          identity.scope === "user" && identity.role === "owner"
            ? deps.killedAgents()
            : identity.userId
              ? deps.killedAgentsForManager(identity.userId)
              : [];
        return ok(
          buildKilledManifest(
            pageKilledAgents(killed, page.limit, page.before),
          ),
        );
      }
      // Projected to the rooms of the identity's user (owners every room,
      // members their grants, agents and cron runs their manager's or
      // creator's). The lobby is listed for every identity.
      const accessible = deps.roomIdsFor(identity);
      const manifest = deps
        .liveManifest()
        .filter((e) => accessible.has(e.roomId) || deps.isLobbyRoom(e.roomId));
      // An agent (or cron run) sees each back room as one summary entry
      // unless it asks for ?back=1.
      const collapseBackRooms =
        (actsForAgent(identity) || identity.scope === "cron-run") &&
        backParam !== "1";
      return ok(projectBackRooms(manifest, collapseBackRooms));
    },
  };
}

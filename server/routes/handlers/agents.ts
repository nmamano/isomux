// Agent-lifecycle resource handlers — Phase 3d slice 7. The agent
// spawn/kill/revive/abort/edit + move/swap-desks/topic mutation surface on the
// unified REST surface (every op caps `agent:manage`).
//
// Strangler EXPAND+CUT in one slice (like rooms slice 6): 3a/3b declared these
// rows in table.ts but NEVER built a handler — the agent lifecycle stayed
// WS-only. This slice builds the handlers AND deletes the WS cases.
//   - 7a (this commit): the FIRE-AND-FORGET mutations
//     (kill/abort/move/swapDesks/setTopic/clearTopic).
//   - 7b: the RESPONSE-DRIVEN trio (spawn/revive/update) + the
//     reviveLastRoomAccess precondition.
//
// TOKEN LIFECYCLE IS CORE-OWNED: agent-manager mints on spawn/revive and revokes
// on kill / revive-rollback, so these handlers NEVER touch tokens — they
// delegate to the same cores the deleted WS cases called. The agent wire shape
// (AgentInfo) carries no token, so an { agent } response cannot leak it.
//
// COMPOUND effects (validateCwd / saveRecentCwd / spawn null-disambiguation,
// added in 7b) live in the injected AgentsDeps closures (the index seam), not
// here — the access/invites/rooms EMIT-IN-DEP pattern. These handlers stay
// contract-shaped: parse the body, call the dep, map the outcome to an envelope.
//
// ACL is the declared guards (table.ts): agentParam(:id) resolves an agent to
// its room and checks access, so a NON-EXISTENT or INACCESSIBLE agent both
// collapse to the guard's uniform 403 (no existence oracle) — matching the WS
// cases' silent agentVisibleForSession break. move requires BOTH source-agent
// and target-room access; swapDesks requires room access.
//
// LEAF over the executor + the injected AgentsDeps.

import { ok, noContent, fail, type RouteHandler } from "../executor.ts";
import type { AgentInfo } from "../../../shared/types.ts";

export interface AgentsDeps {
  // Despawns a live agent (core revokes its token). No-op safe: the agentParam
  // guard already gated existence + access, so a stale id is a harmless no-op.
  kill(agentId: string): Promise<void>;
  // Aborts the agent's in-flight turn. No-op safe.
  abort(agentId: string): Promise<void>;
  // Moves an agent to targetRoomId. Returns the moved AgentInfo (or, for a
  // same-room request, the unchanged agent — an idempotent no-op). A failure is
  // DISCRIMINATED so the handler maps it to the right status, never a false
  // not-found: the guards already proved the source agent and target room are
  // accessible, so a bare "did not apply" means a FULL target room (-> 409), an
  // ABSENT target room (reachable only by an owner, whose rule-based access
  // passes bodyRoom for any id -> 404 room_not_found), or a vanished agent
  // (post-guard race -> 404 agent_not_found).
  move(
    agentId: string,
    targetRoomId: string,
  ):
    | { ok: true; agent: AgentInfo }
    | {
        ok: false;
        reason: "no_free_desk" | "room_not_found" | "agent_not_found";
      };
  // Swaps two desks within a room. No-op safe.
  swapDesks(roomId: string, deskA: number, deskB: number): void;
  // Sets an agent's topic. No-op safe.
  setTopic(agentId: string, topic: string): void;
  // Clears an agent's topic (back to auto-generated). No-op safe.
  clearTopic(agentId: string): void;
}

export function agentsHandlers(deps: AgentsDeps): Record<string, RouteHandler> {
  return {
    "agents.kill": async (ctx) => {
      await deps.kill(ctx.params.id);
      return noContent();
    },

    "agents.abort": async (ctx) => {
      await deps.abort(ctx.params.id);
      return noContent();
    },

    "agents.move": (ctx) => {
      // The bodyRoom("targetRoomId") guard already resolved targetRoomId to an
      // accessible room (for an owner, accessible-by-rule even if absent), so it
      // is a present non-empty string here.
      const b = (ctx.body ?? {}) as { targetRoomId?: unknown };
      const targetRoomId =
        typeof b.targetRoomId === "string" ? b.targetRoomId : "";
      const r = deps.move(ctx.params.id, targetRoomId);
      if (r.ok) return ok({ agent: r.agent }); // includes the same-room no-op
      if (r.reason === "no_free_desk") {
        return fail(409, "no_free_desk", "The target room has no free desks.");
      }
      if (r.reason === "room_not_found") {
        return fail(404, "room_not_found", "Room not found");
      }
      return fail(404, "agent_not_found", "Agent not found");
    },

    "rooms.swapDesks": (ctx) => {
      // No guard validates the desk indices (roomParam only gates the room), so
      // the handler shape-checks them; the cores clamp/no-op an out-of-range or
      // occupied desk the same way the WS path did.
      const b = (ctx.body ?? {}) as { deskA?: unknown; deskB?: unknown };
      if (typeof b.deskA !== "number" || typeof b.deskB !== "number") {
        return fail(422, "invalid_desks", "deskA and deskB are required");
      }
      deps.swapDesks(ctx.params.roomId, b.deskA, b.deskB);
      return noContent();
    },

    "agents.setTopic": (ctx) => {
      // A missing / non-string topic is a malformed body, NOT an empty-topic
      // mutation -> reject it. An empty string is a valid, deliberate topic;
      // DELETE /topic is the clear operation.
      const b = (ctx.body ?? {}) as { topic?: unknown };
      if (typeof b.topic !== "string") {
        return fail(422, "invalid_topic", "topic is required");
      }
      deps.setTopic(ctx.params.id, b.topic);
      return noContent();
    },

    "agents.clearTopic": (ctx) => {
      deps.clearTopic(ctx.params.id);
      return noContent();
    },
  };
}

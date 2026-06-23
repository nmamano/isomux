// Agent-lifecycle resource handlers — Phase 3d slice 7. The agent
// spawn/kill/revive/abort/edit + move/swap-desks/topic mutation surface on the
// unified REST surface (every op caps `agent:manage`).
//
// Strangler EXPAND+CUT in one slice (like rooms slice 6): 3a/3b declared these
// rows in table.ts but NEVER built a handler — the agent lifecycle stayed
// WS-only. This slice builds the handlers AND deletes the WS cases.
//   - 7a: the FIRE-AND-FORGET mutations
//     (kill/abort/move/swapDesks/setTopic/clearTopic).
//   - 7b: the RESPONSE-DRIVEN trio (spawn/revive/update) + the
//     reviveLastRoomAccess precondition (enforced in the index seam).
//
// TOKEN LIFECYCLE IS CORE-OWNED: agent-manager mints on spawn/revive and revokes
// on kill / revive-rollback, so these handlers NEVER touch tokens — they
// delegate to the same cores the deleted WS cases called. The agent wire shape
// (AgentInfo) carries no token, so an { agent } response cannot leak it.
//
// COMPOUND effects (validateCwd / saveRecentCwd / spawn null-disambiguation)
// live in the injected AgentsDeps closures (the index seam), not here — the
// access/invites/rooms EMIT-IN-DEP pattern. These handlers stay contract-shaped:
// parse the body, call the dep, map the outcome to an envelope.
//
// ACL is the declared guards (table.ts): agentParam(:id) resolves an agent to
// its room and checks access, so a NON-EXISTENT or INACCESSIBLE agent both
// collapse to the guard's uniform 403 (no existence oracle) — matching the WS
// cases' silent agentVisibleForSession break. move requires BOTH source-agent
// and target-room access; swapDesks requires room access.
//
// LEAF over the executor + the injected AgentsDeps.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { AgentInfo } from "../../../shared/types.ts";
import type {
  SpawnReq,
  EditAgentReq,
  ReviveReq,
} from "../../../shared/contract-shapes.ts";

// Discriminated results for the response-driven trio: the index closures own the
// compound logic (validateCwd / saveRecentCwd / spawn null-disambiguation) and
// return a `reason` the handler maps to a status + stable error code. spawn/edit
// codes drive the EditAgentDialog field routing (name_taken -> name field).
export type SpawnResult =
  | { ok: true; agent: AgentInfo }
  | {
      ok: false;
      reason: "invalid_cwd" | "name_taken" | "no_free_desk" | "spawn_failed";
      message: string;
    };
export type EditResult =
  | { ok: true; agent: AgentInfo }
  | {
      ok: false;
      reason: "invalid_cwd" | "agent_not_found" | "edit_failed";
      message: string;
    };
// revive delegates to the core, which already returns this discriminated shape.
export type ReviveResult =
  | { ok: true; agent: AgentInfo }
  | { ok: false; error: string; field?: "name" | "desk" | "room" };

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

  // --- response-driven trio (7b) -------------------------------------------
  // Token-derived attribution (createdBy/username from identity, NEVER the body),
  // so a spawning user can't be spoofed; spawn reads userId off the identity too.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // Validates cwd (-> invalid_cwd), saves the recent-cwd list, spawns (the core
  // MINTS the agent token), and disambiguates a null return (duplicate name ->
  // name_taken, else the target room is full -> no_free_desk).
  spawn(input: {
    name: string;
    cwd: string;
    roomId: string;
    desk: number;
    permissionMode?: AgentInfo["permissionMode"];
    customInstructions?: string;
    outfit?: AgentInfo["outfit"];
    modelFamily?: string;
    effort?: AgentInfo["effort"];
    agentType?: AgentInfo["agentType"];
    codexSandbox?: AgentInfo["codexSandbox"];
    username: string | undefined;
    userId: string | null;
  }): Promise<SpawnResult>;
  // Revives a killed agent (the core RE-MINTS its token; revokes on rollback).
  // The target-room + lastRoomId ACL is enforced upstream (bodyRoom guard +
  // reviveLastRoomAccess precondition), so this just delegates to the core.
  revive(agentId: string, roomId: string, desk: number): Promise<ReviveResult>;
  // Validates cwd when present (-> invalid_cwd), applies the edit, returns the
  // updated agent. A no-op edit (no effective change) still returns the current
  // agent (200), never a failure.
  edit(agentId: string, changes: EditAgentReq): Promise<EditResult>;
}

// Reject a present-but-wrong-typed optional agent field at the boundary, so
// malformed input is a 422 contract error rather than a 500 from a string path
// (trim / resolveCwd) or wire corruption from a non-string stored verbatim. null
// and undefined are tolerated (falsy: the cores' `if (changes.x)` guards skip
// them, and EditAgentReq permits null for customInstructions). Shared by spawn +
// update (the two write paths carrying these fields).
function malformedAgentFields(b: Record<string, unknown>): boolean {
  const badStr = (v: unknown) =>
    v !== undefined && v !== null && typeof v !== "string";
  if (
    badStr(b.name) ||
    badStr(b.cwd) ||
    badStr(b.customInstructions) ||
    badStr(b.modelFamily) ||
    badStr(b.effort) ||
    badStr(b.permissionMode) ||
    badStr(b.codexSandbox)
  ) {
    return true;
  }
  // outfit is an AgentOutfit object; tolerate its inner shape but reject a
  // non-object (number / string / array) the core would store verbatim.
  return (
    b.outfit !== undefined &&
    b.outfit !== null &&
    (typeof b.outfit !== "object" || Array.isArray(b.outfit))
  );
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

    "agents.spawn": async (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SpawnReq>;
      if (typeof b.name !== "string" || b.name.trim().length === 0) {
        return fail(422, "invalid_name", "name is required");
      }
      if (typeof b.cwd !== "string" || b.cwd.length === 0) {
        return fail(422, "invalid_cwd", "cwd is required");
      }
      // roomId is guaranteed by the bodyRoom("roomId") guard; read defensively.
      if (typeof b.roomId !== "string" || b.roomId.length === 0) {
        return fail(422, "invalid_request", "roomId is required");
      }
      if (typeof b.desk !== "number") {
        return fail(422, "invalid_desk", "desk is required");
      }
      if (malformedAgentFields(b)) {
        return fail(422, "invalid_request", "malformed agent field");
      }
      const { username } = deps.attributionFor(ctx.identity);
      const r = await deps.spawn({
        name: b.name,
        cwd: b.cwd,
        roomId: b.roomId,
        desk: b.desk,
        permissionMode: b.permissionMode,
        customInstructions: b.customInstructions,
        outfit: b.outfit,
        modelFamily: b.modelFamily,
        effort: b.effort,
        agentType: b.agentType,
        codexSandbox: b.codexSandbox,
        username,
        userId: ctx.identity.userId,
      });
      if (r.ok) return created({ agent: r.agent });
      const status =
        r.reason === "invalid_cwd"
          ? 400
          : r.reason === "spawn_failed"
            ? 500
            : 409;
      return fail(status, r.reason, r.message);
    },

    "agents.revive": async (ctx) => {
      // bodyRoom("roomId") + reviveLastRoomAccess already gated room access; desk
      // is unguarded, so shape-check it.
      const b = (ctx.body ?? {}) as Partial<ReviveReq>;
      if (typeof b.roomId !== "string" || typeof b.desk !== "number") {
        return fail(422, "invalid_request", "roomId and desk are required");
      }
      const r = await deps.revive(ctx.params.id, b.roomId, b.desk);
      if (r.ok) return ok({ agent: r.agent });
      // The revive dialog surfaces e.message; the code mirrors the field hint.
      const code =
        r.field === "name"
          ? "name_taken"
          : r.field === "desk"
            ? "desk_taken"
            : r.field === "room"
              ? "room_not_found"
              : "revive_failed";
      return fail(r.field === "room" ? 404 : 409, code, r.error);
    },

    "agents.update": async (ctx) => {
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      if (malformedAgentFields(b)) {
        return fail(422, "invalid_request", "malformed agent field");
      }
      const r = await deps.edit(ctx.params.id, b);
      if (r.ok) return ok({ agent: r.agent });
      const status =
        r.reason === "invalid_cwd"
          ? 400
          : r.reason === "agent_not_found"
            ? 404
            : 400;
      return fail(status, r.reason, r.message);
    },
  };
}

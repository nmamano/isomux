// The single emit helper — Phase 2.3. The ONLY path to the wire in the new
// transport layer. See internal-docs/generic-runtime-refactor.md → "One wire
// stream, plural audiences" + "Event registry".
//
// Separation of concerns (the hybrid agreed with Reviewer1):
//   - emit() owns AUDIENCE DISPATCH + RECIPIENT SELECTION, derived EXECUTABLY
//     from the registry's {audience, projectionKey}. This is what makes
//     projectionKey non-decorative: a mis-declared audience or a delete/move
//     event that forgot to carry its pre-mutation room id is caught by a test,
//     not trusted from a comment.
//   - the injected EmitDeps seam owns TRANSPORT DELIVERY + per-recipient payload
//     shaping/projection. In 2.3 tests record (strategy, recipients); Phase-3
//     production wires deliver() to today's dense-index projection helpers
//     (visibleRoomProjection / projectAgentForSession / routeAgentEventToWs),
//     so the live wire stays byte-identical.
//
// FAIL CLOSED is the security posture throughout: any event whose declared
// projection subject cannot be derived selects NOBODY (never a broadcast
// fallback). A recipient-scoped event with no concrete connectionId/userId, a
// room-ACL event missing its carried room id, or a half-carried move all reach
// nobody rather than leaking.
//
// ADDITIVE: not wired into the live wireEventSinks in 2.3. Exercised directly by
// contract tests with a fake transport.

import {
  EVENT_REGISTRY,
  type EventId,
  type EventPayloads,
  type ProjectionKey,
  type RegistryEvent,
} from "./registry.ts";

// The routing subject for recipient-scoped events — supplied by the emit call
// site (NOT carried in the payload). connectionId targets a single socket
// (session_context / presence_list / editor_external_change / session_expired);
// userId targets every socket of one user (full_state / invites_list /
// sessions_active_list). Both absent on an `all`/`owners`/room-ACL emit.
export interface EmitContext {
  connectionId?: string;
  userId?: string;
}

// The injected transport seam. `S` is an opaque session handle — emit NEVER
// inspects it; it only asks deps for recipient sets and hands them back to
// deliver(). Tests use a fake session record; Phase-3 production uses the live
// ServerWebSocket. This keeps emit pure and the audience logic unit-testable.
export interface EmitDeps<S> {
  allSessions(): readonly S[];
  ownerSessions(): readonly S[];
  sessionsForUser(userId: string): readonly S[];
  sessionByConnectionId(connectionId: string): S | null;
  // Sessions with ACL access to ANY of `roomIds` (a move spans two rooms). The
  // seam owns the access predicate; emit owns which roomIds to ask about.
  sessionsForRoomAccess(roomIds: readonly string[]): readonly S[];
  // Resolve a live agentId to its CURRENT global roomId, or null if unknown.
  roomIdForAgent(agentId: string): string | null;
  // Per-recipient shaping + send. Receives the already-selected recipient set.
  deliver(recipients: readonly S[], id: EventId, payload: unknown): void;
}

// Walk a dotted path into the payload, defensively (any non-object hop yields
// undefined rather than throwing).
function readPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Derive the room id(s) a room-ACL event projects to, or null to FAIL CLOSED
// (missing carried id, unknown agent, or a half-carried move).
function deriveRoomIds<S>(
  pk: ProjectionKey,
  payload: unknown,
  deps: EmitDeps<S>,
): string[] | null {
  switch (pk.kind) {
    case "carriedRoomId": {
      const v = readPath(payload, pk.path);
      return nonEmptyString(v) ? [v] : null;
    }
    case "agentLookup": {
      const agentId = readPath(payload, pk.path);
      if (!nonEmptyString(agentId)) return null;
      const roomId = deps.roomIdForAgent(agentId);
      return nonEmptyString(roomId) ? [roomId] : null;
    }
    case "agentInfoLookup": {
      const agent = readPath(payload, pk.path);
      const agentId =
        typeof agent === "object" && agent !== null
          ? (agent as Record<string, unknown>).id
          : undefined;
      if (!nonEmptyString(agentId)) return null;
      const roomId = deps.roomIdForAgent(agentId);
      return nonEmptyString(roomId) ? [roomId] : null;
    }
    case "agentMove": {
      const oldId = readPath(payload, pk.oldPath);
      const newId = readPath(payload, pk.newPath);
      const hasOld = nonEmptyString(oldId);
      const hasNew = nonEmptyString(newId);
      if (hasOld || hasNew) {
        // A move: BOTH ids must be carried, else fail closed — a half-carried
        // move would silently drop the departing or arriving room's audience.
        if (!(hasOld && hasNew)) return null;
        return [oldId, newId];
      }
      // Non-move update: project to the agent's CURRENT room.
      const agentId = readPath(payload, pk.agentPath);
      if (!nonEmptyString(agentId)) return null;
      const roomId = deps.roomIdForAgent(agentId);
      return nonEmptyString(roomId) ? [roomId] : null;
    }
    default:
      // A non-room projection kind on a room-ACL event is an inconsistent
      // registry entry (caught by the registry contract test); fail closed.
      return null;
  }
}

// Resolve the recipient set for a registry event, or null to skip delivery
// entirely (audience `none`, or a fail-closed missing subject). An empty array
// means "valid subject, zero current recipients" and is delivered (a harmless
// no-op), distinct from a broadcast fallback which NEVER happens for scoped
// audiences. Exported so contract tests can prove the audience→recipients
// mapping (including the reserved `none`/`by-user` strategies) executably,
// independent of which event ids happen to use each strategy today.
export function resolveRecipients<S>(
  reg: RegistryEvent,
  payload: unknown,
  ctx: EmitContext,
  deps: EmitDeps<S>,
): readonly S[] | null {
  switch (reg.audience) {
    case "all":
      return deps.allSessions();
    case "owners":
      return deps.ownerSessions();
    case "none":
      // Non-observable: never reaches transport.
      return null;
    case "by-user": {
      const uid = ctx.userId;
      return nonEmptyString(uid) ? deps.sessionsForUser(uid) : null;
    }
    case "recipient-scoped": {
      const pk = reg.projectionKey;
      if (pk.kind === "connectionId") {
        // Requires a concrete connectionId; no fanout fallback.
        if (!nonEmptyString(ctx.connectionId)) return null;
        const s = deps.sessionByConnectionId(ctx.connectionId);
        return s === null ? [] : [s];
      }
      if (pk.kind === "userId") {
        if (!nonEmptyString(ctx.userId)) return null;
        return deps.sessionsForUser(ctx.userId);
      }
      // Inconsistent registry (recipient-scoped without a concrete key): fail closed.
      return null;
    }
    case "room-ACL": {
      const roomIds = deriveRoomIds(reg.projectionKey, payload, deps);
      if (roomIds === null) return null;
      return deps.sessionsForRoomAccess(roomIds);
    }
    default:
      // The AudienceStrategy type makes this unreachable; the explicit arm makes
      // fail-closed TOTAL — a malformed runtime audience selects NOBODY rather
      // than falling through to an undefined recipient set (a fail-open).
      return null;
  }
}

// Emit an event. The id correlates its payload type at the call site, and the
// audience/recipients are computed from the registry. Returns nothing; the wire
// outcome is the deliver() the seam performed.
export function emit<K extends EventId, S>(
  id: K,
  payload: EventPayloads[K],
  ctx: EmitContext,
  deps: EmitDeps<S>,
): void {
  // Widen to the declared RegistryEvent type: the `satisfies` on EVENT_REGISTRY
  // narrows each entry's audience to the literal it uses, but resolveRecipients
  // is the GENERAL mechanism and stays exhaustive over the full strategy lattice.
  const reg: RegistryEvent = EVENT_REGISTRY[id];
  const recipients = resolveRecipients(reg, payload, ctx, deps);
  if (recipients === null) return;
  deps.deliver(recipients, id, payload);
}

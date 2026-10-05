// Pager resource handlers (opIds pager.{raise,list,get,ack,resolve}).
// Design: internal-docs/pager-design.md.
//
// A page's source and target come from the raising agent's TOKEN, never the
// request body: the source is the agent and its room, the target is its
// manager. Visibility follows room access, the same as tasks: a caller sees a
// page when it can access the page's source room (an agent caller through its
// manager's set). A page the caller cannot see is the same 404 as an unknown
// id. The source can always resolve its own page.
//
// The store emits the per-recipient event on commit, so these handlers never
// emit directly. LEAF over the executor, the store and shared types.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { PagerEntry, PagerState } from "../../../shared/types.ts";
import {
  parseRaiseFields,
  PagerUnavailableError,
  PAGER_MAX_ACTIVE_PER_SOURCE,
  type PagerActResult,
  type PagerStore,
} from "../../pager-store.ts";

export interface PagerDeps {
  store: PagerStore;
  accessibleRoomIds(identity: Identity): Set<string>;
  // The raising agent as it is now: display name, room, and manager (the
  // user recorded on the agent, null on a legacy unowned agent). Null when the
  // agent is gone.
  agentSource(
    agentId: string,
  ): { name: string; roomId: string; managerUserId: string | null } | null;
  // Display name of the caller, recorded on an ack or a resolve.
  actorName(identity: Identity): string;
}

const LIST_STATES: ReadonlySet<string> = new Set([
  "open",
  "acked",
  "resolved",
  "all",
]);

function isSource(entry: PagerEntry, identity: Identity): boolean {
  return (
    identity.scope === "agent" &&
    !!identity.agentId &&
    entry.source.kind === "agent" &&
    entry.source.agentId === identity.agentId
  );
}

// An unavailable store is a server-side failure the caller can do nothing
// about; every other throw (a failed save) is the executor's generic 500.
function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof PagerUnavailableError) {
        return fail(500, "pager_unavailable", err.message);
      }
      throw err;
    }
  };
}

function actResult(result: PagerActResult) {
  switch (result.outcome) {
    case "changed":
    case "unchanged":
      return ok(result.entry);
    case "already_resolved":
      return fail(409, "already_resolved", "the page is already resolved");
    case "not_found":
      return fail(404, "not_found");
  }
}

export function pagerHandlers(deps: PagerDeps): Record<string, RouteHandler> {
  const visible = (entry: PagerEntry, identity: Identity): boolean =>
    deps.accessibleRoomIds(identity).has(entry.source.roomId);

  const handlers: Record<string, RouteHandler> = {
    "pager.raise": (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId) {
        return fail(403, "forbidden", "only an agent can raise a page");
      }
      const parsed = parseRaiseFields(ctx.body);
      if (!parsed.ok) return fail(400, "invalid_request", parsed.message);
      const agent = deps.agentSource(agentId);
      if (!agent) return fail(404, "not_found");
      if (!agent.managerUserId) {
        return fail(
          409,
          "no_manager",
          "this agent has no manager to receive the page",
        );
      }
      const result = deps.store.raise({
        source: {
          kind: "agent",
          agentId,
          name: agent.name,
          roomId: agent.roomId,
        },
        targetUserId: agent.managerUserId,
        fields: parsed.fields,
      });
      switch (result.outcome) {
        case "created":
          return created(result.entry);
        case "updated":
          return ok(result.entry);
        case "too_many":
          return fail(
            429,
            "too_many_pages",
            `this source already has ${PAGER_MAX_ACTIVE_PER_SOURCE} open or acked pages; resolve some first`,
          );
      }
    },

    "pager.list": (ctx) => {
      const state = ctx.query.get("state");
      if (state !== null && !LIST_STATES.has(state)) {
        return fail(
          400,
          "invalid_request",
          "state must be open, acked, resolved or all",
        );
      }
      const accessible = deps.accessibleRoomIds(ctx.identity);
      const roomFilter = ctx.query.get("roomId");
      // Pages always have a room, so there is no "global" filter to ask for.
      // An inaccessible or unknown room is the same 404 tasks give it.
      if (roomFilter !== null) {
        if (roomFilter.length === 0) {
          return fail(400, "invalid_request", "roomId must name a room");
        }
        if (!accessible.has(roomFilter)) return fail(404, "not_found");
      }
      const wanted = (s: PagerState): boolean =>
        state === "all"
          ? true
          : state === null
            ? s !== "resolved"
            : s === state;
      const entries = deps.store
        .list()
        .filter(
          (e) =>
            accessible.has(e.source.roomId) &&
            (roomFilter === null || e.source.roomId === roomFilter) &&
            wanted(e.state),
        )
        .sort((a, b) => b.lastRaisedAt - a.lastRaisedAt);
      return ok(entries);
    },

    "pager.get": (ctx) => {
      const entry = deps.store.get(ctx.params.id);
      return entry && visible(entry, ctx.identity)
        ? ok(entry)
        : fail(404, "not_found");
    },

    "pager.ack": (ctx) => {
      const entry = deps.store.get(ctx.params.id);
      if (!entry || !visible(entry, ctx.identity)) {
        return fail(404, "not_found");
      }
      return actResult(deps.store.ack(entry.id, deps.actorName(ctx.identity)));
    },

    "pager.resolve": (ctx) => {
      const entry = deps.store.get(ctx.params.id);
      if (
        !entry ||
        !(visible(entry, ctx.identity) || isSource(entry, ctx.identity))
      ) {
        return fail(404, "not_found");
      }
      return actResult(
        deps.store.resolve(entry.id, deps.actorName(ctx.identity)),
      );
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}

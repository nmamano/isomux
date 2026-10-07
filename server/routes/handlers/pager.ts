// Pager resource handlers (opIds pager.{raise,list,get,ack,resolve} and the
// app routes pager.{appRaise,appResolve}).
// Design: internal-docs/pager-design.md.
//
// A page's source and target come from the raising TOKEN, never the request
// body: for an agent, the source is the agent and its room and the target is
// its manager; for an app, the source is the app and its creator agent's room
// (null when that agent is gone) and the target is the app's owner.
// Visibility follows room access, the same as tasks: a caller sees a page when
// it can access the page's stored room (an agent caller through its manager's
// set). The app owner and office owners also see every app page
// (pagerEntryVisible). A page the caller cannot see is the same 404 as an
// unknown id. The source can always resolve its own page.
//
// The store emits the per-recipient event on commit, so these handlers never
// emit directly. LEAF over the executor, the store and shared types.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import {
  PAGER_RESOLVED_SLICE,
  type PagerEntry,
} from "../../../shared/types.ts";
import {
  parseRaiseFields,
  PagerUnavailableError,
  PAGER_KEY_MAX,
  PAGER_MAX_ACTIVE_PER_SOURCE,
  pagerEntryVisible,
  type PagerActResult,
  type PagerStore,
  type PagerViewer,
} from "../../pager-store.ts";

export interface PagerDeps {
  store: PagerStore;
  // The caller as a page viewer: its rooms, its user (an agent's manager) and
  // whether that user is an office owner. An app caller sees no pages.
  viewer(identity: Identity): PagerViewer;
  // The raising agent as it is now: display name, room, and manager (the
  // user recorded on the agent, null on a legacy unowned agent). Null when the
  // agent is gone.
  agentSource(
    agentId: string,
  ): { name: string; roomId: string; managerUserId: string | null } | null;
  // The raising app as it is now: its registration generation, its room (the
  // creator agent's room while that agent and its room are live, else null)
  // and its owner (null on an unowned app). Null when the app is gone.
  appSource(appName: string): {
    registrationGen: number;
    roomId: string | null;
    ownerUserId: string | null;
  } | null;
  // Display name of the caller, recorded on an ack or a resolve.
  actorName(identity: Identity): string;
}

const LIST_STATES: ReadonlySet<string> = new Set([
  "open",
  "acked",
  "resolved",
  "all",
]);

function isAgentSource(entry: PagerEntry, identity: Identity): boolean {
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

// The most resolved pages a caller may ask for in one read (the default is
// PAGER_RESOLVED_SLICE). Open and acked pages are never limited.
export const PAGER_RESOLVED_LIMIT_MAX = 200;

// An ack or a resolve of an archived page answers as it did while the page
// was in memory: it is resolved, so a resolve changes nothing and an ack is
// refused.
function archivedAct(
  entry: PagerEntry,
  to: "acked" | "resolved",
): PagerActResult {
  return to === "resolved"
    ? { outcome: "unchanged", entry }
    : { outcome: "already_resolved", entry };
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

function raiseResult(
  store: PagerStore,
  input: Parameters<PagerStore["raise"]>[0],
) {
  const result = store.raise(input);
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
}

export function pagerHandlers(deps: PagerDeps): Record<string, RouteHandler> {
  const visible = (entry: PagerEntry, identity: Identity): boolean =>
    pagerEntryVisible(entry, deps.viewer(identity));

  // The calling app as it is now. Null when the caller is not an app or the
  // app is gone.
  const callerApp = (identity: Identity) => {
    const appName = identity.appName;
    if (identity.scope !== "app" || !appName) return null;
    const app = deps.appSource(appName);
    return app ? { appName, ...app } : null;
  };

  // A page in memory, or else from the archive.
  const find = async (id: string) => {
    const entry = deps.store.get(id);
    if (entry) return { entry, archived: false };
    const old = await deps.store.findArchived(id);
    return old ? { entry: old, archived: true } : null;
  };

  // Ack or resolve the page `found` names, as `identity`.
  const act = async (
    found: { entry: PagerEntry; archived: boolean },
    to: "acked" | "resolved",
    identity: Identity,
  ) => {
    if (found.archived) return actResult(archivedAct(found.entry, to));
    const id = found.entry.id;
    const by = deps.actorName(identity);
    const result =
      to === "acked" ? deps.store.ack(id, by) : deps.store.resolve(id, by);
    // The page moved to the archive after it was found.
    if (result.outcome === "not_found") {
      const old = await deps.store.findArchived(id);
      if (old) return actResult(archivedAct(old, to));
    }
    return actResult(result);
  };

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
      return raiseResult(deps.store, {
        source: {
          kind: "agent",
          agentId,
          name: agent.name,
          roomId: agent.roomId,
        },
        targetUserId: agent.managerUserId,
        fields: parsed.fields,
      });
    },

    "pager.appRaise": (ctx) => {
      const parsed = parseRaiseFields(ctx.body);
      if (!parsed.ok) return fail(400, "invalid_request", parsed.message);
      const app = callerApp(ctx.identity);
      if (!app) {
        return fail(404, "not_found", "this app is no longer registered");
      }
      if (!app.ownerUserId) {
        return fail(
          409,
          "no_owner",
          "this app has no owner to receive the page",
        );
      }
      return raiseResult(deps.store, {
        source: {
          kind: "app",
          appName: app.appName,
          registrationGen: app.registrationGen,
          name: app.appName,
          roomId: app.roomId,
        },
        targetUserId: app.ownerUserId,
        fields: parsed.fields,
      });
    },

    // By id, or by key: an app that restarted may have lost the id, and it
    // has no route to list its pages. A key names the open or acked page
    // from this app with that key; dedupe keeps it to at most one.
    "pager.appResolve": async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || Array.isArray(body)) {
        return fail(400, "invalid_request", "body must be a JSON object");
      }
      const hasId = body.id !== undefined;
      const hasKey = body.key !== undefined;
      if (hasId === hasKey) {
        return fail(400, "invalid_request", "give exactly one of id or key");
      }
      const app = callerApp(ctx.identity);
      if (!app) {
        return fail(404, "not_found", "this app is no longer registered");
      }
      // The app name AND its registration: a later app with a reused name
      // never reaches an earlier one's pages.
      const own = (e: PagerEntry): boolean =>
        e.source.kind === "app" &&
        e.source.appName === app.appName &&
        e.source.registrationGen === app.registrationGen;
      let found: { entry: PagerEntry; archived: boolean } | null | undefined;
      if (hasId) {
        if (typeof body.id !== "string" || body.id.length === 0) {
          return fail(400, "invalid_request", "id must be a non-empty string");
        }
        found = await find(body.id);
      } else {
        if (
          typeof body.key !== "string" ||
          body.key.length === 0 ||
          body.key.length > PAGER_KEY_MAX
        ) {
          return fail(
            400,
            "invalid_request",
            `key must be a non-empty string of at most ${PAGER_KEY_MAX} characters`,
          );
        }
        const key = body.key;
        const entry = deps.store
          .list()
          .find((e) => e.state !== "resolved" && e.key === key && own(e));
        found = entry ? { entry, archived: false } : null;
      }
      if (!found || !own(found.entry)) {
        return fail(404, "not_found");
      }
      return act(found, "resolved", ctx.identity);
    },

    "pager.list": async (ctx) => {
      const state = ctx.query.get("state");
      if (state !== null && !LIST_STATES.has(state)) {
        return fail(
          400,
          "invalid_request",
          "state must be open, acked, resolved or all",
        );
      }
      const limitParam = ctx.query.get("limit");
      const limit =
        limitParam === null ? PAGER_RESOLVED_SLICE : Number(limitParam);
      if (
        limitParam !== null &&
        (!/^[0-9]+$/.test(limitParam) ||
          limit < 1 ||
          limit > PAGER_RESOLVED_LIMIT_MAX)
      ) {
        return fail(
          400,
          "invalid_request",
          `limit must be a whole number from 1 to ${PAGER_RESOLVED_LIMIT_MAX}`,
        );
      }
      const before = ctx.query.get("before");
      if (before !== null && before.length === 0) {
        return fail(400, "invalid_request", "before must name a page");
      }
      const viewer = deps.viewer(ctx.identity);
      const roomFilter = ctx.query.get("roomId");
      // There is no filter for app pages with no room; a room filter leaves
      // them out. An inaccessible or unknown room is the same 404 tasks give
      // it.
      if (roomFilter !== null) {
        if (roomFilter.length === 0) {
          return fail(400, "invalid_request", "roomId must name a room");
        }
        if (!viewer.accessibleRoomIds.has(roomFilter)) {
          return fail(404, "not_found");
        }
      }
      const accept = (e: PagerEntry): boolean =>
        pagerEntryVisible(e, viewer) &&
        (roomFilter === null || e.source.roomId === roomFilter);
      // Open and acked pages: all of them, newest raise first. Resolved
      // pages: one slice, newest-archived first, after them.
      const active =
        state === "resolved"
          ? []
          : deps.store
              .list()
              .filter(
                (e) =>
                  e.state !== "resolved" &&
                  (state === null || state === "all" || e.state === state) &&
                  accept(e),
              )
              .sort((a, b) => b.lastRaisedAt - a.lastRaisedAt);
      if (state !== "resolved" && state !== "all") return ok(active);
      const slice = await deps.store.listResolved({
        accept,
        limit,
        ...(before !== null ? { before } : {}),
      });
      // An unknown id and a page the caller cannot see answer alike.
      if (!slice.ok) {
        return fail(
          400,
          "invalid_request",
          "before must name a resolved page in this list",
        );
      }
      return ok([...active, ...slice.entries]);
    },

    "pager.get": async (ctx) => {
      const found = await find(ctx.params.id);
      return found && visible(found.entry, ctx.identity)
        ? ok(found.entry)
        : fail(404, "not_found");
    },

    "pager.ack": async (ctx) => {
      const found = await find(ctx.params.id);
      if (!found || !visible(found.entry, ctx.identity)) {
        return fail(404, "not_found");
      }
      return act(found, "acked", ctx.identity);
    },

    "pager.resolve": async (ctx) => {
      const found = await find(ctx.params.id);
      if (
        !found ||
        !(
          visible(found.entry, ctx.identity) ||
          isAgentSource(found.entry, ctx.identity)
        )
      ) {
        return fail(404, "not_found");
      }
      return act(found, "resolved", ctx.identity);
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}

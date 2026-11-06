// Pager resource handlers (opIds pager.{raise,list,get,ack,resolve} and the
// app routes pager.{appRaise,appResolve}).
// Design: internal-docs/pager-design.md.
//
// A page is a paged ask (task 74e8fc07), named by its page id. These routes
// keep the pager's API over the ask store and the ask history: a raise opens
// a P1 paged ask or raises into the open one with its key, and every answer
// is the PagerEntry built from the ask (server/pager-compat.ts).
//
// A page's source and target come from the raising TOKEN, never the request
// body: for an agent, the source is the agent and the target is its manager;
// for an app, the source is the app (its reply goes to its live message
// target, else to no agent) and the target is the app's owner.
// Who sees a page is who sees the ask: the member it is for, an office owner
// as another member's (askVisibleTo, askShownToOwnerAsOther), and its source
// agent; a closed page, the members it was for at the close. Only a member
// acks. The source agent withdraws its page, and a member who sees it
// resolves it (a dismiss). A page the caller cannot see is the same 404 as
// an unknown id.
//
// The ask store pushes each change, so these handlers never emit directly.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import {
  PAGER_RESOLVED_SLICE,
  type AskEntry,
  type AskClosure,
  type PagerEntry,
} from "../../../shared/types.ts";
import { parseRaiseFields, PAGER_KEY_MAX } from "../../pager-store.ts";
import {
  askAgentId,
  askAudienceFor,
  askShownToOwnerAsOther,
  askVisibleTo,
  AsksUnavailableError,
  ASK_PAGES_MAX_OPEN_PER_SOURCE,
  type AskAudienceDeps,
  type AskStore,
} from "../../asks.ts";
import type { AskHistory, AskHistoryRecord } from "../../ask-history.ts";
import {
  pagerEntryFromAsk,
  raisePage,
  type PagerCompatDeps,
} from "../../pager-compat.ts";

export interface PagerDeps {
  asks: AskStore;
  history: Pick<AskHistory, "getByPageId" | "listPaged" | "members">;
  audience: AskAudienceDeps;
  // Names and rooms as they are now, for the PagerEntry.
  compat: PagerCompatDeps;
  // The rooms the caller reaches, for the list's room filter.
  accessibleRoomIds(identity: Identity): ReadonlySet<string>;
  // The raising agent as it is now: its manager (null on a legacy unowned
  // agent) and its session. Null when the agent is gone.
  agentSource(
    agentId: string,
  ): { managerUserId: string | null; sessionId?: string | null } | null;
  // The raising app as it is now: its registration time, its owner (null on
  // an unowned app) and its message target (the configured target, else its
  // creator; null when it has neither). Null when the app is gone.
  appSource(appName: string): {
    createdAt: number;
    ownerUserId: string | null;
    targetAgentId: string | null;
  } | null;
}

const LIST_STATES: ReadonlySet<string> = new Set([
  "open",
  "acked",
  "resolved",
  "all",
]);

// The most resolved pages a caller may ask for in one read (the default is
// PAGER_RESOLVED_SLICE). Open and acked pages are never limited.
export const PAGER_RESOLVED_LIMIT_MAX = 200;

// An unavailable store is a server-side failure the caller can do nothing
// about; every other throw is the executor's generic 500.
function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof AsksUnavailableError) {
        return fail(500, "pager_unavailable", err.message);
      }
      throw err;
    }
  };
}

const notFound = () => fail(404, "not_found");
const alreadyResolved = () =>
  fail(409, "already_resolved", "the page is already resolved");

// The caller as a page viewer: a member (a session or a member's API
// token), an agent, or an app that reads as its live owner agent.
type Viewer =
  | { kind: "member"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "none" };

function viewerOf(identity: Identity): Viewer {
  if (
    (identity.scope === "user" || identity.scope === "api") &&
    identity.userId
  )
    return { kind: "member", userId: identity.userId };
  if (identity.scope === "agent" && identity.agentId)
    return { kind: "agent", agentId: identity.agentId };
  if (identity.scope === "app" && identity.ownerAgentId)
    return { kind: "agent", agentId: identity.ownerAgentId };
  return { kind: "none" };
}

// The agent's own page: an ask it opened itself, not an app's or the
// office's.
const ownedBy = (entry: AskEntry, agentId: string): boolean =>
  !entry.app && !entry.office && askAgentId(entry) === agentId;

export function pagerHandlers(deps: PagerDeps): Record<string, RouteHandler> {
  const { asks, history } = deps;
  const build = (entry: AskEntry, closure: AskClosure | null = null) =>
    pagerEntryFromAsk(entry, closure, deps.compat);

  // Whether a member sees an open paged ask.
  const memberSees = (entry: AskEntry, userId: string, identity: Identity) => {
    const audience = askAudienceFor(deps.audience, identity);
    return (
      askVisibleTo(entry, userId, audience) ||
      askShownToOwnerAsOther(entry, userId, audience)
    );
  };
  // Whether a member sees a closed one: a member it was for at the close,
  // while they reach its agent's room; an owner as another member's.
  const memberSeesClosed = (
    record: AskHistoryRecord,
    userId: string,
    identity: Identity,
  ) => {
    const audience = askAudienceFor(deps.audience, identity);
    const agentId = askAgentId(record.entry);
    const roomId = agentId === null ? null : audience.agentRoomId(agentId);
    if (
      history.members(record.entry.id).includes(userId) &&
      (roomId === null || audience.canSeeRoom(userId, roomId))
    )
      return true;
    return askShownToOwnerAsOther(record.entry, userId, audience);
  };

  const sees = (entry: AskEntry, identity: Identity) => {
    const viewer = viewerOf(identity);
    if (viewer.kind === "member")
      return memberSees(entry, viewer.userId, identity);
    return viewer.kind === "agent" && ownedBy(entry, viewer.agentId);
  };
  const seesClosed = (record: AskHistoryRecord, identity: Identity) => {
    const viewer = viewerOf(identity);
    if (viewer.kind === "member")
      return memberSeesClosed(record, viewer.userId, identity);
    return viewer.kind === "agent" && ownedBy(record.entry, viewer.agentId);
  };

  // The page with this id: its open ask, else its closed record.
  const find = (pageId: string) => {
    const open = asks.findPaged(pageId);
    if (open) return { open };
    const closed = history.getByPageId(pageId);
    return closed ? { closed } : null;
  };

  // The PagerEntry of a page this call just closed, from its record (the
  // closure as the history holds it), or from the entry when the record did
  // not land.
  const closedEntry = (entry: AskEntry, close: Omit<AskClosure, "at">) => {
    const record = entry.page?.pageId
      ? history.getByPageId(entry.page.pageId)
      : null;
    return record
      ? build(record.entry, record.closure)
      : build(entry, { ...close, at: Date.now() });
  };

  const raised = (result: ReturnType<typeof raisePage>) => {
    switch (result.outcome) {
      case "created":
        return created(build(result.entry));
      case "updated":
        return ok(build(result.entry));
      case "too_many_pages":
        return fail(
          429,
          "too_many_pages",
          `this source already has ${ASK_PAGES_MAX_OPEN_PER_SOURCE} open or acked pages; resolve some first`,
        );
      case "too_many":
        return fail(
          429,
          "too_many_asks",
          "this agent has too many open asks; withdraw some first",
        );
    }
  };

  // The calling app as it is now. Null when the caller is not an app or the
  // app is gone.
  const callerApp = (identity: Identity) => {
    const appName = identity.appName;
    if (identity.scope !== "app" || !appName) return null;
    const app = deps.appSource(appName);
    return app ? { appName, ...app } : null;
  };
  const appGone = () =>
    fail(404, "not_found", "this app is no longer registered");

  const handlers: Record<string, RouteHandler> = {
    "pager.raise": (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId) {
        return fail(403, "forbidden", "only an agent can raise a page");
      }
      const parsed = parseRaiseFields(ctx.body);
      if (!parsed.ok) return fail(400, "invalid_request", parsed.message);
      const agent = deps.agentSource(agentId);
      if (!agent) return notFound();
      if (!agent.managerUserId) {
        return fail(
          409,
          "no_manager",
          "this agent has no manager to receive the page",
        );
      }
      return raised(
        raisePage(asks, {
          source: { kind: "agent", agentId },
          agentId,
          memberUserId: agent.managerUserId,
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
          fields: parsed.fields,
        }),
      );
    },

    // The reply goes to the app's message target while it is a live agent;
    // without one the page is an ask with no agent, for its owner.
    "pager.appRaise": (ctx) => {
      const parsed = parseRaiseFields(ctx.body);
      if (!parsed.ok) return fail(400, "invalid_request", parsed.message);
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      if (!app.ownerUserId) {
        return fail(
          409,
          "no_owner",
          "this app has no owner to receive the page",
        );
      }
      const target =
        app.targetAgentId !== null && deps.agentSource(app.targetAgentId)
          ? app.targetAgentId
          : "";
      const registration = { name: app.appName, createdAt: app.createdAt };
      return raised(
        raisePage(asks, {
          source: { kind: "app", ...registration },
          agentId: target,
          memberUserId: app.ownerUserId,
          app: registration,
          fields: parsed.fields,
        }),
      );
    },

    // By id, or by key: an app that restarted may have lost the id, and it
    // has no route to list its pages. A key names the open page from this
    // app with that key; dedupe keeps it to at most one.
    "pager.appResolve": (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || Array.isArray(body)) {
        return fail(400, "invalid_request", "body must be a JSON object");
      }
      const hasId = body.id !== undefined;
      const hasKey = body.key !== undefined;
      if (hasId === hasKey) {
        return fail(400, "invalid_request", "give exactly one of id or key");
      }
      if (hasId && (typeof body.id !== "string" || body.id.length === 0)) {
        return fail(400, "invalid_request", "id must be a non-empty string");
      }
      if (
        hasKey &&
        (typeof body.key !== "string" ||
          body.key.length === 0 ||
          body.key.length > PAGER_KEY_MAX)
      ) {
        return fail(
          400,
          "invalid_request",
          `key must be a non-empty string of at most ${PAGER_KEY_MAX} characters`,
        );
      }
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      // The app name AND its registration: a later app with a reused name
      // never reaches an earlier one's pages.
      const own = (entry: AskEntry): boolean =>
        entry.app?.name === app.appName &&
        entry.app.createdAt === app.createdAt;
      let open: AskEntry | null;
      if (hasId) {
        const found = find(body.id as string);
        if (found?.closed)
          return own(found.closed.entry)
            ? ok(build(found.closed.entry, found.closed.closure))
            : notFound();
        open = found?.open ?? null;
      } else {
        open =
          asks
            .listAll()
            .find((e) => e.page && e.page.key === body.key && own(e)) ?? null;
      }
      if (!open || !own(open)) return notFound();
      const close = { outcome: "withdrawn" as const, app: app.appName };
      const removed = asks.remove(open.id, close);
      return removed ? ok(closedEntry(removed, close)) : notFound();
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
      const roomFilter = ctx.query.get("roomId");
      // There is no filter for pages with no room; a room filter leaves them
      // out. An inaccessible or unknown room is the same 404 tasks give it.
      if (roomFilter !== null) {
        if (roomFilter.length === 0) {
          return fail(400, "invalid_request", "roomId must name a room");
        }
        if (!deps.accessibleRoomIds(ctx.identity).has(roomFilter)) {
          return notFound();
        }
      }
      const inRoom = (e: PagerEntry) =>
        roomFilter === null || e.source.roomId === roomFilter;
      // Open and acked pages: all of them, newest raise first. Resolved
      // pages: one slice, newest close first, after them.
      const active =
        state === "resolved"
          ? []
          : asks
              .listAll()
              .filter((e) => e.page && sees(e, ctx.identity))
              .map((e) => build(e))
              .filter(
                (e) =>
                  (state === null || state === "all" || e.state === state) &&
                  inRoom(e),
              )
              .sort((a, b) => b.lastRaisedAt - a.lastRaisedAt);
      if (state !== "resolved" && state !== "all") return ok(active);
      const slice = history.listPaged({
        accept: (record) =>
          seesClosed(record, ctx.identity) &&
          inRoom(build(record.entry, record.closure)),
        limit,
        ...(before !== null ? { beforePageId: before } : {}),
      });
      // An unknown id and a page the caller cannot see answer alike.
      if (!slice.ok) {
        return fail(
          400,
          "invalid_request",
          "before must name a resolved page in this list",
        );
      }
      return ok([
        ...active,
        ...slice.items.map((r) => build(r.entry, r.closure)),
      ]);
    },

    "pager.get": (ctx) => {
      const found = find(ctx.params.id);
      if (found?.open && sees(found.open, ctx.identity))
        return ok(build(found.open));
      if (found?.closed && seesClosed(found.closed, ctx.identity))
        return ok(build(found.closed.entry, found.closed.closure));
      return notFound();
    },

    // Only a member acks: an agent, the source included, gets the 404.
    "pager.ack": (ctx) => {
      const viewer = viewerOf(ctx.identity);
      if (viewer.kind !== "member") return notFound();
      const found = find(ctx.params.id);
      if (found?.closed)
        return memberSeesClosed(found.closed, viewer.userId, ctx.identity)
          ? alreadyResolved()
          : notFound();
      if (!found?.open || !memberSees(found.open, viewer.userId, ctx.identity))
        return notFound();
      const acked = asks.ack(found.open.id, viewer.userId);
      if (acked) return ok(build(acked.entry));
      // Closed after it was found.
      const closed = history.getByPageId(ctx.params.id);
      return closed ? alreadyResolved() : notFound();
    },

    // The source agent withdraws its page; a member who sees it dismisses
    // it. A closed page answers as it reads.
    "pager.resolve": (ctx) => {
      const viewer = viewerOf(ctx.identity);
      // An app acts on its pages through its own route.
      if (ctx.identity.scope === "app") return notFound();
      const found = find(ctx.params.id);
      if (found?.closed)
        return seesClosed(found.closed, ctx.identity)
          ? ok(build(found.closed.entry, found.closed.closure))
          : notFound();
      const entry = found?.open;
      if (!entry || !sees(entry, ctx.identity)) return notFound();
      const close =
        viewer.kind === "member"
          ? { outcome: "dismissed" as const, byUserId: viewer.userId }
          : { outcome: "withdrawn" as const };
      const removed = asks.remove(entry.id, close);
      if (removed) return ok(closedEntry(removed, close));
      const closed = history.getByPageId(ctx.params.id);
      return closed && seesClosed(closed, ctx.identity)
        ? ok(build(closed.entry, closed.closure))
        : notFound();
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
